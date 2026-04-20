"""
Auth gate tests for /ai/* routes.

Verifies:
  * /ai/scan-invoice without any credential returns 401
  * /ai/scan-invoice with a wrong bearer returns 401
  * /ai/scan-invoice with the correct bearer passes the auth gate and reaches
    the real handler (we stub the Gemini pipeline so we don't make network
    calls — we only care that auth did NOT block the request)
  * X-Internal-Api-Key header also works as an accepted alternative
  * /health stays unauthenticated so Docker healthchecks keep working
"""
from __future__ import annotations

import io
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config as config_module
from app import dependencies as deps_module
from app.routers import invoice as invoice_router


TEST_KEY = "test-internal-key-abc123"


@pytest.fixture(autouse=True)
def _configure_internal_key(monkeypatch):
    """Force a known INTERNAL_API_KEY for every test in this module."""
    monkeypatch.setattr(config_module.settings, "internal_api_key", TEST_KEY)
    monkeypatch.setattr(config_module.settings, "backend_api_key", TEST_KEY)
    # The dependency reads via settings accessor, but make doubly sure.
    monkeypatch.setattr(
        deps_module.settings, "internal_api_key", TEST_KEY, raising=False
    )
    monkeypatch.setattr(
        deps_module.settings, "backend_api_key", TEST_KEY, raising=False
    )
    yield


@pytest.fixture
def client():
    # Import inside the fixture so the monkeypatched settings are honoured by
    # app startup code that reads settings on import.
    from app.main import app

    return TestClient(app)


def _tiny_png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), color=(255, 255, 255)).save(buffer, format="PNG")
    return buffer.getvalue()


# ── /health stays public ────────────────────────────────────────────────────


def test_health_is_unauthenticated(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


# ── /ai/scan-invoice requires the key ───────────────────────────────────────


def test_scan_invoice_rejects_missing_auth(client):
    response = client.post(
        "/ai/scan-invoice",
        files={"file": ("invoice.png", _tiny_png_bytes(), "image/png")},
    )
    assert response.status_code == 401, response.text
    assert "invalid" in response.json()["detail"].lower() or "missing" in response.json()["detail"].lower()


def test_scan_invoice_rejects_wrong_bearer(client):
    response = client.post(
        "/ai/scan-invoice",
        files={"file": ("invoice.png", _tiny_png_bytes(), "image/png")},
        headers={"Authorization": "Bearer not-the-real-key"},
    )
    assert response.status_code == 401, response.text


def test_scan_invoice_accepts_valid_bearer_and_invokes_handler(
    client, monkeypatch
):
    """
    With the correct bearer the request must pass the auth gate and reach the
    handler. We replace the OCR extraction with a stub so we don't hit Gemini.
    A 200 (or any non-401/403) proves auth succeeded.
    """
    sentinel_response: dict[str, Any] = {
        "invoice_number": "INV-TEST-001",
        "supplier_name": "Test Supplier",
        "total_amount": 0.0,
        "currency": "BGN",
        "items": [],
    }

    async def _stub_extract(*args, **kwargs):
        return sentinel_response, {"stub": True}

    # The handler's heavy lifting happens in _extract_invoice_with_fallback.
    # Short-circuit it so the test doesn't touch network/LLM code.
    if hasattr(invoice_router, "_extract_invoice_with_fallback"):
        monkeypatch.setattr(
            invoice_router,
            "_extract_invoice_with_fallback",
            _stub_extract,
            raising=False,
        )

    response = client.post(
        "/ai/scan-invoice",
        files={"file": ("invoice.png", _tiny_png_bytes(), "image/png")},
        headers={"Authorization": f"Bearer {TEST_KEY}"},
    )

    # We don't care about the exact 2xx/4xx — we care that it's NOT 401 or 403.
    # A real downstream error (e.g. 500 from missing API keys in this sandbox)
    # still proves the auth middleware let us through.
    assert response.status_code not in (401, 403), (
        f"auth unexpectedly rejected valid bearer: {response.status_code} {response.text}"
    )


def test_scan_invoice_accepts_x_internal_api_key_header(client, monkeypatch):
    async def _stub_extract(*args, **kwargs):
        return (
            {
                "invoice_number": "INV-X",
                "supplier_name": "X",
                "total_amount": 0.0,
                "currency": "BGN",
                "items": [],
            },
            {"stub": True},
        )

    if hasattr(invoice_router, "_extract_invoice_with_fallback"):
        monkeypatch.setattr(
            invoice_router,
            "_extract_invoice_with_fallback",
            _stub_extract,
            raising=False,
        )

    response = client.post(
        "/ai/scan-invoice",
        files={"file": ("invoice.png", _tiny_png_bytes(), "image/png")},
        headers={"X-Internal-Api-Key": TEST_KEY},
    )
    assert response.status_code not in (401, 403), response.text


# ── /ai/match-products requires the key too ─────────────────────────────────


def test_match_products_rejects_missing_auth(client):
    response = client.post(
        "/ai/match-products",
        json={"line_items": [{"product_name": "test"}]},
    )
    assert response.status_code == 401
