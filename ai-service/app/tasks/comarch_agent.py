"""
Comarch Bridge Agent — Celery task (runs every 30 min)

⚠️ DEPRECATED for MERT-M (2026-04-28): Comarch is a Polish ERP integration
inherited from the greek-foods-platform clone. MERT-M does NOT use Comarch
and never will. This task is currently a no-op because COMARCH_API_URL,
COMARCH_CLIENT_ID, and COMARCH_CLIENT_SECRET are intentionally empty in
MERT-M's ai-service .env, so any sync attempt fails fast and returns early.

Kept in the tree as dead code (rather than deleted) per Phase 3 decision
Q5(B) — minimise diff against the upstream baseline so future merges
remain mechanical. To remove entirely: delete this file, drop
"app.tasks.comarch_agent" from celery_app.py include list, and remove
the comarch-bridge-agent entry from beat_schedule.

Original docstring follows.
---
Fetches new orders from Comarch ERP API, creates them in the warehouse
backend, and updates Comarch order status after fulfillment.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

import requests

from app.celery_app import celery_app
from app.config import settings

logger = logging.getLogger(__name__)

# Redis key to store last sync timestamp
LAST_SYNC_KEY = "comarch:last_sync_at"


# ── Comarch API client ────────────────────────────────────────────────────────

class ComarchClient:
    """Minimal Comarch REST API client with token refresh."""

    def __init__(self):
        self.base_url = settings.comarch_api_url.rstrip("/")
        self.client_id = settings.comarch_client_id
        self.client_secret = settings.comarch_client_secret
        self.company_id = settings.comarch_company_id
        self._token: Optional[str] = None

    def _authenticate(self) -> str:
        resp = requests.post(
            f"{self.base_url}/auth/token",
            json={
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "grant_type": "client_credentials",
            },
            timeout=15,
        )
        resp.raise_for_status()
        self._token = resp.json()["access_token"]
        return self._token

    def _headers(self) -> dict:
        if not self._token:
            self._authenticate()
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "X-Company-Id": self.company_id,
        }

    def _get(self, path: str, params: dict = None, retry: bool = True) -> dict:
        resp = requests.get(
            f"{self.base_url}{path}",
            headers=self._headers(),
            params=params,
            timeout=20,
        )
        if resp.status_code == 401 and retry:
            # Token expired — refresh and retry once
            self._token = None
            return self._get(path, params, retry=False)
        resp.raise_for_status()
        return resp.json()

    def _patch(self, path: str, data: dict, retry: bool = True) -> dict:
        resp = requests.patch(
            f"{self.base_url}{path}",
            headers=self._headers(),
            json=data,
            timeout=20,
        )
        if resp.status_code == 401 and retry:
            self._token = None
            return self._patch(path, data, retry=False)
        resp.raise_for_status()
        return resp.json()

    def get_orders_since(self, since_iso: str) -> list[dict]:
        """Fetch orders created or modified after `since_iso` (ISO 8601)."""
        data = self._get(
            "/orders",
            params={"modifiedSince": since_iso, "status": "new,confirmed", "limit": 200},
        )
        return data.get("orders", data if isinstance(data, list) else [])

    def update_order_status(self, comarch_order_id: str, status: str) -> dict:
        """Update Comarch order status (e.g., 'fulfilled', 'shipped')."""
        return self._patch(f"/orders/{comarch_order_id}/status", {"status": status})


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_last_sync(redis_client) -> str:
    """Retrieve last sync timestamp from Redis, default to 30 min ago."""
    raw = redis_client.get(LAST_SYNC_KEY)
    if raw:
        return raw.decode() if isinstance(raw, bytes) else raw
    # Default: 1 hour ago
    from datetime import timedelta
    ts = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return ts


def _set_last_sync(redis_client, ts: str):
    redis_client.set(LAST_SYNC_KEY, ts)


def _map_comarch_order(order: dict) -> dict:
    """Map a Comarch order object to our warehouse backend format."""
    items = []
    for line in order.get("lines", order.get("items", [])):
        items.append({
            "product_sku": line.get("sku") or line.get("productCode"),
            "quantity": float(line.get("quantity", 0)),
            "unit_price": float(line.get("unitPrice", 0)),
            "total_price": float(line.get("totalPrice", 0)),
        })

    return {
        "comarch_order_id": str(order.get("id") or order.get("orderId")),
        "partner_name": order.get("customerName") or order.get("clientName"),
        "partner_eik": order.get("customerEik") or order.get("clientEik"),
        "order_date": order.get("orderDate") or order.get("createdAt"),
        "delivery_date": order.get("deliveryDate"),
        "notes": order.get("notes") or order.get("comment"),
        "total_amount": float(order.get("totalAmount", 0)),
        "items": items,
        "source": "comarch",
    }


# ── Celery task ───────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.tasks.comarch_agent.sync_comarch_orders",
    bind=True,
    max_retries=5,
    default_retry_delay=120,  # 2 minutes between retries
)
def sync_comarch_orders(self):
    """
    Celery beat task — runs every 30 minutes.
    1. Fetches new/updated Comarch orders since last sync.
    2. POSTs each to the warehouse backend /orders/from-comarch.
    3. After confirmed fulfillment, updates Comarch order status.
    """
    if not settings.comarch_client_id or not settings.comarch_client_secret:
        logger.warning("Comarch credentials not configured — skipping")
        return {"skipped": True, "reason": "Comarch credentials not configured"}

    import redis as redis_lib
    redis_client = redis_lib.from_url(settings.redis_url)

    now_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    last_sync = _get_last_sync(redis_client)

    logger.info(f"Comarch agent: syncing orders since {last_sync}")

    comarch = ComarchClient()
    created = []
    failed = []
    status_updated = []

    try:
        orders = comarch.get_orders_since(last_sync)
        logger.info(f"Comarch agent: fetched {len(orders)} orders")

        for order in orders:
            comarch_order_id = str(order.get("id") or order.get("orderId", "unknown"))
            mapped = _map_comarch_order(order)

            # ── Step 1: Create order in our backend ──────────────────────
            try:
                comarch_headers = {}
                if settings.backend_api_key:
                    comarch_headers["Authorization"] = f"Bearer {settings.backend_api_key}"
                resp = requests.post(
                    f"{settings.warehouse_api_url}/orders/from-comarch",
                    json=mapped,
                    headers=comarch_headers,
                    timeout=15,
                )

                if resp.status_code == 409:
                    # Already exists — check if fulfilled
                    logger.info(f"Order {comarch_order_id} already in system")
                    existing = resp.json()
                    if existing.get("status") == "fulfilled":
                        _try_update_comarch_status(comarch, comarch_order_id, "fulfilled", status_updated)
                    continue

                resp.raise_for_status()
                our_order = resp.json()
                our_order_id = our_order.get("id")
                created.append({"comarch_id": comarch_order_id, "our_id": our_order_id})
                logger.info(f"Comarch order {comarch_order_id} → warehouse order {our_order_id}")

            except requests.RequestException as e:
                logger.error(f"Failed to create order {comarch_order_id}: {e}")
                failed.append({"comarch_id": comarch_order_id, "error": str(e)})
                continue

        # ── Step 2: Check fulfilled orders and update Comarch ─────────────
        try:
            fulfilled_headers = {}
            if settings.backend_api_key:
                fulfilled_headers["Authorization"] = f"Bearer {settings.backend_api_key}"
            fulfilled_resp = requests.get(
                f"{settings.warehouse_api_url}/orders",
                params={"source": "comarch", "status": "fulfilled", "synced": "false"},
                headers=fulfilled_headers,
                timeout=15,
            )
            fulfilled_resp.raise_for_status()
            fulfilled_orders = fulfilled_resp.json().get("data", [])

            for fo in fulfilled_orders:
                comarch_id = fo.get("comarch_order_id")
                if comarch_id:
                    _try_update_comarch_status(comarch, comarch_id, "shipped", status_updated)

        except Exception as e:
            logger.warning(f"Could not fetch fulfilled orders for Comarch status update: {e}")

    except Exception as exc:
        logger.exception(f"Comarch agent error: {exc}")
        raise self.retry(exc=exc)

    # Update last sync timestamp
    _set_last_sync(redis_client, now_ts)

    result = {
        "synced_at": now_ts,
        "orders_created": len(created),
        "orders_failed": len(failed),
        "comarch_status_updated": len(status_updated),
        "details": {"created": created, "failed": failed},
    }
    logger.info(f"Comarch agent done: {result}")
    return result


def _try_update_comarch_status(
    client: ComarchClient,
    comarch_order_id: str,
    status: str,
    status_updated: list,
):
    try:
        client.update_order_status(comarch_order_id, status)
        status_updated.append({"comarch_id": comarch_order_id, "new_status": status})
        logger.info(f"Comarch order {comarch_order_id} → status={status}")
    except Exception as e:
        logger.error(f"Failed to update Comarch status for {comarch_order_id}: {e}")
