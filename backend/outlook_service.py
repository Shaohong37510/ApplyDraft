"""
Outlook service: Microsoft Graph API draft creation via OAuth 2.0.
Creates draft messages in user's Outlook mailbox with attachments.
"""
import base64
import time
import urllib.parse
from pathlib import Path

import httpx

# ── Azure App Registration (multi-tenant) ──────────────────
# Register at https://portal.azure.com → App registrations
# Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
# API permissions: Mail.ReadWrite (Delegated)
MS_CLIENT_ID = ""  # TODO: Fill after Azure registration
MS_AUTHORITY = "https://login.microsoftonline.com/common"
MS_SCOPES = "openid profile offline_access Mail.ReadWrite"
GRAPH_URL = "https://graph.microsoft.com/v1.0"


def get_auth_url(redirect_uri: str, client_id: str = "", state: str = "") -> str:
    """Generate Microsoft OAuth authorization URL."""
    cid = client_id or MS_CLIENT_ID
    params = {
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": MS_SCOPES,
        "response_mode": "query",
        "prompt": "select_account",
    }
    if state:
        params["state"] = state
    return f"{MS_AUTHORITY}/oauth2/v2.0/authorize?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(
    code: str, redirect_uri: str, client_id: str = "", client_secret: str = ""
) -> tuple[bool, dict]:
    """Exchange authorization code for access + refresh tokens.

    Returns (True, token_data) on success, (False, {"error": msg}) on failure.
    """
    cid = client_id or MS_CLIENT_ID
    data = {
        "client_id": cid,
        "scope": MS_SCOPES,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    if client_secret:
        data["client_secret"] = client_secret

    resp = httpx.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data=data, timeout=30)
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
    refresh_token: str, client_id: str = "", client_secret: str = ""
) -> tuple[bool, dict]:
    """Refresh the access token using a refresh token."""
    cid = client_id or MS_CLIENT_ID
    data = {
        "client_id": cid,
        "scope": MS_SCOPES,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }
    if client_secret:
        data["client_secret"] = client_secret

    resp = httpx.post(f"{MS_AUTHORITY}/oauth2/v2.0/token", data=data, timeout=30)
    if resp.status_code == 200:
        token_data = resp.json()
        return True, {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token", refresh_token),
            "expires_at": int(time.time()) + token_data.get("expires_in", 3600),
        }
    else:
        return False, {"error": "Token refresh failed - reconnect Outlook"}


def _get_valid_token(tokens: dict, client_id: str = "", client_secret: str = "") -> tuple[bool, str, dict]:
    """Get a valid access token, refreshing if expired.

    Returns (ok, access_token, updated_tokens).
    """
    if time.time() < tokens.get("expires_at", 0) - 60:
        return True, tokens["access_token"], tokens

    # Token expired, refresh it
    ok, new_tokens = refresh_access_token(
        tokens["refresh_token"], client_id, client_secret
    )
    if ok:
        return True, new_tokens["access_token"], new_tokens
    return False, "", tokens


def get_user_email(tokens: dict, client_id: str = "", client_secret: str = "") -> tuple[bool, str, dict]:
    """Get the authenticated user's email address.

    Returns (ok, email, updated_tokens).
    """
    ok, token, updated = _get_valid_token(tokens, client_id, client_secret)
    if not ok:
        return False, "Token expired - reconnect Outlook", updated

    resp = httpx.get(
        f"{GRAPH_URL}/me",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code == 200:
        data = resp.json()
        email = data.get("mail") or data.get("userPrincipalName", "")
        return True, email, updated
    return False, f"Failed to get user info: {resp.status_code}", updated


def create_outlook_draft(
    tokens: dict,
    to_email: str,
    subject: str,
    body_text: str,
    from_name: str,
    attachments: list[dict],
    client_id: str = "",
    client_secret: str = "",
) -> tuple[bool, str, dict]:
    """Create a draft message in the user's Outlook mailbox.

    Args:
        tokens: OAuth tokens dict with access_token, refresh_token, expires_at
        to_email: Recipient email
        subject: Email subject
        body_text: Plain text email body
        from_name: Sender display name (not used by Graph API, kept for interface compat)
        attachments: List of dicts with 'filename' and 'path' keys
        client_id: Azure app client ID
        client_secret: Azure app client secret

    Returns:
        (True, "", updated_tokens) on success,
        (False, error_message, updated_tokens) on failure
    """
    ok, token, updated_tokens = _get_valid_token(tokens, client_id, client_secret)
    if not ok:
        return False, "Token expired - reconnect Outlook", updated_tokens

    if not to_email:
        return False, "No recipient email", updated_tokens

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Create draft message
    message_data = {
        "subject": subject,
        "body": {"contentType": "Text", "content": body_text},
        "toRecipients": [{"emailAddress": {"address": to_email}}],
        "isDraft": True,
    }

    resp = httpx.post(
        f"{GRAPH_URL}/me/messages",
        headers=headers,
        json=message_data,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        err = resp.json().get("error", {}).get("message", resp.text[:200])
        return False, f"Draft creation failed: {err}", updated_tokens

    message_id = resp.json()["id"]

    # Add attachments
    for att in attachments:
        att_path = Path(att["path"])
        if not att_path.exists():
            continue

        file_bytes = att_path.read_bytes()
        file_size = len(file_bytes)

        if file_size < 3 * 1024 * 1024:  # < 3MB: simple attachment
            att_data = {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": att["filename"],
                "contentBytes": base64.b64encode(file_bytes).decode("ascii"),
            }
            att_resp = httpx.post(
                f"{GRAPH_URL}/me/messages/{message_id}/attachments",
                headers=headers,
                json=att_data,
                timeout=60,
            )
            if att_resp.status_code not in (200, 201):
                # Continue with other attachments even if one fails
                pass
        else:
            # Large file: use upload session
            _upload_large_attachment(
                token, message_id, att["filename"], file_bytes
            )

    return True, "", updated_tokens


def _upload_large_attachment(
    token: str, message_id: str, filename: str, file_bytes: bytes
) -> bool:
    """Upload a large attachment (>3MB) using an upload session."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Create upload session
    session_data = {
        "AttachmentItem": {
            "@odata.type": "#microsoft.graph.fileAttachment",
            "name": filename,
            "size": len(file_bytes),
        }
    }
    resp = httpx.post(
        f"{GRAPH_URL}/me/messages/{message_id}/attachments/createUploadSession",
        headers=headers,
        json=session_data,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        return False

    upload_url = resp.json().get("uploadUrl")
    if not upload_url:
        return False

    # Upload in chunks (max 4MB per chunk)
    chunk_size = 4 * 1024 * 1024
    total = len(file_bytes)
    for start in range(0, total, chunk_size):
        end = min(start + chunk_size, total)
        chunk = file_bytes[start:end]
        chunk_headers = {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(len(chunk)),
            "Content-Range": f"bytes {start}-{end - 1}/{total}",
        }
        httpx.put(upload_url, headers=chunk_headers, content=chunk, timeout=120)

    return True
