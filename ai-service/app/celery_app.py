"""
Celery application factory.
Beat schedule wires periodic tasks.
"""
from celery import Celery
from celery.schedules import crontab

from app.config import settings

celery_app = Celery(
    "mertm_ai",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.tasks.email_agent",
        # ⚠️ DEPRECATED for MERT-M: Comarch ERP integration inherited from
        # greek-foods-platform clone. Task scheduled below is a no-op
        # against MERT-M (empty COMARCH_* env). See comarch_agent.py header.
        "app.tasks.comarch_agent",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="Europe/Sofia",
    enable_utc=True,
    worker_redirect_stdouts=False,
    beat_schedule={
        # Email payment agent — every 15 minutes
        "email-payment-agent": {
            "task": "app.tasks.email_agent.process_payment_emails",
            "schedule": crontab(minute="*/15"),
        },
        # ⚠️ DEPRECATED for MERT-M: Comarch bridge — every 30 minutes.
        # No-op against MERT-M (COMARCH_API_URL is empty). Kept scheduled
        # to minimise diff against upstream baseline. Remove entry +
        # tasks/comarch_agent.py to drop entirely.
        "comarch-bridge-agent": {
            "task": "app.tasks.comarch_agent.sync_comarch_orders",
            "schedule": crontab(minute="*/30"),
        },
    },
)
