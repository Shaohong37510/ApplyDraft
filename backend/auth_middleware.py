"""
Auth middleware: verifies Supabase JWT and extracts user_id.
Tries local JWT decode first, falls back to Supabase Auth API.
"""
import os
import httpx
from jose import jwt, JWTError
from fastapi import Request, HTTPException

_jwt_secret: str | None = None


def _get_jwt_secret() -> str:
    global _jwt_secret
    if _jwt_secret is None:
        _jwt_secret = os.environ.get("SUPABASE_JWT_SECRET", "")
    return _jwt_secret


def _decode_local(token: str) -> str | None:
    """Try to decode JWT locally. Returns user_id or None."""
    secret = _get_jwt_secret()
    if not secret:
        return None
    try:
        payload = jwt.decode(
            token, secret, algorithms=["HS256"], audience="authenticated"
        )
        return payload.get("sub")
    except JWTError as e:
        print(f"[AUTH] Local JWT decode failed: {e}")
        return None


def _verify_via_api(token: str) -> str | None:
    """Verify token via Supabase Auth API. Returns user_id or None."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
    if not supabase_url:
        return None
    try:
        resp = httpx.get(
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": anon_key,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json().get("id")
    except httpx.RequestError:
        pass
    return None


def get_current_user(request: Request) -> str:
    """Extract and verify user_id from Authorization header.

    Tries local JWT decode first, then Supabase API as fallback.
    Returns user_id string.
    Raises HTTPException 401 if not authenticated.
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(401, "Not authenticated")

    token = auth_header[7:]

    # Try local decode first (fast)
    user_id = _decode_local(token)
    if user_id:
        return user_id

    # Fallback to Supabase API (slower but reliable)
    user_id = _verify_via_api(token)
    if user_id:
        return user_id

    raise HTTPException(401, "Invalid or expired token")


def optional_user(request: Request) -> str | None:
    """Same as get_current_user but returns None instead of raising."""
    try:
        return get_current_user(request)
    except HTTPException:
        return None
