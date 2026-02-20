"""
Billing helpers: credit costs per operation.

Pricing:
  - Search:   2 credits per target
  - Generate: 8 credits per target
"""
from __future__ import annotations
import os


def _fenv(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


SEARCH_CREDITS_PER_TARGET   = _fenv("SEARCH_CREDITS_PER_TARGET",   0.2)
DELIVERY_CREDITS_PER_TARGET = _fenv("DELIVERY_CREDITS_PER_TARGET", 0.8)


def search_cost(count: int) -> float:
    """Credits required to search for `count` targets."""
    return round(SEARCH_CREDITS_PER_TARGET * count, 3)


def generate_cost(count: int) -> float:
    """Credits required to generate `count` targets."""
    return round(DELIVERY_CREDITS_PER_TARGET * count, 3)
