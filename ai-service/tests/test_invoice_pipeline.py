"""
Tests for the 3-layer invoice scanning pipeline.
Tests validation logic, batch helpers, parsing, and few-shot prompt building.
"""
import io
from unittest.mock import patch

import pytest
from PIL import Image

from app.routers.invoice import (
    batch_from_prod_date,
    auto_batch_from_expiry,
    _parse_line_items,
    _ensure_line_item_row_count,
    _validate_extraction,
    _build_few_shot_section,
    _build_prompt_with_ocr,
    _checksum_valid,
    _extract_ocr_completeness_cues,
    _assess_extraction_completeness,
    _score_extraction_candidate,
    _build_result,
    _is_gemini_fallback_error,
    _extract_invoice_with_fallback,
    _inflate_sparse_line_items,
    _build_mobile_photo_assist_image,
    _build_mobile_photo_assist_images,
    _image_to_scan_parts,
    _should_enable_mobile_photo_assist,
    LineItem,
    ValidationError,
)


# ── Test 1: Batch number helpers ─────────────────────────────────────────────

class TestBatchHelpers:
    def test_batch_from_prod_date_normal(self):
        assert batch_from_prod_date("2026-02-06") == "06022026"

    def test_batch_from_prod_date_single_digit(self):
        assert batch_from_prod_date("2026-01-03") == "03012026"

    def test_batch_from_prod_date_invalid(self):
        assert batch_from_prod_date("not-a-date") is None

    def test_auto_batch_from_expiry(self):
        # expiry 2026-10-03 → production 2026-08-03 → "03082026"
        assert auto_batch_from_expiry("2026-10-03") == "03082026"

    def test_auto_batch_from_expiry_cross_year(self):
        # expiry 2026-01-15 → production 2025-11-15 → "15112025"
        assert auto_batch_from_expiry("2026-01-15") == "15112025"

    def test_auto_batch_from_expiry_invalid(self):
        assert auto_batch_from_expiry("invalid") is None


# ── Test 2: Layer 3 — Validation ─────────────────────────────────────────────

class TestValidation:
    def test_valid_invoice_passes(self):
        """An invoice where all math checks out should pass validation."""
        items = [
            LineItem(product_name="Feta", quantity=5.0, unit_price=10.0, total_price=50.0),
            LineItem(product_name="Olives", quantity=3.0, unit_price=8.0, total_price=24.0),
        ]
        extracted = {
            "total_net": 74.0,
            "total_vat": 14.80,
            "total_gross": 88.80,
        }
        errors = _validate_extraction(items, extracted)
        assert len(errors) == 0

    def test_item_total_mismatch(self):
        """Detect when qty × unit_price ≠ total_price."""
        items = [
            LineItem(product_name="Baklava", quantity=10.0, unit_price=5.0, total_price=60.0),  # should be 50.0
        ]
        extracted = {"total_net": 60.0}
        errors = _validate_extraction(items, extracted)
        assert len(errors) >= 1
        assert "Baklava" in errors[0].message

    def test_subtotal_mismatch(self):
        """Detect when sum of line totals ≠ total_net."""
        items = [
            LineItem(product_name="Cheese", quantity=2.0, unit_price=10.0, total_price=20.0),
        ]
        extracted = {"total_net": 25.0}  # wrong — should be 20
        errors = _validate_extraction(items, extracted)
        assert any("total_net" in e.field or "subtotal" in e.message.lower() for e in errors)

    def test_gross_total_mismatch(self):
        """Detect when total_net + total_vat ≠ total_gross."""
        items = [
            LineItem(product_name="Wine", quantity=1.0, unit_price=100.0, total_price=100.0),
        ]
        extracted = {
            "total_net": 100.0,
            "total_vat": 20.0,
            "total_gross": 130.0,  # wrong — should be 120
        }
        errors = _validate_extraction(items, extracted)
        assert any("total_gross" in e.field for e in errors)

    def test_rounding_tolerance(self):
        """Small rounding differences (±0.02) should pass."""
        items = [
            LineItem(product_name="Pasta", quantity=2.34, unit_price=7.35, total_price=17.20),
            # 2.34 × 7.35 = 17.199 → rounds to 17.20, within tolerance
        ]
        extracted = {"total_net": 17.20}
        errors = _validate_extraction(items, extracted)
        assert len(errors) == 0


