"""
Product Alias Matching module — POST /ai/match-products
Matches OCR-extracted product names to existing DB products using aliases + Gemini AI.
"""
import json
import logging
import re
import time
from typing import Optional

import os
import unicodedata
from difflib import SequenceMatcher
from threading import Lock

import httpx
from fastapi import APIRouter, Depends, HTTPException
from google import genai
from pydantic import BaseModel

from app.dependencies import require_internal_api_key

try:
    from anyascii import anyascii
except ModuleNotFoundError:  # pragma: no cover - exercised only in degraded local envs
    _FALLBACK_TRANSLITERATION = {
        # Cyrillic (BG)
        "А": "A", "а": "a", "Б": "B", "б": "b", "В": "V", "в": "v", "Г": "G", "г": "g",
        "Д": "D", "д": "d", "Е": "E", "е": "e", "Ж": "Zh", "ж": "zh", "З": "Z", "з": "z",
        "И": "I", "и": "i", "Й": "Y", "й": "y", "К": "K", "к": "k", "Л": "L", "л": "l",
        "М": "M", "м": "m", "Н": "N", "н": "n", "О": "O", "о": "o", "П": "P", "п": "p",
        "Р": "R", "р": "r", "С": "S", "с": "s", "Т": "T", "т": "t", "У": "U", "у": "u",
        "Ф": "F", "ф": "f", "Х": "H", "х": "h", "Ц": "Ts", "ц": "ts", "Ч": "Ch", "ч": "ch",
        "Ш": "Sh", "ш": "sh", "Щ": "Sht", "щ": "sht", "Ъ": "A", "ъ": "a", "Ь": "Y", "ь": "y",
        "Ю": "Yu", "ю": "yu", "Я": "Ya", "я": "ya",
        # Greek
        "Α": "A", "α": "a", "Β": "V", "β": "v", "Γ": "G", "γ": "g", "Δ": "D", "δ": "d",
        "Ε": "E", "ε": "e", "Ζ": "Z", "ζ": "z", "Η": "I", "η": "i", "Θ": "Th", "θ": "th",
        "Ι": "I", "ι": "i", "Κ": "K", "κ": "k", "Λ": "L", "λ": "l", "Μ": "M", "μ": "m",
        "Ν": "N", "ν": "n", "Ξ": "X", "ξ": "x", "Ο": "O", "ο": "o", "Π": "P", "π": "p",
        "Ρ": "R", "ρ": "r", "Σ": "S", "σ": "s", "ς": "s", "Τ": "T", "τ": "t", "Υ": "Y", "υ": "y",
        "Φ": "F", "φ": "f", "Χ": "Ch", "χ": "ch", "Ψ": "Ps", "ψ": "ps", "Ω": "O", "ω": "o",
    }

    def anyascii(value: str) -> str:
        transliterated = "".join(_FALLBACK_TRANSLITERATION.get(char, char) for char in value or "")
        normalized = unicodedata.normalize("NFKD", transliterated)
        return normalized.encode("ascii", "ignore").decode("ascii")

try:
    from rapidfuzz import fuzz
except ModuleNotFoundError:  # pragma: no cover - exercised only in degraded local envs
    class _FuzzFallback:
        @staticmethod
        def token_sort_ratio(left: str, right: str) -> float:
            left_tokens = " ".join(sorted((left or "").split()))
            right_tokens = " ".join(sorted((right or "").split()))
            return SequenceMatcher(None, left_tokens, right_tokens).ratio() * 100

    fuzz = _FuzzFallback()

from app.config import settings

logger = logging.getLogger(__name__)
# Every route on this router requires the internal API key; the warehouse-backend
# is the only intended caller.
router = APIRouter(dependencies=[Depends(require_internal_api_key)])

MATCH_TIMEOUT = 15.0  # seconds for backend API calls
CACHE_TTL_SECONDS = max(30, int(os.environ.get("MATCH_CACHE_TTL_SECONDS", "180")))
AUTO_LINK_CONFIDENCE = 0.75  # AI/fuzzy/translit are auto-linkable from this confidence up
ALIAS_AUTOSAVE_CONFIDENCE = 0.85  # Keep alias writes stricter than auto-linking
TRANSLIT_MIN_CONFIDENCE = 0.70  # Keep lower-confidence translit as best-effort suggestions
NAME_CONFLICT_MIN_CONFIDENCE = 0.20  # Below this, code/alias-only links need stronger non-name evidence
SUPPLIER_GROUP_GENERIC_NAMES = ("Доставчици", "Клиенти", "Служебна група")
_cache_lock = Lock()
_cache_store: dict[str, tuple[float, object]] = {}


def _cache_get(key: str):
    now = time.time()
    with _cache_lock:
        cached = _cache_store.get(key)
        if not cached:
            return None
        if (now - cached[0]) >= CACHE_TTL_SECONDS:
            _cache_store.pop(key, None)
            return None
        return cached[1]


def _cache_set(key: str, value: object) -> object:
    with _cache_lock:
        _cache_store[key] = (time.time(), value)
    return value
NAME_MATCH_LOW_SIGNAL_TOKENS = {
    "premium", "mix", "mini", "cup", "cake", "cream", "dessert",
    "with", "and", "the", "in", "a", "of", "le",
    "karamanli", "legrand", "ragby", "natural", "fat",
}
NAME_MATCH_NOISE_TOKENS = {
    "zamrazen", "frozen", "kash", "opakovka", "br", "kg", "g",
    "pastry", "set", "heart", "triangle", "shaped", "family", "middle", "size",
    "greengrocers", "knitted", "ble",
}
NAME_MATCH_PRIORITY_TOKENS = {
    "feta", "halloumi", "graviera", "kefalotiri", "kasseri", "anthotiro",
    "mizithra", "myzithra", "mastelo", "katziki", "katsikisi", "manouri",
}


# ── Pydantic models ──────────────────────────────────────────────────────────

class MatchLineItem(BaseModel):
    product_name: str
    product_name_raw: Optional[str] = None
    product_code: Optional[str] = None  # Item code from invoice (e.g. "1002")
    name_bg: Optional[str] = None
    quantity: Optional[float] = None
    unit_price: Optional[float] = None


class MatchRequest(BaseModel):
    line_items: list[MatchLineItem]
    supplier_name: Optional[str] = None
    supplier_eik: Optional[str] = None
    preview_mode: bool = False


class Suggestion(BaseModel):
    product_id: int
    product_name: str
    product_sku: Optional[str] = None
    confidence: float
    purchase_price: Optional[float] = None


class MatchResult(BaseModel):
    ocr_name: str
    ocr_name_bg: Optional[str] = None
    matched_product_id: Optional[int] = None
    matched_product_name: Optional[str] = None
    matched_product_sku: Optional[str] = None
    confidence: Optional[float] = None
    match_source: Optional[str] = None  # "alias" | "sku" | "fuzzy" | "translit" | "ai" | "none"
    matched_purchase_price: Optional[float] = None
    matched_selling_price: Optional[float] = None
    suggestions: list[Suggestion] = []


class MatchResponse(BaseModel):
    matches: list[MatchResult]


# ── Backend API helpers ──────────────────────────────────────────────────────

def _backend_headers() -> dict:
    return {"Authorization": f"Bearer {settings.backend_api_key}"}


def _supplier_sku_prefix(supplier_name: Optional[str]) -> Optional[str]:
    """
    Derive SKU prefix from supplier name.
    e.g. "DAGKOS ATHANASIOS" → "D", "PAPAS FOODS" → "P"
    The warehouse uses first letter of supplier name + invoice code = SKU.
    """
    if not supplier_name:
        return None
    first_word = supplier_name.strip().split()[0] if supplier_name.strip() else ""
    if first_word and len(first_word) >= 1:
        return first_word[0].upper()
    return None


