"""
Stock Forecast module — GET /ai/forecast/{product_id}
Uses moving average of sales data from the warehouse backend.
"""
import logging
from datetime import date, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


class ForecastResult(BaseModel):
    product_id: int
    product_name: Optional[str] = None
    current_stock: float
    avg_daily_sales: float
    predicted_depletion_date: Optional[str] = None  # YYYY-MM-DD or None if no sales
    days_remaining: Optional[int] = None
    confidence: float  # 0.0 - 1.0
    method: str = "moving_average_30d"
    note: Optional[str] = None


def _moving_average_forecast(
    sales_history: list[dict],  # [{date: "YYYY-MM-DD", quantity: float}]
    current_stock: float,
    window_days: int = 30,
) -> tuple[float, float, Optional[int]]:
    """
    Compute average daily sales using a moving average window.
    Returns (avg_daily_sales, confidence, days_remaining).
    """
    if not sales_history:
        return 0.0, 0.0, None

    # Sort by date descending, take last `window_days` entries
    sorted_sales = sorted(sales_history, key=lambda x: x.get("date", x.get("group_name", "")), reverse=True)
    window = sorted_sales[:window_days]

    if not window:
        return 0.0, 0.0, None

    total_qty = sum(float(s.get("total_quantity", s.get("quantity", 0))) for s in window)
    days_covered = len(window)
    avg_daily = total_qty / days_covered if days_covered > 0 else 0.0

    # Confidence: higher when we have more data points, full confidence at window_days
    confidence = min(days_covered / window_days, 1.0)

    if avg_daily <= 0:
        return avg_daily, confidence, None

    days_remaining = int(current_stock / avg_daily)
    return avg_daily, confidence, days_remaining


def _get_auth_headers() -> dict:
    """Build authorization headers for backend API calls."""
    headers = {}
    if settings.backend_api_key:
        headers["Authorization"] = f"Bearer {settings.backend_api_key}"
    return headers


@router.get("/forecast/{product_id}", response_model=ForecastResult)
async def get_forecast(product_id: int, window_days: int = 30):
    """
    Predict stock depletion date for a product using a moving average
    of historical sales data fetched from the warehouse backend.
    """
    backend = settings.warehouse_api_url
    headers = _get_auth_headers()

    try:
        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            # Get current stock level
            stock_resp = await client.get(f"{backend}/products/{product_id}/stock")
            if stock_resp.status_code == 404:
                raise HTTPException(status_code=404, detail=f"Product {product_id} not found")
            stock_resp.raise_for_status()
            stock_data = stock_resp.json()

            current_stock = float(stock_data.get("total_stock", stock_data.get("total_quantity", 0)))
            product_name = stock_data.get("name_en") or stock_data.get("name_bg") or f"Product {product_id}"

            # Get sales history using from/to date params
            date_from = (date.today() - timedelta(days=window_days * 2)).isoformat()
            date_to = date.today().isoformat()
            sales_resp = await client.get(
                f"{backend}/analytics/sales",
                params={
                    "product_id": product_id,
                    "from": date_from,
                    "to": date_to,
                    "group_by": "day",
                },
            )
            sales_resp.raise_for_status()
            sales_history = sales_resp.json().get("data", [])

    except HTTPException:
        raise
    except httpx.ConnectError:
        # Return a graceful response when backend is not reachable (dev/test mode)
        logger.warning(f"Cannot connect to backend at {backend}, returning mock forecast")
        return ForecastResult(
            product_id=product_id,
            current_stock=0,
            avg_daily_sales=0,
            confidence=0,
            note="Backend unreachable — cannot compute forecast",
        )
    except Exception as e:
        logger.exception(f"Forecast fetch error: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch data from backend: {str(e)}")

    avg_daily, confidence, days_remaining = _moving_average_forecast(
        sales_history, current_stock, window_days
    )

    depletion_date = None
    if days_remaining is not None:
        depletion_date = (date.today() + timedelta(days=days_remaining)).isoformat()

    note = None
    if avg_daily == 0:
        note = "No sales recorded in the selected window — cannot predict depletion."

    return ForecastResult(
        product_id=product_id,
        product_name=product_name,
        current_stock=current_stock,
        avg_daily_sales=round(avg_daily, 4),
        predicted_depletion_date=depletion_date,
        days_remaining=days_remaining,
        confidence=round(confidence, 2),
        method=f"moving_average_{window_days}d",
        note=note,
    )
