import asyncio

from app.routers.match import (
    AUTO_LINK_CONFIDENCE,
    MatchLineItem,
    MatchRequest,
    _canonical_name_confidence,
    _fuzzy_name_match,
    _sku_code_match,
    match_products,
)


class TestCanonicalNameMatching:
    def test_canonical_name_confidence_handles_greek_cup_ferrero_wording(self):
        product = {
            "id": 1033,
            "name_bg": 'Чашки Микс Фереро "Siropiasta Thessalonikis"',
            "name_en": "Ferrero Cups Mix",
            "sku": "D1033",
            "purchase_price": 4.80,
        }

        confidence = _canonical_name_confidence(["ΠΟΤΗΡΑΚΙ ΦΕΡΕΡΟ"], product)

        assert confidence >= 0.80

    def test_fuzzy_name_match_uses_canonical_overlap_for_bowl_products(self):
        db_products = [
            {
                "id": 2040,
                "name_bg": "Мини профитероли в чашка",
                "name_en": "Mini Profiteroles Bowl",
                "sku": "I2040",
                "purchase_price": 5.20,
            }
        ]

        result = _fuzzy_name_match(["PROFITEROLES IN A BOWL"], db_products)

        assert result is not None
        assert result["product"]["id"] == 2040
        assert result["confidence"] >= AUTO_LINK_CONFIDENCE

    def test_fuzzy_name_match_handles_mini_eclair_with_packaging_noise(self):
        db_products = [
            {
                "id": 2018,
                "name_bg": "ЕКЛЕР МИНИ/ECLAIR MINI 50g - 30бр./каш (Замразен)",
                "sku": "IM212018",
                "purchase_price": 7.35,
            }
        ]

        result = _fuzzy_name_match(["MINI ECLAIR"], db_products)

        assert result is not None
        assert result["product"]["id"] == 2018
        assert result["confidence"] >= AUTO_LINK_CONFIDENCE

    def test_fuzzy_name_match_handles_greek_portnaki_ferrero_wording(self):
        db_products = [
            {
                "id": 1032,
                "name_bg": 'Чашки Микс с Лешник и Ковертюр от Шоколад (Ferrero) "Siropiasta Thessalonikis"',
                "sku": "D1032",
                "purchase_price": 4.80,
            }
        ]

        result = _fuzzy_name_match(["ПОРТНАКИ ФЕРЕРО"], db_products, unit_price=4.80)

        assert result is not None
        assert result["product"]["id"] == 1032
        assert result["confidence"] >= AUTO_LINK_CONFIDENCE

    def test_fuzzy_name_match_handles_exarchos_feta_ocr_variant(self):
        db_products = [
            {
                "id": 1319,
                "name_bg": 'Сирене Фета "Exarchos" 0.400гр.',
                "sku": "000096",
                "purchase_price": 3.95,
            },
            {
                "id": 1596,
                "name_bg": "Халуми Сирене от о-в Кипър 225 гр.",
                "sku": "000228",
                "purchase_price": 2.15,
            },
        ]

        result = _fuzzy_name_match(["ФЕТА ЕЗАРКС ПОП ЛАМБРА 400Г"], db_products, unit_price=3.95)

        assert result is not None
        assert result["product"]["id"] == 1319
        assert result["confidence"] >= AUTO_LINK_CONFIDENCE


class TestSkuMatching:
    def test_sku_code_match_accepts_exact_unique_code_even_with_noisy_name(self):
        db_products = [
            {
                "id": 1033,
                "name_bg": "Чашки Микс Фереро",
                "sku": "D1033",
                "purchase_price": 4.80,
            }
        ]

        result = _sku_code_match(
            "1033,",
            "D",
            db_products,
            ocr_names=["ΠΟΤΗΡΑΚΙ ΦΕΡΕΡΟ"],
            unit_price=4.80,
        )

        assert result is not None
        assert result["product"]["id"] == 1033
        assert result["confidence"] >= 0.98

    def test_sku_code_match_rejects_loose_suffix_hit_without_name_or_price_support(self):
        db_products = [
            {
                "id": 999,
                "name_bg": "Несвързан десерт",
                "name_en": "Unrelated dessert",
                "sku": "D1033-1031",
            }
        ]

        result = _sku_code_match(
            "1031",
            "D",
            db_products,
            ocr_names=["TOTALLY DIFFERENT ITEM"],
            unit_price=None,
        )

        assert result is None

    def test_sku_code_match_rejects_exact_code_when_name_and_price_conflict(self):
        db_products = [
            {
                "id": 1596,
                "name_bg": "Халуми Сирене от о-в Кипър 225 гр.",
                "sku": "000228",
                "purchase_price": 2.15,
            }
        ]

        result = _sku_code_match(
            "00-0228",
            None,
            db_products,
            ocr_names=["ФЕТА ЕЗАРКС ПОП ЛАМБРА 400Г"],
            unit_price=3.95,
        )

        assert result is None

    def test_sku_code_match_rejects_exact_code_when_name_semantics_conflict_without_price_support(self):
        db_products = [
            {
                "id": 1026,
                "name_bg": "ФЪЛИЯ КРЕМА",
                "name_en": "Phyllo Cream",
                "sku": "D1026",
                "purchase_price": 4.50,
            }
        ]

        result = _sku_code_match(
            "1026",
            "D",
            db_products,
            ocr_names=["ФДЛИА КРЕМА"],
            unit_price=None,
        )

        assert result is None


