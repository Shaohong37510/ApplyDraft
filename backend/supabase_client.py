"""
Supabase client: database operations for users, credits, and settings.
"""
import os
from supabase import create_client, Client

_client: Client | None = None


def get_client() -> Client:
    global _client
    if _client is None:
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        _client = create_client(url, key)
    return _client


# ── Credits ──────────────────────────────────────────────────

def get_user_credits(user_id: str) -> int:
    sb = get_client()
    result = sb.table("user_credits").select("credits").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]["credits"]
    # First time user — create row with 0 credits
    sb.table("user_credits").insert({"user_id": user_id, "credits": 0}).execute()
    return 0


def add_credits(user_id: str, amount: int, description: str = "", stripe_session_id: str = "") -> int:
    """Add credits (purchase). Returns new balance."""
    sb = get_client()
    # Ensure user row exists
    get_user_credits(user_id)
    # Update credits
    sb.rpc("increment_credits", {"uid": user_id, "amount": amount}).execute()
    # Log transaction
    sb.table("credit_transactions").insert({
        "user_id": user_id,
        "amount": amount,
        "type": "purchase",
        "description": description,
        "stripe_session_id": stripe_session_id,
    }).execute()
    return get_user_credits(user_id)


def use_credits(user_id: str, amount: int, description: str = "") -> tuple[bool, int]:
    """Use credits (consume). Returns (success, remaining_balance)."""
    balance = get_user_credits(user_id)
    if balance < amount:
        return False, balance
    sb = get_client()
    sb.rpc("increment_credits", {"uid": user_id, "amount": -amount}).execute()
    sb.table("credit_transactions").insert({
        "user_id": user_id,
        "amount": -amount,
        "type": "usage",
        "description": description,
    }).execute()
    return True, balance - amount


def get_credit_history(user_id: str) -> list[dict]:
    sb = get_client()
    result = sb.table("credit_transactions")\
        .select("*")\
        .eq("user_id", user_id)\
        .order("created_at", desc=True)\
        .limit(50)\
        .execute()
    return result.data or []


# ── User Settings ────────────────────────────────────────────

def get_user_settings(user_id: str) -> dict:
    sb = get_client()
    result = sb.table("user_settings").select("*").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]
    # Create default settings
    defaults = {
        "user_id": user_id,
        "email_provider": "none",
        "gmail_email": "",
        "gmail_tokens": None,
        "outlook_tokens": None,
        "outlook_email": "",
    }
    sb.table("user_settings").insert(defaults).execute()
    return defaults


def save_user_settings(user_id: str, settings: dict):
    sb = get_client()
    settings["user_id"] = user_id
    sb.table("user_settings").upsert(settings).execute()
