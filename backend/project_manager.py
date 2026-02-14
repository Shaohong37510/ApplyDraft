"""
Project manager: handles project CRUD and file I/O.
Each project lives in its own folder under projects/.
"""
import json
import os
import shutil
import csv
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECTS_DIR = BASE_DIR / "projects"
GLOBAL_CONFIG_PATH = BASE_DIR / "global_config.json"

PROJECTS_DIR.mkdir(exist_ok=True)


def _sanitize_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in (" ", "-", "_") else "_" for c in name).strip()


# ── Global config ──────────────────────────────────────────────

def load_global_config() -> dict:
    if GLOBAL_CONFIG_PATH.exists():
        return json.loads(GLOBAL_CONFIG_PATH.read_text(encoding="utf-8"))
    return {"api_key": "", "email": "", "gmail_app_password": ""}


def save_global_config(data: dict):
    GLOBAL_CONFIG_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Project CRUD ───────────────────────────────────────────────

def list_projects() -> list[dict]:
    results = []
    for p in sorted(PROJECTS_DIR.iterdir()):
        if p.is_dir():
            config = _load_project_config(p)
            tracker_count = _count_tracker(p)
            results.append({
                "id": p.name,
                "name": config.get("project_name", p.name),
                "tracker_count": tracker_count,
            })
    return results


def create_project(name: str) -> dict:
    folder_name = _sanitize_name(name)
    if not folder_name:
        folder_name = "New-Project"
    project_dir = PROJECTS_DIR / folder_name
    counter = 1
    base = folder_name
    while project_dir.exists():
        folder_name = f"{base}-{counter}"
        project_dir = PROJECTS_DIR / folder_name
        counter += 1

    project_dir.mkdir(parents=True)
    (project_dir / "Material").mkdir()
    (project_dir / "templates").mkdir()
    (project_dir / "Email" / "CoverLetters").mkdir(parents=True)

    config = {
        "project_name": name,
        "job_requirements": "",
        "name": "",
        "phone": "",
        "filename_format": "{{NAME}}-{{FIRM_NAME}}-{{FILE_TYPE}}",
        "customize_files": [
            {"id": "cover_letter", "label": "Cover Letter"},
            {"id": "email_body", "label": "Email Body"},
        ],
    }
    _save_project_config(project_dir, config)

    # Create default template directories
    for cf in config["customize_files"]:
        (project_dir / "templates" / cf["id"] / "examples").mkdir(parents=True, exist_ok=True)

    (project_dir / "targets.json").write_text("[]", encoding="utf-8")
    (project_dir / "tracker.csv").write_text(
        "Firm,Location,Position,OpenDate,AppliedDate,Email,Source,Status\n",
        encoding="utf-8",
    )
    (project_dir / "project.md").write_text("", encoding="utf-8")

    return {"id": folder_name, "name": name}


def delete_project(project_id: str) -> bool:
    project_dir = PROJECTS_DIR / project_id
    if project_dir.exists() and project_dir.is_dir():
        shutil.rmtree(project_dir)
        return True
    return False


def get_project(project_id: str) -> dict | None:
    project_dir = PROJECTS_DIR / project_id
    if not project_dir.exists():
        return None
    config = _load_project_config(project_dir)
    tracker_count = _count_tracker(project_dir)
    templates = _list_templates(project_dir)
    materials = _list_materials(project_dir)
    return {
        "id": project_id,
        "config": config,
        "tracker_count": tracker_count,
        "templates": templates,
        "materials": materials,
    }


def update_project_config(project_id: str, data: dict) -> dict:
    project_dir = PROJECTS_DIR / project_id
    config = _load_project_config(project_dir)
    config.update(data)
    _save_project_config(project_dir, config)
    return config


def get_project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


# ── Targets ────────────────────────────────────────────────────

def load_targets(project_id: str) -> list[dict]:
    path = PROJECTS_DIR / project_id / "targets.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return []