# ── Test 3: Parsing & few-shot ───────────────────────────────────────────────

class TestParsing:
    def test_parse_line_items_with_auto_batch(self):
        """Items with production_date but no batch should get auto_batch."""
        extracted = {
            "line_items": [
                {
                    "product_name": "ΜΠΑΚΛΑΒΑΔΙ",
                    "name_bg": "Баклава",
                    "quantity": 5.0,
                    "unit": "кг",
                    "unit_price": 9.80,
                    "total_price": 49.0,
                    "production_date": "2026-02-06",
                    "batch_number": None,
                },
            ]
        }
        items = _parse_line_items(extracted)
        assert len(items) == 1
        assert items[0].auto_batch == "06022026"

    def test_parse_line_items_explicit_batch_no_auto(self):
        """Items with explicit batch_number should NOT get auto_batch."""
        extracted = {
            "line_items": [
                {
                    "product_name": "Feta",
                    "quantity": 2.0,
                    "unit_price": 15.0,
                    "total_price": 30.0,
                    "batch_number": "LOT123",
                },
            ]
        }
        items = _parse_line_items(extracted)
        assert items[0].auto_batch is None
        assert items[0].batch_number == "LOT123"

    def test_parse_line_items_keeps_non_dict_rows(self):
        extracted = {
            "line_items": [
                {"product_name": "Row 1"},
                "ROW 2 RAW TEXT",
                {"product_name": "Row 3"},
            ]
        }
        items = _parse_line_items(extracted)
        assert len(items) == 3
        assert items[1].product_name == "ROW 2 RAW TEXT"

    def test_parse_line_items_handles_sparse_dict_input(self):
        extracted = {
            "line_items": {
                "1": {"product_name": "Row 1"},
                "3": {"product_name": "Row 3"},
                "5": {"product_name": "Row 5"},
            }
        }
        items = _parse_line_items(extracted)
        assert len(items) == 3
        assert [item.row_number for item in items] == [1, 3, 5]
        assert [item.product_name for item in items] == ["Row 1", "Row 3", "Row 5"]

    def test_few_shot_section_empty(self):
        assert _build_few_shot_section([]) == ""

    def test_few_shot_section_with_templates(self):
        templates = [
            {
                "image_base64": "abc123",
                "extracted_json": {
                    "supplier_name": "DAGKOS",
                    "invoice_number": "INV-001",
                    "line_items": [
                        {"product_name": "ΜΠΑΚΛΑΒΑΔΙ", "quantity": 5.0, "unit_price": 9.80}
                    ],
                },
            }
        ]
        section = _build_few_shot_section(templates)
        assert "FEW-SHOT EXAMPLES" in section
        assert "DAGKOS" in section
        assert "ΜΠΑΚΛΑΒΑΔΙ" in section


class TestBuildResult:
    def test_result_includes_validation(self):
        extracted = {
            "supplier_name": "TestCo",
            "invoice_number": "T-001",
            "total_net": 100.0,
            "total_vat": 20.0,
            "total_gross": 120.0,
        }
        items = [LineItem(product_name="Item1", quantity=10.0, unit_price=10.0, total_price=100.0)]
        errors = [ValidationError(field="test", message="test error")]
        result = _build_result(extracted, items, validation_errors=errors, few_shot_used=True, few_shot_supplier="TestCo")
        assert result.validation_passed is False
        assert len(result.validation_errors) == 1
        assert result.few_shot_used is True
        assert result.few_shot_supplier == "TestCo"

    def test_result_passes_when_no_errors(self):
        extracted = {"supplier_name": "TestCo"}
        items = [LineItem(product_name="Item1")]
        result = _build_result(extracted, items)
        assert result.validation_passed is True
        assert result.few_shot_used is False


