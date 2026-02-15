"""
FastAPI routes: all backend endpoints.
"""
import os
import json
import shutil
import subprocess
from datetime import date
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from . import project_manager as pm
from . import ai_service as ai
from . import pdf_service as pdf
from . import email_service as email_svc

router = APIRouter(prefix="/api")


# ═══════════════════════════════════════════════════════════════
#  Global Config
# ═══════════════════════════════════════════════════════════════

@router.get("/global-config")
def get_global_config():
    cfg = pm.load_global_config()
    # Mask sensitive fields for display
    masked = {**cfg}
    if masked.get("api_key"):
        k = masked["api_key"]
        masked["api_key_display"] = k[:12] + "..." + k[-4:] if len(k) > 20 else "***"
    if masked.get("gmail_app_password"):
        masked["gmail_app_password_display"] = "****"
    return masked


@router.post("/global-config")
def save_global_config(data: dict):
    pm.save_global_config(data)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  Projects CRUD
# ═══════════════════════════════════════════════════════════════

@router.get("/projects")
def list_projects():
    return pm.list_projects()


@router.post("/projects")
def create_project(data: dict):
    name = data.get("name", "New Project")
    return pm.create_project(name)


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")
    return proj


@router.put("/projects/{project_id}/config")
def update_project_config(project_id: str, data: dict):
    return pm.update_project_config(project_id, data)


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    if pm.delete_project(project_id):
        return {"ok": True}
    raise HTTPException(404, "Project not found")


# ═══════════════════════════════════════════════════════════════
#  File Uploads (Materials)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/upload-material")
async def upload_material(project_id: str, file: UploadFile = File(...)):
    mat_dir = pm.get_project_dir(project_id) / "Material"
    mat_dir.mkdir(parents=True, exist_ok=True)
    dest = mat_dir / file.filename
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"filename": file.filename, "size": len(content)}


@router.delete("/projects/{project_id}/material/{filename}")
def delete_material(project_id: str, filename: str):
    path = pm.get_project_dir(project_id) / "Material" / filename
    if path.exists():
        path.unlink()
        return {"ok": True}
    raise HTTPException(404, "File not found")


# ═══════════════════════════════════════════════════════════════
#  Customize Files Management
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/customize-files")
def add_customize_file(project_id: str, data: dict):
    """Add a new customize file type."""
    label = data.get("label", "")
    if not label:
        raise HTTPException(400, "Label is required")
    entry = pm.add_customize_file(project_id, label)
    return entry


@router.delete("/projects/{project_id}/customize-files/{type_id}")
def remove_customize_file(project_id: str, type_id: str):
    pm.remove_customize_file(project_id, type_id)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
#  Template Editor (per file type)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/customize/{type_id}/upload-example")
async def upload_example(project_id: str, type_id: str, file: UploadFile = File(...)):
    """Upload an example file for a given customize file type."""
    examples_dir = pm.get_project_dir(project_id) / "templates" / type_id / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    dest = examples_dir / file.filename
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"filename": file.filename, "size": len(content)}


@router.get("/projects/{project_id}/customize/{type_id}/examples")
def list_examples(project_id: str, type_id: str):
    return pm.list_type_examples(project_id, type_id)


@router.delete("/projects/{project_id}/customize/{type_id}/examples/{filename}")
def delete_example(project_id: str, type_id: str, filename: str):
    path = pm.get_project_dir(project_id) / "templates" / type_id / "examples" / filename
    if path.exists():
        path.unlink()
        return {"ok": True}
    raise HTTPException(404)