async def _lookup_by_sku(sku: str) -> Optional[dict]:
    """Look up a product by exact SKU match."""
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as client:
            resp = await client.get(
                f"{settings.warehouse_api_url}/products",
                params={"search": sku, "limit": "5"},
                headers=_backend_headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            products = data.get("products", data.get("data", []))
            # Find exact SKU match
            for p in products:
                if (p.get("sku") or "").strip().upper() == sku.strip().upper():
                    return p
            return None
    except Exception as e:
        logger.warning(f"SKU lookup failed for '{sku}': {e}")
        return None


async def _lookup_alias(alias_name: str, supplier_id: Optional[int]) -> Optional[dict]:
    """Check product_aliases table for an exact match."""
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as client:
            params = {"alias_name": alias_name}
            if supplier_id:
                params["supplier_id"] = str(supplier_id)
            resp = await client.get(
                f"{settings.warehouse_api_url}/product-aliases/lookup",
                params=params,
                headers=_backend_headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("match")
    except Exception as e:
        logger.warning(f"Alias lookup failed for '{alias_name}': {e}")
        return None


def _normalize_eik(eik: str) -> str:
    """Strip country prefix (EL, BG, GR) from EIK/VAT number for comparison."""
    eik = eik.strip().upper()
    for prefix in ("EL", "BG", "GR", "CY", "RO"):
        if eik.startswith(prefix):
            return eik[len(prefix):]
    return eik


async def _find_supplier_by_eik(eik: str) -> Optional[dict]:
    """Find supplier in DB by EIK (handles EL/BG/GR prefix differences)."""
    normalized_eik = _normalize_eik(eik)
    cache_key = f"supplier:{normalized_eik}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore[return-value]
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as client:
            resp = await client.get(
                f"{settings.warehouse_api_url}/suppliers",
                headers=_backend_headers(),
            )
            resp.raise_for_status()
            suppliers = resp.json().get("data", [])
            for s in suppliers:
                db_eik = _normalize_eik(s.get("eik", "") or "")
                if db_eik == normalized_eik:
                    return _cache_set(cache_key, s)  # type: ignore[return-value]
            return _cache_set(cache_key, None)  # type: ignore[return-value]
    except Exception as e:
        logger.warning(f"Supplier lookup failed for EIK {eik}: {e}")
        return None


async def _fetch_products_by_group(group_name: str) -> list[dict]:
    """Fetch all products matching a supplier group hint via backend filtering."""
    cache_key = f"group:{(group_name or '').strip().lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return list(cached)  # type: ignore[arg-type]
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as client:
            all_matched = []
            for page in range(1, 20):
                resp = await client.get(
                    f"{settings.warehouse_api_url}/products",
                    params={
                        "supplier_group": group_name,
                        "limit": "100",
                        "page": str(page),
                        "catalog": "true",
                        "active_only": "false",
                    },
                    headers=_backend_headers(),
                )
                resp.raise_for_status()
                data = resp.json()
                items = data.get("products", data.get("data", []))
                all_matched.extend(items)
                if len(items) < 100:
                    break
            return list(_cache_set(cache_key, list(all_matched)))  # type: ignore[arg-type]
    except Exception as e:
        logger.warning(f"Product fetch failed for group '{group_name}': {e}")
        return []


async def _fetch_all_products() -> list[dict]:
    """Fetch full product catalog, including out-of-stock items."""
    cache_key = "products:all"
    cached = _cache_get(cache_key)
    if cached is not None:
        return list(cached)  # type: ignore[arg-type]
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as client:
            all_products: list[dict] = []
            for page in range(1, 50):
                resp = await client.get(
                    f"{settings.warehouse_api_url}/products",
                    params={"page": str(page), "limit": "100", "catalog": "true", "active_only": "false"},
                    headers=_backend_headers(),
                )
                resp.raise_for_status()
                data = resp.json()
                items = data.get("products", data.get("data", []))
                all_products.extend(items)
                if len(items) < 100:
                    break
            return list(_cache_set(cache_key, list(all_products)))  # type: ignore[arg-type]
    except Exception as e:
        logger.warning(f"Full product fetch failed: {e}")
        return []


def _normalize_sku(value: Optional[str]) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", (value or "").strip().upper())


def _normalize_invoice_code(value: Optional[str]) -> str:
    """
    Normalize OCR invoice product codes while stripping common leading labels.
    Examples: "No 1002", "CODE:1002", "item-1002" -> "1002".
    """
    code = _normalize_sku(value)
    if not code:
        return ""

    for prefix in ("NO", "NUM", "ITEM", "CODE", "KOD", "KODIKOS", "KWDIKOS"):
        if code.startswith(prefix):
            stripped = code[len(prefix):]
            if any(ch.isdigit() for ch in stripped):
                code = stripped
                break
    return code


def _invoice_code_segment_variants(value: Optional[str]) -> set[str]:
    """Generate joined code variants for dotted/slashed invoice codes with segment zero-padding ambiguity."""
    raw = (value or "").strip().upper()
    if not raw:
        return set()

    parts = [part for part in re.split(r"[^A-Z0-9]+", raw) if part]
    if len(parts) <= 1:
        return set()

    normalized_parts: list[list[str]] = []
    for part in parts:
        cleaned = re.sub(r"[^A-Z0-9]", "", part)
        if not cleaned:
            return set()
        if cleaned.isdigit() and len(cleaned) > 1 and cleaned.startswith("0"):
            variants = [cleaned[i:] for i in range(len(cleaned)) if cleaned[i:]]
            normalized_parts.append(list(dict.fromkeys(variants)))
        else:
            normalized_parts.append([cleaned])

    variants: set[str] = set()

    def _build(index: int, current: str) -> None:
        if len(variants) >= 128:
            return
        if index >= len(normalized_parts):
            if current:
                variants.add(current)
            return
        for part_variant in normalized_parts[index]:
            _build(index + 1, current + part_variant)

    _build(0, "")
    return variants


def _sku_numeric_part(value: Optional[str]) -> str:
    return "".join(ch for ch in _normalize_sku(value) if ch.isdigit())


def _normalized_digits(value: Optional[str]) -> str:
    digits = _sku_numeric_part(value)
    if not digits:
        return ""
    stripped = digits.lstrip("0")
    return stripped or "0"


def _code_variants(product_code: Optional[str], sku_prefix: Optional[str]) -> set[str]:
    """
    Build candidate code forms for robust SKU matching.
    Handles invoice labels, optional supplier prefix, and leading-zero noise.
    """
    code = _normalize_invoice_code(product_code)
    if not code:
        return set()

    variants: set[str] = {code}
    variants.update(_invoice_code_segment_variants(product_code))
    digits = "".join(ch for ch in code if ch.isdigit())
    prefix = _normalize_sku(sku_prefix)[:1] if sku_prefix else ""

    if digits:
        variants.add(digits)
        stripped_digits = digits.lstrip("0")
        if stripped_digits:
            variants.add(stripped_digits)
        if prefix:
            variants.add(f"{prefix}{digits}")
            if stripped_digits:
                variants.add(f"{prefix}{stripped_digits}")

    if prefix:
        if not code.startswith(prefix):
            variants.add(f"{prefix}{code}")
        elif len(code) > 1:
            variants.add(code[1:])

    return {v for v in variants if v}


def _extract_weight_grams(*values: Optional[str]) -> set[int]:
    weights: set[int] = set()
    for value in values:
        if not value:
            continue
        normalized = str(value).lower().replace(",", ".")
        for amount, unit in re.findall(r"(\d+(?:\.\d+)?)\s*(kg|g|гр|gr)\b", normalized):
            try:
                number = float(amount)
            except ValueError:
                continue
            grams = int(round(number * 1000)) if unit == "kg" else int(round(number))
            if grams > 0:
                weights.add(grams)
    return weights


def _name_match_confidence(ocr_names: list[str], product: dict) -> float:
    fuzzy = _fuzzy_name_match(ocr_names, [product])
    translit = _transliteration_match(ocr_names, [product])
    fuzzy_conf = fuzzy["confidence"] if fuzzy else 0.0
    translit_conf = translit["confidence"] if translit else 0.0
    return max(fuzzy_conf, translit_conf)


def _prioritize_products(products: list[dict], preferred_products: Optional[list[dict]] = None) -> list[dict]:
    """Return the full catalog with preferred products moved to the front, preserving the rest."""
    if not products:
        return []
    if not preferred_products:
        return products

    preferred_ids = {
        p.get("id")
        for p in preferred_products
        if isinstance(p, dict) and p.get("id") is not None
    }
    if not preferred_ids:
        return products

    prioritized = [p for p in products if p.get("id") in preferred_ids]
    prioritized.extend(p for p in products if p.get("id") not in preferred_ids)
    return prioritized


def _infer_group_from_codes(line_items: list[MatchLineItem], all_products: list[dict]) -> Optional[str]:
    """Infer supplier product group from repeated SKU-code hits when supplier lookup fails."""
    group_stats: dict[str, dict[str, object]] = {}

    for item in line_items:
        if not item.product_code:
            continue

        code_variants = _code_variants(item.product_code, sku_prefix=None)
        numeric_code = _normalized_digits(item.product_code)
        if not code_variants and not numeric_code:
            continue

        ocr_names = [n for n in [item.name_bg, item.product_name] if n]
        for product in all_products:
            sku = _normalize_sku(product.get("sku"))
            sku_digits = _normalized_digits(product.get("sku"))
            if not sku:
                continue

            exact_strength = 0.0
            if sku in code_variants:
                exact_strength = 2.8
            elif any(sku.endswith(code) for code in code_variants if len(code) >= 3):
                exact_strength = 2.5
            elif numeric_code and sku_digits == numeric_code:
                exact_strength = 2.2
            else:
                continue

            group_name = (product.get("group_name") or "").strip()
            if not group_name:
                continue

            stats = group_stats.setdefault(group_name, {"score": 0.0, "codes": set()})
            stats["score"] = float(stats["score"]) + exact_strength
            cast_codes = stats["codes"]
            if isinstance(cast_codes, set):
                for code in code_variants:
                    cast_codes.add(code)

            db_price = product.get("purchase_price") or product.get("unit_price") or product.get("delivery_price")
            if item.unit_price is not None and db_price is not None:
                try:
                    if abs(float(db_price) - float(item.unit_price)) < 0.11:
                        stats["score"] = float(stats["score"]) + 1.0
                except (TypeError, ValueError):
                    pass

            name_conf = _name_match_confidence(ocr_names, product) if ocr_names else 0.0
            if name_conf >= 0.70:
                stats["score"] = float(stats["score"]) + 0.5

    if not group_stats:
        return None

    ranked = sorted(
        group_stats.items(),
        key=lambda kv: (len(kv[1]["codes"]), float(kv[1]["score"])),
        reverse=True,
    )
    top_group, top_stats = ranked[0]
    top_codes = len(top_stats["codes"])
    top_score = float(top_stats["score"])
    second_codes = len(ranked[1][1]["codes"]) if len(ranked) > 1 else 0
    second_score = float(ranked[1][1]["score"]) if len(ranked) > 1 else 0.0

    if top_codes >= 2 and (top_codes > second_codes or top_score >= second_score + 1.0):
        logger.info(
            f"Inferred supplier group from invoice codes: '{top_group}' (codes={top_codes}, score={top_score:.2f})"
        )
        return top_group

    if top_score >= 6.0 and top_score >= second_score + 1.5:
        logger.info(
            f"Inferred supplier group from strong code overlap: '{top_group}' (codes={top_codes}, score={top_score:.2f})"
        )
        return top_group

    return None


def _infer_group_from_names(line_items: list[MatchLineItem], all_products: list[dict]) -> Optional[str]:
    """Infer supplier product group from repeated strong bilingual name hits."""
    group_stats: dict[str, dict[str, float]] = {}

    for item in line_items:
        ocr_names = _item_ocr_names(item)
        if not ocr_names:
            continue

        ranked: list[tuple[float, float, str]] = []
        for product in all_products:
            group_name = (product.get("group_name") or "").strip()
            if not group_name:
                continue
            conf = _canonical_name_confidence(ocr_names, product)
            if conf < 0.88:
                continue

            price_penalty = 0.0
            db_price = product.get("purchase_price") or product.get("unit_price") or product.get("delivery_price")
            if item.unit_price is not None and db_price is not None:
                try:
                    price_penalty = min(abs(float(db_price) - float(item.unit_price)) * 0.02, 0.12)
                except (TypeError, ValueError):
                    price_penalty = 0.0
            ranked.append((conf - price_penalty, conf, group_name))

        if not ranked:
            continue

        ranked.sort(reverse=True)
        top_score, top_conf, top_group = ranked[0]
        stats = group_stats.setdefault(top_group, {"score": 0.0, "items": 0.0})
        stats["score"] += top_score
        stats["items"] += 1.0

    if not group_stats:
        return None

    ranked_groups = sorted(
        group_stats.items(),
        key=lambda kv: (kv[1]["items"], kv[1]["score"]),
        reverse=True,
    )
    top_group, top_stats = ranked_groups[0]
    second_items = ranked_groups[1][1]["items"] if len(ranked_groups) > 1 else 0.0
    second_score = ranked_groups[1][1]["score"] if len(ranked_groups) > 1 else 0.0

    if top_stats["items"] >= 3 and (
        top_stats["items"] > second_items or top_stats["score"] >= second_score + 1.5
    ):
        logger.info(
            f"Inferred supplier group from strong name overlap: '{top_group}' "
            f"(items={top_stats['items']:.0f}, score={top_stats['score']:.2f})"
        )
        return top_group

    return None


# ── Fuzzy name matching (fast, no API calls) ─────────────────────────────────

def _clean_db_name(name: str) -> str:
    """Remove terminal supplier-brand suffixes while preserving meaningful quoted descriptors.

    Examples:
    - 'Овча Пастърма "SARY"' -> 'Овча Пастърма'
    - 'Телешки Суджук "Golcuk" "SARY"' -> 'Телешки Суджук "Golcuk"'
    - 'KARAMANLI SUJUK "GOLCUK"' -> unchanged
    - 'Beef "PASTRAMI" - NEW YORK USA' -> unchanged
    """
    cleaned = (name or "").strip()
    if not cleaned:
        return ""

    supplier_suffix_tokens = {
        "sary",
        "miran",
        "mirsan",
        "miryan",
        "amvrosia",
        "edesma",
        "koskery",
        "koskeri",
    }

    while True:
        match = re.search(r'\s+[\"«]([^\"»]{2,24})[\"»]\s*$', cleaned)
        if not match:
            break
        suffix_token = _normalize_greek_ascii(anyascii(match.group(1).strip()).lower())
        has_earlier_quote = bool(re.search(r'[\"«].+[\"»].+[\"«]', cleaned[:match.start()]))
        if suffix_token in supplier_suffix_tokens or (has_earlier_quote and suffix_token.isupper()):
            cleaned = cleaned[:match.start()].strip()
            continue
        break

    return cleaned


def _canonicalize_name_token(token: str) -> str:
    token = _normalize_greek_ascii(anyascii(token or "").lower())
    token = re.sub(r"[^a-z0-9]", "", token)
    if len(token) < 2:
        return ""

    if token.startswith(("potir", "potak", "portak", "portnak", "cup", "cups", "bowl", "chash", "kypel")):
        return "cup"
    if token.startswith(("ferrer", "ferrero", "ferero", "ferrerino", "ferrerin", "ferrino", "ferreino")):
        return "ferrer"
    if token.startswith(("profiter", "profitero", "profiterol")):
        return "profiteroles"
    if token.startswith(("speculo", "speculos")):
        return "speculoos"
    if token.startswith(("tiramis",)):
        return "tiramisu"
    if token.startswith(("eclair", "ecler", "eklair", "ekler")):
        return "eclair"
    if token.startswith(("negrak", "negra")):
        return "negraki"
    if token.startswith(("kok", "coc", "coq")):
        return "kok"
    if token.startswith(("saragl",)):
        return "saragli"
    if token.startswith(("baklav",)):
        return "baklava"
    if token.startswith(("feta", "fete", "fetas")):
        return "feta"
    if token.startswith(("halloum", "haloum", "halum", "halaum", "haloumi", "khaloumi", "khalumi")):
        return "halloumi"
    if token.startswith(("exarch", "eksarch", "ezarch", "ezarks", "exarx", "exarhos", "eksarh")):
        return "exarchos"
    if token.startswith(("nest", "folia", "gnesd", "gnezd", "fwlia")):
        return "nest"
    if token.startswith(("chocol", "sokol", "shokol")):
        return "chocolate"
    if token.startswith(("strawber", "fragol", "fraoul", "amarena")):
        return "strawberry"
    if token.startswith(("biscuit", "biskuit", "biscotti")):
        return "biscuit"
    if token.startswith(("tart", "tarte")):
        return "tart"
    if token.startswith(("portokal", "orange")):
        return "orange"
    if token.startswith(("lemon",)):
        return "lemon"
    if token.startswith(("redvelvet",)):
        return "redvelvet"

    # Meat / deli normalization for bilingual SARY catalog matching.
    if token.startswith(("pastirm", "pastyrm", "pastarm", "past", "pastrm")):
        return "pastirma"
    if token.startswith(("sujuk", "sudzhuk", "sudjuk", "soutzou", "soujouk")):
        return "sujuk"
    if token.startswith(("tongue", "ezik")):
        return "tongue"
    if token.startswith(("kavourm", "kavourm", "sazd", "sazdirm", "sazdarm")):
        return "kavourmas"
    if token.startswith(("salami", "salam")):
        return "salami"
    if token.startswith(("dry", "sukh")):
        return "dry"
    if token.startswith(("mortadel",)):
        return "mortadella"
    if token.startswith(("oregano", "rigan")):
        return "oregano"
    if token.startswith(("pepperoni",)):
        return "pepperoni"
    if token.startswith(("sausage", "nadenit", "nadenic")):
        return "sausage"
    if token.startswith(("steak", "stek", "purjol", "parzhol", "rzhola")):
        return "steak"
    if token.startswith(("file", "fillet", "filet")):
        return "fillet"
    if token.startswith(("roasted", "roast", "pechen", "pecheno", "psito")):
        return "roasted"
    if token.startswith(("smoked", "pushen")):
        return "smoked"
    if token.startswith(("prosciutto", "proshuto")):
        return "prosciutto"
    if token.startswith(("dramas", "drama")):
        return "drama"
    if token.startswith(("newyork", "new", "york")):
        return "newyork"
    if token.startswith(("golcuk", "goljuk", "golciuk")):
        return "golcuk"
    if token.startswith(("legrand", "legrande", "grand")):
        return "legrand"
    if token.startswith(("ragby", "rugby")):
        return "ragby"
    if token.startswith(("pork", "svinsk", "choiro")):
        return "pork"
    if token.startswith(("beef", "veal", "calf", "teleshk", "moshar")):
        return "beef"
    if token.startswith(("lamb", "sheep", "ovch")):
        return "lamb"
    if token.startswith(("turkey", "pueshk", "galo")):
        return "turkey"
    if token.startswith(("mountain", "vouno", "planina", "leuko", "leuko", "white", "byalata", "bialata")):
        return "mountain"
    if token.startswith(("piperia", "piper", "chushk", "pepper", "pikant")):
        return "pepper"
    if token.startswith(("piece", "portion", "portsiy")):
        return "piece"
    return token


def _tokenize_name_for_matching(value: Optional[str]) -> list[str]:
    cleaned = _clean_db_name(value or "")
    ascii_name = _normalize_greek_ascii(anyascii(cleaned).lower())
    raw_tokens = re.findall(r"[a-z0-9]+", ascii_name)

    tokens: list[str] = []
    seen: set[str] = set()
    for raw in raw_tokens:
        if raw in NAME_MATCH_NOISE_TOKENS:
            continue
        if raw.isdigit() or re.fullmatch(r"\d+(?:kg|g|br)", raw):
            continue
        token = _canonicalize_name_token(raw)
        if not token or token in NAME_MATCH_NOISE_TOKENS or token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    return tokens


def _token_weight(token: str) -> float:
    return 0.35 if token in NAME_MATCH_LOW_SIGNAL_TOKENS else 1.0


def _ocr_name_has_semantic_signal(ocr_names: list[str]) -> bool:
    for ocr_name in ocr_names:
        ocr_tokens = set(_tokenize_name_for_matching(ocr_name))
        if sum(_token_weight(token) for token in ocr_tokens) >= 1.0:
            return True
    return False


def _canonical_name_confidence(ocr_names: list[str], product: dict) -> float:
    best_conf = 0.0
    product_names = [
        product.get("name_bg") or "",
        product.get("name_en") or "",
        _clean_db_name(product.get("name_bg") or ""),
    ]

    for ocr_name in ocr_names:
        ocr_tokens = _tokenize_name_for_matching(ocr_name)
        if not ocr_tokens:
            continue
        ocr_set = set(ocr_tokens)
        ocr_weight = sum(_token_weight(token) for token in ocr_set)
        if ocr_weight <= 0:
            continue

        for product_name in product_names:
            product_tokens = _tokenize_name_for_matching(product_name)
            if not product_tokens:
                continue
            product_set = set(product_tokens)
            shared = ocr_set & product_set
            if not shared:
                continue

            shared_weight = sum(_token_weight(token) for token in shared)
            coverage = shared_weight / ocr_weight
            product_weight = sum(_token_weight(token) for token in product_set)
            precision = shared_weight / product_weight if product_weight else 0.0
            distinctive_shared = [
                token for token in shared
                if token in NAME_MATCH_PRIORITY_TOKENS or (token not in NAME_MATCH_LOW_SIGNAL_TOKENS and len(token) >= 6)
            ]
            priority_shared = [token for token in shared if token in NAME_MATCH_PRIORITY_TOKENS]

            if shared_weight >= 1.8 and coverage >= 0.50:
                conf = min(
                    0.76 + (coverage * 0.10) + (precision * 0.06) + (0.04 if distinctive_shared else 0.0),
                    0.92,
                )
                best_conf = max(best_conf, round(conf, 2))
            elif distinctive_shared and shared_weight >= 1.35 and coverage >= 0.75:
                conf = min(0.74 + (coverage * 0.10) + (precision * 0.04), 0.88)
                best_conf = max(best_conf, round(conf, 2))
            elif priority_shared and coverage >= 0.20 and precision >= 0.45:
                conf = min(0.72 + (coverage * 0.10) + (precision * 0.06), 0.84)
                best_conf = max(best_conf, round(conf, 2))

    return best_conf


def _has_strong_name_conflict(ocr_names: list[str], product: dict) -> bool:
    if not ocr_names or not _ocr_name_has_semantic_signal(ocr_names):
        return False
    return _canonical_name_confidence(ocr_names, product) < NAME_CONFLICT_MIN_CONFIDENCE


def _item_ocr_names(item: MatchLineItem) -> list[str]:
    names: list[str] = []
    for candidate in [item.name_bg, item.product_name, item.product_name_raw]:
        if not candidate:
            continue
        value = candidate.strip()
        if not value:
            continue
        if value.lower() not in {existing.lower() for existing in names}:
            names.append(value)
    return names


def _fuzzy_name_match(
    ocr_names: list[str],
    db_products: list[dict],
    unit_price: Optional[float] = None,
) -> Optional[dict]:
    """
    Match OCR product name(s) to DB products using string similarity.
    ocr_names: list of candidate names to try (e.g. [name_bg, product_name])
    Returns {"product": <db_product>, "confidence": float} or None.
    """
    candidates = []

    for p in db_products:
        db_name_raw = (p.get("name_bg") or "").strip()
        if not db_name_raw:
            continue
        db_name_lower = db_name_raw.lower()
        db_name_clean = _clean_db_name(db_name_raw).lower()

        best_conf = _canonical_name_confidence(ocr_names, p)
        for ocr_name in ocr_names:
            if not ocr_name:
                continue
            ocr_lower = ocr_name.lower().strip()
            if not ocr_lower:
                continue

            # Exact match after cleaning
            if ocr_lower == db_name_clean:
                best_conf = max(best_conf, 0.95)
                continue

            # Contains match (either direction)
            if len(ocr_lower) >= 3 and len(db_name_clean) >= 3:
                if ocr_lower in db_name_clean or db_name_clean in ocr_lower:
                    best_conf = max(best_conf, 0.90)
                    continue

            # Character-level similarity (handles Тулумбички vs Толумбички)
            if len(ocr_lower) > 3 and len(db_name_clean) > 3:
                if abs(len(ocr_lower) - len(db_name_clean)) <= 2:
                    common = sum(1 for a, b in zip(ocr_lower, db_name_clean) if a == b)
                    ratio = common / max(len(ocr_lower), len(db_name_clean))
                    if ratio >= 0.80:
                        best_conf = max(best_conf, round(ratio, 2))

        if best_conf > 0:
            candidates.append((p, best_conf))

    if not candidates:
        return None

    # Sort by confidence descending
    candidates.sort(key=lambda x: x[1], reverse=True)

    # If price available and multiple candidates, boost price-matching one
    if unit_price is not None and len(candidates) > 1:
        best_candidate, best_conf = candidates[0]

        def _candidate_price_diff(prod: dict) -> Optional[float]:
            db_price = prod.get("purchase_price") or prod.get("unit_price") or prod.get("delivery_price")
            if db_price is None:
                return None
            try:
                return abs(float(db_price) - float(unit_price))
            except (ValueError, TypeError):
                return None

        second_conf = candidates[1][1] if len(candidates) > 1 else 0.0

        for p, conf in candidates:
            price_diff = _candidate_price_diff(p)
            if price_diff is not None and price_diff < 0.01:
                return {
                    "product": p,
                    "confidence": min(conf + 0.05, 0.99),
                    "second_confidence": second_conf,
                }

        # Guard obvious price mismatch: if top fuzzy candidate is far from invoice price,
        # prefer a near-priced candidate with comparable textual confidence.
        best_price_diff = _candidate_price_diff(best_candidate)
        near_priced = [
            (p, conf, diff)
            for p, conf in candidates
            for diff in [_candidate_price_diff(p)]
            if diff is not None and diff < 0.40
        ]
        if best_price_diff is not None and best_price_diff > 1.0 and near_priced:
            near_priced.sort(key=lambda x: (x[2], -x[1]))
            p_alt, conf_alt, _ = near_priced[0]
            if conf_alt >= best_conf - 0.06:
                second_conf = candidates[1][1] if len(candidates) > 1 else 0.0
                return {
                    "product": p_alt,
                    "confidence": min(conf_alt + 0.02, 0.97),
                    "second_confidence": second_conf,
                }

    second_conf = candidates[1][1] if len(candidates) > 1 else 0.0

    if len(candidates) > 1:
        top_conf = candidates[0][1]
        shortlist = [(p, conf) for p, conf in candidates if conf >= top_conf - 0.03]
        invoice_weights = _extract_weight_grams(*ocr_names)

        if invoice_weights:
            weighted_shortlist = [
                (p, conf)
                for p, conf in shortlist
                if _extract_weight_grams(p.get("name_bg"), p.get("name_en"), p.get("sku")) & invoice_weights
            ]
            if weighted_shortlist:
                weighted_shortlist.sort(key=lambda item: item[1], reverse=True)
                weighted_second = weighted_shortlist[1][1] if len(weighted_shortlist) > 1 else second_conf
                return {
                    "product": weighted_shortlist[0][0],
                    "confidence": weighted_shortlist[0][1],
                    "second_confidence": weighted_second,
                }

        if unit_price is not None:
            price_shortlist = [(p, conf) for p, conf in candidates if conf >= top_conf - 0.01]
            if len(price_shortlist) >= 2:
                priced_shortlist: list[tuple[dict, float, float]] = []
                for p, conf in price_shortlist:
                    diff = _candidate_price_diff(p)
                    if diff is not None:
                        priced_shortlist.append((p, conf, diff))
                priced_shortlist.sort(key=lambda item: (item[2], -item[1]))
                if len(priced_shortlist) >= 2 and priced_shortlist[0][2] + 0.35 < priced_shortlist[1][2]:
                    return {
                        "product": priced_shortlist[0][0],
                        "confidence": priced_shortlist[0][1],
                        "second_confidence": second_conf,
                    }

    # Guard ambiguous fuzzy ties to reduce false auto-links after price-based disambiguation.
    if len(candidates) > 1 and candidates[0][1] < 0.92 and (candidates[0][1] - second_conf) < 0.03:
        return None

    return {
        "product": candidates[0][0],
        "confidence": candidates[0][1],
        "second_confidence": second_conf,
    }


# ── SKU code matching ────────────────────────────────────────────────────────

def _sku_code_match(
    product_code: Optional[str],
    sku_prefix: Optional[str],
    db_products: list[dict],
    ocr_names: Optional[list[str]] = None,
    unit_price: Optional[float] = None,
) -> Optional[dict]:
    """
    Match by SKU/code.
    If the product list is already narrowed to the correct supplier group, a unique exact code hit
    should usually win even when OCR naming is weak.
    """
    if not product_code:
        return None

    def _price_diff(product: dict) -> Optional[float]:
        db_price = product.get("purchase_price") or product.get("unit_price") or product.get("delivery_price")
        if unit_price is None or db_price is None:
            return None
        try:
            return abs(float(db_price) - float(unit_price))
        except (TypeError, ValueError):
            return None

    code_variants = _code_variants(product_code, sku_prefix=sku_prefix)
    strict_code = _normalize_invoice_code(product_code)
    strict_prefixed_code = f"{_normalize_sku(sku_prefix)[:1]}{strict_code}" if sku_prefix and strict_code else ""
    numeric_code = _normalized_digits(product_code)
    if not code_variants and not numeric_code:
        return None

    invoice_weights = _extract_weight_grams(*(ocr_names or []), product_code)
    exact_candidates: list[tuple[dict, float, float, str, float, Optional[float], float]] = []

    for product in db_products:
        sku = _normalize_sku(product.get("sku"))
        if not sku:
            continue

        base_score = 0.0
        match_kind = ""
        if strict_code and sku == strict_code:
            base_score = 0.995
            match_kind = "strict_exact"
        elif strict_prefixed_code and sku == strict_prefixed_code:
            base_score = 0.99
            match_kind = "strict_exact_prefixed"
        elif sku in code_variants:
            base_score = 0.96
            match_kind = "exact_variant"
        elif any(sku.endswith(code) for code in code_variants if len(code) >= 3):
            base_score = 0.94
            match_kind = "suffix"
        else:
            sku_digits = _normalized_digits(product.get("sku"))
            if numeric_code and sku_digits == numeric_code:
                base_score = 0.92
                match_kind = "digits"

        if base_score == 0.0:
            continue

        name_conf = _name_match_confidence(ocr_names or [], product) if ocr_names else 0.0
        price_bonus = 0.0
        price_diff = _price_diff(product)
        if price_diff is not None:
            if price_diff < 0.11:
                price_bonus = 0.03
            elif price_diff < 0.26:
                price_bonus = 0.02
            elif price_diff < 0.40:
                price_bonus = 0.01

        product_weights = _extract_weight_grams(
            product.get("name_bg"),
            product.get("name_en"),
            product.get("sku"),
        )
        weight_bonus = 0.0
        if invoice_weights and product_weights:
            if invoice_weights & product_weights:
                weight_bonus = 0.08
            else:
                weight_bonus = -0.03

        exact_candidates.append((
            product,
            base_score + price_bonus + weight_bonus,
            name_conf,
            match_kind,
            price_bonus,
            price_diff,
            weight_bonus,
        ))

    if not exact_candidates:
        return None

    exact_candidates.sort(key=lambda item: (item[1], item[2]), reverse=True)

    if len(exact_candidates) == 1:
        product, score, name_conf, match_kind, _, price_diff, _ = exact_candidates[0]
        if match_kind in {"suffix", "digits"} and name_conf < 0.45 and (price_diff is None or price_diff >= 0.40):
            return None
        if name_conf >= 0.75:
            score += 0.01
        return {"product": product, "confidence": round(min(score, 0.99), 2)}

    best_product, best_score, best_name_conf, best_kind, _, best_price_diff, best_weight_bonus = exact_candidates[0]
    _, second_score, second_name_conf, second_kind, _, second_price_diff, second_weight_bonus = exact_candidates[1]

    if best_kind.startswith("strict_exact") and second_kind == "exact_variant":
        if best_weight_bonus != second_weight_bonus and second_weight_bonus > best_weight_bonus:
            chosen = exact_candidates[1]
            return {"product": chosen[0], "confidence": round(min(chosen[1], 0.99), 2)}

    if best_score >= second_score + 0.02:
        return {"product": best_product, "confidence": round(min(best_score, 0.99), 2)}

    if best_name_conf >= second_name_conf + 0.12 and best_name_conf >= 0.55:
        return {"product": best_product, "confidence": round(min(best_score, 0.97), 2)}

    return None


# ── Transliteration + RapidFuzz matching ─────────────────────────────────────

# Greek digraph → phonetic normalization (applied AFTER anyascii transliteration)
_GREEK_ASCII_NORMALIZATIONS = [
    ("mp", "b"),    # ΜΠ → MP → B
    ("nt", "d"),    # ΝΤ → NT → D
    ("gk", "g"),    # ΓΚ → GK → G
    ("oy", "u"),    # ΟΥ → OY → U
    ("ei", "i"),    # ΕΙ → EI → I
    ("ai", "e"),    # ΑΙ → AI → E
]


def _normalize_greek_ascii(s: str) -> str:
    """Normalize Greek-transliterated ASCII to match Slavic phonetics."""
    for digraph, replacement in _GREEK_ASCII_NORMALIZATIONS:
        s = s.replace(digraph, replacement)
    return s


def _transliteration_match(
    ocr_names: list[str],
    db_products: list[dict],
    unit_price: Optional[float] = None,
) -> Optional[dict]:
    """
    Transliterate both OCR names (Greek) and DB names (Bulgarian) to ASCII,
    normalize Greek digraphs, then compare using RapidFuzz token_sort_ratio.
    """
    best_product = None
    best_score = 0.0

    for p in db_products:
        db_name_raw = (p.get("name_bg") or "").strip()
        if not db_name_raw:
            continue
        db_name_clean = _clean_db_name(db_name_raw)
        db_ascii = anyascii(db_name_clean).lower()
        if not db_ascii:
            continue

        for ocr_name in ocr_names:
            if not ocr_name:
                continue
            ocr_ascii = anyascii(ocr_name).lower().strip()
            if not ocr_ascii:
                continue

            # Try both raw and Greek-normalized comparison, take best
            score_raw = fuzz.token_sort_ratio(ocr_ascii, db_ascii)
            ocr_normalized = _normalize_greek_ascii(ocr_ascii)
            score_norm = fuzz.token_sort_ratio(ocr_normalized, db_ascii)
            score = max(score_raw, score_norm)

            if score > best_score:
                best_score = score
                best_product = p

    if best_product is None or best_score < 65:
        return None

    confidence = round(0.70 + (best_score - 65) * 0.004, 2)  # 65→0.70, 100→0.84
    confidence = min(confidence, 0.85)

    # Price boost
    if unit_price is not None:
        db_price = best_product.get("purchase_price") or best_product.get("unit_price") or best_product.get("delivery_price")
        if db_price is not None:
            try:
                if abs(float(db_price) - unit_price) < 0.01:
                    confidence = min(confidence + 0.05, 0.92)
            except (ValueError, TypeError):
                pass

    return {"product": best_product, "confidence": confidence}


# ── Gemini AI matching ───────────────────────────────────────────────────────

def _ai_match_products(
    ocr_items: list[dict],
    db_products: list[dict],
    sku_prefix: Optional[str] = None,
) -> list[dict]:
    """
    Use Gemini 2.5 Pro to match OCR-extracted product names to DB products.
    Returns a list of match results with confidence scores.
    """
    api_key = settings.gemini_api_key or settings.google_api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        logger.warning("No GEMINI_API_KEY / GOOGLE_API_KEY — skipping AI matching")
        return []

    if not db_products:
        return []

    # Build product catalog for Gemini (include purchase_price for matching)
    catalog = []
    for p in db_products:
        entry = {
            "id": p["id"],
            "name_bg": p.get("name_bg", ""),
            "name_en": p.get("name_en", ""),
            "sku": p.get("sku", ""),
        }
        # Include purchase price if available for price-based matching
        pp = p.get("purchase_price") or p.get("unit_price") or p.get("delivery_price")
        if pp is not None:
            try:
                entry["purchase_price"] = float(pp)
            except (ValueError, TypeError):
                pass
        catalog.append(entry)

    # Build OCR items list (include unit_price + product_code for matching)
    ocr_list = []
    for item in ocr_items:
        entry = {
            "product_name": item["product_name"],
            "name_bg": item.get("name_bg", ""),
        }
        if item.get("unit_price") is not None:
            entry["unit_price"] = item["unit_price"]
        if item.get("product_code"):
            entry["product_code"] = item["product_code"]
        ocr_list.append(entry)

    sku_hint = ""
    if sku_prefix:
        sku_hint = f"""
IMPORTANT — SKU code hint:
- The supplier uses SKU prefix "{sku_prefix}" (first letter of supplier name)
- If an OCR item has product_code (e.g. "1002"), the DB SKU would be "{sku_prefix}1002"
- Use this to VERIFY your match: if name matches AND the code matches → very high confidence
- But NOT all codes match perfectly, so name+price is still the primary signal
"""

    prompt = f"""You are matching OCR-extracted product names from Greek invoices to existing products in a Bulgarian database.

OCR items to match:
{json.dumps(ocr_list, ensure_ascii=False, indent=2)}

Available DB products:
{json.dumps(catalog, ensure_ascii=False, indent=2)}
{sku_hint}
For each OCR item, find the best matching DB product. Consider:
- Greek names may be transliterations of Bulgarian names (e.g. ΜΠΑΚΛΑΒΑΔΑΚΙ = Баклавички)
- The name_bg field contains a Bulgarian translation hint from OCR
- If unit_price is provided, prefer products with matching purchase_price
- If product_code is provided, check if it matches the numeric part of the DB product's SKU
- Match by meaning/transliteration, not just string similarity
- If no good match exists, return null for that item

Return ONLY valid JSON array with one object per OCR item, in the same order:
[
  {{
    "ocr_name": "ΜΠΑΚΛΑΒΑΔΑΚΙ",
    "matched_product_id": 42,
    "matched_product_name": "Баклавички ...",
    "matched_product_sku": "D1002",
    "confidence": 0.95,
    "top_3": [
      {{"product_id": 42, "product_name": "...", "product_sku": "D1002", "confidence": 0.95}},
      {{"product_id": 55, "product_name": "...", "product_sku": "D1005", "confidence": 0.30}}
    ]
  }}
]

Rules:
- confidence: 0.0 to 0.99 (never 1.0 — that's reserved for confirmed aliases)
- Use confidence >= 0.75 only when the match is truly strong (auto-link boundary in clients)
- If uncertain: keep confidence in 0.40-0.74
- If no match: set matched_product_id to null, confidence to 0.0
- top_3: always include up to 3 best candidates sorted by confidence
- Return raw JSON only, no markdown"""

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=genai.types.GenerateContentConfig(
                max_output_tokens=4096,
                temperature=0.1,
                response_mime_type="application/json",
            ),
        )
        # Handle cases where response.text might be None
        raw_text = response.text
        if not raw_text:
            # Try extracting from candidates
            if response.candidates and response.candidates[0].content.parts:
                raw_text = response.candidates[0].content.parts[0].text
            if not raw_text:
                logger.error(f"Gemini returned empty response. finish_reason={getattr(response.candidates[0], 'finish_reason', 'unknown') if response.candidates else 'no candidates'}")
                return []
        raw = raw_text.strip()
        logger.info(f"AI match (Gemini): response length={len(raw)} chars")

        # Strip markdown fences if present
        if raw.startswith("```"):
            first_nl = raw.index("\n") if "\n" in raw else 3
            raw = raw[first_nl + 1:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            # Try to salvage partial JSON — extract all complete objects
            import re as _re
            objects = _re.findall(r'\{[^{}]+\}', raw, _re.DOTALL)
            results = []
            for obj in objects:
                try:
                    results.append(json.loads(obj))
                except Exception:
                    pass
            if results:
                logger.warning(f"AI match: salvaged {len(results)} objects from malformed JSON")
                return results
            logger.error(f"AI match: could not parse JSON: {raw[:200]}")
            return []
    except Exception as e:
        logger.exception(f"AI matching failed: {e}")
        return []


# ── Shared helpers ───────────────────────────────────────────────────────────

def _extract_prices(product: dict) -> tuple[Optional[float], Optional[float]]:
    """Extract purchase and selling prices from a DB product dict."""
    m_purchase = None
    m_selling = None
    pp = product.get("purchase_price") or product.get("unit_price") or product.get("delivery_price")
    if pp is not None:
        try:
            m_purchase = float(pp)
        except (ValueError, TypeError):
            pass
    sp = product.get("selling_price")
    if sp is not None:
        try:
            m_selling = float(sp)
        except (ValueError, TypeError):
            pass
    return m_purchase, m_selling


async def _auto_save_alias(
    alias_name: str, product_id: int, supplier_id: int, confidence: float
) -> None:
    """Auto-save a product alias for future instant matching (high confidence only)."""
    alias_name = (alias_name or "").strip()
    if not alias_name:
        return
    if confidence < ALIAS_AUTOSAVE_CONFIDENCE:
        return
    try:
        async with httpx.AsyncClient(timeout=MATCH_TIMEOUT) as aclient:
            await aclient.post(
                f"{settings.warehouse_api_url}/product-aliases",
                json={
                    "alias_name": alias_name,
                    "product_id": product_id,
                    "supplier_id": supplier_id,
                    "confidence": confidence,
                },
                headers=_backend_headers(),
            )
            logger.info(f"Auto-saved alias: '{alias_name}' → pid:{product_id} (conf={confidence:.0%})")
    except Exception as e:
        logger.warning(f"Failed to auto-save alias: {e}")


# ── Route ────────────────────────────────────────────────────────────────────

@router.post("/match-products", response_model=MatchResponse)
async def match_products(req: MatchRequest):
    """
    Match OCR-extracted product names to existing DB products.
    Uses alias lookup first, then Gemini AI for unmatched items.
    """
    if not req.line_items:
        return MatchResponse(matches=[])

    # DEBUG: log what's being received for match so we can trace missing codes
    logger.info(
        f"[match-debug] received {len(req.line_items)} items from supplier="
        f"{req.supplier_name!r}: "
        + "; ".join(
            f"'{it.product_name!r}' code={it.product_code!r}"
            for it in req.line_items[:5]
        )
    )

    # Step 1: Find supplier
    supplier = None
    supplier_id = None
    group_name = None
    allow_alias_autosave = not req.preview_mode

    if req.supplier_eik:
        supplier = await _find_supplier_by_eik(req.supplier_eik)
        if supplier:
            supplier_id = supplier.get("id")
            group_name = supplier.get("group_name")
            logger.info(f"Found supplier: id={supplier_id}, group={group_name}")

    if group_name in SUPPLIER_GROUP_GENERIC_NAMES:
        group_name = None

    logger.info(
        "match-products: items=%d supplier=%s preview_mode=%s",
        len(req.line_items),
        req.supplier_name or req.supplier_eik or "unknown",
        req.preview_mode,
    )

    # Derive SKU prefix from supplier name (e.g. "DAGKOS" → "D") — used as hint for AI
    sku_prefix = _supplier_sku_prefix(
        (supplier.get("name", "") if supplier else "") or req.supplier_name
    )
    if sku_prefix:
        logger.info(f"SKU prefix derived: '{sku_prefix}' (hint for AI matching)")

    # Step 2: Fetch the full catalog first; supplier/group is only a ranking or narrowing hint.
    db_products: list[dict] = []
    hinted_products: list[dict] = []
    all_products_cache: Optional[list[dict]] = await _fetch_all_products()
    if all_products_cache:
        db_products = all_products_cache
        logger.info(f"Loaded full catalog for matching ({len(db_products)} products)")

    if group_name:
        hinted_products = await _fetch_products_by_group(group_name)
        logger.info(f"Fetched {len(hinted_products)} hinted products for group '{group_name}'")

    if not hinted_products and all_products_cache:
        inferred_group = _infer_group_from_codes(req.line_items, all_products_cache)
        if not inferred_group:
            inferred_group = _infer_group_from_names(req.line_items, all_products_cache)
        if inferred_group:
            group_name = inferred_group
            hinted_products = [
                p for p in all_products_cache
                if (p.get("group_name") or "").strip().lower() == inferred_group.strip().lower()
            ]
            logger.info(f"Using inferred group '{group_name}' as ranking hint ({len(hinted_products)} products)")

    if hinted_products and all_products_cache:
        db_products = _prioritize_products(all_products_cache, hinted_products)
        logger.info(
            f"Prioritized {len(hinted_products)} hinted products ahead of the full catalog "
            f"({len(db_products)} total candidates)"
        )
    elif hinted_products:
        db_products = hinted_products

    # Step 3: Try matching — priority: alias → SKU → fuzzy name → transliteration → AI
    matches: list[MatchResult] = []
    unmatched_items: list[dict] = []
    unmatched_indices: list[int] = []
    fuzzy_product_usage: dict[int, int] = {}

    for i, item in enumerate(req.line_items):
        # 3a: Alias lookup (saved from previous confirmed matches)
        alias = None
        item_ocr_names = _item_ocr_names(item)
        alias_candidates: list[str] = list(item_ocr_names)

        for alias_name in alias_candidates:
            alias = await _lookup_alias(alias_name, supplier_id)
            if alias:
                alias_product = {
                    "name_bg": alias.get("product_name_bg"),
                    "name_en": alias.get("product_name_en"),
                    "sku": alias.get("product_sku"),
                }
                if _has_strong_name_conflict(item_ocr_names, alias_product):
                    logger.info(
                        "Alias guard: refusing saved alias '%s' -> '%s' due to semantic name conflict",
                        alias_name,
                        alias.get("product_name_bg") or alias.get("product_name_en") or alias.get("product_sku"),
                    )
                    alias = None
                    continue
                break

        if alias:
            matches.append(MatchResult(
                ocr_name=item.product_name,
                ocr_name_bg=item.name_bg,
                matched_product_id=alias.get("product_id"),
                matched_product_name=alias.get("product_name_bg"),
                matched_product_sku=alias.get("product_sku"),
                confidence=1.0,
                match_source="alias",
                suggestions=[],
            ))
            continue

        # 3b: SKU code match (supplier prefix + invoice product code → exact SKU)
        if db_products and item.product_code:
            sku_candidates = hinted_products or db_products
            sku_result = _sku_code_match(
                item.product_code,
                sku_prefix,
                sku_candidates,
                ocr_names=item_ocr_names,
                unit_price=item.unit_price,
            )
            # If hint-based candidates miss a strong code hit, retry against the full catalog.
            if not sku_result and all_products_cache and all_products_cache != sku_candidates:
                fallback_sku = _sku_code_match(
                    item.product_code,
                    sku_prefix,
                    all_products_cache,
                    ocr_names=item_ocr_names,
                    unit_price=item.unit_price,
                )
                if fallback_sku and fallback_sku.get("confidence", 0.0) >= 0.96:
                    sku_result = fallback_sku
            if sku_result:
                fp = sku_result["product"]
                fp_id = fp["id"]
                m_purchase, m_selling = _extract_prices(fp)
                matches.append(MatchResult(
                    ocr_name=item.product_name,
                    ocr_name_bg=item.name_bg,
                    matched_product_id=fp_id,
                    matched_product_name=fp.get("name_bg"),
                    matched_product_sku=fp.get("sku"),
                    confidence=sku_result["confidence"],
                    match_source="sku",
                    matched_purchase_price=m_purchase,
                    matched_selling_price=m_selling,
                    suggestions=[],
                ))
                logger.info(f"SKU match: '{sku_prefix}{item.product_code}' → '{fp.get('name_bg')}' (sku={fp.get('sku')})")
                # Auto-save alias
                if supplier_id and allow_alias_autosave:
                    await _auto_save_alias(item.product_name, fp_id, supplier_id, sku_result["confidence"])
                continue

        # 3c: Fuzzy name match against DB products (instant, no API calls)
        if db_products:
            ocr_names = item_ocr_names
            fuzzy = _fuzzy_name_match(ocr_names, db_products, unit_price=item.unit_price)
            if fuzzy and fuzzy["confidence"] >= AUTO_LINK_CONFIDENCE:
                fp = fuzzy["product"]
                fp_id = fp["id"]
                existing_hits = fuzzy_product_usage.get(fp_id, 0)
                second_conf = float(fuzzy.get("second_confidence", 0.0))
                is_ambiguous = second_conf > 0 and (fuzzy["confidence"] - second_conf) < 0.04
                if existing_hits >= 1 and (item.product_code or fuzzy["confidence"] < 0.92 or is_ambiguous):
                    logger.info(
                        f"Fuzzy guard: avoiding repeated auto-link to pid={fp_id} for "
                        f"'{item.name_bg or item.product_name}' (conf={fuzzy['confidence']:.2f}, second={second_conf:.2f})"
                    )
                else:
                    m_purchase, m_selling = _extract_prices(fp)
                    matches.append(MatchResult(
                        ocr_name=item.product_name,
                        ocr_name_bg=item.name_bg,
                        matched_product_id=fp_id,
                        matched_product_name=fp.get("name_bg"),
                        matched_product_sku=fp.get("sku"),
                        confidence=fuzzy["confidence"],
                        match_source="fuzzy",
                        matched_purchase_price=m_purchase,
                        matched_selling_price=m_selling,
                        suggestions=[],
                    ))
                    fuzzy_product_usage[fp_id] = existing_hits + 1
                    logger.info(f"Fuzzy match: '{item.name_bg or item.product_name}' → '{fp.get('name_bg')}' (conf={fuzzy['confidence']:.0%})")
                    if (
                        fuzzy["confidence"] >= ALIAS_AUTOSAVE_CONFIDENCE
                        and supplier_id
                        and allow_alias_autosave
                    ):
                        await _auto_save_alias(item.product_name, fp_id, supplier_id, fuzzy["confidence"])
                    continue

        # 3d: Transliteration + RapidFuzz (Greek↔Bulgarian via ASCII)
        if db_products:
            ocr_names = item_ocr_names
            translit = _transliteration_match(ocr_names, db_products, unit_price=item.unit_price)
            if translit and translit["confidence"] >= TRANSLIT_MIN_CONFIDENCE:
                fp = translit["product"]
                fp_id = fp["id"]
                m_purchase, m_selling = _extract_prices(fp)
                matches.append(MatchResult(
                    ocr_name=item.product_name,
                    ocr_name_bg=item.name_bg,
                    matched_product_id=fp_id,
                    matched_product_name=fp.get("name_bg"),
                    matched_product_sku=fp.get("sku"),
                    confidence=translit["confidence"],
                    match_source="translit",
                    matched_purchase_price=m_purchase,
                    matched_selling_price=m_selling,
                    suggestions=[],
                ))
                logger.info(f"Translit match: '{item.product_name}' → '{fp.get('name_bg')}' (conf={translit['confidence']:.2f})")
                if (
                    translit["confidence"] >= ALIAS_AUTOSAVE_CONFIDENCE
                    and supplier_id
                    and allow_alias_autosave
                ):
                    await _auto_save_alias(item.product_name, fp_id, supplier_id, translit["confidence"])
                continue

        # 3e: Queue for AI matching (last resort)
        matches.append(None)  # placeholder
        unmatched_items.append({
            "product_name": item.product_name,
            "name_bg": item.name_bg,
            "unit_price": item.unit_price,
            "product_code": item.product_code,
        })
        unmatched_indices.append(i)

    # Step 4: AI matching for remaining unmatched items
    if unmatched_items and db_products:
        logger.info(f"Sending {len(unmatched_items)} unmatched items to Gemini AI (out of {len(req.line_items)} total)")
        ai_results = _ai_match_products(unmatched_items, db_products, sku_prefix=sku_prefix)

        for j, idx in enumerate(unmatched_indices):
            item = req.line_items[idx]
            ai_match = ai_results[j] if j < len(ai_results) else None

            if ai_match and ai_match.get("matched_product_id"):
                suggestions = []
                for s in ai_match.get("top_3", []):
                    s_pp = None
                    s_prod = next((p for p in db_products if p["id"] == s["product_id"]), None)
                    if s_prod:
                        raw = s_prod.get("purchase_price") or s_prod.get("unit_price")
                        if raw is not None:
                            try:
                                s_pp = float(raw)
                            except (ValueError, TypeError):
                                pass
                    suggestions.append(Suggestion(
                        product_id=s["product_id"],
                        product_name=s.get("product_name", ""),
                        product_sku=s.get("product_sku"),
                        confidence=s.get("confidence", 0.0),
                        purchase_price=s_pp,
                    ))

                ai_confidence = ai_match.get("confidence", 0.5)
                try:
                    ai_confidence = float(ai_confidence)
                except (TypeError, ValueError):
                    ai_confidence = 0.5
                ai_confidence = max(0.0, min(ai_confidence, 0.99))

                # Price boost: if invoice price matches DB product price → high confidence
                invoice_price = item.unit_price
                db_prod = None
                if invoice_price is not None and ai_confidence >= 0.5:
                    matched_pid = ai_match["matched_product_id"]
                    db_prod = next((p for p in db_products if p["id"] == matched_pid), None)
                    if db_prod:
                        db_price = db_prod.get("purchase_price") or db_prod.get("unit_price") or db_prod.get("delivery_price")
                        if db_price is not None:
                            try:
                                db_price_f = float(db_price)
                                inv_price_f = float(invoice_price)
                                if abs(db_price_f - inv_price_f) < 0.01:
                                    ai_confidence = 0.99
                                    logger.info(f"Price match boost: {item.product_name} → {ai_match.get('matched_product_name')} (price={inv_price_f}€)")
                            except (ValueError, TypeError):
                                pass

                # Look up DB prices for matched product
                if not db_prod:
                    matched_pid = ai_match["matched_product_id"]
                    db_prod = next((p for p in db_products if p["id"] == matched_pid), None)
                m_purchase, m_selling = _extract_prices(db_prod) if db_prod else (None, None)

                matches[idx] = MatchResult(
                    ocr_name=item.product_name,
                    ocr_name_bg=item.name_bg,
                    matched_product_id=ai_match["matched_product_id"],
                    matched_product_name=ai_match.get("matched_product_name"),
                    matched_product_sku=ai_match.get("matched_product_sku"),
                    confidence=ai_confidence,
                    match_source="ai",
                    matched_purchase_price=m_purchase,
                    matched_selling_price=m_selling,
                    suggestions=suggestions,
                )

                # Auto-save alias for high-confidence AI matches
                if (
                    ai_confidence >= ALIAS_AUTOSAVE_CONFIDENCE
                    and supplier_id
                    and allow_alias_autosave
                ):
                    await _auto_save_alias(item.product_name, ai_match["matched_product_id"], supplier_id, ai_confidence)
            else:
                matches[idx] = MatchResult(
                    ocr_name=item.product_name,
                    ocr_name_bg=item.name_bg,
                    match_source="none",
                )
    else:
        # No DB products or no unmatched items — fill remaining None slots
        for idx in unmatched_indices:
            item = req.line_items[idx]
            matches[idx] = MatchResult(
                ocr_name=item.product_name,
                ocr_name_bg=item.name_bg,
                match_source="none",
            )

    # Enrich alias matches with prices (db_products already fetched in step 2)
    if db_products:
        products_by_id = {p["id"]: p for p in db_products}
        for m in matches:
            if m and m.matched_product_id and m.matched_purchase_price is None:
                db_prod = products_by_id.get(m.matched_product_id)
                if db_prod:
                    m.matched_purchase_price, m.matched_selling_price = _extract_prices(db_prod)

    return MatchResponse(matches=matches)
