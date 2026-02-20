"""
Billing helpers for credit charging and token overage calculations.
"""
from __future__ import annotations

import os
from typing import Dict


def _get_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _get_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Claude Haiku pricing (USD per 1M tokens)
HAIKU35_INPUT_PER_MTOK = _get_float_env("HAIKU35_INPUT_PER_MTOK", 0.80)
HAIKU35_OUTPUT_PER_MTOK = _get_float_env("HAIKU35_OUTPUT_PER_MTOK", 4.00)

# Base credits per target
SEARCH_CREDITS_PER_TARGET = _get_float_env("SEARCH_CREDITS_PER_TARGET", 0.2)
DELIVERY_CREDITS_PER_TARGET = _get_float_env("DELIVERY_CREDITS_PER_TARGET", 0.8)

# Overage pricing (USD per credit)
USD_PER_CREDIT = _get_float_env("USD_PER_CREDIT", 0.9)


def usd_from_tokens(input_tokens: float, output_tokens: float) -> float:
    """Convert token usage to USD using Haiku pricing."""
    input_usd = (input_tokens / 1_000_000.0) * HAIKU35_INPUT_PER_MTOK
    output_usd = (output_tokens / 1_000_000.0) * HAIKU35_OUTPUT_PER_MTOK
    return input_usd + output_usd


def credits_from_usd(usd: float) -> float:
    if USD_PER_CREDIT <= 0:
        return 0.0
    return usd / USD_PER_CREDIT


def _parse_limits(raw: str) -> Dict[int, float]:
    """
    Parse limits like "1:8000,2:12000,3:16000,default:20000".
    Returns {1:8000,2:12000,3:16000,-1:20000} where -1 is default.
    """
    limits: Dict[int, float] = {}
    if not raw:
        return limits
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    for p in parts:
        if ":" not in p:
            continue
        k, v = [x.strip() for x in p.split(":", 1)]
        try:
            if k.lower() == "default":
                limits[-1] = float(v)
            else:
                limits[int(k)] = float(v)
        except ValueError:
            continue
    return limits


def token_limit_for_count(count: int, limits_env: str, per_item_env: str) -> float | None:
    """Get token limit for a batch count; returns None if no limit configured."""
    if count <= 0:
        return 0.0
    limits = _parse_limits(os.environ.get(limits_env, ""))
    if count in limits:
        return limits[count]
    if -1 in limits:
        return limits[-1]
    per_item = _get_float_env(per_item_env, 0.0)
    if per_item <= 0:
        return None
    return per_item * count


# Search phase token budgets (matches ai_service._search_limits table)
# Input:  82000 + 40000 * count
# Output:  2000 +  1000 * count  (capped at 12000)
SEARCH_INPUT_BASE     = _get_float_env("SEARCH_INPUT_BASE",     82_000)
SEARCH_INPUT_PER_ITEM = _get_float_env("SEARCH_INPUT_PER_ITEM", 40_000)
SEARCH_OUTPUT_BASE     = _get_float_env("SEARCH_OUTPUT_BASE",    2_000)
SEARCH_OUTPUT_PER_ITEM = _get_float_env("SEARCH_OUTPUT_PER_ITEM", 1_000)


def search_token_limit(count: int) -> float:
    """Total token budget (input + output) for a search batch of `count` targets."""
    input_limit  = SEARCH_INPUT_BASE  + SEARCH_INPUT_PER_ITEM  * count
    output_limit = SEARCH_OUTPUT_BASE + SEARCH_OUTPUT_PER_ITEM * count
    return input_limit + output_limit


def overage_credits_for_tokens(input_tokens: float, output_tokens: float, limit_tokens: float | None) -> float:
    """Calculate overage credits based on total token limit."""
    if limit_tokens is None:
        return 0.0
    total = input_tokens + output_tokens
    if total <= limit_tokens or total <= 0:
        return 0.0
    extra_total = total - limit_tokens
    # Allocate extra proportionally to input/output usage
    extra_input = input_tokens * (extra_total / total)
    extra_output = output_tokens * (extra_total / total)
    extra_usd = usd_from_tokens(extra_input, extra_output)
    return credits_from_usd(extra_usd)