@router.post("/projects/{project_id}/customize/{type_id}/generate-template")
def generate_template(project_id: str, type_id: str):
    """AI reads uploaded examples and generates template + definitions for this file type."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    examples_dir = pm.get_project_dir(project_id) / "templates" / type_id / "examples"
    if not examples_dir.exists():
        raise HTTPException(400, "No examples uploaded")

    # Get the label for this type
    proj = pm.get_project(project_id)
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
                import pymupdf
                doc = pymupdf.open(str(f))
                text = "\n".join(page.get_text() for page in doc)
                doc.close()
                if text.strip():
                    example_texts.append(text)
                else:
                    example_texts.append(f"[PDF {f.name} contains no extractable text - scanned image?]")
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
    pm.append_token_usage(project_id, f"generate_template:{type_id}", usage)

    # Save generated files in type-specific directory
    type_dir = pm.get_project_dir(project_id) / "templates" / type_id
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / "template.txt").write_text(result["template"], encoding="utf-8")
    (type_dir / "definitions.txt").write_text(result["definitions"], encoding="utf-8")

    result["token_usage"] = usage
    return result


@router.post("/projects/{project_id}/customize/{type_id}/preview")
def preview_template(project_id: str, type_id: str):
    """Preview: fill template with sample content locally (no API call), then generate PDF."""
    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    gcfg = pm.load_global_config()
    proj_config = proj["config"]

    type_dir = pm.get_project_dir(project_id) / "templates" / type_id
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
    filled = filled.replace("{{NAME}}", proj_config.get("name", gcfg.get("name", "Jane Doe")))
    filled = filled.replace("{{PHONE}}", proj_config.get("phone", gcfg.get("phone", "555-123-4567")))
    filled = filled.replace("{{EMAIL}}", gcfg.get("email", "jane.doe@email.com"))
    filled = filled.replace("{{FIRM_NAME}}", "Example Studio")
    filled = filled.replace("{{POSITION}}", "Designer")

    # Fill CUSTOM_X with examples from definitions, or placeholder text
    for key, example in custom_examples.items():
        filled = filled.replace("{{" + key + "}}", example)
    # Fill any remaining CUSTOM_X placeholders
    filled = re.sub(r'\{\{CUSTOM_\d+\}\}', '[Sample content]', filled)

    # Wrap in basic HTML for PDF
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page {{ margin: 60px 65px; size: letter; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; }}
p {{ margin: 0 0 13px 0; text-align: justify; }}
</style></head><body>
{filled.replace(chr(10), '<br>')}
</body></html>"""

    preview_dir = pm.get_project_dir(project_id) / "Email" / "CoverLetters"
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = str(preview_dir / f"PREVIEW_{type_id}.pdf")

    ok = pdf.generate_pdf(html, preview_path)
    if not ok:
        raise HTTPException(500, "PDF generation failed. Is Microsoft Edge installed?")

    return {"pdf_path": preview_path, "filled_text": filled}


# ═══════════════════════════════════════════════════════════════
#  Email Template
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/email-template")
def get_email_template(project_id: str):
    """Get current email template and definitions."""
    tpl_dir = pm.get_project_dir(project_id) / "templates" / "email_body"
    tpl_path = tpl_dir / "template.txt"
    defs_path = tpl_dir / "definitions.txt"
    example_path = tpl_dir / "example.txt"
    return {
        "template": tpl_path.read_text(encoding="utf-8") if tpl_path.exists() else "",
        "definitions": defs_path.read_text(encoding="utf-8") if defs_path.exists() else "",
        "example": example_path.read_text(encoding="utf-8") if example_path.exists() else "",
    }


@router.post("/projects/{project_id}/email-template/save-example")
def save_email_example(project_id: str, data: dict):
    """Save pasted email example text."""
    text = data.get("text", "").strip()
    if not text:
        raise HTTPException(400, "No email text provided")
    tpl_dir = pm.get_project_dir(project_id) / "templates" / "email_body"
    tpl_dir.mkdir(parents=True, exist_ok=True)
    (tpl_dir / "example.txt").write_text(text, encoding="utf-8")
    return {"ok": True}


