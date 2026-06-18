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

    # Redis / Celery — Greek Quality Food Redis на :6381 (Greek Foods държи :6379, MERT-M :6380)
    redis_url: str = "redis://localhost:6381/0"

    # Warehouse backend (Greek Quality Food на :3005 в dev; Greek Foods държи :3003, MERT-M :3004)
    warehouse_api_url: str = "http://localhost:3005"

    # IMAP
    imap_host: str = "imap.gmail.com"
    imap_port: int = 993
    imap_user: str = ""
    imap_password: str = ""
    imap_folder: str = "INBOX"

    # ⚠️ DEPRECATED for MERT-M: Comarch ERP settings inherited from
    # greek-foods-platform clone. MERT-M does not use Comarch — keep
    # values empty in .env so tasks become no-ops. See comarch_agent.py.
    comarch_api_url: str = ""  # was https://api.comarch.com (Greek Foods)
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
    # Greek Quality Food backend на :3005 (Greek Foods държи :3003, MERT-M :3004).
    backend_origin: str = "http://localhost:3005"

    # App
    debug: bool = False
    log_level: str = "INFO"

    class Config:
        env_file = ".env"
        case_sensitive = False


settings = Settings()
