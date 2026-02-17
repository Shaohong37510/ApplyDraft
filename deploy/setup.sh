#!/bin/bash
# ═══════════════════════════════════════════════════════════
# ApplyDraft - DigitalOcean One-Click Setup
# Run on a fresh Ubuntu 22.04/24.04 Droplet as root:
#   curl -sSL https://raw.githubusercontent.com/.../setup.sh | bash
# Or: bash setup.sh
# ═══════════════════════════════════════════════════════════

set -e

APP_DIR="/opt/applydraft"
APP_USER="applydraft"
DOMAIN="applydraft.top"
REPO_URL=""  # TODO: Fill with your git repo URL

echo "══════════════════════════════════════"
echo "  ApplyDraft - Server Setup"
echo "══════════════════════════════════════"

# ── 1. System packages ──────────────────────────────────
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nginx certbot python3-certbot-nginx git ufw

# ── 2. Firewall ─────────────────────────────────────────
echo "[2/7] Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 3. Create app user ──────────────────────────────────
echo "[3/7] Creating app user..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$APP_USER"
fi

# ── 4. Clone / copy app ────────────────────────────────
echo "[4/7] Setting up application..."
if [ -n "$REPO_URL" ]; then
    git clone "$REPO_URL" "$APP_DIR" 2>/dev/null || (cd "$APP_DIR" && git pull)
else
    echo "  No REPO_URL set. Copy your code to $APP_DIR manually."
    mkdir -p "$APP_DIR"
fi

# ── 5. Python venv + dependencies ──────────────────────
echo "[5/7] Installing Python dependencies..."
cd "$APP_DIR"
python3 -m venv venv
source venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# Create projects directory
mkdir -p "$APP_DIR/projects"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 6. Systemd service ─────────────────────────────────
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/applydraft.service << 'EOF'
[Unit]
Description=ApplyDraft FastAPI Application
After=network.target

[Service]
Type=simple
User=applydraft
WorkingDirectory=/opt/applydraft
ExecStart=/opt/applydraft/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8899
Restart=always
RestartSec=5
EnvironmentFile=/opt/applydraft/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable applydraft

# ── 7. Nginx config ─────────────────────────────────────
echo "[7/7] Configuring Nginx..."
cat > /etc/nginx/sites-available/applydraft << EOF
server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8899;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE support
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/applydraft /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "══════════════════════════════════════"
echo "  Setup complete!"
echo "══════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Copy your code to $APP_DIR (if not using git)"
echo "  2. Create $APP_DIR/.env with your secrets"
echo "  3. Point DNS: $DOMAIN → this server's IP"
echo "  4. Start the app:"
echo "       systemctl start applydraft"
echo "  5. Get SSL certificate:"
echo "       certbot --nginx -d $DOMAIN -d www.$DOMAIN"
echo "  6. Check status:"
echo "       systemctl status applydraft"
echo "       journalctl -u applydraft -f"
echo ""