class TestChecksum:
    def test_checksum_pass(self):
        items = [
            LineItem(product_name="A", total_price=50.0),
            LineItem(product_name="B", total_price=30.0),
        ]
        assert _checksum_valid(items, {"total_gross": 80.0}) is True

    def test_checksum_fail(self):
        items = [
            LineItem(product_name="A", total_price=50.0),
        ]
        assert _checksum_valid(items, {"total_gross": 100.0}) is False

    def test_checksum_no_total(self):
        items = [LineItem(product_name="A", total_price=50.0)]
        assert _checksum_valid(items, {}) is True


class TestCompletenessHeuristics:
    def _items(self, count: int, total_price: float = 10.0) -> list[LineItem]:
        return [
            LineItem(
                product_name=f"Item {i + 1}",
                quantity=1.0,
                unit_price=total_price,
                total_price=total_price,
            )
            for i in range(count)
        ]

    def test_ocr_row_cues_detect_sequence(self):
        ocr_text = "\n".join(
            [f"{i} PRODUCT-{i} KG 1 3.50 3.50" for i in range(1, 12)]
        )
        cues = _extract_ocr_completeness_cues(ocr_text)
        assert cues["row_number_sequence"] == 11
        assert cues["table_row_hint"] >= 11

    def test_suspicious_when_extracted_items_far_below_ocr_hints(self):
        ocr_text = "\n".join(
            [f"{i} PRODUCT-{i} KG 1 3.50 3.50" for i in range(1, 12)]
        )
        items = self._items(3, total_price=3.50)
        extracted = {"total_gross": 38.50}

        assessment = _assess_extraction_completeness(items, extracted, ocr_text)
        assert assessment["suspicious"] is True
        assert assessment["expected_row_count"] == 11
        assert any("row_number_sequence_hint" in reason for reason in assessment["reasons"])

    def test_candidate_scoring_prefers_more_complete_result(self):
        ocr_text = "\n".join(
            [f"{i} PRODUCT-{i} KG 1 3.50 3.50" for i in range(1, 12)]
        )
        sparse_items = self._items(3, total_price=3.50)
        full_items = self._items(11, total_price=3.50)
        extracted = {"total_gross": 38.50}

        sparse_score, _ = _score_extraction_candidate(sparse_items, extracted, ocr_text)
        full_score, _ = _score_extraction_candidate(full_items, extracted, ocr_text)

        assert full_score > sparse_score

    def test_prompt_marks_truncated_ocr_text(self):
        prompt = _build_prompt_with_ocr("Extract data", "A" * 19000)
        assert "truncated for prompt size limits" in prompt

    def test_ensure_line_item_row_count_backfills_missing_rows(self):
        ocr_text = "\n".join(
            [
                "1 FETA KG 1 5.00 5.00",
                "2 OLIVES KG 1 4.00 4.00",
                "3 HALLOUMI KG 1 6.00 6.00",
                "4 KASSERI KG 1 7.00 7.00",
                "5 YOGURT KG 1 3.00 3.00",
            ]
        )
        sparse = [
            LineItem(row_number=1, product_name="FETA", quantity=1, unit_price=5, total_price=5),
            LineItem(row_number=3, product_name="HALLOUMI", quantity=1, unit_price=6, total_price=6),
            LineItem(row_number=5, product_name="YOGURT", quantity=1, unit_price=3, total_price=3),
        ]
        reconciled = _ensure_line_item_row_count(sparse, ocr_text)
        assert len(reconciled) == 5
        assert [li.row_number for li in reconciled] == [1, 2, 3, 4, 5]
        assert reconciled[1].product_name

    def test_inflate_sparse_line_items_surfaces_visible_five_rows(self):
        sparse = [
            LineItem(row_number=1, product_name="FETA"),
            LineItem(row_number=3, product_name="HALLOUMI"),
            LineItem(row_number=5, product_name="YOGURT"),
        ]
        inflated = _inflate_sparse_line_items(
            sparse,
            {"visible_row_count": 5, "extracted_row_count": 5},
        )
        assert len(inflated) == 5
        assert [li.row_number for li in inflated] == [1, 2, 3, 4, 5]
        assert inflated[1].product_name_raw == "UNKNOWN_ROW_2"
        assert inflated[3].product_name_raw == "UNKNOWN_ROW_4"

    def test_inflate_sparse_line_items_surfaces_visible_eleven_rows(self):
        sparse = [
            LineItem(row_number=1, product_name="Item 1"),
            LineItem(row_number=2, product_name="Item 2"),
            LineItem(row_number=4, product_name="Item 4"),
            LineItem(row_number=5, product_name="Item 5"),
            LineItem(row_number=7, product_name="Item 7"),
            LineItem(row_number=11, product_name="Item 11"),
        ]
        inflated = _inflate_sparse_line_items(
            sparse,
            {"visible_row_count": 11, "extracted_row_count": 11},
        )
        assert len(inflated) == 11
        assert [li.row_number for li in inflated] == list(range(1, 12))
        assert inflated[2].product_name_raw == "UNKNOWN_ROW_3"
        assert inflated[9].product_name_raw == "UNKNOWN_ROW_10"


