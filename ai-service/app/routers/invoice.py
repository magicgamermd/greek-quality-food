"""
Invoice OCR module — POST /ai/scan-invoice
3-layer pipeline:
  Layer 1: Gemini 2.5 Pro for OCR + structured extraction
  Layer 2: Few-shot learning per supplier (invoice_templates)
  Layer 3: Validation (arithmetic checks on totals)
"""
import base64
import io
import json
import logging
import os
import re
import time
from datetime import datetime
from threading import Lock
from typing import Optional, TYPE_CHECKING

import PyPDF2
try:
    import pytesseract
    HAS_TESSERACT = True
except ImportError:
    HAS_TESSERACT = False
from dateutil.relativedelta import relativedelta
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Response, UploadFile

from app.dependencies import require_internal_api_key
from google import genai
from PIL import Image
from pydantic import BaseModel, Field, model_validator

# Register HEIC / HEIF decoder with Pillow. iPhone invoices arrive in HEIC
# (Apple's default since iOS 11) and Pillow 10 does not understand that
# container by itself — without this import `Image.open(...heic)` raises
# UnidentifiedImageError. The `register_heif_opener()` call patches
# Pillow's plugin registry so subsequent Image.open() calls transparently
# decode .heic / .heif, then the rest of the OCR / preprocessing pipeline
# treats them like any JPEG.
try:
    from pillow_heif import register_heif_opener as _register_heif_opener

    _register_heif_opener()
except ImportError:  # pragma: no cover — fall back silently if dep missing
    logging.getLogger(__name__).warning(
        "pillow-heif not installed; .heic uploads will be rejected. "
        "Install with `pip install pillow-heif`."
    )

from app.config import settings

if TYPE_CHECKING:
    from openai import OpenAI


logger = logging.getLogger(__name__)
# Every route on this router requires the internal API key; the warehouse-backend
# is the only intended caller.
router = APIRouter(dependencies=[Depends(require_internal_api_key)])

SCAN_TRACE_HEADER = "x-scan-trace-id"


def _generate_scan_trace_id() -> str:
    return f"scan-{int(time.time() * 1000):x}-{os.urandom(6).hex()}"


def _resolve_scan_trace_id(trace_id: Optional[str]) -> str:
    normalized = (trace_id or "").strip()
    return normalized or _generate_scan_trace_id()


def _scan_log(event: str, trace_id: str, **fields) -> None:
    payload = {"event": event, "trace_id": trace_id, **fields}
    logger.info("[invoice.scan] %s", json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))


TEMPLATE_CACHE_TTL_SECONDS = max(30, int(os.environ.get("SCAN_TEMPLATE_CACHE_TTL_SECONDS", "300")))
_template_cache_lock = Lock()
_template_cache: dict[tuple[str, int], tuple[float, list[dict]]] = {}


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# ── Gemini client ─────────────────────────────────────────────────────────────

def _get_gemini_client() -> genai.Client:
    api_key = settings.gemini_api_key or settings.google_api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY / GOOGLE_API_KEY not configured — cannot scan invoices")
    return genai.Client(api_key=api_key)


def _clean_json_response_text(raw_text: str) -> str:
    raw = (raw_text or "").strip()
    if raw.startswith("```"):
        first_newline = raw.index("\n") if "\n" in raw else 3
        raw = raw[first_newline + 1:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()
    return raw


def _get_gemini_response_text(response) -> str | None:
    raw_text = getattr(response, "text", None)
    if raw_text and str(raw_text).strip():
        return str(raw_text).strip()

    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return None

    parts = getattr(candidates[0].content, "parts", None) or []
    texts = [
        str(getattr(part, "text", "")).strip()
        for part in parts
        if getattr(part, "text", None)
    ]
    if not texts:
        return None
    return "\n".join(texts).strip()


def _is_gemini_fallback_error(err: Exception) -> bool:
    msg = str(err).lower()
    fallback_signals = (
        "gemini_api_key / google_api_key not configured",
        "resource exhausted",
        "resource_exhausted",
        "quota",
        "rate limit",
        "too many requests",
        "429",
        "503",
        "service unavailable",
        "temporarily unavailable",
        "internal error",
        "connection reset",
        "connection aborted",
        "timed out",
        "timeout",
        "empty response from gemini",
        "gemini returned empty response",
        "no candidates",
        "provider",
    )
    return any(sig in msg for sig in fallback_signals)


# ── Batch number helper ───────────────────────────────────────────────────────

def batch_from_prod_date(prod_str: str) -> Optional[str]:
    """Batch number = DDMMYYYY from production date."""
    try:
        d = datetime.strptime(prod_str, "%Y-%m-%d")
        return f"{d.day:02d}{d.month:02d}{d.year}"
    except Exception:
        return None


def auto_batch_from_expiry(expiry_str: str) -> Optional[str]:
    """Derive production date from expiry - 2 months, format as DDMMYYYY."""
    try:
        expiry = datetime.strptime(expiry_str, "%Y-%m-%d")
        production = expiry - relativedelta(months=2)
        return batch_from_prod_date(production.strftime("%Y-%m-%d"))
    except Exception:
        return None


# ── Pydantic models ──────────────────────────────────────────────────────────

class LineItem(BaseModel):
    row_number: Optional[int] = None
    page_number: Optional[int] = None
    product_name_raw: Optional[str] = None
    product_name: Optional[str] = None
    product_code_raw: Optional[str] = None
    name_bg: Optional[str] = None
    product_code: Optional[str] = None
    brand: Optional[str] = None
    category_hint: Optional[str] = None
    quantity: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    gross_price: Optional[float] = None
    discount_percent: Optional[float] = None
    discount_amount: Optional[float] = None
    batch_number_raw: Optional[str] = None
    batch_number: Optional[str] = None
    expiry_date_raw: Optional[str] = None
    expiry_date: Optional[str] = None
    production_date: Optional[str] = None
    notes_raw: Optional[str] = None
    auto_batch: Optional[str] = None
    total_price: Optional[float] = None

    @model_validator(mode="after")
    def _sync_legacy_and_raw_fields(self) -> "LineItem":
        if not self.product_name_raw and self.product_name:
            self.product_name_raw = self.product_name
        if not self.product_name and self.product_name_raw:
            self.product_name = self.product_name_raw

        if self.product_code_raw is None and self.product_code is not None:
            self.product_code_raw = self.product_code
        if self.product_code is None and self.product_code_raw is not None:
            self.product_code = self.product_code_raw

        if self.batch_number_raw is None and self.batch_number is not None:
            self.batch_number_raw = self.batch_number
        if self.batch_number is None and self.batch_number_raw is not None:
            self.batch_number = self.batch_number_raw

        if self.expiry_date_raw is None and self.expiry_date is not None:
            self.expiry_date_raw = self.expiry_date
        if self.expiry_date is None and self.expiry_date_raw is not None:
            self.expiry_date = self.expiry_date_raw

        if not self.product_name_raw and not self.product_name:
            self.product_name_raw = "UNKNOWN_ITEM"
            self.product_name = "UNKNOWN_ITEM"
        return self


class ValidationError(BaseModel):
    field: str
    message: str
    expected: Optional[float] = None
    actual: Optional[float] = None


class InvoiceScanResult(BaseModel):
    document_type: Optional[str] = None
    needs_companion_doc: bool = False
    missing_batch: bool = False
    missing_expiry: bool = False
    supplier_name: Optional[str] = None
    supplier_eik: Optional[str] = None
    supplier_vat: Optional[str] = None
    supplier_address: Optional[str] = None
    supplier_phone: Optional[str] = None
    supplier_email: Optional[str] = None
    supplier_contact: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    total_net: Optional[float] = None
    total_vat: Optional[float] = None
    total_gross: Optional[float] = None
    currency: Optional[str] = "BGN"
    line_items: list[LineItem] = Field(default_factory=list)
    visible_row_count: int = 0
    extracted_row_count: int = 0
    completeness_status: str = "suspicious"
    warnings: list[str] = Field(default_factory=list)
    raw_text: Optional[str] = None
    # Layer 3: Validation results
    validation_passed: bool = True
    validation_errors: list[ValidationError] = Field(default_factory=list)
    few_shot_used: bool = False
    few_shot_supplier: Optional[str] = None


class ConfirmTemplateRequest(BaseModel):
    supplier_name: str
    supplier_eik: Optional[str] = None
    image_base64: str
    extracted_json: dict


class InvoiceTemplate(BaseModel):
    id: int
    supplier_name: str
    supplier_eik: Optional[str] = None
    extracted_json: dict
    created_at: str
    confirmed: bool


# ── Image helpers ────────────────────────────────────────────────────────────

def _load_oriented_rgb_image(image_bytes: bytes) -> Image.Image:
    from PIL import ImageOps

    return ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")


def _maybe_normalize_heic(
    raw_bytes: bytes,
    content_type: str,
    filename: str,
) -> tuple[bytes, str]:
    """Detect HEIC/HEIF input and transcode to JPEG so the rest of the
    pipeline (which assumes JPEG/PNG/PDF) can handle it uniformly.

    Browsers frequently upload .heic with content_type="application/octet-stream"
    because the HEIC MIME type isn't in older browser databases — we fall
    back to the filename extension when that happens.

    Returns (possibly-rewritten bytes, effective mime_type). JPEG quality 92
    preserves enough detail for OCR while keeping the payload well under
    Claude/Gemini's 5 MB base64 limit for typical iPhone photos.
    """
    lower_name = (filename or "").lower()
    lower_ct = (content_type or "").lower()
    looks_heic = (
        lower_ct in {"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"}
        or lower_name.endswith((".heic", ".heif"))
    )
    if not looks_heic:
        return raw_bytes, content_type

    try:
        img = Image.open(io.BytesIO(raw_bytes))
        # HEIC often carries EXIF orientation; respect it before re-encoding
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img).convert("RGB")
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=92, optimize=True)
        return out.getvalue(), "image/jpeg"
    except Exception as e:  # pragma: no cover
        logger.error(f"HEIC transcode failed for {filename}: {e}")
        raise HTTPException(
            status_code=400,
            detail=(
                "HEIC/HEIF image could not be decoded. Make sure pillow-heif "
                "is installed and the file isn't corrupted."
            ),
        )


def _image_to_base64(image_bytes: bytes, mime_type: str) -> tuple[str, str]:
    """Convert image bytes to base64, normalizing mobile photos before upload."""
    MAX_DIMENSION = 8000
    MAX_BASE64_BYTES = 5 * 1024 * 1024
    MAX_RAW_BYTES = int(MAX_BASE64_BYTES / 1.37)
    MIN_WIDTH_FOR_SCAN = 1700
    try:
        img = _load_oriented_rgb_image(image_bytes)
        original_w, original_h = img.size
        w, h = original_w, original_h
        changed = False

        if w < MIN_WIDTH_FOR_SCAN:
            scale = MIN_WIDTH_FOR_SCAN / max(1, w)
            new_w, new_h = int(w * scale), int(h * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            w, h = img.size
            changed = True

        if w > MAX_DIMENSION or h > MAX_DIMENSION:
            scale = min(MAX_DIMENSION / w, MAX_DIMENSION / h)
            new_w, new_h = int(w * scale), int(h * scale)
            img = img.resize((new_w, new_h), Image.LANCZOS)
            w, h = img.size
            changed = True

        save_quality = 92
        if len(image_bytes) > MAX_RAW_BYTES:
            scale = (MAX_RAW_BYTES / max(1, len(image_bytes))) ** 0.5
            new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
            img = img.resize((new_w, new_h), Image.LANCZOS)
            w, h = img.size
            changed = True
            save_quality = 85

        if changed:
            logger.info(
                "Normalized upload image from %sx%s to %sx%s before Gemini scan",
                original_w,
                original_h,
                w,
                h,
            )
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=save_quality)
            image_bytes = buf.getvalue()
            mime_type = "image/jpeg"
        else:
            logger.info(f"Image {w}x{h} ({len(image_bytes)} bytes) — no normalization needed")

        b64 = base64.b64encode(image_bytes).decode("utf-8")
        if len(b64) > MAX_BASE64_BYTES:
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            image_bytes = buf.getvalue()
            b64 = base64.b64encode(image_bytes).decode("utf-8")
            mime_type = "image/jpeg"
    except Exception as e:
        logger.warning(f"Image processing failed: {e}, using original")
        b64 = base64.b64encode(image_bytes).decode("utf-8")
    return b64, mime_type


