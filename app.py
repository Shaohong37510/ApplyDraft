"""
Job Application Kit - Main Entry Point
Starts FastAPI server and opens browser.
"""
import sys
import webbrowser
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from backend.api import router

app = FastAPI(title="Job Application Kit")
app.include_router(router)

# Serve static files
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def index():
    return FileResponse(str(static_dir / "index.html"))


def open_browser():
    webbrowser.open("http://localhost:8899")


def main():
    print("=" * 50)
    print("  Job Application Kit")
    print("  http://localhost:8899")
    print("=" * 50)
    # Open browser after a short delay
    threading.Timer(1.5, open_browser).start()
    uvicorn.run(app, host="127.0.0.1", port=8899, log_level="warning")


if __name__ == "__main__":
    main()
