"""
PDF service: Generate Cover Letter PDFs from HTML templates via Edge headless.
"""
import subprocess
import tempfile
import re
from pathlib import Path


def _find_edge() -> str | None:
    """Find Microsoft Edge executable."""
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for path in candidates:
        if Path(path).exists():
            return path
    return None


def fill_template(template_html: str, replacements: dict) -> str:
    """Replace {{PLACEHOLDER}} tags in an HTML template."""
    result = template_html
    for key, value in replacements.items():
        placeholder = "{{" + key + "}}"
        result = result.replace(placeholder, value or "")
    return result


def generate_pdf(html_content: str, output_path: str) -> bool:
    """Generate a PDF from HTML content using Edge headless.

    Args:
        html_content: The full HTML string
        output_path: Where to save the PDF

    Returns:
        True if PDF was generated successfully
    """
    edge = _find_edge()
    if not edge:
        return False

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    # Write HTML to temp file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".html", delete=False, encoding="utf-8") as f:
        f.write(html_content)
        html_path = f.name

    try:
        result = subprocess.run(
            [
                edge,
                "--headless",
                "--disable-gpu",
                "--no-pdf-header-footer",
                f"--print-to-pdf={output_path}",
                html_path,
            ],
            capture_output=True,
            timeout=20,
        )
        return Path(output_path).exists()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    finally:
        try:
            Path(html_path).unlink()
        except OSError:
            pass


def safe_filename(name: str) -> str:
    """Make a string safe for use in file names."""
    return re.sub(r'[<>:"/\\|?*]', '-', name)