def _build_mobile_photo_assist_images(image_bytes: bytes) -> list[bytes]:
    """Create helper renderings for difficult camera photos.

    We intentionally produce multiple OCR-oriented variants:
    - sharpened grayscale
    - hard binary threshold
    - softer threshold for faint receipts/invoices
    - contrast-boosted RGB to preserve colored/low-contrast glyphs
    """
    from PIL import ImageEnhance, ImageFilter, ImageOps

    try:
        img = _load_oriented_rgb_image(image_bytes)
        if img.width < 2400:
            scale = 2400 / max(1, img.width)
            img = img.resize(
                (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                Image.LANCZOS,
            )

        rgb = img.filter(ImageFilter.MedianFilter(size=3))
        rgb = ImageEnhance.Sharpness(rgb).enhance(1.35)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.15)

        gray = rgb.convert("L")
        gray = ImageOps.autocontrast(gray, cutoff=1)
        gray = ImageEnhance.Contrast(gray).enhance(2.2)
        gray = gray.filter(ImageFilter.UnsharpMask(radius=1.8, percent=220, threshold=2))

        variants = [
            Image.merge("RGB", (gray, gray, gray)),
            rgb,
        ]

        # For tall mobile photos, add overlapping zoomed crops so the model can read
        # dense line-item rows without losing global layout from the original image.
        if rgb.height > rgb.width * 1.1:
            crop_height = int(rgb.height * 0.55)
            step = max(1, int((rgb.height - crop_height) / 2))
            crop_starts = [0, step, max(0, rgb.height - crop_height)]
            seen_boxes: set[tuple[int, int, int, int]] = set()
            for top in crop_starts:
                box = (0, top, rgb.width, min(rgb.height, top + crop_height))
                if box in seen_boxes:
                    continue
                seen_boxes.add(box)
                crop_rgb = rgb.crop(box)
                if crop_rgb.width < 2200:
                    scale = 2200 / max(1, crop_rgb.width)
                    crop_rgb = crop_rgb.resize(
                        (max(1, int(crop_rgb.width * scale)), max(1, int(crop_rgb.height * scale))),
                        Image.LANCZOS,
                    )
                variants.append(crop_rgb)

        hard_binary = ImageOps.autocontrast(gray, cutoff=0)
        hard_binary = ImageEnhance.Brightness(hard_binary).enhance(1.08)
        hard_binary = hard_binary.point(lambda px: 255 if px > 170 else 0, mode="L")
        variants.append(Image.merge("RGB", (hard_binary, hard_binary, hard_binary)))

        soft_binary = ImageOps.autocontrast(gray, cutoff=0)
        soft_binary = ImageEnhance.Brightness(soft_binary).enhance(1.04)
        soft_binary = soft_binary.point(lambda px: 255 if px > 145 else 0, mode="L")
        variants.append(Image.merge("RGB", (soft_binary, soft_binary, soft_binary)))

        outputs: list[bytes] = []
        seen: set[bytes] = set()
        for variant in variants:
            buf = io.BytesIO()
            variant.save(buf, format="JPEG", quality=92)
            enhanced_bytes = buf.getvalue()
            if enhanced_bytes and enhanced_bytes != image_bytes and enhanced_bytes not in seen:
                outputs.append(enhanced_bytes)
                seen.add(enhanced_bytes)
        return outputs
    except Exception as e:
        logger.warning(f"Mobile photo assist image generation failed: {e}")
        return []


def _build_mobile_photo_assist_image(image_bytes: bytes) -> bytes | None:
    """Backwards-compatible single-image helper used by older tests/callers."""
    variants = _build_mobile_photo_assist_images(image_bytes)
    return variants[0] if variants else None


def _should_enable_mobile_photo_assist(image_bytes: bytes) -> bool:
    if _env_flag("SCAN_FORCE_MOBILE_ASSIST", False):
        return True
    if not _env_flag("SCAN_AUTO_MOBILE_ASSIST", False):
        return False

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            width, height = img.size
    except Exception:
        width = 0
        height = 0

    largest_edge = max(width, height)
    smallest_edge = min(width, height) if width and height else 0
    is_high_res_photo = largest_edge >= 2200 and smallest_edge >= 1500
    is_narrow_capture = smallest_edge > 0 and (largest_edge / max(smallest_edge, 1)) >= 1.55
    return is_high_res_photo or is_narrow_capture


def _image_to_scan_parts(
    image_bytes: bytes,
    mime_type: str,
    *,
    include_mobile_photo_assist: bool = False,
    max_assist_images: int = 1,
) -> list[tuple[str, str]]:
    parts: list[tuple[str, str]] = [_image_to_base64(image_bytes, mime_type)]
    if not include_mobile_photo_assist:
        return parts

    if max_assist_images <= 0:
        return parts

    assist_images = _build_mobile_photo_assist_images(image_bytes)
    for assist_bytes in assist_images[:max_assist_images]:
        assist_part = _image_to_base64(assist_bytes, "image/jpeg")
        if assist_part != parts[0] and assist_part not in parts:
            parts.append(assist_part)

    if len(parts) > 1:
        logger.info("Added %d enhanced mobile-photo assist image(s) for invoice scan", len(parts) - 1)
    return parts


def preprocess_for_ocr(image_bytes: bytes) -> bytes:
    """Preprocess image for Tesseract: grayscale, contrast, upscale."""
    from PIL import ImageOps, ImageFilter, ImageEnhance
    try:
        img = _load_oriented_rgb_image(image_bytes)
        gray = img.convert("L")
        w, h = gray.size
        if w < 2600:
            scale = 2600 / max(1, w)
            new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
            gray = gray.resize((new_w, new_h), Image.LANCZOS)
            logger.info(f"Upscaled OCR image from {w}x{h} to {new_w}x{new_h}")
        gray = gray.filter(ImageFilter.MedianFilter(size=3))
        gray = ImageEnhance.Contrast(gray).enhance(2.0)
        gray = ImageOps.autocontrast(gray, cutoff=1)
        gray = gray.filter(ImageFilter.UnsharpMask(radius=1.5, percent=180, threshold=2))
        buf = io.BytesIO()
        gray.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"PIL preprocess failed ({e}), returning original bytes")
        return image_bytes


_TESSERACT_LANG = None

def _get_tesseract_lang() -> str:
    global _TESSERACT_LANG
    if _TESSERACT_LANG is not None:
        return _TESSERACT_LANG
    if not HAS_TESSERACT:
        _TESSERACT_LANG = "eng"
        return _TESSERACT_LANG
    try:
        langs = pytesseract.get_languages()
        parts = []
        if "ell" in langs:
            parts.append("ell")
        if "bul" in langs:
            parts.append("bul")
        parts.append("eng")
        _TESSERACT_LANG = "+".join(parts)
        logger.info(f"Tesseract languages: {_TESSERACT_LANG}")
    except Exception:
        _TESSERACT_LANG = "eng"
    return _TESSERACT_LANG


def extract_text_tesseract(preprocessed_bytes: bytes) -> str:
    if not HAS_TESSERACT:
        return ""
    pil_img = Image.open(io.BytesIO(preprocessed_bytes))
    raw_text = pytesseract.image_to_string(
        pil_img, config=f"--oem 3 --psm 6 -l {_get_tesseract_lang()}"
    )
    logger.info(f"Tesseract OCR: {len(raw_text)} chars")
    return raw_text


def _pdf_to_images_base64(pdf_bytes: bytes) -> list[tuple[str, str]]:
    max_pages = max(1, int(os.environ.get("SCAN_MAX_PDF_PAGES", "8")))
    results = []
    try:
        import fitz
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            mat = fitz.Matrix(2.0, 2.0)
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            results.append((b64, "image/png"))
        doc.close()
        return results
    except ImportError:
        pass
    reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
    for i, page in enumerate(reader.pages[:max_pages]):
        text = page.extract_text() or ""
        results.append((text, "text/plain"))
    return results


# ── Layer 2: Few-shot template DB helpers ────────────────────────────────────

def _get_db_connection():
    """Get a database connection to the warehouse backend's PostgreSQL."""
    import psycopg2
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        return None
    try:
        return psycopg2.connect(db_url)
    except Exception as e:
        logger.warning(f"Could not connect to DB for templates: {e}")
        return None


def _fetch_templates(supplier_name: str, limit: int = 3) -> list[dict]:
    """Fetch confirmed invoice templates for a supplier."""
    cache_key = ((supplier_name or "").strip().lower(), limit)
    now = time.time()
    with _template_cache_lock:
        cached = _template_cache.get(cache_key)
        if cached and (now - cached[0]) < TEMPLATE_CACHE_TTL_SECONDS:
            return cached[1]

    conn = _get_db_connection()
    if not conn:
        return []
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT image_base64, extracted_json
               FROM invoice_templates
               WHERE confirmed = true
                 AND LOWER(supplier_name) = LOWER(%s)
               ORDER BY created_at DESC
               LIMIT %s""",
            (supplier_name, limit),
        )
        rows = cur.fetchall()
        templates = [{"image_base64": r[0], "extracted_json": r[1]} for r in rows]
        with _template_cache_lock:
            _template_cache[cache_key] = (now, templates)
        return templates
    except Exception as e:
        logger.warning(f"Failed to fetch templates: {e}")
        return []
    finally:
        conn.close()


def _save_template(supplier_name: str, supplier_eik: str | None, image_base64: str, extracted_json: dict) -> int | None:
    """Save a confirmed invoice template."""
    conn = _get_db_connection()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO invoice_templates (supplier_name, supplier_eik, image_base64, extracted_json, confirmed)
               VALUES (%s, %s, %s, %s, true)
               RETURNING id""",
            (supplier_name, supplier_eik, image_base64, json.dumps(extracted_json)),
        )
        row = cur.fetchone()
        conn.commit()
        return row[0] if row else None
    except Exception as e:
        logger.warning(f"Failed to save template: {e}")
        conn.rollback()
        return None
    finally:
        conn.close()


def _list_templates(supplier_name: str | None = None) -> list[dict]:
    """List invoice templates, optionally filtered by supplier."""
    conn = _get_db_connection()
    if not conn:
        return []
    try:
        cur = conn.cursor()
        if supplier_name:
            cur.execute(
                """SELECT id, supplier_name, supplier_eik, extracted_json, created_at, confirmed
                   FROM invoice_templates
                   WHERE LOWER(supplier_name) = LOWER(%s)
                   ORDER BY created_at DESC""",
                (supplier_name,),
            )
        else:
            cur.execute(
                """SELECT id, supplier_name, supplier_eik, extracted_json, created_at, confirmed
                   FROM invoice_templates
                   ORDER BY created_at DESC
                   LIMIT 50"""
            )
        rows = cur.fetchall()
        return [
            {
                "id": r[0],
                "supplier_name": r[1],
                "supplier_eik": r[2],
                "extracted_json": r[3],
                "created_at": r[4].isoformat() if r[4] else None,
                "confirmed": r[5],
            }
            for r in rows
        ]
    except Exception as e:
        logger.warning(f"Failed to list templates: {e}")
        return []
    finally:
        conn.close()


# ── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an expert OCR assistant for a Bulgarian food distribution warehouse.
Extract structured data from invoice images. The invoice may be in Greek, Bulgarian, or English.

DOCUMENT TYPE CLASSIFICATION — identify which of these 6 types the document is:
- type1: products + prices only (no batch numbers, no expiry dates)
- type2_invoice: invoice portion of a two-part document (no batch, no expiry) — requires a companion conformity doc
- type2_companion: conformity/declaration document that accompanies type2_invoice (has expiry dates, possibly batch)
- type3: products + prices + handwritten batch numbers in margins or as annotations
- type4_invoice: products + prices + batch numbers in a dedicated column
- type4_companion: weighing record / протокол that has batch numbers + expiry dates
- type5: products + prices + expiry dates visible, but NO batch numbers

