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
            example_texts.append(f"[PDF content from {f.name} - please provide .txt files for best results]")
        else:
            try:
                example_texts.append(f.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                pass

    if len(example_texts) < 1:
        raise HTTPException(400, "Need at least 1 example file (.txt recommended)")

    result = ai.generate_template_from_examples(api_key, example_texts, type_label)

    # Save generated files in type-specific directory
    type_dir = pm.get_project_dir(project_id) / "templates" / type_id
    type_dir.mkdir(parents=True, exist_ok=True)
    (type_dir / "template.txt").write_text(result["template"], encoding="utf-8")
    (type_dir / "definitions.txt").write_text(result["definitions"], encoding="utf-8")

    return result


@router.post("/projects/{project_id}/customize/{type_id}/preview")
def preview_template(project_id: str, type_id: str):
    """Preview: AI fills template with sample content, generates a PDF."""
    gcfg = pm.load_global_config()
    api_key = gcfg.get("api_key", "")
    if not api_key:
        raise HTTPException(400, "API Key not configured")

    type_dir = pm.get_project_dir(project_id) / "templates" / type_id
    template_path = type_dir / "template.txt"
    definitions_path = type_dir / "definitions.txt"

    if not template_path.exists():
        raise HTTPException(400, "No template found. Generate one first.")

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
    preview_path = str(preview_dir / f"PREVIEW_{type_id}.pdf")

    ok = pdf.generate_pdf(html, preview_path)
    if not ok:
        raise HTTPException(500, "PDF generation failed. Is Microsoft Edge installed?")

    return {"pdf_path": preview_path, "filled_text": filled}


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

    md_content = ai.generate_project_md(api_key, job_req, user_profile)
    pm.save_project_md(project_id, md_content)
    return {"content": md_content}


# ═══════════════════════════════════════════════════════════════
#  RUN: Search + Generate + Email
# ═══════════════════════════════════════════════════════════════

def _build_filename(fmt: str, replacements: dict, file_type_label: str) -> str:
    """Build a filename from the user's format template, e.g. '{{NAME}}-{{FIRM_NAME}}-CoverLetter'."""
    result = fmt
    replacements_with_type = {**replacements, "FILE_TYPE": file_type_label}
    for k, v in replacements_with_type.items():
        result = result.replace("{{" + k + "}}", v or "")
    # Sanitize for filesystem
    return pdf.safe_filename(result)


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
    filename_format = proj_config.get("filename_format", "{{NAME}}-{{FIRM_NAME}}-{{FILE_TYPE}}")

    # Load all customize file templates
    customize_files = proj_config.get("customize_files", [])
    file_templates = {}  # type_id -> {"template": str, "definitions": str, "label": str}
    all_definitions = []
    for cf in customize_files:
        cf_id = cf["id"]
        cf_label = cf["label"]
        type_dir = tpl_dir / cf_id
        tpl_path = type_dir / "template.txt"
        defs_path = type_dir / "definitions.txt"
        tpl_text = tpl_path.read_text(encoding="utf-8") if tpl_path.exists() else ""
        defs_text = defs_path.read_text(encoding="utf-8") if defs_path.exists() else ""
        file_templates[cf_id] = {"template": tpl_text, "definitions": defs_text, "label": cf_label}
        if defs_text:
            all_definitions.append(f"[{cf_label}]\n{defs_text}")

    combined_definitions = "\n\n".join(all_definitions)

    project_md = pm.load_project_md(project_id)

    # Get existing firms to avoid duplicates
    existing_targets = pm.load_targets(project_id)
    existing_firms = [t["firm"] for t in existing_targets]

    tracker_rows = pm.load_tracker(project_id)
    generated_firms = [r["Firm"] for r in tracker_rows if r.get("Status") == "Generated"]

    # Step 1: AI search and generate targets
    search_result = ai.search_and_generate_targets(
        api_key, project_md, combined_definitions, job_req, count,
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

    output_dir = project_dir / "Email" / "CoverLetters"
    output_dir.mkdir(parents=True, exist_ok=True)

    materials = [
        pm.get_project_dir(project_id) / "Material" / f
        for f in (proj.get("materials") or [])
    ]

    for target in new_targets:
        firm = target.get("firm", "Unknown")
        firm_safe = pdf.safe_filename(firm)
        status = {"firm": firm, "pdfs": [], "draft": False, "error": None}

        base_replacements = {
            "NAME": user_name,
            "PHONE": user_phone,
            "EMAIL": user_email,
            "FIRM_NAME": firm,
            "POSITION": target.get("position", ""),
        }
        # Add custom_pX placeholders
        for key in target:
            if key.startswith("custom_"):
                base_replacements[key.upper()] = target[key]

        generated_pdfs = []
        email_body = None

        # Process each customize file type
        for cf in customize_files:
            cf_id = cf["id"]
            cf_label = cf["label"]
            ft = file_templates.get(cf_id, {})
            tpl_text = ft.get("template", "")
            if not tpl_text:
                continue

            # Fill template
            filled = tpl_text
            for k, v in base_replacements.items():
                filled = filled.replace("{{" + k + "}}", v or "")

            # Determine if this type is an "email body" type (no PDF, used as email text)
            if cf_id == "email_body":
                email_body = filled
                continue

            # Generate PDF for this file type
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

            # Build filename from format
            out_filename = _build_filename(filename_format, base_replacements, cf_label)
            pdf_path = str(output_dir / f"{out_filename}.pdf")
            if pdf.generate_pdf(filled_html, pdf_path):
                generated_pdfs.append({"type": cf_label, "path": pdf_path, "filename": f"{out_filename}.pdf"})

        status["pdfs"] = [p["type"] for p in generated_pdfs]
        status["pdf"] = len(generated_pdfs) > 0

        # Fallback email body if no email_body template
        if email_body is None:
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
