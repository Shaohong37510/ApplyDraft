"""
Job Application Kit - Main Entry Point
Starts FastAPI server and opens browser.
"""
import os
import sys
import webbrowser
import threading
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from backend.api import router

app = FastAPI(title="ApplyDraft - Job Application Kit")
app.include_router(router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def index():
    return FileResponse(str(static_dir / "index.html"))


@app.get("/privacy")
@app.get("/privacy.html")
def privacy():
    return FileResponse(str(static_dir / "privacy.html"))


@app.get("/terms")
@app.get("/terms.html")
def terms():
    return FileResponse(str(static_dir / "terms.html"))


@app.get("/ai-cover-letter-generator")
@app.get("/ai-cover-letter-generator.html")
def ai_cover_letter_generator():
    return FileResponse(str(static_dir / "ai-cover-letter-generator.html"))


@app.get("/ai-email-job-application")
@app.get("/ai-email-job-application.html")
def ai_email_job_application():
    return FileResponse(str(static_dir / "ai-email-job-application.html"))


@app.get("/automate-job-applications")
@app.get("/automate-job-applications.html")
def automate_job_applications():
    return FileResponse(str(static_dir / "automate-job-applications.html"))


@app.get("/job-application-tracker")
@app.get("/job-application-tracker.html")
def job_application_tracker():
    return FileResponse(str(static_dir / "job-application-tracker.html"))


def open_browser(port):
    webbrowser.open(f"http://localhost:{port}")


def main():
    port = int(os.environ.get("PORT", 8899))
    host = os.environ.get("HOST", "127.0.0.1")

    # In production (Railway etc.), bind 0.0.0.0
    if os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("PORT"):
        host = "0.0.0.0"

    print("=" * 50)
    print("  Job Application Kit")
    print(f"  http://localhost:{port}")
    print("=" * 50)

    # Only open browser locally
    if host == "127.0.0.1":
        threading.Timer(1.5, open_browser, args=[port]).start()

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