Return ONLY valid JSON with this exact structure:
{
  "document_type": "type5",
  "needs_companion_doc": false,
  "missing_batch": true,
  "missing_expiry": false,
  "supplier_name": "...",
  "supplier_eik": "...",
  "supplier_vat": "...",
  "supplier_address": "...",
  "supplier_phone": "...",
  "supplier_email": "...",
  "supplier_contact": "...",
  "invoice_number": "...",
  "invoice_date": "YYYY-MM-DD",
  "line_items": [
    {
      "row_number": 1,
      "page_number": 1,
      "product_name_raw": "ORIGINAL NAME AS ON INVOICE",
      "product_code_raw": "1002",
      "quantity": 10.0,
      "unit": "кг",
      "unit_price": 4.125,
      "gross_price": 5.50,
      "discount_percent": 25.0,
      "discount_amount": 1.375,
      "batch_number_raw": null,
      "expiry_date_raw": "YYYY-MM-DD",
      "total_price": 41.25,
      "notes_raw": null
    }
  ],
  "visible_row_count": 11,
  "extracted_row_count": 11,
  "completeness_status": "complete",
  "warnings": [],
  "total_net": 100.00,
  "total_vat": 20.00,
  "total_gross": 120.00,
  "currency": "BGN"
}

Rules:
- line_items MUST be in the EXACT ORDER they appear on the invoice (row 1, row 2, etc.)
- If the invoice has a row number column (Α/Α, №, #), use it to verify order and completeness.
- NEVER skip a row. If you extracted 10 items but the last row number is 11, find the missing one.
- row_number: include integer row number per line item. If no row-number column exists, assign sequential 1..N in visual order.
- page_number: page index for this row (first page = 1). If unknown, use 1.
- supplier_name: full company/person name from the invoice header.
- supplier_eik: TAX ID / VAT number (9-10 digits).
    Labeled as: ΑΦΜ, VAT.REG.NO, VAT No, A.F.M., EIK, ЕИК, ЕИК/BULSTAT.
    May have country prefix: "EL-094466230", "BG123456789", "EL094466230".
    ⚠️ DO NOT confuse with Γ.Ε.ΜΗ / Γ.Ε.ΜΗ. / G.E.MI / GEMI / ΑΡ.ΓΕΜΗ — that is the
    Greek GENERAL COMMERCIAL REGISTRY number (usually 12-13 digits), NOT the VAT.
    If you see both on an invoice, supplier_eik = the ΑΦΜ/VAT.REG.NO value (shorter,
    9-10 digits); the Γ.Ε.ΜΗ goes to null / is ignored.
    Examples:
      "VAT.REG.NO: EL-094466230"  → supplier_eik = "EL094466230" ✓
      "G.E.MI.1215970019000"      → ignore (this is NOT eik/vat)
      "ΑΦΜ: 094466230"            → supplier_eik = "094466230" ✓
      "ЕИК: 123456789"            → supplier_eik = "123456789" ✓
- supplier_vat: The VAT number — same value as supplier_eik for most cases.
    For Greek suppliers, this is the ΑΦΜ with "EL" prefix (e.g. "EL094466230").
    For Bulgarian suppliers, this is the EIK with "BG" prefix (e.g. "BG123456789").
    ⚠️ Never put Γ.Ε.ΜΗ / G.E.MI here — that is NOT a VAT number.
    If no country-prefixed version is visible, return null.
- supplier_address: full address of the supplier.
- supplier_phone: phone/fax number of the supplier (look for ΤΗΛ, ΤΗΛΕΦΩΝΟ, FAX, TEL).
- supplier_email: email address of the supplier if visible.
- supplier_contact: contact person name if visible.
- document_type: pick the closest match from the 6 types above.
- needs_companion_doc: true for type2_invoice (it needs the conformity doc to get expiry/batch).
- missing_batch: true if ANY line item lacks a batch number.
- missing_expiry: true if ANY line item lacks an expiry date.
- All amounts as numbers (not strings).
- Dates as YYYY-MM-DD strings.
- If a field is not found, use null.
- Do NOT include markdown, only raw JSON.
- visible_row_count/extracted_row_count: MUST reflect how many product rows are visually present vs returned.
- completeness_status: one of `complete | suspicious | incomplete`.
- warnings: list extraction warnings (empty array when complete).
- product_code_raw: If the invoice has an ITEM/CODE/ΚΩΔΙΚΟΣ column with numeric codes (e.g. 1002, 1025, 1013), extract the code for each line item. This is typically a 3-5 digit number in the first column. If no code column exists, use null.

  CRITICAL — LOT NUMBER vs PRODUCT CODE:
  Some invoices (especially ELMAR CRETE, oil/olive producers) print the LOT NUMBER on
  a SEPARATE LINE immediately BELOW each product row. It looks like:
      "L.N.02726", "L.N. 02726", "LN: 02726", "Lot: 02726",
      "ΛΝ 02726", "ΑΡ. ΠΑΡΤΙΔΑΣ: 02726", "BATCH: 02726", "Партида: 02726"
  These rows are NOT separate products — they belong to the product above.
  RULE: When you see a line starting with "L.N", "LN", "Lot", "ΛΝ", "ΑΡ. ΠΑΡΤΙΔΑΣ", or "BATCH":
    → DO NOT create a new line_item for it.
    → DO NOT put it in product_code_raw.
    → Extract the number that follows and put it in batch_number_raw of the PRECEDING product.
    → Example: product "Extra Virgin Olive Oil ELMAR", followed by "L.N.02726"
      → one line_item with product_name_raw = "Extra Virgin Olive Oil ELMAR",
         batch_number_raw = "02726", product_code_raw = null (no real code column exists).

  HANDWRITTEN DATES (ръкописни срокове на годност):
  Some invoices have handwritten dates next to products in short format like
  "20-10-27", "30-3-27", "30-4-27" (DD-MM-YY). These are EXPIRY DATES.
  → Extract into expiry_date_raw of the PRECEDING product in format YYYY-MM-DD
    (interpret "27" as "2027" — 2-digit year means 20XX).
  → Also handwritten words like "ГОДНОСТ", "ПАРТИДА", "годни до" are user annotations,
    not product data — ignore them.
- product_name_raw: ALWAYS copy the EXACT text as printed on the invoice — do NOT translate, do NOT transliterate, do NOT change the language.
- unit: Extract the unit of measure from the invoice. Map Greek/English units to Bulgarian:
    ΚΓ / ΚΙΛΟ / ΚΙΛΑ / KG / KGR / KILO → "кг"
    ΤΕΜ / ΤΕΜ. / ΤΕΜΑΧΙΟ / ΤΕΜ / piece → "бр"
    Γ / ΓΡ / GR / G → "г"
    Λ / L / LT → "л"
    BOTTLE/TIN INVOICES: Some invoices have columns "QUANTITY .1." (e.g. 1×12×750ml) and "QUANTITY .2." (e.g. 12×750ml)
    plus a separate "TOTAL WEIGHT Net (Kgr)" column. In this case:
    - quantity = total number of bottles/tins/units (the multiplied count, e.g. 12 for "1×12×750ml")
    - unit = "бр" (pieces), NOT liters and NOT kg
    - unit_price = price per single bottle/tin (VALUE/UNIT column)

    DISCOUNT INVOICES: Some invoices have columns like ΕΚΠΤΩΣΗ / DISCOUNT / % / ΠΟΣΟΣΤΟ.
    When a discount column exists, extract ALL these fields PER UNIT (not per line!):

    Example 1 (KILO item): MINI TRUFFLE | KILO | 2.34 | PRICE: 9.80 | 25% | DISC.VA: 5.72 | TOTAL: 17.16
    → gross_price = 9.80 (PRICE column = per KILO before discount)
    → discount_percent = 25.0
    → discount_amount = 2.45 (= 9.80 × 25/100 per unit, NOT the DISC.VA column which is line total)
    → unit_price = 7.35 (= 9.80 - 2.45 per unit)
    → total_price = 17.16 (TOTAL column)

    CRITICAL: gross_price is ALWAYS from the PRICE/ΤΙΜΗ column, which is ALWAYS PER UNIT.
    The TOTAL column is ALWAYS the LINE total (quantity × unit_price). NEVER use TOTAL as gross_price.

    If NO discount column exists: set gross_price=null, discount_percent=null, discount_amount=null

COMPANION DOCUMENT RULES (type2_companion — DECLARATION OF CONFORMITY or similar):
- These documents have a TABLE with rows per product, typically with columns: DESCRIPTION, CARTONS, PROD. DATE, EXP. DATE
- For EACH row extract:
    production_date → from "PROD. DATE" column (format YYYY-MM-DD)
    expiry_date → from "EXP. DATE" column (format YYYY-MM-DD)
    product_name_raw → from "DESCRIPTION" column (copy the exact text as printed, do not translate)
    quantity → from "CARTONS" or quantity column
- The batch_number for each item = DDMMYYYY of its production_date
- DO NOT use the same batch for all products — each row has its own PROD. DATE
- Date format on these docs is usually D/M/YYYY — convert to YYYY-MM-DD

╔═══════════════════════════════════════════════════════════════════════════╗
║  CRITICAL — ROW ALIGNMENT (read before returning ANY tabular data)        ║
╠═══════════════════════════════════════════════════════════════════════════╣
║ Every column value you extract MUST come from the SAME physical row as    ║
║ the product it belongs to. This applies especially to:                    ║
║   - batch_number / ΠΑΡΤΙΔΑ / L.N. / Lot / АР. ПАРТИДАС / ΑΡ. ΠΑΡΤΙΔΑΣ     ║
║   - production_date / ΗΜ.ΠΑΡΑΓΩΓΗΣ / PROD. DATE                           ║
║   - expiry_date / ΛΗΞΗ / EXP. DATE / срок на годност                      ║
║   - quantity / ΠΟΣΟΤΗΣ                                                    ║
║                                                                           ║
║ COMMON MISTAKE TO AVOID:                                                  ║
║   If the FIRST data row has a value in the batch column that is          ║
║   visually close to the HEADER row (e.g. "ПАРТИДА" is just above         ║
║   "00244791"), DO NOT skip it and start from row 2.                      ║
║   DO NOT treat the header as "row 0" — the header is NOT a data row.     ║
║   DO NOT shift column values up or down by one row.                      ║
║                                                                           ║
║ SELF-CHECK BEFORE RETURNING:                                              ║
║   - Count visible product rows. Count batch_number values. They match?   ║
║   - If the first product row has a visible batch number, row 1's batch   ║
║     MUST be that value — not the value printed NEXT to row 2.            ║
║   - If the first row has NO batch number but later rows do, verify       ║
║     again by re-reading the first row. If truly absent, return null      ║
║     for row 1 (do NOT borrow from row 2).                                 ║
║   - When both an invoice and a companion weighing doc describe the       ║
║     SAME product_code, their batch_numbers MUST agree per row.           ║
║                                                                           ║
║ If you are uncertain about alignment on any row, add a warning string    ║
║ "row_alignment_unclear_row_<N>" to the warnings array and return null    ║
║ for the uncertain fields on that row. DO NOT guess.                      ║
╚═══════════════════════════════════════════════════════════════════════════╝
"""


# ── Layer 1: Gemini 2.5 Pro extraction ───────────────────────────────────────

MAX_OCR_PROMPT_CHARS = 18000
_ROW_NUMBER_RE = re.compile(r"^\s*(\d{1,3})(?:\s+|[.)\-:]\s*)")
_NUMBER_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?")
_LETTER_TOKEN_RE = re.compile(r"[A-Za-zΑ-Ωα-ωА-Яа-я]")
_NUMERIC_TOKEN_FULL_RE = re.compile(r"^[+-]?\d+(?:[.,]\d+)?%?$")
_TOTAL_LIKE_RE = re.compile(
    r"(total|subtotal|vat|fpa|φπα|συνολο|σύνολο|grand total|net|gross)",
    re.IGNORECASE,
)


def _build_prompt_with_ocr(text_prompt: str, ocr_text: str | None) -> str:
    if not ocr_text or not ocr_text.strip():
        return text_prompt
    normalized_ocr = ocr_text.strip()
    truncated = False
    if len(normalized_ocr) > MAX_OCR_PROMPT_CHARS:
        normalized_ocr = normalized_ocr[:MAX_OCR_PROMPT_CHARS]
        truncated = True
    truncation_note = (
        "\nNOTE: OCR text was truncated for prompt size limits. Prioritize row completeness."
        if truncated
        else ""
    )
    return (
        "Here is the raw OCR text extracted from this invoice using Tesseract:\n"
        "---BEGIN OCR TEXT---\n"
        f"{normalized_ocr}\n"
        "---END OCR TEXT---\n\n"
        "Now examine BOTH the image AND the OCR text above. "
        "The OCR text may have formatting issues but contains ALL rows from the invoice table.\n"
        "Cross-reference: if the OCR text shows more line items than you can see in the image, "
        "trust the OCR text for completeness and use the image to verify details.\n"
        "If some row fields are unclear, include the row with nulls instead of skipping it."
        f"{truncation_note}\n\n"
        f"{text_prompt}"
    )


def _sum_line_item_totals(line_items: list["LineItem"]) -> float:
    return sum(item.total_price for item in line_items if item.total_price is not None)


def _extract_row_numbered_candidates(ocr_text: str | None) -> list[dict]:
    """
    Parse OCR lines that look like numbered invoice table rows.
    Returns rows ordered by row_number, first hit wins per number.
    """
    if not ocr_text or not ocr_text.strip():
        return []

    by_row_number: dict[int, dict] = {}
    for raw_line in ocr_text.splitlines():
        match = _ROW_NUMBER_RE.match(raw_line)
        if not match:
            continue

        row_no = int(match.group(1))
        if row_no < 1 or row_no > 300:
            continue

        line = " ".join(raw_line.strip().split())
        if len(line) < 6 or _TOTAL_LIKE_RE.search(line):
            continue

        number_tokens = _NUMBER_TOKEN_RE.findall(line)
        if len(number_tokens) < 2:
            continue

        row_body = _ROW_NUMBER_RE.sub("", line, count=1).strip(" -|")
        if len(row_body) < 3 or not _LETTER_TOKEN_RE.search(row_body):
            continue

        if row_no not in by_row_number:
            by_row_number[row_no] = {
                "row_number": row_no,
                "line": line,
                "row_body": row_body,
            }

    return [by_row_number[k] for k in sorted(by_row_number)]


def _estimate_expected_row_count(cues: dict[str, int]) -> int:
    """
    Build a strict expected row count when OCR evidence is strong enough.
    Priority:
    1) contiguous numbered rows starting from 1
    2) max row number when sequence is almost contiguous
    3) conservative fraction of generic table-row hint
    """
    row_sequence_hint = cues.get("row_number_sequence", 0)
    row_max_hint = cues.get("row_number_max", 0)
    table_row_hint = cues.get("table_row_hint", 0)

    if row_sequence_hint >= 4:
        return row_sequence_hint
    if row_max_hint >= 4 and row_max_hint - row_sequence_hint <= 2:
        return row_max_hint
    if table_row_hint >= 10:
        return max(4, int(round(table_row_hint * 0.80)))
    return 0


def _extract_ocr_completeness_cues(ocr_text: str | None) -> dict[str, int]:
    """
    Derive lightweight completeness cues from OCR text:
    - row_number_sequence: contiguous row numbering starting from 1
    - row_number_max: highest leading row number detected
    - table_row_hint: count of lines that look like product rows
    """
    if not ocr_text or not ocr_text.strip():
        return {"row_number_sequence": 0, "row_number_max": 0, "table_row_hint": 0}

    numbered_rows = _extract_row_numbered_candidates(ocr_text)
    row_numbers = [r["row_number"] for r in numbered_rows]
    table_rows = 0

    for raw_line in ocr_text.splitlines():
        line = " ".join(raw_line.strip().split())
        if len(line) < 4:
            continue

        number_tokens = _NUMBER_TOKEN_RE.findall(line)
        has_letters = bool(_LETTER_TOKEN_RE.search(line))
        if has_letters and len(number_tokens) >= 2 and not _TOTAL_LIKE_RE.search(line):
            table_rows += 1

    row_set = set(row_numbers)
    row_sequence = 0
    while (row_sequence + 1) in row_set and row_sequence < 300:
        row_sequence += 1

    return {
        "row_number_sequence": row_sequence,
        "row_number_max": max(row_numbers) if row_numbers else 0,
        "table_row_hint": table_rows,
    }


def _trim_product_name_from_row_text(row_text: str | None, row_no: int) -> str:
    if not row_text:
        return f"UNKNOWN_ROW_{row_no}"

    tokens = row_text.split()
    drop_budget = 8
    while tokens and drop_budget > 0 and _NUMERIC_TOKEN_FULL_RE.match(tokens[-1]):
        tokens.pop()
        drop_budget -= 1

    cleaned = " ".join(tokens).strip(" -|")
    if not cleaned:
        cleaned = row_text.strip(" -|")
    cleaned = cleaned or f"UNKNOWN_ROW_{row_no}"
    return cleaned[:160]


def _line_item_payload_score(item: "LineItem") -> int:
    score_fields = (
        "product_name_raw",
        "product_name",
        "name_bg",
        "product_code_raw",
        "product_code",
        "quantity",
        "unit",
        "unit_price",
        "total_price",
        "batch_number_raw",
        "batch_number",
        "expiry_date_raw",
        "expiry_date",
        "production_date",
        "notes_raw",
        "gross_price",
        "discount_percent",
        "discount_amount",
    )
    score = 0
    for field in score_fields:
        value = getattr(item, field, None)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        score += 1
    return score


def _ensure_line_item_row_count(
    line_items: list["LineItem"],
    ocr_text: str | None,
) -> list["LineItem"]:
    """
    Reconcile extracted line items with OCR row numbering.
    If OCR confidently indicates N numbered rows, force exactly N rows by:
    - preserving extracted rows
    - assigning missing row numbers positionally when absent
    - backfilling missing rows with OCR-derived placeholders
    """
    cues = _extract_ocr_completeness_cues(ocr_text)
    expected_rows = _estimate_expected_row_count(cues)
    if expected_rows < 4:
        return line_items

    row_candidates = _extract_row_numbered_candidates(ocr_text)
    row_by_number = {
        row["row_number"]: row
        for row in row_candidates
        if 1 <= row["row_number"] <= expected_rows
    }
    if len(row_by_number) < max(3, int(round(expected_rows * 0.60))):
        # OCR numbering evidence is too weak to force hard reconciliation.
        return line_items

    mapped: dict[int, LineItem] = {}
    unassigned: list[LineItem] = []
    explicit_row_hits = 0

    for item in line_items:
        row_number = getattr(item, "row_number", None)
        row_no = int(row_number) if isinstance(row_number, int) else None
        if row_no is not None and 1 <= row_no <= expected_rows:
            explicit_row_hits += 1
            existing = mapped.get(row_no)
            if not existing or _line_item_payload_score(item) > _line_item_payload_score(existing):
                mapped[row_no] = item
            continue
        unassigned.append(item)

    use_positional_assignment = explicit_row_hits < max(2, len(line_items) // 2)
    if use_positional_assignment:
        for row_no in list(mapped):
            if row_no > len(line_items):
                # Keep explicit rows that are likely genuine; don't drop them preemptively.
                continue
        available_rows = [r for r in range(1, expected_rows + 1) if r not in mapped]
        for idx, item in enumerate(unassigned):
            if idx >= len(available_rows):
                break
            target_row = available_rows[idx]
            mapped[target_row] = item.model_copy(update={"row_number": target_row})

    reconciled: list[LineItem] = []
    for row_no in range(1, expected_rows + 1):
        item = mapped.get(row_no)
        if item:
            if item.row_number != row_no:
                item = item.model_copy(update={"row_number": row_no})
            reconciled.append(item)
            continue

        row_hint = row_by_number.get(row_no, {})
        row_body = row_hint.get("row_body")
        name = _trim_product_name_from_row_text(row_body, row_no)
        reconciled.append(
            LineItem(
                row_number=row_no,
                page_number=1,
                product_name_raw=name,
                product_name=name,
                name_bg=name,
            )
        )

    if len(reconciled) != len(line_items):
        logger.info(
            "OCR row reconciliation adjusted line_items count from %d to %d (expected_rows=%d)",
            len(line_items),
            len(reconciled),
            expected_rows,
        )
    return reconciled


def _assess_extraction_completeness(
    line_items: list["LineItem"], extracted: dict, ocr_text: str | None
) -> dict:
    """
    Evaluate if extraction is likely missing rows, even when checksum passes.
    """
    cues = _extract_ocr_completeness_cues(ocr_text)
    reasons: list[str] = []
    item_count = len(line_items)

    if item_count == 0:
        reasons.append("no_line_items")

    row_sequence_hint = cues["row_number_sequence"]
    row_max_hint = cues["row_number_max"]
    expected_row_count = _estimate_expected_row_count(cues)
    if row_sequence_hint >= 4 and item_count < row_sequence_hint:
        reasons.append(
            f"row_number_sequence_hint({row_sequence_hint}) > extracted_items({item_count})"
        )
    if expected_row_count >= 4 and item_count < expected_row_count:
        reasons.append(
            f"expected_row_count({expected_row_count}) > extracted_items({item_count})"
        )

    table_row_hint = cues["table_row_hint"]
    if table_row_hint >= 8:
        min_expected = max(4, int(round(table_row_hint * 0.80)))
        if item_count < min_expected:
            reasons.append(
                f"ocr_table_row_hint({table_row_hint}) implies at least {min_expected} rows, got {item_count}"
            )

    invoice_total_raw = extracted.get("total_gross") or extracted.get("total_net")
    invoice_total = None
    total_diff = 0.0
    extracted_total = _sum_line_item_totals(line_items)
    if invoice_total_raw is not None:
        try:
            invoice_total = float(invoice_total_raw)
        except (TypeError, ValueError):
            invoice_total = None

    if invoice_total and extracted_total > 0:
        total_diff = abs(extracted_total - invoice_total)
        allowed_diff = max(1.0, invoice_total * 0.12)
        if total_diff > allowed_diff:
            reasons.append(
                f"line_total_mismatch(diff={total_diff:.2f}, invoice_total={invoice_total:.2f})"
            )

    return {
        "suspicious": len(reasons) > 0,
        "reasons": reasons,
        "item_count": item_count,
        "invoice_total": invoice_total,
        "extracted_total": extracted_total,
        "total_diff": total_diff,
        "row_number_sequence_hint": row_sequence_hint,
        "row_number_max_hint": row_max_hint,
        "table_row_hint": table_row_hint,
        "expected_row_count": expected_row_count,
    }


def _line_item_label(item: "LineItem", fallback_row: int) -> str:
    return (
        item.product_name_raw
        or item.product_name
        or item.name_bg
        or f"ROW_{fallback_row}"
    )


def _row_numbers_are_contiguous(line_items: list["LineItem"]) -> bool:
    if not line_items:
        return True
    row_numbers: list[int] = []
    for item in line_items:
        row_no = item.row_number
        if row_no is None:
            return False
        try:
            row_numbers.append(int(row_no))
        except (TypeError, ValueError):
            return False
    return row_numbers == list(range(1, len(line_items) + 1))


def _line_item_looks_like_table_contamination(item: "LineItem", row_idx: int) -> bool:
    label = _line_item_label(item, row_idx).strip()
    if not label:
        return False
    if not _TOTAL_LIKE_RE.search(label):
        return False
    has_qty = item.quantity is not None and float(item.quantity) > 0
    has_unit = bool((item.unit or "").strip())
    has_price = item.unit_price is not None or item.total_price is not None
    return not (has_qty and has_unit and has_price)


def _dedupe_warnings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for raw in values:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def _build_completeness_metadata(
    line_items: list["LineItem"],
    assessment: dict,
    validation_errors: list[ValidationError],
) -> dict:
    extracted_row_count = len(line_items)

    expected_rows = int(assessment.get("expected_row_count") or 0)
    row_sequence_hint = int(assessment.get("row_number_sequence_hint") or 0)
    row_max_hint = int(assessment.get("row_number_max_hint") or 0)

    visible_candidates = [v for v in (expected_rows, row_sequence_hint) if v > 0]
    if row_max_hint > 0 and (
        row_sequence_hint == 0 or row_max_hint - row_sequence_hint <= 2
    ):
        visible_candidates.append(row_max_hint)

    visible_row_count = max(visible_candidates) if visible_candidates else extracted_row_count

    warnings: list[str] = []
    if visible_row_count != extracted_row_count:
        warnings.append(
            f"row_count_mismatch: visible={visible_row_count}, extracted={extracted_row_count}"
        )

    if not _row_numbers_are_contiguous(line_items):
        warnings.append("row_sequence_not_contiguous")

    contaminated_rows = [
        str(item.row_number or idx)
        for idx, item in enumerate(line_items, start=1)
        if _line_item_looks_like_table_contamination(item, idx)
    ]
    if contaminated_rows:
        warnings.append(f"table_contamination_rows:{','.join(contaminated_rows)}")

    if validation_errors:
        warnings.append(f"arithmetic_plausibility_issues:{len(validation_errors)}")

    for reason in assessment.get("reasons") or []:
        warnings.append(str(reason))

    warnings = _dedupe_warnings(warnings)

    if extracted_row_count == 0:
        completeness_status = "incomplete"
    elif visible_row_count > extracted_row_count:
        completeness_status = "incomplete"
    elif visible_row_count < extracted_row_count:
        completeness_status = "suspicious"
    elif warnings:
        completeness_status = "suspicious"
    else:
        completeness_status = "complete"

    if completeness_status == "complete" and assessment.get("suspicious"):
        completeness_status = "suspicious"

    return {
        "visible_row_count": visible_row_count,
        "extracted_row_count": extracted_row_count,
        "completeness_status": completeness_status,
        "warnings": warnings,
    }


def _score_extraction_candidate(
    line_items: list["LineItem"], extracted: dict, ocr_text: str | None
) -> tuple[float, dict]:
    """
    Score extraction quality with strong preference for complete item sets.
    """
    assessment = _assess_extraction_completeness(line_items, extracted, ocr_text)
    score = float(len(line_items)) * 100.0

    invoice_total = assessment["invoice_total"]
    if invoice_total is not None and assessment["extracted_total"] > 0:
        diff = assessment["total_diff"]
        score -= min(diff, 500.0)
        if diff <= 1.0:
            score += 25.0

    row_hint = assessment["row_number_sequence_hint"]
    if row_hint >= 4:
        score -= abs(len(line_items) - row_hint) * 35.0

    expected_rows = assessment["expected_row_count"]
    if expected_rows >= 4:
        score -= abs(len(line_items) - expected_rows) * 60.0
        if len(line_items) == expected_rows:
            score += 120.0

    table_hint = assessment["table_row_hint"]
    if table_hint >= 8 and len(line_items) < table_hint:
        score -= (table_hint - len(line_items)) * 10.0

    score -= len(assessment["reasons"]) * 15.0
    return score, assessment


def _select_best_candidate(
    candidates: list[tuple[str, dict, list["LineItem"], float, dict]]
) -> tuple[str, dict, list["LineItem"], float, dict]:
    if not candidates:
        raise ValueError("No extraction candidates to select from")

    expected = max(
        (int(c[4].get("expected_row_count") or 0) for c in candidates),
        default=0,
    )
    if expected >= 4:
        exact = [c for c in candidates if len(c[2]) == expected]
        if exact:
            return max(exact, key=lambda c: c[3])

        return max(
            candidates,
            key=lambda c: (
                -abs(len(c[2]) - expected),
                c[3],
                len(c[2]),
            ),
        )

    return max(candidates, key=lambda c: (len(c[2]), c[3]))


def _build_completeness_retry_prompt(
    base_prompt: str, assessment: dict, *, line_items_only: bool = False
) -> str:
    reasons = assessment.get("reasons") or ["suspected missing rows"]
    reason_text = "; ".join(reasons)

    base = (
        "RETRY MODE: The previous extraction appears incomplete.\n"
        f"Evidence: {reason_text}\n"
        f"- Previously extracted items: {assessment.get('item_count')}\n"
        f"- OCR row-number sequence hint: {assessment.get('row_number_sequence_hint')}\n"
        f"- OCR row-number max hint: {assessment.get('row_number_max_hint')}\n"
        f"- OCR expected row count: {assessment.get('expected_row_count')}\n"
        f"- OCR table-row hint: {assessment.get('table_row_hint')}\n"
        f"- Previous line total sum: {assessment.get('extracted_total', 0.0):.2f}\n"
        f"- Invoice total field: {assessment.get('invoice_total')}\n"
        "Re-read the FULL table from top to bottom. Do not skip rows.\n"
        "If a row has uncertain fields, include it with nulls instead of omitting it.\n"
    )

    expected_rows = assessment.get("expected_row_count")
    if isinstance(expected_rows, int) and expected_rows >= 4:
        base += (
            f"Return EXACTLY {expected_rows} rows in line_items.\n"
            "Each row must include `row_number` and the row numbers must be contiguous from 1.\n"
        )

    if line_items_only:
        return (
            f"{base_prompt}\n\n"
            f"{base}\n"
            "Focus primarily on table completeness and return JSON containing `line_items`."
        )
    return f"{base_prompt}\n\n{base}\nReturn the full invoice JSON schema."


def _merge_with_rescued_line_items(base_extracted: dict, rescue_extracted: dict) -> dict:
    merged = dict(base_extracted)
    rescue_items = rescue_extracted.get("line_items")
    if isinstance(rescue_items, list):
        merged["line_items"] = rescue_items

    for key in ("total_net", "total_vat", "total_gross", "currency"):
        if merged.get(key) is None and rescue_extracted.get(key) is not None:
            merged[key] = rescue_extracted.get(key)
    return merged


def _build_few_shot_section(templates: list[dict]) -> str:
    """Build few-shot examples from confirmed templates."""
    if not templates:
        return ""
    section = "\n\nFEW-SHOT EXAMPLES — Here are previous confirmed extractions from this same supplier. Follow the same patterns:\n"
    for i, tmpl in enumerate(templates, 1):
        extracted = tmpl["extracted_json"]
        if isinstance(extracted, str):
            extracted = json.loads(extracted)
        # Show a compact version (first 3 items only)
        compact = {k: v for k, v in extracted.items() if k != "line_items"}
        items = extracted.get("line_items", [])[:3]
        compact["line_items"] = items
        compact["_note"] = f"({len(extracted.get('line_items', []))} items total, showing first 3)"
        section += f"\nExample {i}:\n```json\n{json.dumps(compact, ensure_ascii=False, indent=2)}\n```\n"
    section += "\nFollow the same field naming, unit mapping, and category patterns as the examples above.\n"
    return section


def _extract_supplier_quick(client: genai.Client, image_parts: list[tuple[str, str]]) -> str | None:
    """Quick first pass to identify supplier name from invoice image."""
    try:
        contents = []
        for b64_data, mime_type in image_parts[:1]:
            raw_bytes = base64.b64decode(b64_data)
            contents.append(genai.types.Part.from_bytes(data=raw_bytes, mime_type=mime_type))
        contents.append("Look at this invoice image. Return ONLY the supplier/company name as a plain string (no JSON, no quotes). Just the name.")

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                max_output_tokens=100,
                temperature=0.0,
            ),
        )
        raw_text = _get_gemini_response_text(response)
        if not raw_text:
            return None
        name = raw_text.strip().strip('"').strip("'")
        logger.info(f"Quick supplier identification: {name}")
        return name if name else None
    except Exception as e:
        logger.warning(f"Quick supplier identification failed: {e}")
        return None


def _is_openrouter_fallback_error(err: Exception) -> bool:
    text = str(err).lower()
    markers = [
        "status code: 402",
        "error code: 402",
        "payment required",
        "requires more credits",
        "insufficient credits",
        "resource_exhausted",
        "quota",
        "rate limit",
        "credits",
    ]
    return any(m in text for m in markers)


def _get_openai_vision_clients() -> list[tuple["OpenAI", str, str]]:
    try:
        from openai import OpenAI
    except ImportError as e:
        raise ValueError(
            "openai package is not installed — cannot use OpenAI/OpenRouter fallback"
        ) from e

    clients: list[tuple["OpenAI", str, str]] = []

    openrouter_key = settings.openrouter_api_key or os.environ.get("OPENROUTER_API_KEY")
    openrouter_base_url = (
        settings.openrouter_base_url
        or os.environ.get("OPENROUTER_BASE_URL")
        or "https://openrouter.ai/api/v1"
    )
    openrouter_model = (
        settings.openrouter_vision_model
        or os.environ.get("OPENROUTER_VISION_MODEL")
        or "openai/gpt-4o-mini"
    )
    if openrouter_key:
        clients.append(
            (
                OpenAI(api_key=openrouter_key, base_url=openrouter_base_url),
                openrouter_model,
                "openrouter",
            )
        )

    openai_key = settings.openai_api_key or os.environ.get("OPENAI_API_KEY")
    openai_model = settings.openai_vision_model or os.environ.get("OPENAI_VISION_MODEL") or "gpt-4o-mini"
    if openai_key:
        clients.append((OpenAI(api_key=openai_key), openai_model, "openai"))

    if not clients:
        raise ValueError("OPENROUTER_API_KEY or OPENAI_API_KEY is required for OCR fallback")

    return clients


def _extract_with_openai_vision(
    image_parts: list[tuple[str, str]],
    text_prompt: str,
    ocr_text: str | None = None,
    few_shot_templates: list[dict] | None = None,
) -> dict:
    """OpenAI/OpenRouter vision fallback for structured invoice extraction."""
    clients = _get_openai_vision_clients()

    combined_prompt = _build_prompt_with_ocr(text_prompt, ocr_text)
    if few_shot_templates:
        combined_prompt += _build_few_shot_section(few_shot_templates)
    combined_prompt += "\n\nReturn ONLY valid JSON, no markdown code fences."

    user_content: list[dict] = [{"type": "text", "text": combined_prompt}]
    for b64_data, mime_type in image_parts:
        user_content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{b64_data}"},
            }
        )

    last_err: Exception | None = None
    for idx, (client, model, provider) in enumerate(clients):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                temperature=0.0,
                max_tokens=8192,
                response_format={"type": "json_object"},
            )
            raw_text = response.choices[0].message.content if response.choices else None
            if not raw_text:
                raise ValueError(f"{provider} fallback returned empty response")

            raw = _clean_json_response_text(raw_text)
            if not raw:
                raise ValueError(f"{provider} fallback returned empty JSON payload")
            logger.info(f"{provider} vision fallback: response length={len(raw)} chars")
            return json.loads(raw)
        except Exception as err:
            last_err = err
            can_retry_next = idx < len(clients) - 1
            if provider == "openrouter" and can_retry_next and _is_openrouter_fallback_error(err):
                logger.warning(
                    "OpenRouter vision fallback failed (%s). Retrying with OpenAI direct vision.",
                    err,
                )
                continue
            if can_retry_next:
                logger.warning(
                    "%s vision fallback failed (%s). Retrying next provider.",
                    provider,
                    err,
                )
                continue
            raise

    raise last_err or ValueError("No vision provider succeeded")


def _run_gemini_model(
    *,
    model: str,
    image_parts: list[tuple[str, str]],
    combined_prompt: str,
) -> dict:
    """Single Gemini model invocation — used by smart-router below."""
    client = _get_gemini_client()
    contents = []
    for b64_data, mime_type in image_parts:
        raw_bytes = base64.b64decode(b64_data)
        contents.append(
            genai.types.Part.from_bytes(data=raw_bytes, mime_type=mime_type)
        )
    contents.append(combined_prompt)

    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=genai.types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=16384,
            temperature=0.0,
            response_mime_type="application/json",
        ),
    )

    raw_text = _get_gemini_response_text(response)
    if not raw_text:
        raise ValueError(
            f"Gemini {model} returned empty response. "
            f"finish_reason="
            f"{getattr(response.candidates[0], 'finish_reason', 'unknown') if response.candidates else 'no candidates'}"
        )
    raw = _clean_json_response_text(raw_text)
    logger.info(f"Gemini {model}: response length={len(raw)} chars")
    if not raw:
        raise ValueError(f"Empty response from Gemini {model}")
    return json.loads(raw)


def _gemini_result_is_good(result: dict) -> bool:
    """
    Smart-router heuristic: was the Flash result good enough to skip Pro?
    Good = non-empty line_items AND each with a product_name_raw.
    """
    if not isinstance(result, dict):
        return False
    line_items = result.get("line_items") or result.get("items") or []
    if not isinstance(line_items, list) or len(line_items) == 0:
        return False
    named = sum(
        1
        for it in line_items
        if isinstance(it, dict)
        and (it.get("product_name_raw") or it.get("product_name"))
    )
    # Require at least 70% of rows to have a name — catches rubbish Flash output
    return named / len(line_items) >= 0.7


def _extract_with_gemini(
    image_parts: list[tuple[str, str]],
    text_prompt: str,
    ocr_text: str | None = None,
    few_shot_templates: list[dict] | None = None,
) -> dict:
    """
    Smart router: try Gemini 2.5 Flash first (~5-10s). If result looks
    incomplete (no items, mostly blank names, parse error), fall back to
    Gemini 2.5 Pro (~40-60s) which is slower but more accurate.

    Typical average latency: ~12s (Flash succeeds most of the time).
    """
    combined_prompt = _build_prompt_with_ocr(text_prompt, ocr_text)
    if few_shot_templates:
        combined_prompt += _build_few_shot_section(few_shot_templates)
    combined_prompt += "\n\nReturn ONLY valid JSON, no markdown code fences."

    # Attempt 1: Flash (fast)
    try:
        flash_result = _run_gemini_model(
            model="gemini-2.5-flash",
            image_parts=image_parts,
            combined_prompt=combined_prompt,
        )
        if _gemini_result_is_good(flash_result):
            logger.info("Gemini smart-router: Flash result accepted")
            return flash_result
        logger.info(
            "Gemini smart-router: Flash result insufficient, retrying with Pro"
        )
    except Exception as flash_err:
        logger.warning(
            f"Gemini smart-router: Flash failed ({flash_err}), retrying with Pro"
        )

    # Attempt 2: Pro (slow but more accurate)
    return _run_gemini_model(
        model="gemini-2.5-pro",
        image_parts=image_parts,
        combined_prompt=combined_prompt,
    )


def _extract_with_claude(
    image_parts: list[tuple[str, str]],
    text_prompt: str,
    ocr_text: str | None = None,
    few_shot_templates: list[dict] | None = None,
) -> dict:
    """
    Primary extractor: Claude Sonnet 4.5 — best-in-class for structured
    document extraction. Excellent Greek/Cyrillic/Latin handling, consistent
    JSON output, 5-10s latency typically.

    Requires ANTHROPIC_API_KEY in environment. Falls back silently (raises)
    if key is missing so outer fallback chain tries Gemini next.
    """
    import anthropic

    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not configured")

    combined_prompt = _build_prompt_with_ocr(text_prompt, ocr_text)
    if few_shot_templates:
        combined_prompt += _build_few_shot_section(few_shot_templates)
    combined_prompt += "\n\nReturn ONLY valid JSON, no markdown code fences."

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    # Build multimodal content — one image part per page
    content: list = []
    for b64_data, mime_type in image_parts:
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": mime_type,
                    "data": b64_data,
                },
            }
        )
    content.append({"type": "text", "text": combined_prompt})

    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=16384,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )

    raw_text = response.content[0].text if response.content else ""
    if not raw_text:
        raise ValueError("Claude returned empty response")

    raw = _clean_json_response_text(raw_text)
    logger.info(f"Claude Sonnet 4.5: response length={len(raw)} chars")
    if not raw:
        raise ValueError("Empty cleaned response from Claude")
    return json.loads(raw)


def _claude_available() -> bool:
    """Is Claude configured and ready to use?"""
    return bool(settings.anthropic_api_key)


def _extract_invoice_with_fallback(
    image_parts: list[tuple[str, str]],
    text_prompt: str,
    ocr_text: str | None = None,
    few_shot_templates: list[dict] | None = None,
    *,
    allow_provider_fallback: bool = True,
    trace_id: str | None = None,
) -> dict:
    """
    Provider chain: Claude Sonnet 4.5 (primary) → Gemini (fallback) →
    OpenAI vision (last resort). Claude is preferred because it's faster,
    more reliable for Greek invoices, and rarely hit by rate limits.
    """
    resolved_trace_id = _resolve_scan_trace_id(trace_id)

    # ── Attempt 1: Claude Sonnet 4.5 ────────────────────────────────────
    if _claude_available():
        _scan_log(
            "provider_attempt",
            resolved_trace_id,
            provider="claude",
            image_parts=len(image_parts),
            has_ocr_text=bool(ocr_text),
            few_shot_templates=len(few_shot_templates or []),
        )
        try:
            result = _extract_with_claude(
                image_parts,
                text_prompt,
                ocr_text=ocr_text,
                few_shot_templates=few_shot_templates,
            )
            _scan_log(
                "provider_success", resolved_trace_id, provider="claude"
            )
            return result
        except Exception as claude_err:
            _scan_log(
                "provider_failed",
                resolved_trace_id,
                provider="claude",
                error=str(claude_err),
            )
            if not allow_provider_fallback:
                raise
            # Fall through to Gemini below
            _scan_log(
                "provider_fallback_started",
                resolved_trace_id,
                from_provider="claude",
                to_provider="gemini",
                error=str(claude_err),
            )

    # ── Attempt 2: Gemini (smart-router: Flash → Pro) ───────────────────
    _scan_log(
        "provider_attempt",
        resolved_trace_id,
        provider="gemini",
        image_parts=len(image_parts),
        has_ocr_text=bool(ocr_text),
        few_shot_templates=len(few_shot_templates or []),
        allow_provider_fallback=allow_provider_fallback,
    )
    try:
        result = _extract_with_gemini(
            image_parts,
            text_prompt,
            ocr_text=ocr_text,
            few_shot_templates=few_shot_templates,
        )
        _scan_log("provider_success", resolved_trace_id, provider="gemini")
        return result
    except Exception as gemini_err:
        _scan_log(
            "provider_failed",
            resolved_trace_id,
            provider="gemini",
            error=str(gemini_err),
            fallback_eligible=_is_gemini_fallback_error(gemini_err),
        )
        if not _is_gemini_fallback_error(gemini_err):
            raise
        if not allow_provider_fallback:
            raise

        # ── Attempt 3: OpenAI vision (last resort) ──────────────────────
        _scan_log(
            "provider_fallback_started",
            resolved_trace_id,
            from_provider="gemini",
            to_provider="openai_vision",
            error=str(gemini_err),
        )
        result = _extract_with_openai_vision(
            image_parts,
            text_prompt,
            ocr_text=ocr_text,
            few_shot_templates=few_shot_templates,
        )
        _scan_log(
            "provider_success", resolved_trace_id, provider="openai_vision"
        )
        return result


# ── Claude fallback for quick-invoice-check (cheap, keeps existing behavior) ─

def _quick_check_with_claude(b64: str, mime: str) -> str | None:
    """Use Claude Sonnet for quick invoice number extraction (cheap/fast)."""
    import anthropic
    if not settings.anthropic_api_key:
        return None
    try:
        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=100,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                    {"type": "text", "text": 'Extract ONLY the invoice number from this document image. Return ONLY a JSON object: {"invoice_number": "..."}. Use Latin characters only (not Greek). Nothing else.'},
                ],
            }],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            first_nl = raw.index("\n") if "\n" in raw else 3
            raw = raw[first_nl + 1:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()
        result = json.loads(raw)
        return result.get("invoice_number")
    except Exception as e:
        logger.warning(f"Claude quick check failed: {e}")
        return None


# ── Helpers: parsing & validation ────────────────────────────────────────────

def _parse_line_items(extracted: dict) -> list[LineItem]:
    """Parse raw extraction dict into LineItem list with auto_batch."""
    raw_line_items = extracted.get("line_items", [])
    if isinstance(raw_line_items, dict):
        ordered_entries: list[tuple[int, object]] = []
        fallback_entries: list[tuple[int, object]] = []
        for idx, (raw_key, raw_value) in enumerate(raw_line_items.items()):
            try:
                sort_key = int(str(raw_key).strip())
            except (TypeError, ValueError):
                sort_key = None

            if isinstance(raw_value, dict) and raw_value.get("row_number") is None and sort_key:
                raw_value = {**raw_value, "row_number": sort_key}

            if sort_key is not None:
                ordered_entries.append((sort_key, raw_value))
            else:
                fallback_entries.append((idx + 1_000_000, raw_value))

        ordered_entries.sort(key=lambda entry: entry[0])
        source_items = [value for _, value in ordered_entries + fallback_entries]
    elif isinstance(raw_line_items, list):
        source_items = raw_line_items
    else:
        source_items = []

    line_items = []
    for idx, raw_item in enumerate(source_items):
        if not isinstance(raw_item, dict):
            logger.warning(
                "Non-dict line item at index %d (type=%s). Converting to placeholder row.",
                idx,
                type(raw_item).__name__,
            )
            fallback_name = str(raw_item).strip() if raw_item is not None else ""
            line_items.append(
                LineItem(
                    row_number=idx + 1,
                    page_number=1,
                    product_name_raw=fallback_name or f"UNKNOWN_ITEM_{idx + 1}",
                    product_name=fallback_name or f"UNKNOWN_ITEM_{idx + 1}",
                    name_bg=fallback_name or None,
                )
            )
            continue

        item_data = {k: raw_item.get(k) for k in LineItem.model_fields}
        fallback_name = (
            raw_item.get("product_name_raw")
            or raw_item.get("product_name")
            or raw_item.get("name_bg")
            or raw_item.get("product_code_raw")
            or raw_item.get("product_code")
        )
        if not item_data.get("product_name_raw"):
            item_data["product_name_raw"] = (
                str(fallback_name) if fallback_name else f"UNKNOWN_ITEM_{idx + 1}"
            )
        if not item_data.get("product_name"):
            item_data["product_name"] = item_data["product_name_raw"]
        if item_data.get("product_code_raw") is None:
            item_data["product_code_raw"] = raw_item.get("product_code")
        if item_data.get("product_code") is None:
            item_data["product_code"] = item_data.get("product_code_raw")
        if item_data.get("batch_number_raw") is None:
            item_data["batch_number_raw"] = raw_item.get("batch_number")
        if item_data.get("batch_number") is None:
            item_data["batch_number"] = item_data.get("batch_number_raw")
        if item_data.get("expiry_date_raw") is None:
            item_data["expiry_date_raw"] = raw_item.get("expiry_date")
        if item_data.get("expiry_date") is None:
            item_data["expiry_date"] = item_data.get("expiry_date_raw")
        if item_data.get("row_number") is None:
            item_data["row_number"] = idx + 1
        if item_data.get("page_number") is None:
            item_data["page_number"] = 1

        effective_batch = item_data.get("batch_number") or item_data.get(
            "batch_number_raw"
        )
        effective_expiry = item_data.get("expiry_date") or item_data.get(
            "expiry_date_raw"
        )
        if not effective_batch:
            if item_data.get("production_date"):
                item_data["auto_batch"] = batch_from_prod_date(item_data["production_date"])
            elif effective_expiry:
                item_data["auto_batch"] = auto_batch_from_expiry(effective_expiry)
            else:
                item_data["auto_batch"] = None
        else:
            item_data["auto_batch"] = None

        try:
            line_items.append(LineItem(**item_data))
        except Exception as err:
            logger.warning(
                "Line item parse failed at index %d (%s). Keeping minimal placeholder.",
                idx,
                err,
            )
            line_items.append(
                LineItem(
                    row_number=item_data.get("row_number") or (idx + 1),
                    page_number=item_data.get("page_number") or 1,
                    product_name_raw=item_data.get("product_name_raw")
                    or f"UNKNOWN_ITEM_{idx + 1}",
                    product_name=item_data.get("product_name")
                    or item_data.get("product_name_raw")
                    or f"UNKNOWN_ITEM_{idx + 1}",
                    name_bg=str(raw_item.get("name_bg")) if raw_item.get("name_bg") else None,
                )
            )
    return line_items


def _inflate_sparse_line_items(
    line_items: list[LineItem],
    extracted: dict,
) -> list[LineItem]:
    """
    Preserve visual row count when extraction exposes sparse row-numbered items.
    If line items carry explicit row numbers with gaps, or AI metadata declares more
    visible rows than payload items, backfill missing rows with placeholders instead
    of silently collapsing the table.
    """
    if not line_items:
        return line_items

    explicit_rows: list[int] = []
    for item in line_items:
        row_no = getattr(item, "row_number", None)
        if isinstance(row_no, int) and row_no > 0:
            explicit_rows.append(row_no)

    visible_row_count = 0
    extracted_row_count = 0
    for field_name in ("visible_row_count", "extracted_row_count"):
        raw_value = extracted.get(field_name)
        try:
            parsed = int(raw_value)
        except (TypeError, ValueError):
            parsed = 0
        if field_name == "visible_row_count":
            visible_row_count = parsed if parsed > 0 else 0
        else:
            extracted_row_count = parsed if parsed > 0 else 0

    target_row_count = max(
        len(line_items),
        visible_row_count,
        extracted_row_count,
        max(explicit_rows, default=0),
    )
    if target_row_count <= len(line_items) or not explicit_rows:
        return line_items

    row_map: dict[int, LineItem] = {}
    for idx, item in enumerate(line_items, start=1):
        row_no = item.row_number if isinstance(item.row_number, int) and item.row_number > 0 else idx
        if row_no not in row_map:
            row_map[row_no] = item if row_no == item.row_number else item.model_copy(update={"row_number": row_no})

    dense_items: list[LineItem] = []
    for row_no in range(1, target_row_count + 1):
        existing = row_map.get(row_no)
        if existing is not None:
            dense_items.append(existing)
            continue

        placeholder_name = f"UNKNOWN_ROW_{row_no}"
        dense_items.append(
            LineItem(
                row_number=row_no,
                page_number=1,
                product_name_raw=placeholder_name,
                product_name=placeholder_name,
                name_bg=placeholder_name,
            )
        )

    logger.info(
        "Inflated sparse line_items from %d to %d rows using explicit row numbers / AI metadata",
        len(line_items),
        len(dense_items),
    )
    return dense_items


def _build_result(
    extracted: dict,
    line_items: list[LineItem],
    validation_errors: list[ValidationError] | None = None,
    few_shot_used: bool = False,
    few_shot_supplier: str | None = None,
    completeness: dict | None = None,
) -> InvoiceScanResult:
    """Build InvoiceScanResult from extracted dict and parsed line items."""
    ai_missing_batch = extracted.get("missing_batch", False)
    ai_missing_expiry = extracted.get("missing_expiry", False)
    computed_missing_batch = any(
        not (item.batch_number or item.batch_number_raw) for item in line_items
    )
    computed_missing_expiry = any(
        not (item.expiry_date or item.expiry_date_raw) for item in line_items
    )

    for li in line_items:
        if li.gross_price is not None or li.discount_percent is not None:
            logger.info(
                "Discount data: %s gross=%s disc%%=%s disc_amt=%s net=%s",
                li.product_name_raw or li.product_name,
                li.gross_price,
                li.discount_percent,
                li.discount_amount,
                li.unit_price,
            )

    errors = validation_errors or []
    completeness_data = completeness or {}
    visible_row_count = int(
        completeness_data.get("visible_row_count", len(line_items))
    )
    extracted_row_count = int(
        completeness_data.get("extracted_row_count", len(line_items))
    )
    completeness_status = completeness_data.get("completeness_status")
    if completeness_status not in {"complete", "suspicious", "incomplete"}:
        completeness_status = (
            "complete"
            if visible_row_count == extracted_row_count and len(errors) == 0
            else "suspicious"
        )
    warnings = [str(w) for w in (completeness_data.get("warnings") or []) if w]

    return InvoiceScanResult(
        document_type=extracted.get("document_type"),
        needs_companion_doc=bool(extracted.get("needs_companion_doc", False)),
        missing_batch=ai_missing_batch or computed_missing_batch,
        missing_expiry=ai_missing_expiry or computed_missing_expiry,
        supplier_name=extracted.get("supplier_name"),
        supplier_eik=extracted.get("supplier_eik"),
        supplier_vat=extracted.get("supplier_vat"),
        supplier_address=extracted.get("supplier_address"),
        supplier_phone=extracted.get("supplier_phone"),
        supplier_email=extracted.get("supplier_email"),
        supplier_contact=extracted.get("supplier_contact"),
        invoice_number=extracted.get("invoice_number"),
        invoice_date=extracted.get("invoice_date"),
        line_items=line_items,
        visible_row_count=visible_row_count,
        extracted_row_count=extracted_row_count,
        completeness_status=completeness_status,
        warnings=warnings,
        total_net=extracted.get("total_net"),
        total_vat=extracted.get("total_vat"),
        total_gross=extracted.get("total_gross"),
        currency=extracted.get("currency", "BGN"),
        validation_passed=len(errors) == 0,
        validation_errors=errors,
        few_shot_used=few_shot_used,
        few_shot_supplier=few_shot_supplier,
    )


# ── Layer 3: Validation ─────────────────────────────────────────────────────

def _validate_extraction(line_items: list[LineItem], extracted: dict) -> list[ValidationError]:
    """Validate arithmetic consistency of extracted invoice data."""
    errors = []

    # Check each item: quantity × unit_price ≈ total_price
    for i, item in enumerate(line_items):
        if item.quantity is not None and item.unit_price is not None and item.total_price is not None:
            expected = round(item.quantity * item.unit_price, 2)
            actual = round(item.total_price, 2)
            if abs(expected - actual) > 0.02:
                item_name = item.product_name_raw or item.product_name or f"Row {i + 1}"
                errors.append(ValidationError(
                    field=f"line_items[{i}].total_price",
                    message=f"Item '{item_name}': qty({item.quantity}) × unit_price({item.unit_price}) = {expected}, but total_price = {actual}",
                    expected=expected,
                    actual=actual,
                ))

    # Check subtotal: sum of item totals ≈ total_net
    subtotal = extracted.get("total_net")
    if subtotal is not None:
        items_sum = sum(item.total_price for item in line_items if item.total_price is not None)
        if abs(items_sum - subtotal) > 0.05:
            errors.append(ValidationError(
                field="total_net",
                message=f"Sum of line item totals ({items_sum:.2f}) ≠ subtotal ({subtotal:.2f})",
                expected=items_sum,
                actual=subtotal,
            ))

    # Check total: subtotal + vat ≈ total_gross
    total_net = extracted.get("total_net")
    total_vat = extracted.get("total_vat")
    total_gross = extracted.get("total_gross")
    if total_net is not None and total_vat is not None and total_gross is not None:
        expected_gross = round(total_net + total_vat, 2)
        if abs(expected_gross - total_gross) > 0.05:
            errors.append(ValidationError(
                field="total_gross",
                message=f"total_net({total_net}) + total_vat({total_vat}) = {expected_gross}, but total_gross = {total_gross}",
                expected=expected_gross,
                actual=total_gross,
            ))

    if errors:
        logger.warning(f"Validation found {len(errors)} errors: {[e.message for e in errors]}")
    else:
        logger.info("Validation passed — all arithmetic checks OK")

    return errors


def _checksum_valid(line_items: list[LineItem], extracted: dict) -> bool:
    """Check if sum of line item totals matches the invoice total (within 1.0 tolerance)."""
    invoice_total = extracted.get("total_gross") or extracted.get("total_net")
    if invoice_total is None:
        return True
    extracted_total = _sum_line_item_totals(line_items)
    diff = abs(extracted_total - invoice_total)
    if diff > 1.0:
        logger.warning(f"Checksum MISMATCH: sum={extracted_total:.2f}, invoice={invoice_total:.2f}, diff={diff:.2f}")
        return False
    logger.info(f"Checksum OK: sum={extracted_total:.2f}, total={invoice_total:.2f}")
    return True


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/quick-invoice-check")
async def quick_invoice_check(
    response: Response,
    file: UploadFile = File(...),
    x_scan_trace_id: Optional[str] = Header(None, alias=SCAN_TRACE_HEADER),
):
    """Quick pre-check: extract ONLY the invoice number from image."""
    trace_id = _resolve_scan_trace_id(x_scan_trace_id)
    response.headers[SCAN_TRACE_HEADER] = trace_id
    raw_bytes = await file.read()
    content_type = file.content_type or ""
    filename = file.filename or ""
    t_start = time.time()

    _scan_log(
        "quick_request_received",
        trace_id,
        filename=filename,
        content_type=content_type,
        file_size_bytes=len(raw_bytes),
    )

    # Transparent HEIC → JPEG normalization (iPhone uploads)
    raw_bytes, content_type = _maybe_normalize_heic(raw_bytes, content_type, filename)

    try:
        if content_type in ("image/jpeg", "image/png", "image/jpg") or filename.lower().endswith((".jpg", ".jpeg", ".png")):
            mime = "image/jpeg" if "jpg" in filename.lower() or "jpeg" in content_type else "image/png"
            b64, final_mime = _image_to_base64(raw_bytes, mime)
        elif content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            pages = _pdf_to_images_base64(raw_bytes)
            image_pages = [(d, m) for d, m in pages if m != "text/plain"]
            if image_pages:
                b64, final_mime = image_pages[0]
            else:
                raise HTTPException(status_code=400, detail="PDF contains no renderable pages")
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {content_type}")

        invoice_number = _quick_check_with_claude(b64, final_mime)
        _scan_log(
            "quick_request_completed",
            trace_id,
            duration_ms=round((time.time() - t_start) * 1000),
            invoice_number=invoice_number,
            success=bool(invoice_number),
        )
        return {"invoice_number": invoice_number, "trace_id": trace_id}
    except HTTPException as exc:
        _scan_log(
            "quick_request_http_error",
            trace_id,
            duration_ms=round((time.time() - t_start) * 1000),
            status_code=exc.status_code,
            detail=exc.detail,
        )
        raise
    except Exception as e:
        _scan_log(
            "quick_request_failed",
            trace_id,
            duration_ms=round((time.time() - t_start) * 1000),
            error=str(e),
        )
        logger.exception(f"quick-invoice-check failed: {e}")
        return {"invoice_number": None, "trace_id": trace_id}

@router.post("/scan-invoice", response_model=InvoiceScanResult)
async def scan_invoice(
    response: Response,
    file: UploadFile = File(...),
    x_scan_trace_id: Optional[str] = Header(None, alias=SCAN_TRACE_HEADER),
):
    """
    Upload a JPG, PNG, or PDF invoice.
    Extraction-first pipeline with lazy recovery only when completeness signals demand it.
    """
    trace_id = _resolve_scan_trace_id(x_scan_trace_id)
    response.headers[SCAN_TRACE_HEADER] = trace_id
    content_type = file.content_type or ""
    filename = file.filename or ""
    raw_bytes = await file.read()
    t_start = time.time()

    _scan_log(
        "request_received",
        trace_id,
        filename=filename,
        content_type=content_type,
        file_size_bytes=len(raw_bytes),
    )

    # Transparent HEIC → JPEG normalization (iPhone uploads). Browsers often
    # send .heic as application/octet-stream, so we sniff by filename too.
    raw_bytes, content_type = _maybe_normalize_heic(raw_bytes, content_type, filename)

    try:
        image_parts: list[tuple[str, str]] = []
        assist_image_parts: list[tuple[str, str]] | None = None
        ocr_text: str | None = None
        few_shot_templates: list[dict] | None = None
        few_shot_supplier: str | None = None
        mobile_assist_enabled = False
        text_prompt = """Extract ALL invoice data from this image.

