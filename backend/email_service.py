"""
Email service: Gmail IMAP draft creation.
Uploads MIME messages to Gmail Drafts folder.
"""
import base64
import imaplib
import ssl
import email.utils
from datetime import datetime, timezone
from pathlib import Path


def _wrap_base64(data: bytes) -> str:
    b64 = base64.b64encode(data).decode("ascii")
    lines = [b64[i:i+76] for i in range(0, len(b64), 76)]
    return "\n".join(lines)


def _make_attachment_block(boundary: str, filename: str, file_bytes: bytes) -> str:
    wrapped = _wrap_base64(file_bytes)
    return f"""
--{boundary}
Content-Type: application/pdf; name="{filename}"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="{filename}"

{wrapped}"""


def _find_drafts_folder(mail: imaplib.IMAP4_SSL) -> str:
    """Auto-detect the Gmail Drafts folder name (works for all locales)."""
    # Try common names first
    for name in ['"[Gmail]/Drafts"', '"[Gmail]/&BCIEMAQ8BDwEOAQ4-"', "[Gmail]/Drafts"]:
        status, _ = mail.select(name)
        if status == "OK":
            mail.close()
            return name

    # List all folders and find the one with \Drafts attribute
    status, folder_list = mail.list()
    if status == "OK":
        for folder_info in folder_list:
            decoded = folder_info.decode("utf-8", errors="replace")
            if "\\Drafts" in decoded:
                # Extract folder name: b'(\\HasNoChildren \\Drafts) "/" "[Gmail]/Drafts"'
                parts = decoded.rsplit('" "', 1)
                if len(parts) == 2:
                    folder_name = '"' + parts[1].rstrip('"') + '"'
                    return folder_name
                # Try alternate format
                parts = decoded.rsplit('"', 2)
                if len(parts) >= 2:
                    return '"' + parts[-2] + '"'

    # Fallback
    return '"[Gmail]/Drafts"'


def create_gmail_draft(
    gmail_user: str,
    gmail_app_password: str,
    to_email: str,
    subject: str,
    body_text: str,
    from_name: str,
    attachments: list[dict],  # [{"filename": "cv.pdf", "path": "/path/to/file"}, ...]
) -> tuple[bool, str]:
    """Create a draft in Gmail via IMAP.

    Args:
        gmail_user: Gmail address
        gmail_app_password: Gmail App Password (spaces are stripped automatically)
        to_email: Recipient email
        subject: Email subject
        body_text: Plain text email body
        from_name: Sender display name
        attachments: List of dicts with 'filename' and 'path' keys

    Returns:
        (True, "") on success, (False, error_message) on failure
    """
    # Strip spaces from app password (Gmail shows them as "xxxx xxxx xxxx xxxx")
    gmail_app_password = gmail_app_password.replace(" ", "")

    if not gmail_user or not gmail_app_password:
        return False, "Gmail credentials not configured"
    if not to_email:
        return False, "No recipient email"

    boundary = f"----=_Part_{datetime.now().timestamp()}"
    eml_date = email.utils.formatdate(localtime=True)

    # Build attachment blocks
    attachment_blocks = ""
    for att in attachments:
        att_path = Path(att["path"])
        if att_path.exists():
            file_bytes = att_path.read_bytes()
            attachment_blocks += _make_attachment_block(boundary, att["filename"], file_bytes)

    mime = f"""MIME-Version: 1.0
From: {from_name} <{gmail_user}>
To: {to_email}
Subject: {subject}
Date: {eml_date}
Content-Type: multipart/mixed; boundary="{boundary}"

--{boundary}
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

{body_text}{attachment_blocks}
--{boundary}--"""

    # Upload to Gmail Drafts via IMAP
    mail = None
    try:
        context = ssl.create_default_context()
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=context)
        mail.login(gmail_user, gmail_app_password)

        # Auto-detect drafts folder
        drafts_folder = _find_drafts_folder(mail)

        status, response = mail.append(
            drafts_folder,
            "\\Draft",
            None,
            mime.encode("utf-8"),
        )
        mail.logout()
        if status == "OK":
            return True, ""
        else:
            return False, f"IMAP append failed: {status} {response}"
    except imaplib.IMAP4.error as e:
        err_msg = str(e)
        if "AUTHENTICATIONFAILED" in err_msg or "Invalid credentials" in err_msg:
            return False, "Gmail login failed - check email and app password in Settings"
        return False, f"IMAP error: {err_msg}"
    except Exception as e:
        return False, f"Gmail draft error: {str(e)}"
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:
                pass
