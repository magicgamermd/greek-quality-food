"""
Email Payment Agent — Celery task (runs every 15 min)
Connects to an IMAP inbox, detects bank payment notifications,
extracts payment data, and POSTs to the warehouse backend.
"""
import email
import logging
import re
from datetime import datetime
from email.header import decode_header
from typing import Optional

import requests
from imapclient import IMAPClient

from app.celery_app import celery_app
from app.config import settings

logger = logging.getLogger(__name__)


# ── Payment extraction ────────────────────────────────────────────────────────

# Patterns for Bulgarian bank notification emails (DSK, UniCredit, Raiffeisen, etc.)
AMOUNT_PATTERNS = [
    r"(?:сума|amount|sum|наредена сума|получена сума)[:\s]+([0-9]+[.,][0-9]{2})\s*(?:лв|BGN|EUR|USD)?",
    r"([0-9]+[.,][0-9]{2})\s*(?:лв\.?|BGN)",
    r"Amount[:\s]+([0-9]+[.,][0-9]{2})",
]

REFERENCE_PATTERNS = [
    r"(?:основание|reference|ref|наредено от|вносител)[:\s]+([^\n\r]{3,80})",
    r"Reference[:\s]+([A-Z0-9\-/]{4,40})",
    r"(?:основание за плащане|payment reference)[:\s]+([^\n\r]{3,80})",
]

PAYER_PATTERNS = [
    r"(?:наредител|от|from|payer|наредено от)[:\s]+([^\n\r]{3,80})",
    r"Payer[:\s]+([^\n\r]{3,80})",
]

DATE_PATTERNS = [
    r"(\d{2}[./-]\d{2}[./-]\d{4})",
    r"(\d{4}-\d{2}-\d{2})",
]

BANK_KEYWORDS = [
    # BG bank notification subjects
    "плащане", "превод", "наредена сума", "получена сума",
    "payment", "bank transfer", "bank notification",
    "уведомление", "транзакция", "transaction",
    # Common senders
    "dskbank", "unicreditbulbank", "raiffeisen", "fibank", "postbank",
    "ubb.bg", "ccbank", "dsk.bg",
]


def _decode_header_value(raw) -> str:
    parts = decode_header(raw)
    decoded = []
    for part, enc in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(enc or "utf-8", errors="replace"))
        else:
            decoded.append(str(part))
    return " ".join(decoded)


def _is_payment_email(subject: str, sender: str, body: str) -> bool:
    combined = (subject + " " + sender + " " + body).lower()
    return any(kw in combined for kw in BANK_KEYWORDS)


def _extract_float(patterns: list[str], text: str) -> Optional[float]:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            raw = match.group(1).replace(",", ".").strip()
            try:
                return float(raw)
            except ValueError:
                continue
    return None


def _extract_str(patterns: list[str], text: str) -> Optional[str]:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def _extract_date(text: str) -> Optional[str]:
    for pattern in DATE_PATTERNS:
        match = re.search(pattern, text)
        if match:
            raw = match.group(1)
            for fmt in ("%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
                try:
                    return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    continue
    return None


def _parse_payment(subject: str, body: str) -> Optional[dict]:
    text = subject + "\n" + body

    amount = _extract_float(AMOUNT_PATTERNS, text)
    if not amount:
        return None  # Can't match without amount

    reference = _extract_str(REFERENCE_PATTERNS, text)
    payer = _extract_str(PAYER_PATTERNS, text)
    payment_date = _extract_date(text) or datetime.utcnow().strftime("%Y-%m-%d")

    return {
        "amount": amount,
        "reference": reference,
        "payer": payer,
        "date": payment_date,
        "raw_subject": subject,
    }


def _get_email_body(msg) -> str:
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() in ("text/plain", "text/html"):
                charset = part.get_content_charset() or "utf-8"
                body += part.get_payload(decode=True).decode(charset, errors="replace")
    else:
        charset = msg.get_content_charset() or "utf-8"
        body = msg.get_payload(decode=True).decode(charset, errors="replace")
    return body


# ── Celery task ───────────────────────────────────────────────────────────────

@celery_app.task(name="app.tasks.email_agent.process_payment_emails", bind=True, max_retries=3)
def process_payment_emails(self):
    """
    Celery beat task — runs every 15 minutes.
    Checks IMAP inbox for bank payment notifications and posts them
    to the warehouse backend for auto-matching against unpaid invoices.
    """
    if not settings.imap_user or not settings.imap_password:
        logger.warning("IMAP credentials not configured — skipping email agent")
        return {"skipped": True, "reason": "IMAP not configured"}

    logger.info(f"Email agent: connecting to {settings.imap_host} as {settings.imap_user}")
    processed = []
    errors = []

    try:
        with IMAPClient(settings.imap_host, port=settings.imap_port, ssl=True) as client:
            client.login(settings.imap_user, settings.imap_password)
            client.select_folder(settings.imap_folder)

            # Fetch UNSEEN messages
            uids = client.search(["UNSEEN"])
            logger.info(f"Email agent: found {len(uids)} unseen messages")

            for uid in uids:
                try:
                    raw = client.fetch([uid], ["RFC822"])
                    raw_email = raw[uid][b"RFC822"]
                    msg = email.message_from_bytes(raw_email)

                    subject = _decode_header_value(msg.get("Subject", ""))
                    sender = _decode_header_value(msg.get("From", ""))
                    body = _get_email_body(msg)

                    if not _is_payment_email(subject, sender, body):
                        # Not a payment email — mark seen and skip
                        client.add_flags([uid], [b"\\Seen"])
                        continue

                    payment = _parse_payment(subject, body)
                    if not payment:
                        logger.info(f"Email uid={uid}: payment email but could not extract amount")
                        client.add_flags([uid], [b"\\Seen"])
                        continue

                    # POST to warehouse backend
                    post_headers = {}
                    if settings.backend_api_key:
                        post_headers["Authorization"] = f"Bearer {settings.backend_api_key}"
                    resp = requests.post(
                        f"{settings.warehouse_api_url}/payments/auto-match",
                        json=payment,
                        headers=post_headers,
                        timeout=10,
                    )
                    resp.raise_for_status()

                    logger.info(f"Email uid={uid}: payment matched — {payment}")
                    processed.append({"uid": uid, "amount": payment["amount"], "reference": payment["reference"]})
                    client.add_flags([uid], [b"\\Seen"])

                except requests.RequestException as e:
                    logger.error(f"Email uid={uid}: backend POST failed — {e}")
                    errors.append({"uid": uid, "error": str(e)})
                except Exception as e:
                    logger.error(f"Email uid={uid}: processing error — {e}")
                    errors.append({"uid": uid, "error": str(e)})

    except Exception as exc:
        logger.exception(f"Email agent IMAP error: {exc}")
        raise self.retry(exc=exc, countdown=60)

    result = {"processed": len(processed), "errors": len(errors), "details": processed}
    logger.info(f"Email agent done: {result}")
    return result