CRITICAL RULES FOR LINE ITEMS:
1. Extract EVERY SINGLE row from the product table — do NOT skip ANY row.
2. BEFORE returning, COUNT the total number of product rows. Your line_items array MUST match exactly.
3. Return items in the EXACT ORDER they appear (top to bottom).
4. If an ITEM/code column exists (4-digit numbers like 1026, 1002...), use it to verify completeness.
5. Missing even ONE item = FAILURE. Double-check your count.
6. Include row_number for every line item. If invoice has row numbers, copy them. Otherwise assign 1..N.

TABLE COLUMN READING — be VERY careful:
- The table typically has columns: ITEM | DESCRIPTION | UNIT | QTY | UNIT PRICE | AMOUNT | DISC | VAT | TOTAL
- QTY (quantity) is usually the 4th column — a number like 7, 27, 8, 3, 2.7, 30, 22.4, 11.2, 5.6
- UNIT PRICE is usually the 5th column — often 4.80, 10.00, 0.60
- TOTAL is the LAST number column — it equals QTY × UNIT PRICE
- Do NOT confuse UNIT PRICE with QTY
- Verify: QTY × UNIT PRICE should approximately equal TOTAL for each row

HANDWRITTEN ANNOTATIONS:
- If there are handwritten dates (like 19/04, 17/04) next to product names, these are EXPIRY DATES
- Extract them as expiry_date in YYYY-MM-DD format (assume current year 2026)"""

        recovery_prompt_suffix = """