@router.post("/projects/{project_id}/email-template/generate")
def generate_email_template(project_id: str):
    """Generate email template from saved example."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    tpl_dir = pm.get_project_dir(project_id) / "templates" / "email_body"
    example_path = tpl_dir / "example.txt"
    if not example_path.exists():
        raise HTTPException(400, "No email example saved. Paste an example first.")

    example = example_path.read_text(encoding="utf-8")
    result, usage = ai.generate_template_from_examples(api_key, [example], "Email")
    pm.append_token_usage(project_id, "generate_email_template", usage)

    tpl_dir.mkdir(parents=True, exist_ok=True)
    (tpl_dir / "template.txt").write_text(result["template"], encoding="utf-8")
    (tpl_dir / "definitions.txt").write_text(result["definitions"], encoding="utf-8")

    # Ensure email_body is in customize_files list for the generate flow
    proj = pm.get_project(project_id)
    customize_files = proj["config"].get("customize_files", [])
    if not any(cf["id"] == "email_body" for cf in customize_files):
        customize_files.append({"id": "email_body", "label": "Email Body", "is_attachment": False})
        pm.update_project_config(project_id, {"customize_files": customize_files})

    result["token_usage"] = usage
    return result


@router.get("/projects/{project_id}/templates")
def get_templates(project_id: str):
    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404)
    return proj["templates"]


@router.post("/projects/{project_id}/open-file")
def open_file(project_id: str, data: dict):
    """Open a file with the system default application."""
    filename = data.get("filename", "")
    type_id = data.get("type_id", "")

    # Per-type template/definitions files
    if type_id and filename in ["template.txt", "definitions.txt"]:
        full_path = pm.get_project_dir(project_id) / "templates" / type_id / filename
    elif filename == "tracker.csv":
        full_path = pm.get_project_dir(project_id) / "tracker.csv"
    elif filename == "project.md":
        full_path = pm.get_project_dir(project_id) / "project.md"
    elif filename.endswith(".pdf"):
        # Open a specific PDF by path
        full_path = Path(filename)
        if not full_path.exists():
            raise HTTPException(404, "PDF not found")
    # Backward compat for legacy flat files
    elif filename in ["cover_letter.txt", "email_body.txt", "custom_definitions.txt"]:
        full_path = pm.get_project_dir(project_id) / "templates" / filename
    else:
        raise HTTPException(400, "Unknown file")

    if not full_path.exists():
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text("", encoding="utf-8")

    os.startfile(str(full_path))
    return {"ok": True, "path": str(full_path)}


# ═══════════════════════════════════════════════════════════════
#  project.md
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/project-md")
def get_project_md(project_id: str):
    return {"content": pm.load_project_md(project_id)}


@router.post("/projects/{project_id}/generate-project-md")
def generate_project_md(project_id: str):
    """Generate project.md from job requirements."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    proj_config = pm.get_project(project_id)["config"]
    job_req = proj_config.get("job_requirements", "")
    if not job_req:
        raise HTTPException(400, "No job requirements specified")

    user_profile = {
        "name": proj_config.get("name", gcfg.get("name", "")),
        "phone": proj_config.get("phone", gcfg.get("phone", "")),
    }

    md_content, usage = ai.generate_project_md(api_key, job_req, user_profile)
    pm.save_project_md(project_id, md_content)
    pm.append_token_usage(project_id, "generate_project_md", usage)
    return {"content": md_content, "token_usage": usage}


