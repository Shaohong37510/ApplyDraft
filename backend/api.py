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
from fastapi.responses import JSONResponse

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
#  Template Editor
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/upload-example")
async def upload_example(project_id: str, file: UploadFile = File(...)):
    """Upload an example cover letter for template generation."""
    examples_dir = pm.get_project_dir(project_id) / "templates" / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    dest = examples_dir / file.filename
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"filename": file.filename, "size": len(content)}


@router.get("/projects/{project_id}/examples")
def list_examples(project_id: str):
    examples_dir = pm.get_project_dir(project_id) / "templates" / "examples"
    if not examples_dir.exists():
        return []
    return [f.name for f in examples_dir.iterdir() if f.is_file()]


@router.delete("/projects/{project_id}/examples/{filename}")
def delete_example(project_id: str, filename: str):
    path = pm.get_project_dir(project_id) / "templates" / "examples" / filename
    if path.exists():
        path.unlink()
        return {"ok": True}
    raise HTTPException(404)


@router.post("/projects/{project_id}/generate-template")
def generate_template(project_id: str):
    """AI reads uploaded example cover letters and generates template + definitions."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    examples_dir = pm.get_project_dir(project_id) / "templates" / "examples"
    if not examples_dir.exists():
        raise HTTPException(400, "No examples uploaded")

    # Read example files (txt or pdf text extraction)
    example_texts = []
    for f in sorted(examples_dir.iterdir()):
        if f.suffix.lower() == ".txt":
            example_texts.append(f.read_text(encoding="utf-8"))
        elif f.suffix.lower() == ".pdf":
            # Simple text extraction: read raw and attempt decode
            try:
                import subprocess as sp
                # Use Edge to print PDF content isn't great; store as-is for now
                example_texts.append(f"[PDF content from {f.name} - please provide .txt files for best results]")
            except Exception:
                pass
        else:
            try:
                example_texts.append(f.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                pass

    if len(example_texts) < 1:
        raise HTTPException(400, "Need at least 1 example file (.txt recommended)")

    result = ai.generate_template_from_examples(api_key, example_texts)

    # Save generated files
    tpl_dir = pm.get_project_dir(project_id) / "templates"
    (tpl_dir / "cover_letter.txt").write_text(result["template"], encoding="utf-8")
    (tpl_dir / "custom_definitions.txt").write_text(result["definitions"], encoding="utf-8")

    return result


@router.post("/projects/{project_id}/generate-email-template")
def generate_email_template(project_id: str, data: dict):
    """Generate email template from an example."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    example = data.get("example", "")
    if not example:
        raise HTTPException(400, "No example provided")

    result = ai.generate_email_template(api_key, example)

    tpl_dir = pm.get_project_dir(project_id) / "templates"
    (tpl_dir / "email_body.txt").write_text(result["template"], encoding="utf-8")

    return result


@router.get("/projects/{project_id}/templates")
def get_templates(project_id: str):
    proj = pm.get_project(project_id)
    if not proj:
        raise HTTPException(404)
    return proj["templates"]


@router.put("/projects/{project_id}/templates/{filename}")
def update_template(project_id: str, filename: str, data: dict):
    """Save edited template content."""
    tpl_dir = pm.get_project_dir(project_id) / "templates"
    allowed = ["cover_letter.txt", "email_body.txt", "custom_definitions.txt"]
    if filename not in allowed:
        raise HTTPException(400, f"Invalid template file: {filename}")
    (tpl_dir / filename).write_text(data.get("content", ""), encoding="utf-8")
    return {"ok": True}


