"""
FastAPI routes: all backend endpoints.
"""
import os
import json
import re
import shutil
import subprocess
from datetime import date
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Request, Depends
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse, FileResponse

from . import project_manager as pm
from . import ai_service as ai
from . import pdf_service as pdf
from . import outlook_service as outlook_svc
from . import gmail_service as gmail_svc
from . import supabase_client as db
from . import billing
from . import stripe_service as stripe_svc
from . import billing
from .auth_middleware import get_current_user

router = APIRouter(prefix="/api")


def _text_to_html(text: str) -> str:
    """Convert plain/markdown-ish text to HTML preserving paragraphs, bold, italic.

    Handles:
    - Double newlines → <p> paragraph breaks
    - **bold** → <strong>
    - *italic* → <em>
    - Single newlines → <br>
    """
    import html as html_mod
    # Split into paragraphs on double newlines
    paragraphs = re.split(r'\n\s*\n', text.strip())
    html_parts = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        # Escape HTML entities first
        para = html_mod.escape(para)
        # Convert **bold** to <strong>
        para = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', para)
        # Convert *italic* to <em> (but not inside <strong>)
        para = re.sub(r'(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)', r'<em>\1</em>', para)
        # Convert single newlines to <br>
        para = para.replace('\n', '<br>\n')
        html_parts.append(f'<p>{para}</p>')
    return '\n'.join(html_parts)


def _wrap_in_html(body_html: str) -> str:
    """Wrap HTML body content in a full HTML document for PDF generation."""
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page {{ margin: 60px 65px; size: letter; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; }}
p {{ margin: 0 0 13px 0; text-align: justify; }}
strong {{ font-weight: 700; }}
em {{ font-style: italic; }}
</style></head><body>
{body_html}
</body></html>"""


# Content limits (words or CJK characters)
MAX_CUSTOMIZE_FILES = 4
MAX_CUSTOM_BODY_UNITS = 2000
MAX_EMAIL_UNITS = 2000


def _count_text_units(text: str) -> int:
    """Count words (Latin) + CJK characters for mixed-language limits."""
    if not text:
        return 0
    cjk = re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u30ff\uac00-\ud7af]", text)
    cjk_count = len(cjk)
    non_cjk = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u30ff\uac00-\ud7af]", " ", text)
    words = re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?", non_cjk)
    return cjk_count + len(words)


def _enforce_text_limit(text: str, limit: int, label: str):
    units = _count_text_units(text)
    if units > limit:
        raise HTTPException(400, f"{label} is too long ({units} > {limit})")


def _charge_credits(user_id: str, amount: float, description: str) -> float:
    if amount <= 0:
        return db.get_user_credits(user_id)
    ok, balance = db.use_credits(user_id, amount, description=description)
    if not ok:
        raise HTTPException(402, "Not enough credits")
    return balance


# ═══════════════════════════════════════════════════════════════
#  Public config (no auth required)
# ═══════════════════════════════════════════════════════════════

@router.get("/config/public")
def get_public_config():
    """Return public Supabase config for frontend initialization."""
    return {
        "supabase_url": os.environ.get("SUPABASE_URL", ""),
        "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY", ""),
    }


# ═══════════════════════════════════════════════════════════════
#  Helpers: user config from Supabase + env vars
# ═══════════════════════════════════════════════════════════════

def _get_user_config(user_id: str) -> dict:
    """Build a config dict merging server env vars + per-user Supabase settings.

    Replaces the old file-based global_config.json.
    """
    settings = db.get_user_settings(user_id)
    return {
        # Server-side (env vars)
        "api_key": os.environ.get("ANTHROPIC_API_KEY", ""),
        "ms_client_id": os.environ.get("MS_CLIENT_ID", ""),
        "ms_client_secret": os.environ.get("MS_CLIENT_SECRET", ""),
        "google_client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
        "google_client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
        # Per-user (Supabase)
        "email_provider": settings.get("email_provider", "none"),
        "email": settings.get("gmail_email", ""),
        "gmail_tokens": settings.get("gmail_tokens") or {},
        "outlook_tokens": settings.get("outlook_tokens") or {},
        "outlook_email": settings.get("outlook_email", ""),
    }


def _save_user_config(user_id: str, cfg: dict):
    """Persist user-specific settings back to Supabase."""
    settings = db.get_user_settings(user_id)
    # Only update fields that are present in cfg
    if "email_provider" in cfg:
        settings["email_provider"] = cfg["email_provider"]
    if "email" in cfg:
        settings["gmail_email"] = cfg["email"]
    if "gmail_tokens" in cfg:
        settings["gmail_tokens"] = cfg["gmail_tokens"]
    if "outlook_tokens" in cfg:
        settings["outlook_tokens"] = cfg["outlook_tokens"]
    if "outlook_email" in cfg:
        settings["outlook_email"] = cfg["outlook_email"]
    db.save_user_settings(user_id, settings)


# ═══════════════════════════════════════════════════════════════
#  Auth & User
# ═══════════════════════════════════════════════════════════════

@router.get("/auth/me")
def get_me(user_id: str = Depends(get_current_user)):
    """Get current user info + credits."""
    credits = db.get_user_credits(user_id)
    settings = db.get_user_settings(user_id)
    return {
        "user_id": user_id,
        "credits": credits,
        "email_provider": settings.get("email_provider", "none"),
        "outlook_connected": bool((settings.get("outlook_tokens") or {}).get("refresh_token")),
        "outlook_email": settings.get("outlook_email", ""),
        "gmail_connected": bool((settings.get("gmail_tokens") or {}).get("refresh_token")),
        "gmail_email": settings.get("gmail_email", ""),
    }


@router.get("/auth/credits/history")
def get_credit_history(user_id: str = Depends(get_current_user)):
    return db.get_credit_history(user_id)


# ═══════════════════════════════════════════════════════════════
#  Stripe
# ═══════════════════════════════════════════════════════════════

@router.post("/stripe/checkout")
def create_checkout(data: dict, request: Request, user_id: str = Depends(get_current_user)):
    """Create a Stripe Checkout session for purchasing credits."""
    credits = int(data.get("credits", 100))
    if credits < 10:
        raise HTTPException(400, "Minimum 10 credits")
    host = request.headers.get("host", "localhost:8899")
    scheme = "https" if "localhost" not in host else "http"
    base_url = f"{scheme}://{host}"
    url = stripe_svc.create_checkout_session(
        user_id=user_id,
        credits=credits,
        success_url=f"{base_url}/?payment=success",
        cancel_url=f"{base_url}/?payment=cancelled",
    )
    return {"checkout_url": url}


@router.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook — NO auth required (Stripe calls this)."""
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    result = stripe_svc.handle_webhook(payload, sig)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "Webhook failed"))
    return result