# ═══════════════════════════════════════════════════════════════
#  Phase 1: SEARCH (returns candidates for user review)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/search")
def search_positions(project_id: str, data: dict):
    """Search for positions. Returns candidates for user to review before generation."""
    count = min(int(data.get("count", 5)), 10)

    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    job_req = proj_config.get("job_requirements", "")
    if not job_req:
        raise HTTPException(400, "No job requirements specified")

    project_dir = pm.get_project_dir(project_id)
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

    project_md = pm.load_project_md(project_id)

    # Get existing firms to avoid duplicates
    existing_targets = pm.load_targets(project_id)
    existing_firms = [t["firm"] for t in existing_targets]
    tracker_rows = pm.load_tracker(project_id)
    generated_firms = [r["Firm"] for r in tracker_rows if r.get("Status") == "Generated"]

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

    pm.append_token_usage(project_id, "search", usage)

    search_result["token_usage"] = usage
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
def generate_from_targets(project_id: str, data: dict):
    """Generate PDFs + Gmail drafts from user-confirmed target list."""
    confirmed_targets = data.get("targets", [])
    if not confirmed_targets:
        raise HTTPException(400, "No targets provided")

    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    gmail_user = gcfg.get("email", "")
    gmail_pass = gcfg.get("gmail_app_password", "")

    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    project_dir = pm.get_project_dir(project_id)
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
    user_name = proj_config.get("name", gcfg.get("name", "Applicant"))
    user_phone = proj_config.get("phone", "")
    user_email = gmail_user

    output_dir = project_dir / "Email" / "CoverLetters"
    output_dir.mkdir(parents=True, exist_ok=True)

    materials = [
        pm.get_project_dir(project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]

    existing_targets = pm.load_targets(project_id)
    tracker_rows = pm.load_tracker(project_id)

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
                email_body = filled
                continue

            if not ft.get("is_attachment", True):
                continue

            # Generate PDF
            if "<html" not in filled.lower():
                filled_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page {{ margin: 60px 65px; size: letter; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; }}
p {{ margin: 0 0 13px 0; text-align: justify; }}
.signature {{ margin-top: 24px; font-weight: 600; }}
</style></head><body>
{filled}
</body></html>"""
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

        if gmail_user and gmail_pass:
            attachments = []
            for mat_file in materials:
                if mat_file.exists():
                    attachments.append({"filename": mat_file.name, "path": str(mat_file)})
            for gp in generated_pdfs:
                if Path(gp["path"]).exists():
                    attachments.append({"filename": gp["filename"], "path": gp["path"]})

            status["draft"] = email_svc.create_gmail_draft(
                gmail_user=gmail_user,
                gmail_app_password=gmail_pass,
                to_email=target.get("email", ""),
                subject=target.get("subject", f"Application - {user_name}"),
                body_text=email_body,
                from_name=user_name,
                attachments=attachments,
            )

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
    pm.save_targets(project_id, existing_targets)
    pm.save_tracker(project_id, tracker_rows)

    if total_usage["api_calls"] > 0:
        pm.append_token_usage(project_id, "generate", total_usage)

    return {"generated": results, "token_usage": total_usage}


# ═══════════════════════════════════════════════════════════════
#  Phase 2b: GENERATE with SSE (real-time progress)
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/generate-stream")
def generate_stream(project_id: str, data: dict):
    """Generate PDFs + Gmail drafts with Server-Sent Events for progress."""
    confirmed_targets = data.get("targets", [])
    if not confirmed_targets:
        raise HTTPException(400, "No targets provided")

    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    gmail_user = gcfg.get("email", "")
    gmail_pass = gcfg.get("gmail_app_password", "")

    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404, "Project not found")

    proj_config = proj["config"]
    project_dir = pm.get_project_dir(project_id)
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

    user_name = proj_config.get("name", gcfg.get("name", "Applicant"))
    user_phone = proj_config.get("phone", "")
    user_email = gmail_user
    output_dir = project_dir / "Email" / "CoverLetters"
    output_dir.mkdir(parents=True, exist_ok=True)
    materials = [
        pm.get_project_dir(project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]
    existing_targets = pm.load_targets(project_id)
    tracker_rows = pm.load_tracker(project_id)

    def event_stream():
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
                    email_body = filled
                    continue
                if not ft.get("is_attachment", True):
                    continue

                # Step 2: Generating PDF
                ft_label = ft["label"]
                yield f"data: {json.dumps({'type': 'progress', 'pct': pct + int(0.3/total*100), 'detail': f'Generating {ft_label} PDF...'})}\n\n"

                if "<html" not in filled.lower():
                    filled_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page {{ margin: 60px 65px; size: letter; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; }}
p {{ margin: 0 0 13px 0; text-align: justify; }}
.signature {{ margin-top: 24px; font-weight: 600; }}
</style></head><body>
{filled}
</body></html>"""
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

            # Step 3: Creating Gmail draft
            if gmail_user and gmail_pass:
                yield f"data: {json.dumps({'type': 'progress', 'pct': pct + int(0.6/total*100), 'detail': f'Creating Gmail draft for {firm}...'})}\n\n"

                attachments = []
                for mat_file in materials:
                    if mat_file.exists():
                        attachments.append({"filename": mat_file.name, "path": str(mat_file)})
                for gp in generated_pdfs:
                    if Path(gp["path"]).exists():
                        attachments.append({"filename": gp["filename"], "path": gp["path"]})

                draft_ok, draft_err = email_svc.create_gmail_draft(
                    gmail_user=gmail_user,
                    gmail_app_password=gmail_pass,
                    to_email=target.get("email", ""),
                    subject=target.get("subject", f"Application - {user_name}"),
                    body_text=email_body,
                    from_name=user_name,
                    attachments=attachments,
                )
                status_obj["draft"] = draft_ok
                if draft_err:
                    status_obj["draft_error"] = draft_err

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
            pm.save_targets(project_id, existing_targets)
            pm.save_tracker(project_id, tracker_rows)
        except PermissionError:
            save_error = "tracker.csv is locked (close Excel first). Drafts were created but tracker was not updated."
        except Exception as e:
            save_error = f"Save error: {str(e)[:100]}"

        if total_usage["api_calls"] > 0:
            try:
                pm.append_token_usage(project_id, "generate", total_usage)
            except Exception:
                pass

        # Final completion event
        completion = {'type': 'complete', 'generated': results, 'token_usage': total_usage}
        if save_error:
            completion['save_error'] = save_error
        yield f"data: {json.dumps(completion)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ═══════════════════════════════════════════════════════════════
#  Token Usage
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/token-usage")
def get_token_usage(project_id: str):
    """Get token usage log and totals for a project."""
    return pm.load_token_usage(project_id)


# ═══════════════════════════════════════════════════════════════
#  Open output folder
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/open-output-folder")
def open_output_folder(project_id: str):
    folder = pm.get_project_dir(project_id) / "Email" / "CoverLetters"
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(["explorer", str(folder)])
    return {"ok": True, "path": str(folder)}


# ═══════════════════════════════════════════════════════════════
#  Tracker
# ═══════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/tracker")
def get_tracker(project_id: str):
    return pm.load_tracker(project_id)


@router.post("/projects/{project_id}/open-tracker")
def open_tracker(project_id: str):
    path = pm.get_tracker_path(project_id)
    if path.exists():
        os.startfile(str(path))
        return {"ok": True, "path": str(path)}
    raise HTTPException(404, "Tracker not found")