PHOTO RECOVERY NOTE:
- If multiple images are attached, they show the SAME invoice photo.
- Some extra images may be high-contrast renders or zoomed crops of the same photo.
- Use the first/original image for overall layout, geometry, and row order.
- Use the extra images only to recover faint, blurred, shadowed, cropped, or low-contrast text so you do not miss rows."""

        if content_type in ("image/jpeg", "image/png", "image/jpg") or filename.lower().endswith((".jpg", ".jpeg", ".png")):
            mime = "image/jpeg" if "jpg" in filename.lower() or "jpeg" in content_type else "image/png"
            image_parts = _image_to_scan_parts(
                raw_bytes,
                mime,
                include_mobile_photo_assist=False,
            )
            mobile_assist_enabled = _should_enable_mobile_photo_assist(raw_bytes)

            try:
                preprocessed = preprocess_for_ocr(raw_bytes)
                ocr_text = extract_text_tesseract(preprocessed)
            except Exception as e:
                logger.warning(f"Tesseract OCR failed ({e}), proceeding without OCR text")
                ocr_text = None

        elif content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            pages = _pdf_to_images_base64(raw_bytes)
            texts = []
            for data, mime in pages:
                if mime == "text/plain":
                    texts.append(data)
                else:
                    image_parts.append((data, mime))
            if texts:
                ocr_text = "\n\n--- PAGE BREAK ---\n\n".join(texts)

            if image_parts:
                max_pdf_ocr_pages = max(1, int(os.environ.get("SCAN_MAX_PDF_OCR_PAGES", "8")))
                ocr_chunks: list[str] = []
                for page_idx, (page_b64, _) in enumerate(image_parts[:max_pdf_ocr_pages], start=1):
                    try:
                        page_bytes = base64.b64decode(page_b64)
                        preprocessed = preprocess_for_ocr(page_bytes)
                        page_ocr = extract_text_tesseract(preprocessed)
                        if page_ocr and page_ocr.strip():
                            ocr_chunks.append(f"--- PAGE {page_idx} OCR ---\n{page_ocr.strip()}")
                    except Exception as e:
                        logger.warning(f"Tesseract OCR on PDF page {page_idx} failed ({e})")
                if ocr_chunks:
                    page_ocr_text = "\n\n".join(ocr_chunks)
                    if ocr_text:
                        ocr_text = f"{ocr_text}\n\n{page_ocr_text}"
                    else:
                        ocr_text = page_ocr_text
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {content_type}")

        _scan_log(
            "input_prepared",
            trace_id,
            image_parts=len(image_parts),
            has_ocr_text=bool(ocr_text),
            mobile_assist_enabled=mobile_assist_enabled,
        )

        t_llm = time.time()
        _scan_log("primary_extraction_started", trace_id, image_parts=len(image_parts))
        extracted = _extract_invoice_with_fallback(
            image_parts,
            text_prompt,
            ocr_text=ocr_text,
            few_shot_templates=None,
            allow_provider_fallback=True,
            trace_id=trace_id,
        )
        _scan_log(
            "primary_extraction_finished",
            trace_id,
            duration_ms=round((time.time() - t_llm) * 1000),
        )

        line_items = _parse_line_items(extracted)
        line_items = _inflate_sparse_line_items(line_items, extracted)
        initial_checksum_ok = _checksum_valid(line_items, extracted)
        initial_score, initial_assessment = _score_extraction_candidate(line_items, extracted, ocr_text)
        logger.info(
            "Extraction completeness assessment: items=%d, suspicious=%s, reasons=%s, row_hint=%d, row_max=%d, table_hint=%d, expected_rows=%d, score=%.2f",
            initial_assessment["item_count"],
            initial_assessment["suspicious"],
            initial_assessment["reasons"],
            initial_assessment["row_number_sequence_hint"],
            initial_assessment["row_number_max_hint"],
            initial_assessment["table_row_hint"],
            initial_assessment["expected_row_count"],
            initial_score,
        )

        candidates: list[tuple[str, dict, list[LineItem], float, dict]] = [
            ("initial", extracted, line_items, initial_score, initial_assessment)
        ]

        retry_needed = (not initial_checksum_ok) or initial_assessment["suspicious"]
        if retry_needed:
            _scan_log(
                "retry_path_started",
                trace_id,
                checksum_ok=initial_checksum_ok,
                reasons=initial_assessment["reasons"] or ["checksum_mismatch"],
            )
            if mobile_assist_enabled and assist_image_parts is None and image_parts:
                base_mime = image_parts[0][1]
                assist_image_parts = _image_to_scan_parts(
                    raw_bytes,
                    base_mime,
                    include_mobile_photo_assist=True,
                    max_assist_images=1,
                )
            retry_image_parts = assist_image_parts or image_parts
            retry_prompt = text_prompt + (recovery_prompt_suffix if retry_image_parts is assist_image_parts else "")

            if retry_image_parts and few_shot_templates is None:
                try:
                    client = _get_gemini_client()
                    supplier_name = _extract_supplier_quick(client, retry_image_parts)
                    if supplier_name:
                        templates = _fetch_templates(supplier_name)
                        if templates:
                            few_shot_templates = templates
                            few_shot_supplier = supplier_name
                            _scan_log(
                                "few_shot_templates_found",
                                trace_id,
                                supplier_name=supplier_name,
                                template_count=len(templates),
                            )
                            logger.info(f"Found {len(templates)} few-shot templates for '{supplier_name}'")
                        else:
                            _scan_log(
                                "few_shot_templates_missing",
                                trace_id,
                                supplier_name=supplier_name,
                            )
                            logger.info(f"No templates found for '{supplier_name}', retrying without few-shot examples")
                except Exception as e:
                    _scan_log("few_shot_lookup_failed", trace_id, error=str(e))
                    logger.warning(f"Deferred few-shot lookup failed: {e}")

            logger.info(
                "Retrying extraction due to completeness/checksum signals: checksum_ok=%s, reasons=%s, assist=%s, few_shot=%s",
                initial_checksum_ok,
                initial_assessment["reasons"] or ["checksum_mismatch"],
                retry_image_parts is assist_image_parts,
                bool(few_shot_templates),
            )
            retry_prompt = _build_completeness_retry_prompt(retry_prompt, initial_assessment)

            try:
                t_retry = time.time()
                _scan_log(
                    "retry_extraction_started",
                    trace_id,
                    assist_used=retry_image_parts is assist_image_parts,
                    few_shot_used=bool(few_shot_templates),
                    image_parts=len(retry_image_parts),
                )
                retry_extracted = _extract_invoice_with_fallback(
                    retry_image_parts,
                    retry_prompt,
                    ocr_text=ocr_text,
                    few_shot_templates=few_shot_templates,
                    allow_provider_fallback=False,
                    trace_id=trace_id,
                )
                _scan_log(
                    "retry_extraction_finished",
                    trace_id,
                    duration_ms=round((time.time() - t_retry) * 1000),
                )

                retry_items = _parse_line_items(retry_extracted)
                retry_items = _inflate_sparse_line_items(retry_items, retry_extracted)
                retry_score, retry_assessment = _score_extraction_candidate(
                    retry_items, retry_extracted, ocr_text
                )
                logger.info(
                    "Retry assessment: items=%d, suspicious=%s, reasons=%s, score=%.2f",
                    retry_assessment["item_count"],
                    retry_assessment["suspicious"],
                    retry_assessment["reasons"],
                    retry_score,
                )
                candidates.append(("retry", retry_extracted, retry_items, retry_score, retry_assessment))
            except Exception as e:
                _scan_log("retry_extraction_failed", trace_id, error=str(e))
                logger.warning(f"Retry extraction failed: {e}")

        best_label, best_extracted, best_items, best_score, best_assessment = _select_best_candidate(candidates)

        needs_line_item_rescue = (
            best_assessment.get("suspicious")
            and int(best_assessment.get("expected_row_count") or 0) >= 4
            and len(best_items) < int(best_assessment.get("expected_row_count") or 0)
        )
        if needs_line_item_rescue:
            _scan_log(
                "line_item_rescue_started",
                trace_id,
                expected_row_count=int(best_assessment.get("expected_row_count") or 0),
                current_item_count=len(best_items),
            )
            rescue_image_parts = assist_image_parts or image_parts
            rescue_prompt = text_prompt + (recovery_prompt_suffix if rescue_image_parts is assist_image_parts else "")
            rescue_prompt = _build_completeness_retry_prompt(
                rescue_prompt,
                best_assessment,
                line_items_only=True,
            )
            try:
                t_rescue = time.time()
                rescue_extracted = _extract_invoice_with_fallback(
                    rescue_image_parts,
                    rescue_prompt,
                    ocr_text=ocr_text,
                    few_shot_templates=few_shot_templates,
                    allow_provider_fallback=False,
                    trace_id=trace_id,
                )
                _scan_log(
                    "line_item_rescue_finished",
                    trace_id,
                    duration_ms=round((time.time() - t_rescue) * 1000),
                )

                merged_extracted = _merge_with_rescued_line_items(best_extracted, rescue_extracted)
                merged_items = _parse_line_items(merged_extracted)
                merged_items = _inflate_sparse_line_items(merged_items, merged_extracted)
                merged_score, merged_assessment = _score_extraction_candidate(
                    merged_items, merged_extracted, ocr_text
                )
                logger.info(
                    "Line-item rescue assessment: items=%d, suspicious=%s, reasons=%s, score=%.2f",
                    merged_assessment["item_count"],
                    merged_assessment["suspicious"],
                    merged_assessment["reasons"],
                    merged_score,
                )
                candidates.append(
                    ("line_item_rescue", merged_extracted, merged_items, merged_score, merged_assessment)
                )
                best_label, best_extracted, best_items, best_score, best_assessment = _select_best_candidate(candidates)
            except Exception as e:
                _scan_log("line_item_rescue_failed", trace_id, error=str(e))
                logger.warning(f"Line-item rescue extraction failed: {e}")

        validation_errors = _validate_extraction(best_items, best_extracted)
        completeness = _build_completeness_metadata(
            best_items,
            best_assessment,
            validation_errors,
        )
        result = _build_result(
            best_extracted,
            best_items,
            validation_errors=validation_errors,
            few_shot_used=bool(few_shot_templates),
            few_shot_supplier=few_shot_supplier,
            completeness=completeness,
        )

        _scan_log(
            "request_completed",
            trace_id,
            best_label=best_label,
            item_count=len(best_items),
            visible_row_count=result.visible_row_count,
            extracted_row_count=result.extracted_row_count,
            completeness_status=result.completeness_status,
            mobile_assist_enabled=mobile_assist_enabled,
            total_duration_ms=round((time.time() - t_start) * 1000),
        )
        return result

    except HTTPException as exc:
        _scan_log(
            "request_http_error",
            trace_id,
            status_code=exc.status_code,
            detail=exc.detail,
            total_duration_ms=round((time.time() - t_start) * 1000),
        )
        raise
    except Exception as e:
        _scan_log(
            "request_failed",
            trace_id,
            error=str(e),
            total_duration_ms=round((time.time() - t_start) * 1000),
        )
        logger.exception(f"scan-invoice failed: {e}")
        raise HTTPException(status_code=500, detail=f"OCR processing failed: {str(e)}")


@router.post("/confirm-invoice-template")
async def confirm_invoice_template(req: ConfirmTemplateRequest):
    """Save a confirmed invoice extraction as a template for few-shot learning."""
    template_id = _save_template(
        supplier_name=req.supplier_name,
        supplier_eik=req.supplier_eik,
        image_base64=req.image_base64,
        extracted_json=req.extracted_json,
    )
    if template_id is None:
        raise HTTPException(status_code=500, detail="Failed to save template — check DATABASE_URL")
    cache_key = ((req.supplier_name or "").strip().lower(), 3)
    with _template_cache_lock:
        _template_cache.pop(cache_key, None)
    logger.info(f"Saved invoice template #{template_id} for supplier '{req.supplier_name}'")
    return {"id": template_id, "status": "saved"}


@router.get("/invoice-templates")
async def list_invoice_templates(supplier: Optional[str] = Query(None)):
    """List invoice templates, optionally filtered by supplier name."""
    templates = _list_templates(supplier_name=supplier)
    return {"templates": templates, "count": len(templates)}