# ═══════════════════════════════════════════════════════════════
#  User Settings (replaces global-config)
# ═══════════════════════════════════════════════════════════════

@router.get("/global-config")
def get_global_config(user_id: str = Depends(get_current_user)):
    cfg = _get_user_config(user_id)
    masked = {**cfg}
    # Mask sensitive fields for display
    if masked.get("api_key"):
        k = masked["api_key"]
        masked["api_key_display"] = k[:12] + "..." + k[-4:] if len(k) > 20 else "***"
        del masked["api_key"]
    # Never expose OAuth tokens to frontend
    if "gmail_tokens" in masked:
        masked["gmail_connected"] = bool(masked["gmail_tokens"].get("refresh_token"))
        masked["gmail_email"] = masked.get("email", "")
        del masked["gmail_tokens"]
    if "outlook_tokens" in masked:
        masked["outlook_connected"] = bool(masked["outlook_tokens"].get("refresh_token"))
        del masked["outlook_tokens"]
    for secret_key in ("ms_client_secret", "ms_client_id", "google_client_id", "google_client_secret"):
        masked.pop(secret_key, None)
    return masked


@router.post("/global-config")
def save_global_config(data: dict, user_id: str = Depends(get_current_user)):
    # Only save user-editable fields
    settings = db.get_user_settings(user_id)
    if "email_provider" in data:
        settings["email_provider"] = data["email_provider"]
    db.save_user_settings(user_id, settings)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  Outlook OAuth 2.0
# ═══════════════════════════════════════════════════════════════

def _get_redirect_uri(request) -> str:
    """Build OAuth redirect URI from the current request's host."""
    host = request.headers.get("host", "localhost:8899")
    scheme = "https" if "localhost" not in host else "http"
    return f"{scheme}://{host}/api/oauth/outlook/callback"


@router.get("/oauth/outlook/authorize")
def outlook_authorize(request: Request, user_id: str = Depends(get_current_user)):
    """Return the Microsoft OAuth authorization URL."""
    client_id = os.environ.get("MS_CLIENT_ID", "") or outlook_svc.MS_CLIENT_ID
    if not client_id:
        raise HTTPException(400, "Microsoft Client ID not configured")
    redirect_uri = _get_redirect_uri(request)
    # Pass user_id in state so callback can associate tokens
    url = outlook_svc.get_auth_url(redirect_uri, client_id, state=user_id)
    return {"auth_url": url}


