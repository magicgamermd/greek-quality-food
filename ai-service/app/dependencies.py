"""
Shared FastAPI dependencies.

`require_internal_api_key` protects every /ai/* and /internal/* route so that
only the warehouse-backend (which shares the same secret) can call them.
Public endpoints like /health remain unauthenticated for container healthchecks.

The dependency accepts either of two header shapes the backend might send:
  1. Authorization: Bearer <INTERNAL_API_KEY>   (preferred, RFC 6750)
  2. X-Internal-Api-Key: <INTERNAL_API_KEY>     (legacy fallback)

Both headers are compared against settings.internal_api_key (env
INTERNAL_API_KEY). If INTERNAL_API_KEY is unset, the service falls back to
settings.backend_api_key (env BACKEND_API_KEY) for backward compatibility
with existing deployments that only defined the symmetric key under that
name. If BOTH are empty, the dependency fails closed with 503 rather than
accepting anonymous calls — misconfiguration must not silently disable auth.
"""
from __future__ import annotations

import hmac
import logging
from typing import Optional

from fastapi import Header, HTTPException, status

from app.config import settings

logger = logging.getLogger(__name__)


def _expected_secret() -> str:
    """Return the configured internal API key, preferring INTERNAL_API_KEY."""
    return (settings.internal_api_key or settings.backend_api_key or "").strip()


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2:
        return None
    scheme, token = parts
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


async def require_internal_api_key(
    authorization: Optional[str] = Header(default=None),
    x_internal_api_key: Optional[str] = Header(default=None),
) -> None:
    """
    FastAPI dependency: 401 unless the caller presents the shared internal
    API key via either `Authorization: Bearer <key>` or `X-Internal-Api-Key`.
    """
    expected = _expected_secret()
    if not expected:
        logger.error(
            "INTERNAL_API_KEY (or BACKEND_API_KEY) is not configured; "
            "refusing to serve internal routes."
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ai-service auth is not configured",
        )

    provided = _extract_bearer(authorization) or (x_internal_api_key or "").strip()

    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid internal API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
