"""
Greek Foods AI Microservice
FastAPI application entry point.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.dependencies import require_internal_api_key
from app.routers import invoice, forecast, anomalies, match

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Greek Foods AI Service starting up...")
    yield
    logger.info("🛑 Greek Foods AI Service shutting down...")


app = FastAPI(
    title="Greek Foods AI Service",
    description="AI microservice for invoice OCR, payment matching, Comarch sync, forecasting and anomaly detection.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS is locked down to the warehouse-backend origin(s). Service-to-service
# calls from the backend go server-to-server and don't care about CORS at all,
# so in practice only browsers are affected; we keep this list tight to avoid
# drive-by requests from other origins.
_raw_origins = settings.backend_origin or "http://localhost:3003"
_allowed_origins = [origin.strip() for origin in _raw_origins.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,  # bearer auth, no cookies
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Internal-Api-Key", "x-scan-trace-id"],
)

# Routers.
# invoice and match routers already declare the auth dependency at the APIRouter
# level. forecast and anomalies don't, so we attach it here at mount-time to
# make sure every /ai/* route is gated. /health stays unauthenticated below so
# Docker healthchecks keep working.
_internal_deps = [Depends(require_internal_api_key)]
app.include_router(invoice.router, prefix="/ai", tags=["Invoice OCR"])
app.include_router(
    forecast.router, prefix="/ai", tags=["Stock Forecast"], dependencies=_internal_deps
)
app.include_router(
    anomalies.router,
    prefix="/ai",
    tags=["Anomaly Detection"],
    dependencies=_internal_deps,
)
app.include_router(match.router, prefix="/ai", tags=["Product Matching"])


@app.get("/health")
async def health():
    """Unauthenticated liveness probe for Docker/Kubernetes healthchecks."""
    return {"status": "ok", "service": "greek-foods-ai"}