@router.get("/oauth/outlook/callback")
def outlook_callback(request: Request, code: str = "", error: str = "", state: str = ""):
    """Handle OAuth callback from Microsoft."""
    if error:
        return HTMLResponse(f"""<html><body><h2>Authorization Failed</h2>
            <p>{error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    user_id = state
    if not user_id:
        return HTMLResponse("""<html><body><h2>Error</h2>
            <p>Missing user context. Please try again.</p>
            <script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    client_id = os.environ.get("MS_CLIENT_ID", "") or outlook_svc.MS_CLIENT_ID
    client_secret = os.environ.get("MS_CLIENT_SECRET", "")
    redirect_uri = _get_redirect_uri(request)

    ok, token_data = outlook_svc.exchange_code_for_tokens(
        code, redirect_uri, client_id, client_secret
    )
    if not ok:
        return HTMLResponse(f"""<html><body><h2>Token Exchange Failed</h2>
            <p>{token_data.get('error', 'Unknown error')}</p>
            <script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    # Get user email
    email_ok, user_email, token_data = outlook_svc.get_user_email(
        token_data, client_id, client_secret
    )

    # Save tokens to user settings in Supabase
    _save_user_config(user_id, {
        "outlook_tokens": token_data,
        "outlook_email": user_email if email_ok else "",
        "email_provider": "outlook",
    })

    return HTMLResponse(f"""<html><body>
        <h2>Outlook Connected!</h2>
        <p>Logged in as: {user_email if email_ok else '(unknown)'}</p>
        <p>You can close this window.</p>
        <script>
            if (window.opener) {{ window.opener.location.reload(); }}
            setTimeout(()=>window.close(), 2000);
        </script>
    </body></html>""")


@router.post("/oauth/outlook/disconnect")
def outlook_disconnect(user_id: str = Depends(get_current_user)):
    """Remove Outlook OAuth tokens."""
    settings = db.get_user_settings(user_id)
    settings.pop("outlook_tokens", None)
    settings.pop("outlook_email", None)
    if settings.get("email_provider") == "outlook":
        settings["email_provider"] = "none"
    db.save_user_settings(user_id, settings)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  Gmail OAuth 2.0
# ═══════════════════════════════════════════════════════════════

def _get_gmail_redirect_uri(request) -> str:
    """Build Gmail OAuth redirect URI from the current request's host."""
    host = request.headers.get("host", "localhost:8899")
    scheme = "https" if "localhost" not in host else "http"
    return f"{scheme}://{host}/api/oauth/gmail/callback"


@router.get("/oauth/gmail/authorize")
def gmail_authorize(request: Request, user_id: str = Depends(get_current_user)):
    """Return the Google OAuth authorization URL."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    if not client_id:
        raise HTTPException(400, "Google Client ID not configured")
    redirect_uri = _get_gmail_redirect_uri(request)
    url = gmail_svc.get_auth_url(redirect_uri, client_id, state=user_id)
    return {"auth_url": url}


@router.get("/oauth/gmail/callback")
def gmail_callback(request: Request, code: str = "", error: str = "", state: str = ""):
    """Handle OAuth callback from Google."""
    if error:
        return HTMLResponse(f"""<html><body><h2>Authorization Failed</h2>
            <p>{error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    user_id = state
    if not user_id:
        return HTMLResponse("""<html><body><h2>Error</h2>
            <p>Missing user context. Please try again.</p>
            <script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    redirect_uri = _get_gmail_redirect_uri(request)

    ok, token_data = gmail_svc.exchange_code_for_tokens(
        code, redirect_uri, client_id, client_secret
    )
    if not ok:
        return HTMLResponse(f"""<html><body><h2>Token Exchange Failed</h2>
            <p>{token_data.get('error', 'Unknown error')}</p>
            <script>setTimeout(()=>window.close(),3000)</script></body></html>""")

    # Get user email
    email_ok, user_email, token_data = gmail_svc.get_user_email(
        token_data, client_id, client_secret
    )

    # Save tokens to user settings in Supabase
    _save_user_config(user_id, {
        "gmail_tokens": token_data,
        "email": user_email if email_ok else "",
        "email_provider": "gmail",
    })

    return HTMLResponse(f"""<html><body>
        <h2>Gmail Connected!</h2>
        <p>Logged in as: {user_email if email_ok else '(unknown)'}</p>
        <p>You can close this window.</p>
        <script>
            if (window.opener) {{ window.opener.location.reload(); }}
            setTimeout(()=>window.close(), 2000);
        </script>
    </body></html>""")


@router.post("/oauth/gmail/disconnect")
def gmail_disconnect(user_id: str = Depends(get_current_user)):
    """Remove Gmail OAuth tokens."""
    settings = db.get_user_settings(user_id)
    settings.pop("gmail_tokens", None)
    settings.pop("gmail_email", None)
    if settings.get("email_provider") == "gmail":
        settings["email_provider"] = "none"
    db.save_user_settings(user_id, settings)
    return {"ok": True}


def _create_draft(gcfg, target, email_body, user_name, attachments):
    """Create email draft using configured provider (Gmail or Outlook).

    Returns (draft_ok, draft_error, updated_gcfg_or_None).
    """
    provider = gcfg.get("email_provider", "gmail")

    if provider == "outlook":
        tokens = gcfg.get("outlook_tokens", {})
        if not tokens.get("refresh_token"):
            return False, "Outlook not connected", None
        client_id = gcfg.get("ms_client_id", "") or outlook_svc.MS_CLIENT_ID
        client_secret = gcfg.get("ms_client_secret", "")
        draft_ok, draft_err, updated_tokens = outlook_svc.create_outlook_draft(
            tokens=tokens,
            to_email=target.get("email", ""),
            subject=target.get("subject", f"Application - {user_name}"),
            body_text=email_body,
            from_name=user_name,
            attachments=attachments,
            client_id=client_id,
            client_secret=client_secret,
        )
        # Update tokens if refreshed
        if updated_tokens != tokens:
            gcfg["outlook_tokens"] = updated_tokens
            return draft_ok, draft_err, gcfg
        return draft_ok, draft_err, None

    elif provider == "gmail":
        tokens = gcfg.get("gmail_tokens", {})
        if not tokens.get("refresh_token"):
            return False, "Gmail not connected", None
        client_id = gcfg.get("google_client_id", "")
        client_secret = gcfg.get("google_client_secret", "")
        draft_ok, draft_err, updated_tokens = gmail_svc.create_gmail_draft(
            tokens=tokens,
            to_email=target.get("email", ""),
            subject=target.get("subject", f"Application - {user_name}"),
            body_text=email_body,
            from_name=user_name,
            attachments=attachments,
            client_id=client_id,
            client_secret=client_secret,
        )
        if updated_tokens != tokens:
            gcfg["gmail_tokens"] = updated_tokens
            return draft_ok, draft_err, gcfg
        return draft_ok, draft_err, None

    else:
        return False, "No email provider configured", None


# ═══════════════════════════════════════════════════════════════
#  Projects CRUD
# ═══════════════════════════════════════════════════════════════

@router.get("/projects")
def list_projects(user_id: str = Depends(get_current_user)):
    return pm.list_projects(user_id)


@router.post("/projects")
def create_project(data: dict, user_id: str = Depends(get_current_user)):
    name = data.get("name", "New Project")
    return pm.create_project(user_id, name)


@router.get("/projects/{project_id}")
def get_project(project_id: str, user_id: str = Depends(get_current_user)):
    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    return proj


@router.put("/projects/{project_id}/config")
def update_project_config(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    return pm.update_project_config(user_id, project_id, data)


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, user_id: str = Depends(get_current_user)):
    if pm.delete_project(user_id, project_id):
        return {"ok": True}
    raise HTTPException(404, "Project not found")


# ═══════════════════════════════════════════════════════════════
#  File Uploads (Materials)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/upload-material")
async def upload_material(project_id: str, file: UploadFile = File(...), user_id: str = Depends(get_current_user)):
    mat_dir = pm.get_project_dir(user_id, project_id) / "Material"
    mat_dir.mkdir(parents=True, exist_ok=True)
    dest = mat_dir / file.filename
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"filename": file.filename, "size": len(content)}


@router.delete("/projects/{project_id}/material/{filename}")
def delete_material(project_id: str, filename: str, user_id: str = Depends(get_current_user)):
    path = pm.get_project_dir(user_id, project_id) / "Material" / filename
    if path.exists():
        path.unlink()
        return {"ok": True}
    raise HTTPException(404, "File not found")


# ═══════════════════════════════════════════════════════════════
#  Customize Files Management
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/customize-files")
def add_customize_file(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Add a new customize file type."""
    label = data.get("label", "")
    if not label:
        raise HTTPException(400, "Label is required")
    try:
        entry = pm.add_customize_file(user_id, project_id, label)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return entry


@router.delete("/projects/{project_id}/customize-files/{type_id}")
def remove_customize_file(project_id: str, type_id: str, user_id: str = Depends(get_current_user)):
    pm.remove_customize_file(user_id, project_id, type_id)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  Template Editor (per file type)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/customize/{type_id}/upload-example")
async def upload_example(project_id: str, type_id: str, file: UploadFile = File(...), user_id: str = Depends(get_current_user)):
    """Upload an example file for a given customize file type."""
    examples_dir = pm.get_project_dir(user_id, project_id) / "templates" / type_id / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    dest = examples_dir / file.filename
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"filename": file.filename, "size": len(content)}


@router.get("/projects/{project_id}/customize/{type_id}/examples")
def list_examples(project_id: str, type_id: str, user_id: str = Depends(get_current_user)):
    return pm.list_type_examples(user_id, project_id, type_id)


@router.delete("/projects/{project_id}/customize/{type_id}/examples/{filename}")
def delete_example(project_id: str, type_id: str, filename: str, user_id: str = Depends(get_current_user)):
    path = pm.get_project_dir(user_id, project_id) / "templates" / type_id / "examples" / filename
    if path.exists():
        path.unlink()
        return {"ok": True}
    raise HTTPException(404)


@router.post("/projects/{project_id}/customize/{type_id}/generate-template")
def generate_template(project_id: str, type_id: str, user_id: str = Depends(get_current_user)):
    """AI reads uploaded examples and generates template + definitions for this file type."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    examples_dir = pm.get_project_dir(user_id, project_id) / "templates" / type_id / "examples"
    if not examples_dir.exists():
        raise HTTPException(400, "No examples uploaded")

    # Get the label for this type
    proj = pm.get_project(user_id, project_id)
    customize_files = proj["config"].get("customize_files", [])
    type_label = type_id
    for cf in customize_files:
        if cf["id"] == type_id:
            type_label = cf["label"]
            break

    # Read example files
    example_texts = []
    for f in sorted(examples_dir.iterdir()):
        if f.suffix.lower() == ".txt":
            example_texts.append(f.read_text(encoding="utf-8"))
        elif f.suffix.lower() == ".pdf":
            try:
                try:
                    import pymupdf
                except ImportError:
                    import fitz as pymupdf
                doc = pymupdf.open(str(f))
                text = "\n".join(page.get_text() for page in doc)
                doc.close()
                if text.strip():
                    example_texts.append(text)
                else:
                    example_texts.append(f"[PDF {f.name} contains no extractable text - scanned image?]")
            except ImportError:
                example_texts.append(f"[PDF {f.name} cannot be read - install pymupdf: pip install pymupdf]")
            except Exception as e:
                example_texts.append(f"[Failed to read PDF {f.name}: {e}]")
        else:
            try:
                example_texts.append(f.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                pass

    if len(example_texts) < 1:
        raise HTTPException(400, "Need at least 1 example file (.txt recommended)")

    result, usage = ai.generate_template_from_examples(api_key, example_texts, type_label)
    pm.append_token_usage(user_id, project_id, f"generate_template:{type_id}", usage)

    # Save generated files in type-specific directory
    type_dir = pm.get_project_dir(user_id, project_id) / "templates" / type_id
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / "template.txt").write_text(result["template"], encoding="utf-8")
    (type_dir / "definitions.txt").write_text(result["definitions"], encoding="utf-8")

    result["token_usage"] = usage
    return result


@router.post("/projects/{project_id}/customize/{type_id}/preview")
def preview_template(project_id: str, type_id: str, user_id: str = Depends(get_current_user)):
    """Preview: fill template with sample content locally (no API call), then generate PDF."""
    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]

    type_dir = pm.get_project_dir(user_id, project_id) / "templates" / type_id
    template_path = type_dir / "template.txt"
    definitions_path = type_dir / "definitions.txt"

    if not template_path.exists():
        raise HTTPException(400, "No template found. Generate one first.")

    template = template_path.read_text(encoding="utf-8")
    definitions = definitions_path.read_text(encoding="utf-8") if definitions_path.exists() else ""

    # Parse examples from definitions for each CUSTOM_X
    import re
    custom_examples = {}
    for match in re.finditer(r'\[CUSTOM_(\d+)\].*?Examples:\s*(.+?)(?:\n|Constrains:)', definitions, re.DOTALL):
        custom_examples[f"CUSTOM_{match.group(1)}"] = match.group(2).strip()

    # Fill template with sample/real values locally — no API call needed
    filled = template
    filled = filled.replace("{{NAME}}", proj_config.get("name", "Jane Doe"))
    filled = filled.replace("{{PHONE}}", proj_config.get("phone", "555-123-4567"))
    filled = filled.replace("{{EMAIL}}", "jane.doe@email.com")
    filled = filled.replace("{{FIRM_NAME}}", "Example Studio")
    filled = filled.replace("{{POSITION}}", "Designer")

    # Fill CUSTOM_X with examples from definitions, or placeholder text
    for key, example in custom_examples.items():
        filled = filled.replace("{{" + key + "}}", example)
    # Fill any remaining CUSTOM_X placeholders
    filled = re.sub(r'\{\{CUSTOM_\d+\}\}', '[Sample content]', filled)

    # Convert text to formatted HTML for PDF
    if type_id == "email_body":
        _enforce_text_limit(filled, MAX_EMAIL_UNITS, "Email body")
    else:
        _enforce_text_limit(filled, MAX_CUSTOM_BODY_UNITS, "Document body")
    if "<html" not in filled.lower():
        html = _wrap_in_html(_text_to_html(filled))
    else:
        html = filled

    preview_dir = pm.get_project_dir(user_id, project_id) / "Email" / "CoverLetters"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = str(preview_dir / f"PREVIEW_{type_id}.pdf")

    ok = pdf.generate_pdf(html, preview_path)
    if not ok:
        raise HTTPException(500, "PDF generation failed. Is Microsoft Edge installed?")

    return {"filled_text": filled}


@router.get("/projects/{project_id}/customize/{type_id}/preview-pdf")
def download_preview_pdf(project_id: str, type_id: str, user_id: str = Depends(get_current_user)):
    """Download the last generated preview PDF for a given type."""
    pdf_path = pm.get_project_dir(user_id, project_id) / "Email" / "CoverLetters" / f"PREVIEW_{type_id}.pdf"
    if not pdf_path.exists():
        raise HTTPException(404, "No preview PDF found. Generate a preview first.")
    return FileResponse(str(pdf_path), media_type="application/pdf", filename=f"PREVIEW_{type_id}.pdf")


# ═══════════════════════════════════════════════════════════════
#  Email Template
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/email-template")
def get_email_template(project_id: str, user_id: str = Depends(get_current_user)):
    """Get current email template and definitions."""
    tpl_dir = pm.get_project_dir(user_id, project_id) / "templates" / "email_body"
    tpl_path = tpl_dir / "template.txt"
    defs_path = tpl_dir / "definitions.txt"
    example_path = tpl_dir / "example.txt"
    settings_path = tpl_dir / "subject_settings.json"
    subject_settings = {}
    if settings_path.exists():
        try:
            subject_settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "template": tpl_path.read_text(encoding="utf-8") if tpl_path.exists() else "",
        "definitions": defs_path.read_text(encoding="utf-8") if defs_path.exists() else "",
        "example": example_path.read_text(encoding="utf-8") if example_path.exists() else "",
        "subject_template": subject_settings.get("subject_template", ""),
        "smart_subject": subject_settings.get("smart_subject", False),
    }


@router.post("/projects/{project_id}/email-template/save-example")
def save_email_example(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Save pasted email example text and subject settings."""
    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(400, "No email text provided")
    tpl_dir = pm.get_project_dir(user_id, project_id) / "templates" / "email_body"
    tpl_dir.mkdir(parents=True, exist_ok=True)
    (tpl_dir / "example.txt").write_text(text, encoding="utf-8")
    # Save subject settings if provided
    subject_template = data.get("subject_template", "")
    smart_subject = data.get("smart_subject", False)
    settings = {"subject_template": subject_template, "smart_subject": smart_subject}
    (tpl_dir / "subject_settings.json").write_text(json.dumps(settings), encoding="utf-8")
    return {"ok": True}


@router.post("/projects/{project_id}/email-template/generate")
def generate_email_template(project_id: str, user_id: str = Depends(get_current_user)):
    """Generate email template from saved example."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    tpl_dir = pm.get_project_dir(user_id, project_id) / "templates" / "email_body"
    example_path = tpl_dir / "example.txt"
    if not example_path.exists():
        raise HTTPException(400, "No email example saved. Paste an example first.")

    example = example_path.read_text(encoding="utf-8")
    result, usage = ai.generate_template_from_examples(api_key, [example], "Email")
    pm.append_token_usage(user_id, project_id, "generate_email_template", usage)

    tpl_dir.mkdir(parents=True, exist_ok=True)
    (tpl_dir / "template.txt").write_text(result["template"], encoding="utf-8")
    (tpl_dir / "definitions.txt").write_text(result["definitions"], encoding="utf-8")

    # Ensure email_body is in customize_files list for the generate flow
    proj = pm.get_project(user_id, project_id)
    customize_files = proj["config"].get("customize_files", [])
    if not any(cf["id"] == "email_body" for cf in customize_files):
        if len(customize_files) >= MAX_CUSTOMIZE_FILES:
            raise HTTPException(400, "Customize files limit reached (max 4)")
        customize_files.append({"id": "email_body", "label": "Email Body", "is_attachment": False})
        pm.update_project_config(user_id, project_id, {"customize_files": customize_files})

    result["token_usage"] = usage
    return result


@router.get("/projects/{project_id}/templates")
def get_templates(project_id: str, user_id: str = Depends(get_current_user)):
    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404)
    return proj["templates"]


@router.post("/projects/{project_id}/templates/{type_id}/save")
def save_template(project_id: str, type_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Save template and definitions content for a given type."""
    type_dir = pm.get_project_dir(user_id, project_id) / "templates" / type_id
    type_dir.mkdir(parents=True, exist_ok=True)
    template_content = data.get("template_content", "")
    definitions_content = data.get("definitions_content", "")
    (type_dir / "template.txt").write_text(template_content, encoding="utf-8")
    (type_dir / "definitions.txt").write_text(definitions_content, encoding="utf-8")
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  project.md
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/project-md")
def get_project_md(project_id: str, user_id: str = Depends(get_current_user)):
    return {"content": pm.load_project_md(user_id, project_id)}


@router.post("/projects/{project_id}/generate-project-md")
def generate_project_md(project_id: str, user_id: str = Depends(get_current_user)):
    """Generate project.md from job requirements."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    proj_config = pm.get_project(user_id, project_id)["config"]
    job_req = proj_config.get("job_requirements", "")
    if not job_req:
        raise HTTPException(400, "No job requirements specified")

    user_profile = {
        "name": proj_config.get("name", ""),
        "phone": proj_config.get("phone", ""),
    }

    md_content, usage = ai.generate_project_md(api_key, job_req, user_profile)
    pm.save_project_md(user_id, project_id, md_content)
    pm.append_token_usage(user_id, project_id, "generate_project_md", usage)
    return {"content": md_content, "token_usage": usage}


# ═══════════════════════════════════════════════════════════════
#  Smart Subject Line Generation
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/generate-subject")
def generate_subject(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Search a firm's career page for required email subject format and generate the correct subject line."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    firm = data.get("firm", "")
    position = data.get("position", "")
    website = data.get("website", "")
    if not firm:
        raise HTTPException(400, "Firm name is required")

    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    applicant_name = proj["config"].get("name", "Applicant")

    try:
        subject, usage = ai.generate_email_subject(api_key, firm, position, website, applicant_name)
        pm.append_token_usage(user_id, project_id, "generate_subject", usage)
        # Clean up the subject line
        subject = subject.strip().strip('"').strip("'").strip()
        return {"subject": subject, "token_usage": usage}
    except Exception as e:
        raise HTTPException(500, f"Subject generation failed: {str(e)[:200]}")


# ═══════════════════════════════════════════════════════════════
#  Phase 1: SEARCH (returns candidates for user review)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/search")
def search_positions(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Search for positions. Returns candidates for user to review before generation."""
    count = min(int(data.get("count", 5)), 10)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    job_req = proj_config.get("job_requirements", "")
    if not job_req:
        raise HTTPException(400, "No job requirements specified")

    project_dir = pm.get_project_dir(user_id, project_id)
    tpl_dir = project_dir / "templates"

    # Collect definitions from all file types
    customize_files = proj_config.get("customize_files", [])
    all_definitions = []
    for cf in customize_files:
        defs_path = tpl_dir / cf["id"] / "definitions.txt"
        if defs_path.exists():
            defs_text = defs_path.read_text(encoding="utf-8")
            if defs_text:
                all_definitions.append(f"[{cf['label']}]\n{defs_text}")
    combined_definitions = "\n\n".join(all_definitions)

    project_md = pm.load_project_md(user_id, project_id)

    # Get existing firms to avoid duplicates
    existing_targets = pm.load_targets(user_id, project_id)
    existing_firms = [t["firm"] for t in existing_targets]
    tracker_rows = pm.load_tracker(user_id, project_id)
    generated_firms = [r["Firm"] for r in tracker_rows if r.get("Status") == "Generated"]

    # Pre-flight: check user has enough credits
    min_cost = billing.search_cost(count)
    balance = db.get_user_credits(user_id)
    if balance < min_cost:
        raise HTTPException(402, f"Insufficient credits: need {min_cost:.1f}, have {balance:.1f}")

    try:
        search_result, usage = ai.search_and_generate_targets(
            api_key, project_md, combined_definitions, job_req, count,
            existing_firms + generated_firms,
        )
    except Exception as e:
        err_msg = str(e)
        if "rate_limit" in err_msg.lower() or "429" in err_msg:
            raise HTTPException(429, "API rate limit reached. Please wait 1-2 minutes and try again.")
        raise HTTPException(500, f"Search failed: {err_msg[:200]}")

    pm.append_token_usage(user_id, project_id, "search", usage)

    targets = search_result.get("targets", []) or []
    success_count = len(targets)
    base_credits = success_count * billing.SEARCH_CREDITS_PER_TARGET
    limit_tokens = billing.search_token_limit(count)
    overage = billing.overage_credits_for_tokens(
        float(usage.get("input_tokens", 0) or 0),
        float(usage.get("output_tokens", 0) or 0),
        limit_tokens,
    )
    total_credits = base_credits + overage
    balance = _charge_credits(
        user_id,
        total_credits,
        description=f"Search: {success_count} targets (base={base_credits:.3f}, overage={overage:.3f})",
    )

    search_result["token_usage"] = usage
    search_result["credit_usage"] = {
        "base": base_credits,
        "overage": overage,
        "total": total_credits,
        "limit_tokens": limit_tokens,
        "balance": balance,
    }
    return search_result


# ═══════════════════════════════════════════════════════════════
#  Phase 2: GENERATE (user-confirmed targets → PDF + Gmail)
# ═══════════════════════════════════════════════════════════════

def _build_filename(fmt: str, replacements: dict) -> str:
    """Build a filename from a format template, e.g. '{{NAME}}-{{FIRM_NAME}}-Cover Letter'."""
    result = fmt
    for k, v in replacements.items():
        result = result.replace("{{" + k + "}}", v or "")
    return pdf.safe_filename(result)


@router.post("/projects/{project_id}/generate")
def generate_from_targets(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Generate PDFs + Gmail drafts from user-confirmed target list."""
    confirmed_targets = data.get("targets", [])
    if not confirmed_targets:
        raise HTTPException(400, "No targets provided")

    gcfg = _get_user_config(user_id)

    manual_count = sum(
        1 for t in confirmed_targets
        if t.get("_manual") or (t.get("source", "") or "").lower() == "manual"
    )
    # Pre-check credits for base costs (manual search + delivery)
    est_base = (manual_count * billing.SEARCH_CREDITS_PER_TARGET) + (
        len(confirmed_targets) * billing.DELIVERY_CREDITS_PER_TARGET
    )
    if db.get_user_credits(user_id) < est_base:
        raise HTTPException(402, "Not enough credits for this batch")

    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    project_dir = pm.get_project_dir(user_id, project_id)
    tpl_dir = project_dir / "templates"

    # Load customize file templates
    customize_files = proj_config.get("customize_files", [])
    file_templates = {}
    for cf in customize_files:
        cf_id = cf["id"]
        type_dir = tpl_dir / cf_id
        tpl_path = type_dir / "template.txt"
        tpl_text = tpl_path.read_text(encoding="utf-8") if tpl_path.exists() else ""
        file_templates[cf_id] = {
            "template": tpl_text,
            "label": cf["label"],
            "filename_format": cf.get("filename_format", "{{NAME}}-{{FIRM_NAME}}-" + cf["label"]),
            "is_attachment": cf.get("is_attachment", True),
        }

    results = []
    user_name = proj_config.get("name", "Applicant")
    user_phone = proj_config.get("phone", "")
    user_email = gcfg.get("email", "") or gcfg.get("outlook_email", "")

    output_dir = project_dir / "Email" / "CoverLetters"
    output_dir.mkdir(parents=True, exist_ok=True)

    materials = [
        pm.get_project_dir(user_id, project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]

    existing_targets = pm.load_targets(user_id, project_id)
    tracker_rows = pm.load_tracker(user_id, project_id)

    total_usage = {"input_tokens": 0, "output_tokens": 0, "api_calls": 0}

    for target in confirmed_targets:
        firm = target.get("firm", "Unknown")
        status = {"firm": firm, "pdfs": [], "draft": False, "error": None}

        base_replacements = {
            "NAME": user_name,
            "PHONE": user_phone,
            "EMAIL": user_email,
            "FIRM_NAME": firm,
            "POSITION": target.get("position", ""),
        }
        for key in target:
            if key.startswith("custom_"):
                base_replacements[key.upper()] = target[key]

        generated_pdfs = []
        email_body = None

        for cf in customize_files:
            cf_id = cf["id"]
            ft = file_templates.get(cf_id, {})
            tpl_text = ft.get("template", "")
            if not tpl_text:
                continue

            filled = tpl_text
            for k, v in base_replacements.items():
                filled = filled.replace("{{" + k + "}}", v or "")

            if cf_id == "email_body":
                _enforce_text_limit(filled, MAX_EMAIL_UNITS, "Email body")
                email_body = filled
                continue

            _enforce_text_limit(filled, MAX_CUSTOM_BODY_UNITS, f"{ft.get('label', cf_id)} body")
            if not ft.get("is_attachment", True):
                continue

            # Generate PDF
            if "<html" not in filled.lower():
                filled_html = _wrap_in_html(_text_to_html(filled))
            else:
                filled_html = filled

            fn_fmt = ft.get("filename_format", "{{NAME}}-{{FIRM_NAME}}-" + ft["label"])
            out_filename = _build_filename(fn_fmt, base_replacements)
            pdf_path = str(output_dir / f"{out_filename}.pdf")
            if pdf.generate_pdf(filled_html, pdf_path):
                generated_pdfs.append({"type": ft["label"], "path": pdf_path, "filename": f"{out_filename}.pdf"})

        status["pdfs"] = [p["type"] for p in generated_pdfs]
        status["pdf"] = len(generated_pdfs) > 0

        if email_body is None:
            email_body = f"""Dear Hiring Manager,

I am writing to apply for the {target.get('position', 'open')} position at {firm}.

I would welcome the opportunity to bring my skills to your team.

Thank you for your time and consideration.

Best regards,
{user_name}
{user_phone}
{user_email}"""
        _enforce_text_limit(email_body, MAX_EMAIL_UNITS, "Email body")

        if gcfg.get("email_provider", "gmail") != "none":
            attachments = []
            for mat_file in materials:
                if mat_file.exists():
                    attachments.append({"filename": mat_file.name, "path": str(mat_file)})
            for gp in generated_pdfs:
                if Path(gp["path"]).exists():
                    attachments.append({"filename": gp["filename"], "path": gp["path"]})

            draft_ok, draft_err, updated_gcfg = _create_draft(
                gcfg, target, email_body, user_name, attachments
            )
            status["draft"] = draft_ok
            if draft_err:
                status["draft_error"] = draft_err
            if updated_gcfg:
                gcfg = updated_gcfg
                _save_user_config(user_id, gcfg)

        tracker_rows.append({
            "Firm": firm,
            "Location": target.get("location", ""),
            "Position": target.get("position", ""),
            "OpenDate": target.get("openDate", ""),
            "AppliedDate": date.today().isoformat(),
            "Email": target.get("email", ""),
            "Source": target.get("source", ""),
            "Status": "Generated",
        })

        results.append(status)

    existing_targets.extend(confirmed_targets)
    pm.save_targets(user_id, project_id, existing_targets)
    pm.save_tracker(user_id, project_id, tracker_rows)

    if total_usage["api_calls"] > 0:
        pm.append_token_usage(user_id, project_id, "generate", total_usage)

    delivery_success = sum(1 for r in results if r.get("draft"))
    base_credits = (manual_count * billing.SEARCH_CREDITS_PER_TARGET) + (
        delivery_success * billing.DELIVERY_CREDITS_PER_TARGET
    )
    limit_tokens = billing.generate_token_limit(delivery_success)
    overage = billing.overage_credits_for_tokens(
        float(total_usage.get("input_tokens", 0) or 0),
        float(total_usage.get("output_tokens", 0) or 0),
        limit_tokens,
    )
    total_credits = base_credits + overage
    balance = _charge_credits(
        user_id,
        total_credits,
        description=(
            f"Generate: manual={manual_count}, delivered={delivery_success} "
            f"(base={base_credits:.3f}, overage={overage:.3f})"
        ),
    )

    return {
        "generated": results,
        "token_usage": total_usage,
        "credit_usage": {
            "base": base_credits,
            "overage": overage,
            "total": total_credits,
            "limit_tokens": limit_tokens,
            "balance": balance,
        },
    }


# ═══════════════════════════════════════════════════════════════
#  Phase 2b: GENERATE with SSE (real-time progress)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/generate-stream")
def generate_stream(project_id: str, data: dict, user_id: str = Depends(get_current_user)):
    """Generate PDFs + Gmail drafts with Server-Sent Events for progress."""
    confirmed_targets = data.get("targets", [])
    if not confirmed_targets:
        raise HTTPException(400, "No targets provided")

    # Deduct credits immediately on generation start
    cost = billing.generate_cost(len(confirmed_targets))
    ok, balance = db.use_credits(user_id, cost, f"Generate {len(confirmed_targets)} targets")
    if not ok:
        raise HTTPException(402, f"Insufficient credits: need {cost:.1f}, have {balance:.1f}")

    smart_subject = data.get("smart_subject", False)
    subject_template = data.get("subject_template", "")

    gcfg = _get_user_config(user_id)

    manual_count = sum(
        1 for t in confirmed_targets
        if t.get("_manual") or (t.get("source", "") or "").lower() == "manual"
    )
    est_base = (manual_count * billing.SEARCH_CREDITS_PER_TARGET) + (
        len(confirmed_targets) * billing.DELIVERY_CREDITS_PER_TARGET
    )
    if db.get_user_credits(user_id) < est_base:
        raise HTTPException(402, "Not enough credits for this batch")

    proj = pm.get_project(user_id, project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    project_dir = pm.get_project_dir(user_id, project_id)
    tpl_dir = project_dir / "templates"

    customize_files = proj_config.get("customize_files", [])
    file_templates = {}
    for cf in customize_files:
        cf_id = cf["id"]
        type_dir = tpl_dir / cf_id
        tpl_path = type_dir / "template.txt"
        tpl_text = tpl_path.read_text(encoding="utf-8") if tpl_path.exists() else ""
        file_templates[cf_id] = {
            "template": tpl_text,
            "label": cf["label"],
            "filename_format": cf.get("filename_format", "{{NAME}}-{{FIRM_NAME}}-" + cf["label"]),
            "is_attachment": cf.get("is_attachment", True),
        }

    user_name = proj_config.get("name", "Applicant")
    user_phone = proj_config.get("phone", "")
    user_email = gcfg.get("email", "") or gcfg.get("outlook_email", "")
    output_dir = project_dir / "Email" / "CoverLetters"
    output_dir.mkdir(parents=True, exist_ok=True)
    materials = [
        pm.get_project_dir(user_id, project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]
    existing_targets = pm.load_targets(user_id, project_id)
    tracker_rows = pm.load_tracker(user_id, project_id)

    def event_stream():
        nonlocal gcfg
        total = len(confirmed_targets)
        results = []
        total_usage = {"input_tokens": 0, "output_tokens": 0, "api_calls": 0}

        for i, target in enumerate(confirmed_targets):
            firm = target.get("firm", "Unknown")
            pct = int((i / total) * 100)
            status_obj = {"firm": firm, "pdfs": [], "draft": False, "error": None}

            # Step 1: Filling templates
            yield f"data: {json.dumps({'type': 'progress', 'pct': pct, 'status': f'Processing {firm} ({i+1}/{total})', 'detail': 'Filling templates...', 'step': f'Filling templates for {firm}'})}\n\n"

            base_replacements = {
                "NAME": user_name, "PHONE": user_phone, "EMAIL": user_email,
                "FIRM_NAME": firm, "POSITION": target.get("position", ""),
            }
            for key in target:
                if key.startswith("custom_"):
                    base_replacements[key.upper()] = target[key]

            generated_pdfs = []
            email_body = None

            for cf in customize_files:
                cf_id = cf["id"]
                ft = file_templates.get(cf_id, {})
                tpl_text = ft.get("template", "")
                if not tpl_text:
                    continue
                filled = tpl_text
                for k, v in base_replacements.items():
                    filled = filled.replace("{{" + k + "}}", v or "")
                if cf_id == "email_body":
                    try:
                        _enforce_text_limit(filled, MAX_EMAIL_UNITS, "Email body")
                    except HTTPException as e:
                        yield f"data: {json.dumps({'type': 'error', 'error': str(e.detail)})}\n\n"
                        return
                    email_body = filled
                    continue
                try:
                    _enforce_text_limit(filled, MAX_CUSTOM_BODY_UNITS, f"{ft.get('label', cf_id)} body")
                except HTTPException as e:
                    yield f"data: {json.dumps({'type': 'error', 'error': str(e.detail)})}\n\n"
                    return
                if not ft.get("is_attachment", True):
                    continue

                # Step 2: Generating PDF
                ft_label = ft["label"]
                yield f"data: {json.dumps({'type': 'progress', 'pct': pct + int(0.3/total*100), 'detail': f'Generating {ft_label} PDF...'})}\n\n"

                if "<html" not in filled.lower():
                    filled_html = _wrap_in_html(_text_to_html(filled))
                else:
                    filled_html = filled

                fn_fmt = ft.get("filename_format", "{{NAME}}-{{FIRM_NAME}}-" + ft["label"])
                out_filename = _build_filename(fn_fmt, base_replacements)
                pdf_path = str(output_dir / f"{out_filename}.pdf")
                if pdf.generate_pdf(filled_html, pdf_path):
                    generated_pdfs.append({"type": ft["label"], "path": pdf_path, "filename": f"{out_filename}.pdf"})

            status_obj["pdfs"] = [p["type"] for p in generated_pdfs]
            status_obj["pdf"] = len(generated_pdfs) > 0

            if email_body is None:
                email_body = f"""Dear Hiring Manager,

I am writing to apply for the {target.get('position', 'open')} position at {firm}.

I would welcome the opportunity to bring my skills to your team.

Thank you for your time and consideration.

Best regards,
{user_name}
{user_phone}
{user_email}"""
            try:
                _enforce_text_limit(email_body, MAX_EMAIL_UNITS, "Email body")
            except HTTPException as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e.detail)})}\n\n"
                return

            # Resolve email subject
            # Priority: manual subject on target > smart subject > template > default
            target_subject = target.get("subject", "").strip()
            if not target_subject and smart_subject:
                # Smart subject: search firm's career page for required format
                api_key = os.environ.get("ANTHROPIC_API_KEY", "")
                if api_key:
                    yield f"data: {json.dumps({'type': 'progress', 'pct': pct + int(0.5/total*100), 'detail': f'Searching subject format for {firm}...'})}\n\n"
                    try:
                        subj_result, subj_usage = ai.generate_email_subject(
                            api_key, firm, target.get("position", ""),
                            target.get("website", ""), user_name
                        )
                        subj_result = subj_result.strip().strip('"').strip("'").strip()
                        if subj_result:
                            target["subject"] = subj_result
                            target_subject = subj_result
                        total_usage["input_tokens"] += subj_usage.get("input_tokens", 0)
                        total_usage["output_tokens"] += subj_usage.get("output_tokens", 0)
                        total_usage["api_calls"] += subj_usage.get("api_calls", 0)
                    except Exception as e:
                        yield f"data: {json.dumps({'type': 'progress', 'detail': f'Smart subject failed for {firm}: {str(e)[:80]}'})}\n\n"

            if not target_subject and subject_template:
                # Fill subject template with placeholders
                target_subject = subject_template
                for k, v in base_replacements.items():
                    target_subject = target_subject.replace("{{" + k + "}}", v or "")

            if not target_subject:
                target_subject = f"Application for {target.get('position', 'Architect')} - {user_name}"

            target["subject"] = target_subject

            # Step 3: Creating email draft
            email_provider = gcfg.get("email_provider", "gmail")
            if email_provider != "none":
                provider_label = "Outlook" if email_provider == "outlook" else "Gmail"
                yield f"data: {json.dumps({'type': 'progress', 'pct': pct + int(0.6/total*100), 'detail': f'Creating {provider_label} draft for {firm}...'})}\n\n"

                attachments = []
                for mat_file in materials:
                    if mat_file.exists():
                        attachments.append({"filename": mat_file.name, "path": str(mat_file)})
                for gp in generated_pdfs:
                    if Path(gp["path"]).exists():
                        attachments.append({"filename": gp["filename"], "path": gp["path"]})

                draft_ok, draft_err, updated_gcfg = _create_draft(
                    gcfg, target, email_body, user_name, attachments
                )
                status_obj["draft"] = draft_ok
                if draft_err:
                    status_obj["draft_error"] = draft_err
                if updated_gcfg:
                    gcfg = updated_gcfg
                    _save_user_config(user_id, gcfg)

            # Add to tracker
            tracker_rows.append({
                "Firm": firm,
                "Location": target.get("location", ""),
                "Position": target.get("position", ""),
                "OpenDate": target.get("openDate", ""),
                "AppliedDate": date.today().isoformat(),
                "Email": target.get("email", ""),
                "Source": target.get("source", ""),
                "Status": "Generated",
            })

            results.append(status_obj)

            # Notify this target is done
            done_evt = {'type': 'target_done', 'index': i, 'firm': firm, 'pdf': status_obj['pdf'], 'draft': status_obj['draft']}
            if status_obj.get("draft_error"):
                done_evt['draft_error'] = status_obj['draft_error']
            yield f"data: {json.dumps(done_evt)}\n\n"

        # Save everything
        save_error = None
        try:
            existing_targets.extend(confirmed_targets)
            pm.save_targets(user_id, project_id, existing_targets)
            pm.save_tracker(user_id, project_id, tracker_rows)
        except PermissionError:
            save_error = "tracker.csv is locked (close Excel first). Drafts were created but tracker was not updated."
        except Exception as e:
            save_error = f"Save error: {str(e)[:100]}"

        if total_usage["api_calls"] > 0:
            try:
                pm.append_token_usage(user_id, project_id, "generate", total_usage)
            except Exception:
                pass

        delivery_success = sum(1 for r in results if r.get("draft"))
        base_credits = (manual_count * billing.SEARCH_CREDITS_PER_TARGET) + (
            delivery_success * billing.DELIVERY_CREDITS_PER_TARGET
        )
        limit_tokens = billing.generate_token_limit(delivery_success)
        overage = billing.overage_credits_for_tokens(
            float(total_usage.get("input_tokens", 0) or 0),
            float(total_usage.get("output_tokens", 0) or 0),
            limit_tokens,
        )
        total_credits = base_credits + overage
        credit_usage = {
            "base": base_credits,
            "overage": overage,
            "total": total_credits,
            "limit_tokens": limit_tokens,
        }
        try:
            balance = _charge_credits(
                user_id,
                total_credits,
                description=(
                    f"Generate: manual={manual_count}, delivered={delivery_success} "
                    f"(base={base_credits:.3f}, overage={overage:.3f})"
                ),
            )
            credit_usage["balance"] = balance
        except HTTPException as e:
            credit_usage["error"] = str(e.detail)

        # Final completion event
        completion = {'type': 'complete', 'generated': results, 'token_usage': total_usage, 'credit_usage': credit_usage}
        if save_error:
            completion['save_error'] = save_error
        yield f"data: {json.dumps(completion)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ═══════════════════════════════════════════════════════════════
#  Token Usage
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/token-usage")
def get_token_usage(project_id: str, user_id: str = Depends(get_current_user)):
    """Get token usage log and totals for a project."""
    return pm.load_token_usage(user_id, project_id)


# ═══════════════════════════════════════════════════════════════
#  Open output folder
# ═══════════════════════════════════════════════════════════════



# ═══════════════════════════════════════════════════════════════
#  Tracker
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/tracker")
def get_tracker(project_id: str, user_id: str = Depends(get_current_user)):
    return pm.load_tracker(user_id, project_id)