def save_targets(project_id: str, targets: list[dict]):
    path = PROJECTS_DIR / project_id / "targets.json"
    path.write_text(json.dumps(targets, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Tracker ────────────────────────────────────────────────────

def load_tracker(project_id: str) -> list[dict]:
    path = PROJECTS_DIR / project_id / "tracker.csv"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)


def save_tracker(project_id: str, rows: list[dict]):
    path = PROJECTS_DIR / project_id / "tracker.csv"
    if not rows:
        path.write_text(
            "Firm,Location,Position,OpenDate,AppliedDate,Email,Source,Status\n",
            encoding="utf-8",
        )
        return
    fieldnames = ["Firm", "Location", "Position", "OpenDate", "AppliedDate", "Email", "Source", "Status"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def get_tracker_path(project_id: str) -> Path:
    return PROJECTS_DIR / project_id / "tracker.csv"


# ── Project.md ─────────────────────────────────────────────────

def load_project_md(project_id: str) -> str:
    path = PROJECTS_DIR / project_id / "project.md"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


def save_project_md(project_id: str, content: str):
    path = PROJECTS_DIR / project_id / "project.md"
    path.write_text(content, encoding="utf-8")


# ── Internal helpers ───────────────────────────────────────────

def _load_project_config(project_dir: Path) -> dict:
    path = project_dir / "config.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def _save_project_config(project_dir: Path, config: dict):
    path = project_dir / "config.json"
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def _count_tracker(project_dir: Path) -> int:
    path = project_dir / "tracker.csv"
    if not path.exists():
        return 0
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return sum(1 for row in reader if row.get("Status") == "Generated")


def _list_templates(project_dir: Path) -> dict:
    """Load templates for all customize file types."""
    tpl_dir = project_dir / "templates"
    config = _load_project_config(project_dir)
    customize_files = config.get("customize_files", [])

    result = {}
    for cf in customize_files:
        cf_id = cf["id"]
        type_dir = tpl_dir / cf_id
        template_path = type_dir / "template.txt"
        definitions_path = type_dir / "definitions.txt"
        result[cf_id] = {
            "template": template_path.read_text(encoding="utf-8") if template_path.exists() else "",
            "definitions": definitions_path.read_text(encoding="utf-8") if definitions_path.exists() else "",
        }

    # Backward compat: also read old flat files if they exist
    for name in ["cover_letter.txt", "email_body.txt", "custom_definitions.txt"]:
        path = tpl_dir / name
        if path.exists():
            result["_legacy_" + name] = path.read_text(encoding="utf-8")

    return result


def _list_materials(project_dir: Path) -> list[str]:
    mat_dir = project_dir / "Material"
    if not mat_dir.exists():
        return []
    return [f.name for f in mat_dir.iterdir() if f.is_file()]


def list_type_examples(project_id: str, type_id: str) -> list[str]:
    """List uploaded example files for a given customize file type."""
    examples_dir = PROJECTS_DIR / project_id / "templates" / type_id / "examples"
    if not examples_dir.exists():
        return []
    return [f.name for f in examples_dir.iterdir() if f.is_file()]


def add_customize_file(project_id: str, label: str) -> dict:
    """Add a new customize file type to the project."""
    project_dir = PROJECTS_DIR / project_id
    config = _load_project_config(project_dir)
    customize_files = config.get("customize_files", [])

    # Generate ID from label
    type_id = _sanitize_name(label).lower().replace(" ", "_").replace("-", "_")
    if not type_id:
        type_id = "custom_file"
    # Ensure unique
    existing_ids = [cf["id"] for cf in customize_files]
    base_id = type_id
    counter = 1
    while type_id in existing_ids:
        type_id = f"{base_id}_{counter}"
        counter += 1

    new_entry = {"id": type_id, "label": label}
    customize_files.append(new_entry)
    config["customize_files"] = customize_files
    _save_project_config(project_dir, config)

    # Create directory
    (project_dir / "templates" / type_id / "examples").mkdir(parents=True, exist_ok=True)

    return new_entry


def remove_customize_file(project_id: str, type_id: str) -> bool:
    """Remove a customize file type from the project."""
    import shutil as _shutil
    project_dir = PROJECTS_DIR / project_id
    config = _load_project_config(project_dir)
    customize_files = config.get("customize_files", [])
    config["customize_files"] = [cf for cf in customize_files if cf["id"] != type_id]
    _save_project_config(project_dir, config)

    # Remove directory
    type_dir = project_dir / "templates" / type_id
    if type_dir.exists():
        _shutil.rmtree(type_dir)
    return True
