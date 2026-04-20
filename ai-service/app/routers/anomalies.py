"""
Anomaly Detection — GET /ai/anomalies
Compares physical (scan-based) vs system inventory trends and flags discrepancies.
"""
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


class AnomalyItem(BaseModel):
    product_id: int
    product_name: Optional[str] = None
    system_stock: float
    physical_stock: Optional[float] = None
    discrepancy: float  # system - physical
    discrepancy_pct: float  # % of system stock
    severity: float  # 0.0 (low) to 1.0 (critical)
    severity_label: str  # low | medium | high | critical
    description: str


class AnomalyReport(BaseModel):
    total_products_checked: int
    anomalies_found: int
    anomalies: list[AnomalyItem]


def _severity(discrepancy_pct: float) -> tuple[float, str]:
    """Map discrepancy percentage to severity score and label."""
    abs_pct = abs(discrepancy_pct)
    if abs_pct < 3:
        return 0.1, "low"
    elif abs_pct < 10:
        return 0.4, "medium"
    elif abs_pct < 25:
        return 0.7, "high"
    else:
        return 1.0, "critical"


def _detect_anomalies(inventory_data: list[dict]) -> list[AnomalyItem]:
    """
    Core anomaly detection logic.
    Each inventory record must have: product_id, product_name, system_quantity, physical_quantity.
    """
    anomalies = []

    for item in inventory_data:
        product_id = item.get("product_id", 0)
        product_name = item.get("name_en") or item.get("name_bg") or f"Product {product_id}"
        system_stock = float(item.get("system_quantity", item.get("total_stock", 0)))
        physical_stock_raw = item.get("physical_quantity")

        # Skip if no physical count recorded
        if physical_stock_raw is None:
            continue

        physical_stock = float(physical_stock_raw)
        discrepancy = system_stock - physical_stock

        if system_stock == 0:
            discrepancy_pct = 100.0 if physical_stock != 0 else 0.0
        else:
            discrepancy_pct = (discrepancy / system_stock) * 100

        # Only flag when discrepancy is meaningful (>= 2% or >= 0.5 unit absolute)
        if abs(discrepancy_pct) < 2 and abs(discrepancy) < 0.5:
            continue

        severity_score, severity_label = _severity(discrepancy_pct)

        if discrepancy > 0:
            direction = f"System shows {discrepancy:.2f} more than physical count"
        else:
            direction = f"Physical count shows {abs(discrepancy):.2f} more than system"

        description = (
            f"{direction} ({discrepancy_pct:+.1f}%). "
            f"System: {system_stock}, Physical: {physical_stock}."
        )

        anomalies.append(AnomalyItem(
            product_id=product_id,
            product_name=product_name,
            system_stock=system_stock,
            physical_stock=physical_stock,
            discrepancy=round(discrepancy, 4),
            discrepancy_pct=round(discrepancy_pct, 2),
            severity=severity_score,
            severity_label=severity_label,
            description=description,
        ))

    # Sort by severity descending
    anomalies.sort(key=lambda x: x.severity, reverse=True)
    return anomalies


def _get_auth_headers() -> dict:
    """Build authorization headers for backend API calls."""
    headers = {}
    if settings.backend_api_key:
        headers["Authorization"] = f"Bearer {settings.backend_api_key}"
    return headers


@router.get("/anomalies", response_model=AnomalyReport)
async def get_anomalies(min_severity: float = 0.0):
    """
    Fetch inventory levels from the warehouse backend, compare physical
    vs system stock, and return anomalies ranked by severity.

    Query params:
    - min_severity: filter out anomalies below this score (0.0-1.0)
    """
    backend = settings.warehouse_api_url
    headers = _get_auth_headers()

    try:
        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
            resp = await client.get(f"{backend}/inventory")
            resp.raise_for_status()
            inventory_data = resp.json().get("data", resp.json() if isinstance(resp.json(), list) else [])

    except httpx.ConnectError:
        logger.warning(f"Cannot connect to backend at {backend}")
        return AnomalyReport(
            total_products_checked=0,
            anomalies_found=0,
            anomalies=[],
        )
    except Exception as e:
        logger.exception(f"Anomaly fetch error: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch inventory from backend: {str(e)}")

    all_anomalies = _detect_anomalies(inventory_data)
    filtered = [a for a in all_anomalies if a.severity >= min_severity]

    return AnomalyReport(
        total_products_checked=len(inventory_data),
        anomalies_found=len(filtered),
        anomalies=filtered,
    )
