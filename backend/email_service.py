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


def create_gmail_draft(
    gmail_user: str,
    gmail_app_password: str,
    to_email: str,
    subject: str,
    body_text: str,
    from_name: str,
    attachments: list[dict],  # [{"filename": "cv.pdf", "path": "/path/to/file"}, ...]
) -> bool:
    """Create a draft in Gmail via IMAP.

    Args:
        gmail_user: Gmail address
        gmail_app_password: Gmail App Password
        to_email: Recipient email
        subject: Email subject
        body_text: Plain text email body
        from_name: Sender display name
        attachments: List of dicts with 'filename' and 'path' keys

    Returns:
        True if draft was created successfully
    """
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
    try:
        context = ssl.create_default_context()
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=context)
        mail.login(gmail_user, gmail_app_password)
        mail.append(
            '"[Gmail]/Drafts"',
            "\\Draft",
            None,
            mime.encode("utf-8"),
        )
        mail.logout()
        return True
    except Exception as e:
        print(f"Gmail draft error: {e}")
        return False
