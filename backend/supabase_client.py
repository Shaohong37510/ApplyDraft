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

WELCOME_CREDITS = 12


def get_user_credits(user_id: str) -> float:
    sb = get_client()
    result = sb.table("user_credits").select("credits").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]["credits"]
    # First time user — create row with welcome bonus
    sb.table("user_credits").insert({"user_id": user_id, "credits": WELCOME_CREDITS}).execute()
    sb.table("credit_transactions").insert({
        "user_id": user_id,
        "amount": WELCOME_CREDITS,
        "type": "bonus",
        "description": "Welcome bonus",
    }).execute()
    return WELCOME_CREDITS


def add_credits(user_id: str, amount: float, description: str = "", stripe_session_id: str = "") -> float:
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


def use_credits(user_id: str, amount: float, description: str = "") -> tuple[bool, float]:
    """Atomically deduct credits. Returns (success, remaining_balance).

    Uses use_credits_safe RPC to prevent overdraft and race conditions.
    """
    sb = get_client()
    result = sb.rpc("use_credits_safe", {"uid": user_id, "amount": float(amount)}).execute()
    ok = bool(result.data)
    if not ok:
        return False, get_user_credits(user_id)
    sb.table("credit_transactions").insert({
        "user_id": user_id,
        "amount": float(-amount),
        "type": "usage",
        "description": description,
    }).execute()
    return True, get_user_credits(user_id)


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


# ── Referral ──────────────────────────────────────────────────
#
# Run this SQL in Supabase before using referral features:
#
#   CREATE TABLE IF NOT EXISTS user_referral (
#     user_id TEXT PRIMARY KEY,
#     referral_code TEXT UNIQUE NOT NULL,
#     referred_by TEXT DEFAULT NULL,
#     round INTEGER DEFAULT 1,
#     count INTEGER DEFAULT 0,
#     credits_claimed BOOLEAN DEFAULT FALSE,
#     coupon_claimed BOOLEAN DEFAULT FALSE,
#     has_discount BOOLEAN DEFAULT FALSE,
#     created_at TIMESTAMPTZ DEFAULT NOW()
#   );
#   CREATE INDEX IF NOT EXISTS idx_user_referral_code ON user_referral(referral_code);

import secrets
import string


def _gen_referral_code() -> str:
    chars = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(chars) for _ in range(8))


def get_or_create_referral(user_id: str) -> dict:
    """Get or create referral record for user."""
    sb = get_client()
    result = sb.table("user_referral").select("*").eq("user_id", user_id).execute()
    if result.data:
        return result.data[0]
    # Generate unique code
    code = None
    for _ in range(10):
        candidate = _gen_referral_code()
        exists = sb.table("user_referral").select("user_id").eq("referral_code", candidate).execute()
        if not exists.data:
            code = candidate
            break
    if not code:
        code = _gen_referral_code()
    row = {
        "user_id": user_id,
        "referral_code": code,
        "referred_by": None,
        "round": 1,
        "count": 0,
        "credits_claimed": False,
        "coupon_claimed": False,
        "has_discount": False,
    }
    sb.table("user_referral").insert(row).execute()
    return row


def set_referred_by(user_id: str, referral_code: str) -> bool:
    """Set referrer for new user. Returns True if valid."""
    sb = get_client()
    result = sb.table("user_referral").select("user_id").eq("referral_code", referral_code).execute()
    if not result.data:
        return False
    owner_id = result.data[0]["user_id"]
    if owner_id == user_id:
        return False
    row = get_or_create_referral(user_id)
    if row.get("referred_by"):
        return True
    sb.table("user_referral").update({"referred_by": referral_code}).eq("user_id", user_id).execute()
    return True


def process_referral_completion(user_id: str):
    """Called when user completes onboarding. Increments referrer's count if applicable."""
    sb = get_client()
    try:
        my_ref = get_or_create_referral(user_id)
    except Exception:
        return
    referred_by_code = my_ref.get("referred_by")
    if not referred_by_code:
        return
    result = sb.table("user_referral").select("*").eq("referral_code", referred_by_code).execute()
    if not result.data:
        return
    referrer = result.data[0]
    referrer_id = referrer["user_id"]
    # Idempotent: check if already counted
    already = sb.table("credit_transactions").select("id").eq("user_id", referrer_id)\
        .eq("description", f"referral_event:{user_id}").execute()
    if already.data:
        return
    # Log event (amount=0, type=bonus)
    sb.table("credit_transactions").insert({
        "user_id": referrer_id,
        "amount": 0,
        "type": "bonus",
        "description": f"referral_event:{user_id}",
    }).execute()
    new_count = referrer["count"] + 1
    sb.table("user_referral").update({"count": new_count}).eq("user_id", referrer_id).execute()


def claim_referral_credits(user_id: str) -> dict:
    """Claim 6 credits reward for 3 referrals."""
    sb = get_client()
    ref = get_or_create_referral(user_id)
    if ref["count"] < 3:
        raise ValueError("Need at least 3 referrals")
    if ref["credits_claimed"]:
        raise ValueError("Credits already claimed this round")
    add_credits(user_id, 6, description="Referral reward: 6 credits")
    sb.table("user_referral").update({"credits_claimed": True}).eq("user_id", user_id).execute()
    ref["credits_claimed"] = True
    return ref


def claim_referral_coupon(user_id: str) -> dict:
    """Claim 70% discount coupon for 5 referrals."""
    sb = get_client()
    ref = get_or_create_referral(user_id)
    if ref["count"] < 5:
        raise ValueError("Need at least 5 referrals")
    if ref["coupon_claimed"]:
        raise ValueError("Coupon already claimed this round")
    sb.table("user_referral").update({"coupon_claimed": True, "has_discount": True}).eq("user_id", user_id).execute()
    ref["coupon_claimed"] = True
    ref["has_discount"] = True
    return ref


def use_referral_discount(user_id: str):
    """Consume the 70% discount after a purchase."""
    sb = get_client()
    sb.table("user_referral").update({"has_discount": False}).eq("user_id", user_id).execute()