class TestRouteGuards:
    def test_match_products_skips_alias_auto_link_when_name_semantics_conflict(self, monkeypatch):
        async def fake_lookup_alias(alias_name, supplier_id):
            return {
                "product_id": 1609,
                "product_name_bg": "Тулумбички Премиум",
                "product_name_en": "Tuloumpaki Premium",
                "product_sku": "D1609",
            }

        async def fake_fetch_all_products():
            return [
                {
                    "id": 1609,
                    "name_bg": "Тулумбички Премиум",
                    "name_en": "Tuloumpaki Premium",
                    "sku": "D1609",
                    "purchase_price": 4.80,
                }
            ]

        async def fake_fetch_products_by_group(group_name):
            return []

        async def fake_find_supplier_by_eik(eik):
            return None

        monkeypatch.setattr("app.routers.match._lookup_alias", fake_lookup_alias)
        monkeypatch.setattr("app.routers.match._fetch_all_products", fake_fetch_all_products)
        monkeypatch.setattr("app.routers.match._fetch_products_by_group", fake_fetch_products_by_group)
        monkeypatch.setattr("app.routers.match._find_supplier_by_eik", fake_find_supplier_by_eik)
        monkeypatch.setattr("app.routers.match._ai_match_products", lambda items, products, sku_prefix=None: [])

        response = asyncio.run(match_products(MatchRequest(
            line_items=[MatchLineItem(product_name="RED VELVET' PREMIUM")],
        )))

        assert response.matches[0].match_source == "none"
        assert response.matches[0].matched_product_id is None

    def test_match_products_keeps_alias_auto_link_when_name_semantics_support_product(self, monkeypatch):
        async def fake_lookup_alias(alias_name, supplier_id):
            return {
                "product_id": 1033,
                "product_name_bg": "Чашки Микс Фереро",
                "product_name_en": "Ferrero Cups Mix",
                "product_sku": "D1033",
            }

        async def fake_fetch_all_products():
            return [
                {
                    "id": 1033,
                    "name_bg": "Чашки Микс Фереро",
                    "name_en": "Ferrero Cups Mix",
                    "sku": "D1033",
                    "purchase_price": 4.80,
                }
            ]

        async def fake_fetch_products_by_group(group_name):
            return []

        async def fake_find_supplier_by_eik(eik):
            return None

        monkeypatch.setattr("app.routers.match._lookup_alias", fake_lookup_alias)
        monkeypatch.setattr("app.routers.match._fetch_all_products", fake_fetch_all_products)
        monkeypatch.setattr("app.routers.match._fetch_products_by_group", fake_fetch_products_by_group)
        monkeypatch.setattr("app.routers.match._find_supplier_by_eik", fake_find_supplier_by_eik)
        monkeypatch.setattr("app.routers.match._ai_match_products", lambda items, products, sku_prefix=None: [])

        response = asyncio.run(match_products(MatchRequest(
            line_items=[MatchLineItem(product_name="ΠΟΤΗΡΑΚΙ ΦΕΡΕΡΟ")],
        )))

        assert response.matches[0].match_source == "alias"
        assert response.matches[0].matched_product_id == 1033

    def test_match_preview_mode_skips_alias_autosave_side_effects(self, monkeypatch):
        async def fake_lookup_alias(alias_name, supplier_id):
            return {
                "product_id": 1033,
                "product_name_bg": "Чашки Микс Фереро",
                "product_name_en": "Ferrero Cups Mix",
                "product_sku": "D1033",
            }

        async def fake_fetch_all_products():
            return [
                {
                    "id": 1033,
                    "name_bg": "Чашки Микс Фереро",
                    "name_en": "Ferrero Cups Mix",
                    "sku": "D1033",
                    "purchase_price": 4.80,
                }
            ]

        async def fake_fetch_products_by_group(group_name):
            return []

        async def fake_find_supplier_by_eik(eik):
            return {"id": 7, "name": "Dagkos", "group_name": None}

        autosave_calls = []

        async def fake_auto_save(alias_name, product_id, supplier_id, confidence):
            autosave_calls.append((alias_name, product_id, supplier_id, confidence))

        monkeypatch.setattr("app.routers.match._lookup_alias", fake_lookup_alias)
        monkeypatch.setattr("app.routers.match._fetch_all_products", fake_fetch_all_products)
        monkeypatch.setattr("app.routers.match._fetch_products_by_group", fake_fetch_products_by_group)
        monkeypatch.setattr("app.routers.match._find_supplier_by_eik", fake_find_supplier_by_eik)
        monkeypatch.setattr("app.routers.match._auto_save_alias", fake_auto_save)
        monkeypatch.setattr("app.routers.match._ai_match_products", lambda items, products, sku_prefix=None: [])

        response = asyncio.run(match_products(MatchRequest(
            line_items=[MatchLineItem(product_name="ΠΟΤΗΡΑΚΙ ΦΕΡΕΡΟ")],
            supplier_eik="BG123",
            preview_mode=True,
        )))

        assert response.matches[0].match_source == "alias"
        assert autosave_calls == []
