#!/bin/bash
# ═══════════════════════════════════════════════════════════
# ApplyDraft - Quick Update Script
# Run after pushing new code: bash update.sh
# ═══════════════════════════════════════════════════════════

set -e

APP_DIR="/opt/applydraft"

echo "Updating ApplyDraft..."

cd "$APP_DIR"

# Pull latest code
git pull

# Update dependencies
source venv/bin/activate
pip install --quiet -r requirements.txt

# Restart
sudo systemctl restart applydraft

echo "Done! Checking status..."
sleep 2
sudo systemctl status applydraft --no-pager -l
