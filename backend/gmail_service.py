"""
Gmail service: Google OAuth 2.0 + Gmail API draft creation.
Creates draft messages in user's Gmail with attachments via REST API.
"""
import base64
import time
import urllib.parse
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from pathlib import Path

import httpx

# ── Google OAuth 2.0 Configuration ──────────────────────────
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1"
GOOGLE_SCOPES = "email https://www.googleapis.com/auth/gmail.compose"


def get_auth_url(redirect_uri: str, client_id: str, state: str = "") -> str:
    """Generate Google OAuth authorization URL."""
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": GOOGLE_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    if state:
        params["state"] = state
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(
    code: str, redirect_uri: str, client_id: str, client_secret: str
) -> tuple[bool, dict]:
    """Exchange authorization code for access + refresh tokens.

    Returns (True, token_data) on success, (False, {"error": msg}) on failure.
    """
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    resp = httpx.post(GOOGLE_TOKEN_URL, data=data, timeout=30)
    if resp.status_code == 200:
        token_data = resp.json()
        return True, {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token", ""),
            "expires_at": int(time.time()) + token_data.get("expires_in", 3600),
        }
    else:
        err = resp.json().get("error_description", resp.text[:200])
        return False, {"error": f"Token exchange failed: {err}"}


def refresh_access_token(
    refresh_token: str, client_id: str, client_secret: str
) -> tuple[bool, dict]:
    """Refresh the access token using a refresh token."""
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    resp = httpx.post(GOOGLE_TOKEN_URL, data=data, timeout=30)
    if resp.status_code == 200:
        token_data = resp.json()
        return True, {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token", refresh_token),
            "expires_at": int(time.time()) + token_data.get("expires_in", 3600),
        }
    else:
        return False, {"error": "Token refresh failed - reconnect Gmail"}


def _get_valid_token(
    tokens: dict, client_id: str, client_secret: str
) -> tuple[bool, str, dict]:
    """Get a valid access token, refreshing if expired.

    Returns (ok, access_token, updated_tokens).
    """
    if time.time() < tokens.get("expires_at", 0) - 60:
        return True, tokens["access_token"], tokens

    ok, new_tokens = refresh_access_token(
        tokens["refresh_token"], client_id, client_secret
    )
    if ok:
        return True, new_tokens["access_token"], new_tokens
    return False, "", tokens


def get_user_email(
    tokens: dict, client_id: str, client_secret: str
) -> tuple[bool, str, dict]:
    """Get the authenticated user's Gmail address.

    Returns (ok, email, updated_tokens).
    """
    ok, token, updated = _get_valid_token(tokens, client_id, client_secret)
    if not ok:
        return False, "Token expired - reconnect Gmail", updated

    resp = httpx.get(
        f"{GMAIL_API_URL}/users/me/profile",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code == 200:
        email = resp.json().get("emailAddress", "")
        return True, email, updated
    return False, f"Failed to get Gmail profile: {resp.status_code}", updated


def create_gmail_draft(
    tokens: dict,
    to_email: str,
    subject: str,
    body_text: str,
    from_name: str,
    attachments: list[dict],
    client_id: str,
    client_secret: str,
) -> tuple[bool, str, dict]:
    """Create a draft message in the user's Gmail via Gmail API.

    Args:
        tokens: OAuth tokens dict with access_token, refresh_token, expires_at
        to_email: Recipient email
        subject: Email subject
        body_text: Plain text email body
        from_name: Sender display name
        attachments: List of dicts with 'filename' and 'path' keys
        client_id: Google OAuth client ID
        client_secret: Google OAuth client secret

    Returns:
        (True, "", updated_tokens) on success,
        (False, error_message, updated_tokens) on failure
    """
    ok, token, updated_tokens = _get_valid_token(tokens, client_id, client_secret)
    if not ok:
        return False, "Token expired - reconnect Gmail", updated_tokens

    if not to_email:
        return False, "No recipient email", updated_tokens

    # Build MIME message
    msg = MIMEMultipart()
    msg["To"] = to_email
    msg["Subject"] = subject
    if from_name:
        msg["From"] = from_name

    msg.attach(MIMEText(body_text, "plain", "utf-8"))

    # Add attachments
    for att in attachments:
        att_path = Path(att["path"])
        if not att_path.exists():
            continue
        file_bytes = att_path.read_bytes()
        part = MIMEBase("application", "octet-stream")
        part.set_payload(file_bytes)
        encoders.encode_base64(part)
        part.add_header("Content-Disposition", f'attachment; filename="{att["filename"]}"')
        msg.attach(part)

    # Base64url encode the message
    raw_message = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    # Create draft via Gmail API
    resp = httpx.post(
        f"{GMAIL_API_URL}/users/me/drafts",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={"message": {"raw": raw_message}},
        timeout=60,
    )
    if resp.status_code in (200, 201):
        return True, "", updated_tokens
    else:
        err = resp.json().get("error", {}).get("message", resp.text[:200])
        return False, f"Gmail draft creation failed: {err}", updated_tokens