class TestImageScanParts:
    def test_mobile_photo_assist_image_generates_distinct_rendering(self):
        from PIL import Image
        import io

        img = Image.new("RGB", (320, 200), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        assist = _build_mobile_photo_assist_image(buf.getvalue())
        assert assist is not None
        assert isinstance(assist, bytes)
        assert assist != buf.getvalue()

    @patch("app.routers.invoice._build_mobile_photo_assist_images")
    @patch("app.routers.invoice._image_to_base64")
    def test_image_to_scan_parts_appends_mobile_assist_variant(
        self,
        image_to_base64_mock,
        assist_mock,
    ):
        assist_mock.return_value = [b"assist-bytes"]
        image_to_base64_mock.side_effect = [
            ("primary-b64", "image/jpeg"),
            ("assist-b64", "image/jpeg"),
        ]

        parts = _image_to_scan_parts(
            b"raw-image",
            "image/jpeg",
            include_mobile_photo_assist=True,
        )

        assert parts == [
            ("primary-b64", "image/jpeg"),
            ("assist-b64", "image/jpeg"),
        ]
        assert image_to_base64_mock.call_count == 2

    @patch("app.routers.invoice._build_mobile_photo_assist_images")
    @patch("app.routers.invoice._image_to_base64")
    def test_image_to_scan_parts_limits_assist_variants_to_one_by_default(
        self,
        image_to_base64_mock,
        assist_mock,
    ):
        assist_mock.return_value = [b"assist-1", b"assist-2", b"assist-3"]
        image_to_base64_mock.side_effect = [
            ("primary-b64", "image/jpeg"),
            ("assist-1-b64", "image/jpeg"),
        ]

        parts = _image_to_scan_parts(
            b"raw-image",
            "image/jpeg",
            include_mobile_photo_assist=True,
        )

        assert parts == [
            ("primary-b64", "image/jpeg"),
            ("assist-1-b64", "image/jpeg"),
        ]
        assert image_to_base64_mock.call_count == 2

    @patch("app.routers.invoice._build_mobile_photo_assist_images")
    @patch("app.routers.invoice._image_to_base64")
    def test_image_to_scan_parts_skips_duplicate_assist_variant(
        self,
        image_to_base64_mock,
        assist_mock,
    ):
        assist_mock.return_value = [b"assist-bytes"]
        image_to_base64_mock.side_effect = [
            ("same-b64", "image/jpeg"),
            ("same-b64", "image/jpeg"),
        ]

        parts = _image_to_scan_parts(
            b"raw-image",
            "image/jpeg",
            include_mobile_photo_assist=True,
        )

        assert parts == [("same-b64", "image/jpeg")]
        assert image_to_base64_mock.call_count == 2

    def test_build_mobile_photo_assist_images_returns_multiple_variants(self):
        from PIL import Image, ImageDraw
        import io

        img = Image.new("RGB", (320, 200), color="white")
        draw = ImageDraw.Draw(img)
        draw.rectangle((20, 20, 300, 180), outline="black", width=3)
        draw.text((40, 80), "INV 1026", fill="black")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)

        variants = _build_mobile_photo_assist_images(buf.getvalue())
        assert len(variants) >= 2
        assert all(isinstance(variant, bytes) for variant in variants)

    def test_mobile_photo_assist_is_disabled_by_default(self):
        img = Image.new("RGB", (3024, 4032), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95)

        assert _should_enable_mobile_photo_assist(buf.getvalue()) is False

    @patch.dict("os.environ", {"SCAN_AUTO_MOBILE_ASSIST": "true"}, clear=False)
    def test_should_enable_mobile_photo_assist_when_auto_mode_is_enabled(self):
        img = Image.new("RGB", (3024, 4032), color="white")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=95)

        assert _should_enable_mobile_photo_assist(buf.getvalue()) is True


