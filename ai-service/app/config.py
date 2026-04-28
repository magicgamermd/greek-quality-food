from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # OpenAI
    openai_api_key: str = ""
    openai_vision_model: str = "gpt-4o-mini"

    # OpenRouter (optional OpenAI-compatible fallback)
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_vision_model: str = "openai/gpt-4o-mini"

    # Anthropic (Claude) — used for product matching & quick checks
    anthropic_api_key: str = ""

    # Google Gemini — primary OCR engine
    gemini_api_key: str = ""
    google_api_key: str = ""

    # Redis / Celery — MERT-M Redis на :6380 (Greek Foods държи :6379)
    redis_url: str = "redis://localhost:6380/0"

    # Warehouse backend (MERT-M на :3004 в dev; Greek Foods държи :3003)
    warehouse_api_url: str = "http://localhost:3004"

    # IMAP
    imap_host: str = "imap.gmail.com"
    imap_port: int = 993
    imap_user: str = ""
    imap_password: str = ""
    imap_folder: str = "INBOX"

    # Comarch
    comarch_api_url: str = "https://api.comarch.com"
    comarch_client_id: str = ""
    comarch_client_secret: str = ""
    comarch_company_id: str = ""

    # Backend auth (internal API key for service-to-service calls)
    # BACKEND_API_KEY: token this service sends when calling warehouse-backend.
    # INTERNAL_API_KEY: token this service REQUIRES on incoming /ai/* and /internal/* calls.
    # They are usually the same value (symmetric service-to-service secret).
    backend_api_key: str = ""
    internal_api_key: str = ""

    # CORS origin for the warehouse backend (only allowed browser origin).
    # Set BACKEND_ORIGIN env to a comma-separated list for multiple origins.
    # MERT-M backend на :3004 (Greek Foods държи :3003).
    backend_origin: str = "http://localhost:3004"

    # App
    debug: bool = False
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