@router.post("/projects/{project_id}/preview-template")
def preview_template(project_id: str):
    """Preview: AI fills template with sample content, generates a PDF."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    tpl_dir = pm.get_project_dir(project_id) / "templates"
    template_path = tpl_dir / "cover_letter.txt"
    definitions_path = tpl_dir / "custom_definitions.txt"

    if not template_path.exists():
        raise HTTPException(400, "No cover letter template found")

    template = template_path.read_text(encoding="utf-8")
    definitions = definitions_path.read_text(encoding="utf-8") if definitions_path.exists() else ""

    filled = ai.preview_template(api_key, template, definitions)

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
    preview_path = str(preview_dir / "PREVIEW_CoverLetter.pdf")

    ok = pdf.generate_pdf(html, preview_path)
    if not ok:
        raise HTTPException(500, "PDF generation failed. Is Microsoft Edge installed?")

    return {"pdf_path": preview_path, "filled_text": filled}


@router.post("/projects/{project_id}/open-file")
def open_file(project_id: str, data: dict):
    """Open a file with the system default application."""
    filename = data.get("filename", "")
    # Determine full path
    if filename in ["cover_letter.txt", "email_body.txt", "custom_definitions.txt"]:
        full_path = pm.get_project_dir(project_id) / "templates" / filename
    elif filename == "tracker.csv":
        full_path = pm.get_project_dir(project_id) / "tracker.csv"
    elif filename == "project.md":
        full_path = pm.get_project_dir(project_id) / "project.md"
    else:
        raise HTTPException(400, "Unknown file")

    if not full_path.exists():
        # Create empty file if it doesn't exist
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

    md_content = ai.generate_project_md(api_key, job_req, user_profile)
    pm.save_project_md(project_id, md_content)
    return {"content": md_content}


# ═══════════════════════════════════════════════════════════════
#  RUN: Search + Generate + Email
# ═══════════════════════════════════════════════════════════════

@router.post("/projects/{project_id}/run")
def run_pipeline(project_id: str, data: dict):
    """Main pipeline: search firms -> generate content -> PDF -> Gmail draft."""
    count = min(int(data.get("count", 5)), 10)

    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    gmail_user = gcfg.get("email", "")
    gmail_pass = gcfg.get("gmail_app_password", "")

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

    # Load templates
    cover_tpl = ""
    cover_tpl_path = tpl_dir / "cover_letter.txt"
    if cover_tpl_path.exists():
        cover_tpl = cover_tpl_path.read_text(encoding="utf-8")

    email_tpl = ""
    email_tpl_path = tpl_dir / "email_body.txt"
    if email_tpl_path.exists():
        email_tpl = email_tpl_path.read_text(encoding="utf-8")

    custom_defs = ""
    custom_defs_path = tpl_dir / "custom_definitions.txt"
    if custom_defs_path.exists():
        custom_defs = custom_defs_path.read_text(encoding="utf-8")

    project_md = pm.load_project_md(project_id)

    # Get existing firms to avoid duplicates
    existing_targets = pm.load_targets(project_id)
    existing_firms = [t["firm"] for t in existing_targets]

    tracker_rows = pm.load_tracker(project_id)
    generated_firms = [r["Firm"] for r in tracker_rows if r.get("Status") == "Generated"]

    # Step 1: AI search and generate targets
    search_result = ai.search_and_generate_targets(
        api_key, project_md, custom_defs, job_req, count,
        existing_firms + generated_firms,
    )

    new_targets = search_result.get("targets", [])
    skipped = search_result.get("skipped", [])

    if not new_targets:
        return {
            "generated": [],
            "skipped": skipped,
            "error": search_result.get("error", "No targets found"),
        }

    # Step 2: For each target -> fill templates -> PDF -> Gmail draft
    results = []
    user_name = proj_config.get("name", gcfg.get("name", "Applicant"))
    user_phone = proj_config.get("phone", "")
    user_email = gmail_user

    cl_dir = project_dir / "Email" / "CoverLetters"
    cl_dir.mkdir(parents=True, exist_ok=True)

    materials = [
        pm.get_project_dir(project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]

    for target in new_targets:
        firm = target.get("firm", "Unknown")
        firm_safe = pdf.safe_filename(firm)
        status = {"firm": firm, "pdf": False, "draft": False, "error": None}

        # Fill cover letter template
        if cover_tpl:
            replacements = {
                "NAME": user_name,
                "PHONE": user_phone,
                "EMAIL": user_email,
                "FIRM_NAME": firm,
                "POSITION": target.get("position", ""),
            }
            # Add custom_pX placeholders
            for key in target:
                if key.startswith("custom_"):
                    placeholder = key.upper()
                    replacements[placeholder] = target[key]

            filled_html = cover_tpl
            for k, v in replacements.items():
                filled_html = filled_html.replace("{{" + k + "}}", v or "")

            # Wrap in HTML if not already
            if "<html" not in filled_html.lower():
                filled_html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
@page {{ margin: 60px 65px; size: letter; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.65; color: #222; }}
p {{ margin: 0 0 13px 0; text-align: justify; }}
.signature {{ margin-top: 24px; font-weight: 600; }}
</style></head><body>
{filled_html}
</body></html>"""

            pdf_path = str(cl_dir / f"{firm_safe}_CoverLetter.pdf")
            status["pdf"] = pdf.generate_pdf(filled_html, pdf_path)
        else:
            pdf_path = None

        # Build email body
        if email_tpl:
            email_body = email_tpl
            email_replacements = {
                "NAME": user_name,
                "PHONE": user_phone,
                "EMAIL": user_email,
                "FIRM_NAME": firm,
                "POSITION": target.get("position", ""),
            }
            for key in target:
                if key.startswith("custom_"):
                    email_replacements[key.upper()] = target[key]
            for k, v in email_replacements.items():
                email_body = email_body.replace("{{" + k + "}}", v or "")
        else:
            email_body = f"""Dear Hiring Manager,

I am writing to apply for the {target.get('position', 'open')} position at {firm}.

{target.get('custom_p3', '')}

{target.get('custom_p4', '')}. I would welcome the opportunity to bring my skills to your team.

Thank you for your time and consideration.

Best regards,
{user_name}
{user_phone}
{user_email}"""

        # Create Gmail draft
        if gmail_user and gmail_pass:
            attachments = []
            for mat_file in materials:
                if mat_file.exists():
                    attachments.append({"filename": mat_file.name, "path": str(mat_file)})
            if pdf_path and Path(pdf_path).exists():
                attachments.append({"filename": f"{firm_safe}_CoverLetter.pdf", "path": pdf_path})

            status["draft"] = email_svc.create_gmail_draft(
                gmail_user=gmail_user,
                gmail_app_password=gmail_pass,
                to_email=target.get("email", ""),
                subject=target.get("subject", f"Application - {user_name}"),
                body_text=email_body,
                from_name=user_name,
                attachments=attachments,
            )

        # Update tracker
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

    # Save updated data
    existing_targets.extend(new_targets)
    pm.save_targets(project_id, existing_targets)
    pm.save_tracker(project_id, tracker_rows)

    return {"generated": results, "skipped": skipped}


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