class TestGeminiFallback:
    def test_fallback_signal_detection(self):
        assert _is_gemini_fallback_error(RuntimeError("429 RESOURCE_EXHAUSTED")) is True
        assert _is_gemini_fallback_error(RuntimeError("quota exceeded")) is True
        assert _is_gemini_fallback_error(RuntimeError("service unavailable")) is True

    def test_non_fallback_signal_detection(self):
        assert _is_gemini_fallback_error(ValueError("invalid json payload")) is False

    @patch("app.routers.invoice._extract_with_openai_vision")
    @patch("app.routers.invoice._extract_with_gemini")
    def test_wrapper_uses_openai_fallback(self, gemini_mock, openai_mock):
        gemini_mock.side_effect = RuntimeError("RESOURCE_EXHAUSTED: quota")
        openai_mock.return_value = {"invoice_number": "INV-1", "line_items": []}

        result = _extract_invoice_with_fallback([("abc", "image/png")], "prompt")

        assert result["invoice_number"] == "INV-1"
        assert gemini_mock.call_count == 1
        assert openai_mock.call_count == 1

    @patch("app.routers.invoice._extract_with_openai_vision")
    @patch("app.routers.invoice._extract_with_gemini")
    def test_wrapper_uses_openai_fallback_when_gemini_not_configured(
        self, gemini_mock, openai_mock
    ):
        gemini_mock.side_effect = ValueError(
            "GEMINI_API_KEY / GOOGLE_API_KEY not configured — cannot scan invoices"
        )
        openai_mock.return_value = {"invoice_number": "INV-2", "line_items": []}

        result = _extract_invoice_with_fallback([("abc", "image/png")], "prompt")

        assert result["invoice_number"] == "INV-2"
        assert gemini_mock.call_count == 1
        assert openai_mock.call_count == 1

    @patch("app.routers.invoice._extract_with_openai_vision")
    @patch("app.routers.invoice._extract_with_gemini")
    def test_wrapper_does_not_fallback_on_non_provider_error(
        self, gemini_mock, openai_mock
    ):
        gemini_mock.side_effect = ValueError("invalid json payload")
        openai_mock.return_value = {"invoice_number": "INV-1", "line_items": []}

        with pytest.raises(ValueError):
            _extract_invoice_with_fallback([("abc", "image/png")], "prompt")

        assert gemini_mock.call_count == 1
        assert openai_mock.call_count == 0

    @patch("app.routers.invoice._extract_with_openai_vision")
    @patch("app.routers.invoice._extract_with_gemini")
    def test_wrapper_can_disable_provider_fallback(self, gemini_mock, openai_mock):
        gemini_mock.side_effect = RuntimeError("RESOURCE_EXHAUSTED: quota")
        openai_mock.return_value = {"invoice_number": "INV-1", "line_items": []}

        with pytest.raises(RuntimeError):
            _extract_invoice_with_fallback(
                [("abc", "image/png")],
                "prompt",
                allow_provider_fallback=False,
            )

        assert gemini_mock.call_count == 1
        assert openai_mock.call_count == 0
