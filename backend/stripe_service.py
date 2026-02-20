"""
Stripe service: credit purchase via Stripe Checkout.
"""
import os
import stripe

from . import supabase_client as db


def _init_stripe():
    stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")


def create_checkout_session(user_id: str, credits: int, success_url: str, cancel_url: str) -> str:
    """Create a Stripe Checkout session for purchasing credits.

    Returns the checkout URL.
    """
    _init_stripe()

    session = stripe.checkout.Session.create(
        payment_method_types=["card"],
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": f"{credits} Credits - ApplyDraft",
                    "description": f"Purchase {credits} credits for AI-powered job applications",
                },
                "unit_amount": _credits_to_cents(credits),
            },
            "quantity": 1,
        }],
        mode="payment",
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "user_id": user_id,
            "credits": str(credits),
        },
    )
    return session.url


def handle_webhook(payload: bytes, sig_header: str) -> dict:
    """Handle Stripe webhook event.

    Returns {"ok": True, "credits": X} on success.
    """
    _init_stripe()
    webhook_secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
    except (ValueError, stripe.error.SignatureVerificationError):
        return {"ok": False, "error": "Invalid webhook signature"}

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        user_id = session["metadata"].get("user_id")
        credits = int(session["metadata"].get("credits", 0))
        session_id = session["id"]

        if user_id and credits > 0:
            new_balance = db.add_credits(
                user_id, credits,
                description=f"Purchased {credits} credits",
                stripe_session_id=session_id,
            )
            return {"ok": True, "credits": credits, "balance": new_balance}

    return {"ok": True, "event": event["type"]}


# Fixed credit packages: credits → price in cents
CREDIT_PACKAGES = {
    10: 900,    # $9
    100: 6900,  # $69
    300: 16500, # $165
}


def _credits_to_cents(credits: int) -> int:
    """Convert credit amount to price in cents using tiered pricing."""
    if credits in CREDIT_PACKAGES:
        return CREDIT_PACKAGES[credits]
    if credits < 100:
        return credits * 90
    elif credits < 300:
        return credits * 69
    else:
        return credits * 55
