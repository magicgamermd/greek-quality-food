import React, { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
  Animated,
} from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { apiClient } from "../api/client";
import { colors } from "../theme/colors";

// ── Helpers ──────────────────────────────────────────────────────────────────

function autoBatchFromExpiry(expiryDateStr: string): string {
  try {
    let expiry: Date;
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(expiryDateStr)) {
      const [dd, mm, yyyy] = expiryDateStr.split(".");
      expiry = new Date(`${yyyy}-${mm}-${dd}`);
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(expiryDateStr)) {
      const parts = expiryDateStr.split("/");
      expiry = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    } else {
      expiry = new Date(expiryDateStr);
    }
    if (isNaN(expiry.getTime())) return "";
    const production = new Date(expiry);
    production.setMonth(production.getMonth() - 2);
    const dd = String(production.getDate()).padStart(2, "0");
    const mm = String(production.getMonth() + 1).padStart(2, "0");
    return `${dd}${mm}${production.getFullYear()}`;
  } catch {
    return "";
  }
}

/** Smart DD.MM input: "1904" → "19.04.2026", "19.04" → "19.04.2026" */
function formatSmartExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 4) {
    const dd = digits.slice(0, 2);
    const mm = digits.slice(2, 4);
    return `${dd}.${mm}.2026`;
  }
  if (digits.length === 8) {
    const dd = digits.slice(0, 2);
    const mm = digits.slice(2, 4);
    const yyyy = digits.slice(4, 8);
    return `${dd}.${mm}.${yyyy}`;
  }
  return raw;
}

/** Convert DD.MM.YYYY to ISO YYYY-MM-DD for API */
function expiryToISO(dateStr: string): string {
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
    const [dd, mm, yyyy] = dateStr.split(".");
    return `${yyyy}-${mm}-${dd}`;
  }
  return dateStr;
}

function batchFromProdDate(prodDateStr: string): string {
  try {
    const d = new Date(prodDateStr);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}${mm}${d.getFullYear()}`;
  } catch {
    return "";
  }
}

function toOptionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = "camera" | "preview" | "postSave" | "manual" | "done";

interface PostSaveState {
  deliveryId: number;
  supplierName: string;
  requiresCompanion: boolean;
  missingDetailsCount: number;
}

interface ScanResult {
  supplier_name: string;
  supplier_eik: string | null;
  supplier_vat: string | null;
  supplier_address: string | null;
  invoice_number: string;
  invoice_date: string;
  document_type: string;
  total: number | null;
  items: ScanItem[];
}

interface ScanItem {
  product_name: string;
  product_code?: string | null;
  name_en: string;
  name_bg: string;
  brand: string | null;
  category_hint: string | null;
  unit: string;
  quantity: number;
  unit_price: number;
  batch_number: string;
  expiry_date: string;
  auto_batch: string | null;
  total: number | null;
  product_id: number | null;
  production_date: string | null;
  matched_product_id: number | null;
  matched_product_name: string | null;
  matched_product_sku: string | null;
  match_confidence: number | null;
  match_source: string | null;
  selling_price: number | null;
  matched_purchase_price: number | null;
  matched_selling_price: number | null;
  gross_price: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  _unitPriceText?: string;
  _sellingPriceText?: string;
}

interface MatchPreviewResult {
  matched_product_id?: number | null;
  matched_product_name?: string | null;
  matched_product_sku?: string | null;
  confidence?: number | null;
  match_source?: string | null;
  matched_purchase_price?: number | string | null;
  matched_selling_price?: number | string | null;
}

// ─────────────────────────────────────────────────────────────────────────────

export function CameraInvoiceScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  // Phase state
  const [phase, setPhase] = useState<Phase>("camera");
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingBatches, setSavingBatches] = useState(false);
  const [companionScanning, setCompanionScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("AI анализира фактурата...");
  const [scanStage, setScanStage] = useState(0); // 1-3 during scan
  const [estimatedTimeLeft, setEstimatedTimeLeft] = useState(0);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const animateProgressTo = (toValue: number, duration: number) => {
    Animated.timing(progressAnim, {
      toValue,
      duration,
      useNativeDriver: false,
    }).start();
  };

  const startCountdown = (seconds: number) => {
    setEstimatedTimeLeft(seconds);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setEstimatedTimeLeft((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const stopCountdown = () => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  };

  // Duplicate modal state
  const [dupModalVisible, setDupModalVisible] = useState(false);
  const [dupModalData, setDupModalData] = useState<{
    invoiceNumber: string;
    date: string;
    status: string;
  } | null>(null);
  const dupResolveRef = useRef<{
    resolve: () => void;
    reject: (e: Error) => void;
  } | null>(null);

  // Data
  const [scanned, setScanned] = useState<ScanResult | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [deliveryId, setDeliveryId] = useState<number | null>(null);
  const [postSaveState, setPostSaveState] = useState<PostSaveState | null>(null);

  // Product picker modal
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerItemIndex, setPickerItemIndex] = useState<number | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerResults, setPickerResults] = useState<any[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Product Picker ──────────────────────────────────────────────────────

  const openPicker = (index: number) => {
    setPickerItemIndex(index);
    setPickerQuery("");
    setPickerResults([]);
    setPickerVisible(true);
  };

  const searchProducts = useCallback((query: string) => {
    setPickerQuery(query);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setPickerResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setPickerLoading(true);
      try {
        const res = await apiClient.get("/products", {
          params: { search: query.trim(), limit: 20 },
        });
        const data = res.data?.data ?? res.data ?? [];
        setPickerResults(Array.isArray(data) ? data : []);
      } catch {
        setPickerResults([]);
      } finally {
        setPickerLoading(false);
      }
    }, 300);
  }, []);

  const selectProduct = (product: any) => {
    if (pickerItemIndex == null) return;
    const updated = [...items];
    updated[pickerItemIndex] = {
      ...updated[pickerItemIndex],
      matched_product_id: product.id,
      matched_product_name: product.name_bg,
      matched_product_sku: product.sku,
      match_confidence: 1.0,
      match_source: "manual",
      matched_purchase_price:
        product.purchase_price != null
          ? parseFloat(product.purchase_price)
          : null,
      matched_selling_price:
        product.selling_price != null
          ? parseFloat(product.selling_price)
          : null,
    };
    setItems(updated);
    setPickerVisible(false);
    setPickerItemIndex(null);
  };

  const clearMatch = () => {
    if (pickerItemIndex == null) return;
    const updated = [...items];
    updated[pickerItemIndex] = {
      ...updated[pickerItemIndex],
      matched_product_id: null,
      matched_product_name: null,
      matched_product_sku: null,
      match_confidence: null,
      match_source: null,
      matched_purchase_price: null,
      matched_selling_price: null,
    };
    setItems(updated);
    setPickerVisible(false);
    setPickerItemIndex(null);
  };

  const countItemsMissingBatchOrExpiry = (sourceItems: Array<Partial<ScanItem>>) =>
    sourceItems.filter((item) => !item.batch_number || !item.expiry_date).length;

  const openPostSaveStep = (
    nextDeliveryId: number,
    savedItems: Array<Partial<ScanItem>>,
    options?: {
      supplierName?: string | null;
      forceCompanion?: boolean;
    },
  ) => {
    const missingDetailsCount = countItemsMissingBatchOrExpiry(savedItems);
    const requiresCompanion =
      options?.forceCompanion === true || missingDetailsCount > 0;

    setDeliveryId(nextDeliveryId);
    setPostSaveState({
      deliveryId: nextDeliveryId,
      supplierName:
        options?.supplierName?.trim() || scanned?.supplier_name || "Доставчик",
      requiresCompanion,
      missingDetailsCount,
    });
    setPhase("postSave");
  };

  // ── Camera / Gallery ─────────────────────────────────────────────────────

  const pickImage = useCallback(async (source: "camera" | "gallery") => {
    if (source === "camera") {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Грешка", "Необходим е достъп до камерата");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        await scanInvoice(result.assets[0].uri);
      }
    } else {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Грешка", "Необходим е достъп до галерията");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        await scanInvoice(result.assets[0].uri);
      }
    }
  }, []);

  // ── AI Scan ──────────────────────────────────────────────────────────────

  const buildFormData = (uri: string): FormData => {
    const formData = new FormData();
    const ext = uri.split(".").pop()?.toLowerCase() || "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      pdf: "application/pdf",
      heic: "image/heic",
      heif: "image/heif",
    };
    const mimeType = mimeMap[ext] || "image/jpeg";
    const fileName = `invoice.${ext === "heic" || ext === "heif" ? "jpg" : ext}`;
    formData.append("file", { uri, type: mimeType, name: fileName } as any);
    return formData;
  };

  const normalizeScanItem = (li: any): ScanItem => ({
    product_name: li.product_name ?? li.name_en ?? li.name ?? "",
    product_code: li.product_code ?? li.product_code_raw ?? null,
    name_en: li.product_name ?? li.name_en ?? li.name ?? "",
    name_bg: li.name_bg ?? li.product_name ?? li.name ?? "",
    brand: li.brand ?? null,
    category_hint: li.category_hint ?? null,
    quantity: parseFloat(li.quantity) || 1,
    unit: li.unit ?? "бр",
    unit_price: parseFloat(li.unit_price ?? li.price) || 0,
    batch_number: li.batch_number ?? li.batch ?? "",
    expiry_date: li.expiry_date ?? li.expiry ?? "",
    auto_batch: li.auto_batch ?? null,
    total: li.total_price ?? li.total ?? null,
    product_id: li.product_id ?? null,
    production_date: li.production_date ?? null,
    matched_product_id: li.matched_product_id ?? null,
    matched_product_name: li.matched_product_name ?? null,
    matched_product_sku: li.matched_product_sku ?? null,
    match_confidence: toOptionalNumber(li.match_confidence),
    match_source: li.match_source ?? null,
    selling_price: null,
    matched_purchase_price: toOptionalNumber(li.matched_purchase_price),
    matched_selling_price: toOptionalNumber(li.matched_selling_price),
    gross_price: toOptionalNumber(li.gross_price),
    discount_percent: toOptionalNumber(li.discount_percent),
    discount_amount: toOptionalNumber(li.discount_amount),
  });

  const mergeMatchPreviewIntoItems = (
    baseItems: ScanItem[],
    matches: MatchPreviewResult[],
  ): ScanItem[] =>
    baseItems.map((item, index) => {
      const match = matches[index];
      if (!match || typeof match !== "object") {
        return item;
      }

      return {
        ...item,
        matched_product_id: match.matched_product_id ?? null,
        matched_product_name: match.matched_product_name ?? null,
        matched_product_sku: match.matched_product_sku ?? null,
        match_confidence: toOptionalNumber(match.confidence),
        match_source: match.match_source ?? "none",
        matched_purchase_price: toOptionalNumber(match.matched_purchase_price),
        matched_selling_price: toOptionalNumber(match.matched_selling_price),
      };
    });

  const runMatchPreview = async (
    supplierName: string | null | undefined,
    supplierEik: string | null | undefined,
    scanItems: ScanItem[],
  ): Promise<ScanItem[]> => {
    if (scanItems.length === 0) return scanItems;

    try {
      const previewResponse = await apiClient.post("/incoming/match-preview", {
        supplier_name: supplierName ?? null,
        supplier_eik: supplierEik ?? null,
        items: scanItems.map((item) => ({
          name: item.name_bg || item.product_name || null,
          name_en: item.name_en || null,
          name_bg: item.name_bg || null,
          product_name: item.product_name || null,
          product_name_raw: item.product_name || null,
          product_code: item.product_code || null,
          product_code_raw: item.product_code || null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          price: item.unit_price,
        })),
      });

      const matches = Array.isArray(previewResponse.data?.matches)
        ? previewResponse.data.matches
        : [];
      if (matches.length === 0) {
        return scanItems;
      }

      return mergeMatchPreviewIntoItems(scanItems, matches);
    } catch {
      return scanItems;
    }
  };

  const runFullScan = async (uri: string) => {
    const formData = buildFormData(uri);
    const res = await apiClient.post("/incoming/scan", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 120000,
    });
    const data = res.data;
    if (data.error) throw new Error(data.error);

    const extractedItems = (data.line_items ?? data.items ?? []).map(normalizeScanItem);
    const rawItems = await runMatchPreview(
      data.supplier_name,
      data.supplier_eik,
      extractedItems,
    );

    const result: ScanResult = {
      supplier_name: data.supplier_name ?? "",
      supplier_eik: data.supplier_eik ?? null,
      supplier_vat: data.supplier_vat ?? null,
      supplier_address: data.supplier_address ?? null,
      invoice_number: data.invoice_number ?? "",
      invoice_date: data.invoice_date ?? "",
      document_type: data.document_type ?? "invoice",
      total: data.total ?? null,
      items: rawItems,
    };

    setScanned(result);
    setItems(rawItems);
    setPhase("preview");
  };

  const scanInvoice = async (uri: string) => {
    setScanning(true);
    setPhase("camera");
    progressAnim.setValue(0);
    setScanStage(1);
    startCountdown(60);
    try {
      // Phase 1: Quick pre-check — extract only invoice number (cheap Haiku call)
      try {
        setScanMessage("Проверка за дублиране...");
        animateProgressTo(0.15, 5000);
        const quickForm = buildFormData(uri);
        const quickRes = await apiClient.post(
          "/incoming/quick-invoice-check",
          quickForm,
          {
            headers: { "Content-Type": "multipart/form-data" },
            timeout: 30000,
          },
        );
        const invoiceNumber = quickRes.data?.invoice_number;

        if (invoiceNumber) {
          const dupCheck = await apiClient.get(
            `/incoming/check-duplicate?invoice_number=${encodeURIComponent(invoiceNumber)}`,
          );
          if (dupCheck.data.duplicate) {
            // Duplicate found — stop scanning overlay first, then show alert
            setScanning(false);
            const createdDate = dupCheck.data.created_at
              ? new Date(dupCheck.data.created_at).toLocaleDateString("bg-BG", {
                  day: "2-digit",
                  month: "2-digit",
                  year: "numeric",
                })
              : "неизвестна дата";
            const statusText =
              dupCheck.data.status === "confirmed"
                ? "✅ Потвърдена"
                : "⏳ Чакаща";
            await new Promise<void>((resolve, reject) => {
              Alert.alert(
                "⚠️ Дублирана фактура",
                `Фактура ${invoiceNumber} вече е вкарана!\n\n📅 Дата: ${createdDate}\n📋 Статус: ${statusText}\n\nИскате ли да сканирате отново?`,
                [
                  {
                    text: "✕ Отказ",
                    style: "cancel",
                    onPress: () => reject(new Error("__duplicate_cancelled__")),
                  },
                  {
                    text: "→ Продължи",
                    style: "destructive",
                    onPress: () => {
                      setScanning(true);
                      resolve();
                    },
                  },
                ],
              );
            });
          }
        }
      } catch (quickErr: any) {
        if (quickErr?.message === "__duplicate_cancelled__") {
          setPhase("camera");
          setScanning(false);
          return;
        }
        // Quick check failed — proceed to full scan anyway
      }

      // Phase 2: Full OCR scan
      setScanStage(2);
      setScanMessage("AI анализира фактурата...");
      animateProgressTo(0.75, 45000);
      startCountdown(50);
      await runFullScan(uri);

      // Phase 3: Brief product matching visual
      setScanStage(3);
      setScanMessage("Свързване на продукти...");
      animateProgressTo(1, 800);
      startCountdown(0);
      stopCountdown();
    } catch (e: any) {
      Alert.alert(
        "Грешка при сканиране",
        e.response?.data?.detail || e.message || "Опитайте отново",
      );
    } finally {
      setScanning(false);
      setScanStage(0);
      stopCountdown();
      progressAnim.setValue(0);
    }
  };

  // ── Save pending delivery (POST /incoming) ───────────────────────────────

  const savePendingDelivery = async () => {
    if (!scanned) return;
    setSaving(true);
    try {
      const res = await apiClient.post("/incoming", {
        supplier_name: scanned.supplier_name,
        supplier_eik: scanned.supplier_eik,
        supplier_vat: scanned.supplier_vat,
        supplier_address: scanned.supplier_address,
        invoice_number: scanned.invoice_number,
        invoice_date: scanned.invoice_date,
        document_type: "invoice",
        items: items.map((item) => {
          const isMatched =
            item.matched_product_id != null &&
            (item.match_confidence ?? 0) >= 0.8;
          return {
            product_id: isMatched ? item.matched_product_id : undefined,
            product_name: item.name_en || item.product_name,
            name_bg: item.name_bg || item.product_name,
            brand: item.brand,
            category_hint: item.category_hint,
            unit: item.unit,
            quantity: item.quantity,
            unit_price: item.unit_price,
            batch_number: item.batch_number || null,
            expiry_date: item.expiry_date || null,
            selling_price:
              !isMatched && item.selling_price != null
                ? item.selling_price
                : undefined,
          };
        }),
      });

      const doc = res.data ?? {};
      const docId = doc.id;
      const savedArr: any[] = Array.isArray(doc.items) ? doc.items : [];
      const merged = items.map((item, idx) => {
        const saved = savedArr[idx] ?? {};
        return {
          ...item,
          product_id: saved.product_id ?? item.product_id ?? null,
          batch_number: saved.batch_number ?? item.batch_number ?? "",
          expiry_date: saved.expiry_date ?? item.expiry_date ?? "",
          production_date: saved.production_date ?? item.production_date ?? null,
        };
      });
      const requiresCompanion = Boolean(
        doc.needs_companion_doc ||
          doc.missing_batch ||
          doc.missing_expiry ||
          countItemsMissingBatchOrExpiry(merged) > 0,
      );

      setItems(merged);
      openPostSaveStep(docId, merged, {
        supplierName: scanned.supplier_name,
        forceCompanion: requiresCompanion,
      });
    } catch (e: any) {
      const data = e?.response?.data;
      if (data?.error === "duplicate_invoice") {
        Alert.alert("Дублирана фактура", data.message);
      } else {
        Alert.alert("Грешка", data?.message || e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  // ── Companion document scan ──────────────────────────────────────────────

  const scanCompanion = async (source: "camera" | "gallery") => {
    let uri: string | null = null;

    if (source === "camera") {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Грешка", "Необходим е достъп до камерата");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) uri = result.assets[0].uri;
    } else {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Грешка", "Необходим е достъп до галерията");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) uri = result.assets[0].uri;
    }

    if (!uri) return;

    setCompanionScanning(true);
    try {
      const formData = buildFormData(uri);
      const res = await apiClient.post("/incoming/scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      const d = res.data ?? {};
      const companionItems: any[] = (
        Array.isArray(d.items) ? d.items : (d.line_items ?? [])
      ).map((li: any) => ({
        name_en: (li.product_name || li.name || "").toLowerCase(),
        name_bg: (li.name_bg || "").toLowerCase(),
        batch_number: li.batch_number ?? null,
        production_date: li.production_date ?? null,
        expiry_date: li.expiry_date ?? null,
        auto_batch: li.auto_batch ?? null,
      }));

      // Score-based name matching (same as web)
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-zа-яё0-9]/gi, " ")
          .replace(/\s+/g, " ")
          .trim();

      const updated = items.map((item, idx) => {
        const invName = normalize(item.product_name || item.name_en || "");
        let bestMatch: any = null;
        let bestScore = 0;
        companionItems.forEach((ci) => {
          const ciName = normalize(ci.name_en + " " + ci.name_bg);
          const invWords = invName.split(" ").filter((w) => w.length > 2);
          const ciWords = ciName.split(" ").filter((w) => w.length > 2);
          const overlap = invWords.filter((w) =>
            ciWords.some((cw) => cw.includes(w) || w.includes(cw)),
          ).length;
          if (overlap > bestScore) {
            bestScore = overlap;
            bestMatch = ci;
          }
        });

        const match = bestScore > 0 ? bestMatch : (companionItems[idx] ?? null);
        if (!match) return item;

        const expiry = match.expiry_date || "";
        const batch =
          match.batch_number ||
          match.auto_batch ||
          item.batch_number ||
          (match.production_date
            ? batchFromProdDate(match.production_date)
            : "") ||
          (expiry ? autoBatchFromExpiry(expiry) : "");

        return {
          ...item,
          expiry_date: expiry,
          batch_number: batch,
          production_date: match.production_date || item.production_date,
        };
      });

      setItems(updated);
      setPhase("manual");
    } catch {
      Alert.alert("Грешка", "Грешка при сканиране на втория документ");
    } finally {
      setCompanionScanning(false);
    }
  };

  // ── Save batches (PATCH /incoming/:id/batches) ───────────────────────────

  const saveBatches = async () => {
    if (!deliveryId) {
      setPhase("done");
      return;
    }
    setSavingBatches(true);
    try {
      const updates = items.filter((i) => i.batch_number || i.expiry_date);
      if (updates.length > 0) {
        await apiClient.patch(`/incoming/${deliveryId}/batches`, {
          items: updates.map((i) => ({
            product_id: i.product_id,
            batch_number: i.batch_number || null,
            expiry_date: i.expiry_date ? expiryToISO(i.expiry_date) : null,
            production_date: i.production_date || null,
          })),
        });
      }

      openPostSaveStep(deliveryId, items, {
        supplierName: postSaveState?.supplierName || scanned?.supplier_name,
      });
    } catch {
      /* silent */
    } finally {
      setSavingBatches(false);
    }
  };

  // ── Reset to start ──────────────────────────────────────────────────────

  const resetAll = () => {
    setPhase("camera");
    setScanning(false);
    setSaving(false);
    setSavingBatches(false);
    setCompanionScanning(false);
    setScanned(null);
    setItems([]);
    setDeliveryId(null);
    setPostSaveState(null);
    setScanStage(0);
    stopCountdown();
    progressAnim.setValue(0);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Camera / Gallery
  // ═══════════════════════════════════════════════════════════════════════════

  if (phase === "camera" && !scanning) {
    return (
      <SafeAreaView style={s.container} edges={["top", "bottom"]}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Сканирай фактура</Text>
        </View>

        <View style={s.cameraBody}>
          <TouchableOpacity
            onPress={() => pickImage("camera")}
            style={s.primaryBtn}
            activeOpacity={0.8}
          >
            <Ionicons name="camera-outline" size={40} color="#ffffff" />
            <Text style={s.primaryBtnTitle}>Снимай с камера</Text>
            <Text style={s.primaryBtnSub}>Насочи камерата към фактурата</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => pickImage("gallery")}
            style={s.secondaryBtn}
            activeOpacity={0.8}
          >
            <Ionicons
              name="images-outline"
              size={40}
              color={colors.textLight}
            />
            <Text style={s.secondaryBtnTitle}>Избери от галерията</Text>
            <Text style={s.secondaryBtnSub}>Снимка на фактура от телефона</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scanning / loading overlay
  // ═══════════════════════════════════════════════════════════════════════════

  if (scanning) {
    const progressPercent = progressAnim.interpolate({
      inputRange: [0, 1],
      outputRange: ["0%", "100%"],
    });
    return (
      <SafeAreaView style={s.container} edges={["top", "bottom"]}>
        <View style={s.loadingBody}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={s.loadingTitle}>{scanMessage}</Text>
          {scanStage > 0 && (
            <Text style={s.loadingStage}>Стъпка {scanStage} от 3</Text>
          )}

          {/* Progress bar */}
          <View style={s.progressContainer}>
            <View style={s.progressTrack}>
              <Animated.View
                style={[s.progressFill, { width: progressPercent }]}
              />
            </View>
          </View>

          {estimatedTimeLeft > 0 && (
            <Text style={s.loadingTime}>~{estimatedTimeLeft} сек. остават</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Preview scan results + confirm delivery
  // ═══════════════════════════════════════════════════════════════════════════

  if (phase === "preview" && scanned) {
    const missingBatchExpiryCount = countItemsMissingBatchOrExpiry(items);
    const needsCompanionAfterSave = missingBatchExpiryCount > 0;
    const unresolvedCount = items.filter((item) => item.matched_product_id == null).length;
    const weakMatchCount = items.filter(
      (item) => item.matched_product_id != null && (item.match_confidence ?? 0) < 0.8,
    ).length;

    return (
      <SafeAreaView style={s.container} edges={["top"]}>
        <View style={s.navHeader}>
          <TouchableOpacity onPress={resetAll} style={s.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.accentAlt} />
            <Text style={s.backBtnText}>Назад</Text>
          </TouchableOpacity>
          <Text style={s.navHeaderTitle}>Преглед на фактура</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView
          style={s.flex1}
          contentContainerStyle={s.scrollPad}
          keyboardShouldPersistTaps="handled"
        >
          <LinearGradient
            colors={["rgba(197,166,92,0.22)", "rgba(28,34,54,0.96)", "rgba(10,10,20,1)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.reviewHeroCard}
          >
            <View style={s.reviewHeroHeader}>
              <View style={s.reviewHeroCopy}>
                <Text style={s.reviewHeroEyebrow}>Преглед на фактура</Text>
                <Text style={s.reviewHeroTitle}>{scanned.supplier_name || "Неизвестен доставчик"}</Text>
                <Text style={s.reviewHeroText}>
                  Провери редовете и запази доставката. След записа ще има само една ясна
                  следваща стъпка.
                </Text>
              </View>
              <View style={s.reviewHeroStatusPill}>
                <Ionicons
                  name={needsCompanionAfterSave ? "document-attach-outline" : "checkmark-circle-outline"}
                  size={15}
                  color={needsCompanionAfterSave ? "#f4d58d" : "#7bf0bf"}
                />
                <Text style={s.reviewHeroStatusText}>
                  {needsCompanionAfterSave ? "Следва втори документ" : "Следва приемане"}
                </Text>
              </View>
            </View>

            <View style={s.reviewHeroMetaRow}>
              <View style={s.reviewHeroMetaCard}>
                <Text style={s.reviewHeroMetaLabel}>Фактура</Text>
                <Text style={s.reviewHeroMetaValue}>{scanned.invoice_number || "без номер"}</Text>
                {scanned.invoice_date ? (
                  <Text style={s.reviewHeroMetaHint}>{scanned.invoice_date}</Text>
                ) : null}
              </View>
              <View style={s.reviewHeroMetaCard}>
                <Text style={s.reviewHeroMetaLabel}>Редове</Text>
                <Text style={s.reviewHeroMetaValue}>{items.length}</Text>
                <Text style={s.reviewHeroMetaHint}>
                  {unresolvedCount > 0 ? `${unresolvedCount} за избор` : "Всички имат връзка"}
                </Text>
              </View>
              <View style={s.reviewHeroMetaCard}>
                <Text style={s.reviewHeroMetaLabel}>Сума</Text>
                <Text style={s.reviewHeroMetaValue}>
                  {scanned.total != null
                    ? `${(
                        typeof scanned.total === "string"
                          ? parseFloat(scanned.total) || 0
                          : scanned.total
                      ).toFixed(2)} €`
                    : "—"}
                </Text>
                <Text style={s.reviewHeroMetaHint}>
                  {weakMatchCount > 0 ? `${weakMatchCount} с ниска увереност` : "Спокойна проверка"}
                </Text>
              </View>
            </View>
          </LinearGradient>

          <View style={s.reviewSummaryCard}>
            <View style={s.reviewSummaryHeader}>
              <Text style={s.reviewSummaryLabel}>Документ</Text>
              {scanned.supplier_eik ? <Text style={s.reviewSummaryBadge}>ЕИК {scanned.supplier_eik}</Text> : null}
            </View>
            <Text style={s.reviewSummaryTitle}>Операторски преглед преди запис</Text>
            <Text style={s.reviewSummaryText}>
              Дръж фокуса върху продуктова връзка, цена и липсващи партиди/срокове. Техническите
              детайли и debug поведението остават непроменени зад този UI.
            </Text>
          </View>

          <View style={s.sectionHeadingRow}>
            <Text style={s.sectionHeadingTitle}>Редове за проверка</Text>
            <Text style={s.sectionHeadingCount}>{items.length}</Text>
          </View>
          {items.map((item, i) => {
            const conf = item.match_confidence ?? 0;
            const hasMatch = item.matched_product_id != null;
            // 4-level color system:
            // Green (≥95%): name + price confirmed
            // Blue (80-94%): name match only
            // Yellow (<80%): weak suggestion
            // Orange: no match / new product
            const isConfirmed = hasMatch && conf >= 0.95;
            const isNameMatch = hasMatch && conf >= 0.8 && conf < 0.95;
            const isSuggested = hasMatch && conf < 0.8;
            const isNew = !hasMatch;

            const invoiceCode = item.product_code?.trim() || null;
            const lineTotal = (
              (typeof item.quantity === "string" ? parseFloat(item.quantity) : item.quantity || 0) *
              (typeof item.unit_price === "string"
                ? parseFloat(item.unit_price)
                : item.unit_price || 0)
            ).toFixed(2);
            const catalogPurchase =
              item.matched_purchase_price != null
                ? `${parseFloat(String(item.matched_purchase_price)).toFixed(2)} €`
                : "Няма";
            const matchedSelling =
              item.matched_selling_price != null && item.matched_selling_price > 0
                ? `${parseFloat(String(item.matched_selling_price)).toFixed(2)} €`
                : null;
            const batchNote = !item.batch_number || !item.expiry_date;

            return (
              <View
                key={i}
                style={[
                  s.itemCard,
                  isConfirmed && s.itemCardConfirmed,
                  isNameMatch && s.itemCardNameMatch,
                  isSuggested && s.itemCardSuggested,
                  isNew && s.itemCardNew,
                ]}
              >
                <View style={s.itemCardHeaderRow}>
                  <View style={s.flex1}>
                    <Text style={s.itemCardEyebrow}>Ред {i + 1}</Text>
                    <Text style={s.itemName} numberOfLines={2}>
                      {item.name_bg || item.product_name}
                    </Text>
                    {item.name_en &&
                      item.name_en !== item.name_bg &&
                      item.name_en !== item.product_name && (
                        <Text style={s.itemSubname} numberOfLines={1}>
                          На фактурата: {item.name_en}
                        </Text>
                      )}
                    {invoiceCode ? (
                      <Text style={s.itemInvoiceCode}>Код от фактура: {invoiceCode}</Text>
                    ) : null}
                  </View>
                  <View style={s.itemHeaderRightColumn}>
                    <View
                      style={[
                        s.itemStatusPill,
                        isConfirmed && s.itemStatusConfirmed,
                        isNameMatch && s.itemStatusInfo,
                        isSuggested && s.itemStatusWarning,
                        isNew && s.itemStatusNew,
                      ]}
                    >
                      <Text style={s.itemStatusPillText}>
                        {isConfirmed
                          ? "Потвърден мач"
                          : isNameMatch
                            ? "Име съвпада"
                            : isSuggested
                              ? "Провери мача"
                              : "Нов продукт"}
                      </Text>
                    </View>
                    <Text style={s.itemQty}>{item.quantity} {item.unit}</Text>
                    <Text style={s.itemLineTotal}>{lineTotal} €</Text>
                  </View>
                </View>

                <TouchableOpacity
                  onPress={() => openPicker(i)}
                  activeOpacity={0.78}
                  style={s.matchedProductCard}
                >
                  <View style={s.flex1}>
                    <Text style={s.matchedProductLabel}>Складов продукт</Text>
                    <Text style={s.matchedProductName} numberOfLines={2}>
                      {item.matched_product_name || "Избери продукт от каталога"}
                    </Text>
                    <Text style={s.matchedProductMeta}>
                      {item.matched_product_sku ? `SKU ${item.matched_product_sku}` : "Без SKU"}
                      {item.match_source === "manual" ? " • избран ръчно" : ""}
                      {hasMatch ? ` • ${Math.round(conf * 100)}% увереност` : ""}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.accentAlt} />
                </TouchableOpacity>

                <View style={s.priceSummaryGrid}>
                  <View style={s.priceSummaryCard}>
                    <Text style={s.priceSummaryLabel}>Фактурна цена</Text>
                    <Text style={s.priceSummaryValue}>{Number(item.unit_price || 0).toFixed(2)} €</Text>
                  </View>
                  <View style={s.priceSummaryCard}>
                    <Text style={s.priceSummaryLabel}>Каталожна цена</Text>
                    <Text style={s.priceSummaryValue}>{catalogPurchase}</Text>
                  </View>
                  <View style={s.priceSummaryCard}>
                    <Text style={s.priceSummaryLabel}>Продажна цена</Text>
                    <Text style={s.priceSummaryValue}>{matchedSelling || "Въведи отдолу"}</Text>
                  </View>
                </View>

                <View style={s.priceRow}>
                  <Text style={s.priceLabel}>Ед. цена</Text>
                  <TextInput
                    value={
                      item._unitPriceText != null
                        ? item._unitPriceText
                        : String(item.unit_price)
                    }
                    onChangeText={(v) => {
                      const updated = [...items];
                      updated[i] = {
                        ...updated[i],
                        _unitPriceText: v,
                        unit_price: parseFloat(v.replace(",", ".")) || 0,
                      };
                      setItems(updated);
                    }}
                    onBlur={() => {
                      const updated = [...items];
                      updated[i] = {
                        ...updated[i],
                        _unitPriceText: undefined,
                      };
                      setItems(updated);
                    }}
                    keyboardType="decimal-pad"
                    style={s.priceInput}
                    selectTextOnFocus
                  />
                  <Text style={s.priceCurrency}>€</Text>
                  <View style={s.flex1} />
                  <Text style={s.lineTotal}>Общо {lineTotal} €</Text>
                </View>
                {item.gross_price != null &&
                  (item.discount_percent ?? 0) > 0 && (
                    <View style={s.discountSummaryRow}>
                      <Text style={s.discountSummaryText}>
                        Цена: {Number(item.gross_price).toFixed(2)}€
                      </Text>
                      <Text style={s.discountSummaryDivider}>|</Text>
                      <Text style={s.discountSummaryWarning}>
                        Отст: {Number(item.discount_percent).toFixed(0)}%
                      </Text>
                      <Text style={s.discountSummaryText}>
                        (-{Number(item.discount_amount ?? 0).toFixed(2)}€)
                      </Text>
                      <Text style={s.discountSummaryDivider}>|</Text>
                      <Text style={s.discountSummaryText}>
                        Нето: {Number(item.unit_price).toFixed(2)}€
                      </Text>
                    </View>
                  )}
                {/* Price comparison — for matched products */}
                {hasMatch &&
                  item.matched_purchase_price != null &&
                  (() => {
                    const dbPrice =
                      parseFloat(String(item.matched_purchase_price)) || 0;
                    const invPrice = parseFloat(String(item.unit_price)) || 0;
                    const diff = invPrice - dbPrice;
                    const pricesMatch = Math.abs(diff) < 0.01;
                    return (
                      <View style={s.priceCompareRow}>
                        <Text style={s.priceCompareLabel}>
                          Доставна (база):
                        </Text>
                        <Text style={s.priceCompareValue}>
                          {dbPrice.toFixed(2)} €
                        </Text>
                        <Text style={s.priceCompareSep}>│</Text>
                        <Text style={s.priceCompareLabel}>Фактура:</Text>
                        <Text
                          style={[
                            s.priceCompareValue,
                            !pricesMatch && s.priceCompareDiff,
                          ]}
                        >
                          {invPrice.toFixed(2)} €
                        </Text>
                        {pricesMatch ? (
                          <Text style={s.priceCompareOk}> ✓</Text>
                        ) : (
                          <Text style={s.priceCompareDiff}>
                            {" "}
                            ⚠️ {diff > 0 ? "+" : ""}
                            {diff.toFixed(2)}€
                          </Text>
                        )}
                      </View>
                    );
                  })()}
                {hasMatch &&
                  item.matched_selling_price != null &&
                  item.matched_selling_price > 0 && (
                    <View style={s.priceCompareRow}>
                      <Text style={s.priceCompareLabel}>Продажна:</Text>
                      <Text style={s.priceCompareValue}>
                        {parseFloat(String(item.matched_selling_price)).toFixed(
                          2,
                        )}{" "}
                        €
                      </Text>
                    </View>
                  )}
                {/* Selling price — for new products OR matched products with 0 selling price */}
                {(isNew ||
                  (hasMatch &&
                    (item.matched_selling_price == null ||
                      item.matched_selling_price <= 0))) && (
                  <View style={s.priceRow}>
                    <Text style={s.priceLabel}>Продажна:</Text>
                    <TextInput
                      value={
                        item._sellingPriceText != null
                          ? item._sellingPriceText
                          : item.selling_price != null
                            ? String(item.selling_price)
                            : ""
                      }
                      onChangeText={(v) => {
                        const updated = [...items];
                        updated[i] = {
                          ...updated[i],
                          _sellingPriceText: v,
                          selling_price:
                            v === ""
                              ? null
                              : parseFloat(v.replace(",", ".")) || 0,
                        };
                        setItems(updated);
                      }}
                      onBlur={() => {
                        const updated = [...items];
                        updated[i] = {
                          ...updated[i],
                          _sellingPriceText: undefined,
                        };
                        setItems(updated);
                      }}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      style={s.priceInput}
                      selectTextOnFocus
                    />
                    <Text style={s.priceCurrency}>€</Text>
                  </View>
                )}

                {batchNote ? (
                  <View style={s.batchFollowUpNote}>
                    <Ionicons name="time-outline" size={15} color="#f4d58d" />
                    <Text style={s.batchFollowUpText}>
                      Липсва партида или срок на годност. След записа системата ще отведе към
                      втори документ или ръчно попълване.
                    </Text>
                  </View>
                ) : null}
              </View>
            );
          })}

          <LinearGradient
            colors={["rgba(88,122,255,0.24)", "rgba(18,22,42,0.94)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.reviewNextStepCard}
          >
            <Text style={s.reviewNextStepLabel}>След записа</Text>
            <Text style={s.reviewNextStepTitle}>
              {needsCompanionAfterSave
                ? "Ще поискаме втори документ"
                : "Следва приемане в склада"}
            </Text>
            <Text style={s.reviewNextStepText}>
              {needsCompanionAfterSave
                ? `${missingBatchExpiryCount} ${missingBatchExpiryCount === 1 ? "ред чака" : "реда чакат"} партида или срок. Първо запазваш доставката, после системата показва само една следваща стъпка: сканиране на втори документ.`
                : "Ако всичко изглежда добре, запази доставката и веднага ще получиш бутон „Към приемане“ без други конкуриращи се действия."}
            </Text>
          </LinearGradient>

          <View style={{ height: 24 }} />
        </ScrollView>

        {/* Confirm button — pinned above tab bar */}
        <View
          style={[
            s.footer,
            { paddingBottom: Math.max(insets.bottom, 16) + 70 },
          ]}
        >
          {(() => {
            const newWithoutPrice = items.filter(
              (it) =>
                it.matched_product_id == null &&
                (it.selling_price == null || it.selling_price <= 0),
            );
            const hasBlock = newWithoutPrice.length > 0;
            return (
              <>
                {hasBlock && (
                  <Text
                    style={{
                      color: "#f97316",
                      fontSize: 12,
                      marginBottom: 8,
                      textAlign: "center",
                    }}
                  >
                    ⚠️ {newWithoutPrice.length} нов
                    {newWithoutPrice.length === 1 ? "" : "и"} продукт
                    {newWithoutPrice.length === 1 ? "" : "а"} без продажна цена!
                  </Text>
                )}
                <TouchableOpacity
                  onPress={savePendingDelivery}
                  disabled={saving || hasBlock}
                  style={[s.accentBtn, (saving || hasBlock) && s.btnDisabled]}
                  activeOpacity={0.8}
                >
                  {saving ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <View style={s.btnRow}>
                      <Ionicons
                        name="save-outline"
                        size={20}
                        color="#ffffff"
                      />
                      <Text style={s.accentBtnText}>
                        {hasBlock
                          ? "Въведи цени на новите продукти"
                          : "Запази чакащата доставка"}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              </>
            );
          })()}
        </View>

        {/* ── Duplicate Invoice Modal ────────────────────────────────── */}
        <Modal
          visible={dupModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            setDupModalVisible(false);
            dupResolveRef.current?.reject(new Error("__duplicate_cancelled__"));
            dupResolveRef.current = null;
          }}
        >
          <View style={s.dupOverlay}>
            <View style={s.dupCard}>
              {/* Warning icon */}
              <View style={s.dupIconContainer}>
                <View style={s.dupIconCircle}>
                  <Ionicons
                    name="alert-circle"
                    size={36}
                    color={colors.warning}
                  />
                </View>
              </View>

              {/* Title */}
              <Text style={s.dupTitle}>Дублирана фактура</Text>

              {/* Invoice info card */}
              <View style={s.dupInfoCard}>
                <View style={s.dupInfoRow}>
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color={colors.textSecondary}
                  />
                  <Text style={s.dupInfoLabel}>Номер:</Text>
                  <Text style={s.dupInfoValue}>
                    {dupModalData?.invoiceNumber}
                  </Text>
                </View>
                <View style={[s.dupInfoRow, { marginTop: 8 }]}>
                  <Ionicons
                    name="calendar-outline"
                    size={18}
                    color={colors.textSecondary}
                  />
                  <Text style={s.dupInfoLabel}>Вкарана на:</Text>
                  <Text style={s.dupInfoValue}>{dupModalData?.date}</Text>
                </View>
                <View style={[s.dupInfoRow, { marginTop: 8 }]}>
                  <Ionicons
                    name="checkmark-circle-outline"
                    size={18}
                    color={colors.success}
                  />
                  <Text style={s.dupInfoLabel}>Статус:</Text>
                  <Text style={[s.dupInfoValue, { color: colors.success }]}>
                    {dupModalData?.status}
                  </Text>
                </View>
              </View>

              {/* Question */}
              <Text style={s.dupQuestion}>Искате ли да сканирате отново?</Text>

              {/* Buttons */}
              <View style={s.dupButtons}>
                <TouchableOpacity
                  style={s.dupBtnCancel}
                  onPress={() => {
                    setDupModalVisible(false);
                    dupResolveRef.current?.reject(
                      new Error("__duplicate_cancelled__"),
                    );
                    dupResolveRef.current = null;
                  }}
                >
                  <Ionicons
                    name="close-circle-outline"
                    size={20}
                    color={colors.text}
                  />
                  <Text style={s.dupBtnCancelText}>Отказ</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.dupBtnContinue}
                  onPress={() => {
                    setDupModalVisible(false);
                    dupResolveRef.current?.resolve();
                    dupResolveRef.current = null;
                  }}
                >
                  <Ionicons
                    name="arrow-forward-circle-outline"
                    size={20}
                    color="#fff"
                  />
                  <Text style={s.dupBtnContinueText}>Продължи</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* ── Product Picker Modal ──────────────────────────────────── */}
        <Modal
          visible={pickerVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setPickerVisible(false)}
        >
          <SafeAreaView style={s.pickerContainer} edges={["top", "bottom"]}>
            {/* Header */}
            <View style={s.pickerHeader}>
              <Text style={s.pickerTitle}>Избери продукт</Text>
              <TouchableOpacity
                onPress={() => setPickerVisible(false)}
                style={s.pickerCloseBtn}
              >
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Search input */}
            <View style={s.pickerSearchWrap}>
              <Ionicons
                name="search"
                size={18}
                color={colors.textMuted}
                style={{ marginRight: 8 }}
              />
              <TextInput
                value={pickerQuery}
                onChangeText={searchProducts}
                placeholder="Търси по име или SKU..."
                placeholderTextColor={colors.textMuted}
                style={s.pickerSearchInput}
                autoFocus
                returnKeyType="search"
              />
              {pickerQuery.length > 0 && (
                <TouchableOpacity onPress={() => searchProducts("")}>
                  <Ionicons
                    name="close-circle"
                    size={18}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              )}
            </View>

            {/* Current suggestion (if item has one) */}
            {pickerItemIndex != null &&
              items[pickerItemIndex]?.matched_product_id != null && (
                <TouchableOpacity
                  style={s.pickerSuggestion}
                  onPress={() =>
                    selectProduct({
                      id: items[pickerItemIndex!].matched_product_id,
                      name_bg: items[pickerItemIndex!].matched_product_name,
                      sku: items[pickerItemIndex!].matched_product_sku,
                    })
                  }
                  activeOpacity={0.7}
                >
                  <Text style={s.pickerSuggestionLabel}>
                    Текущо предложение:
                  </Text>
                  <Text style={s.pickerSuggestionText}>
                    ✅ {items[pickerItemIndex!].matched_product_name} [
                    {items[pickerItemIndex!].matched_product_sku}] —{" "}
                    {Math.round(
                      (items[pickerItemIndex!].match_confidence ?? 0) * 100,
                    )}
                    %
                  </Text>
                </TouchableOpacity>
              )}

            {/* Results */}
            {pickerLoading ? (
              <ActivityIndicator
                size="small"
                color={colors.accent}
                style={{ marginTop: 24 }}
              />
            ) : (
              <FlatList
                data={pickerResults}
                keyExtractor={(p) => String(p.id)}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingBottom: 24,
                }}
                ListEmptyComponent={
                  pickerQuery.length > 0 ? (
                    <Text style={s.pickerEmpty}>Няма резултати</Text>
                  ) : (
                    <Text style={s.pickerEmpty}>
                      Въведи име или SKU за търсене
                    </Text>
                  )
                }
                renderItem={({ item: product }) => (
                  <TouchableOpacity
                    style={[
                      s.pickerProductCard,
                      pickerItemIndex != null &&
                        items[pickerItemIndex]?.matched_product_id ===
                          product.id &&
                        s.pickerProductSelected,
                    ]}
                    onPress={() => selectProduct(product)}
                    activeOpacity={0.7}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.pickerProductName} numberOfLines={1}>
                        {product.name_bg}
                      </Text>
                      <Text style={s.pickerProductMeta}>
                        SKU: {product.sku} · {product.unit}
                        {product.group_name ? ` · ${product.group_name}` : ""}
                      </Text>
                    </View>
                    {product.selling_price != null && (
                      <Text style={s.pickerProductPrice}>
                        {parseFloat(product.selling_price).toFixed(2)}€
                      </Text>
                    )}
                  </TouchableOpacity>
                )}
              />
            )}

            {/* Footer */}
            <View style={s.pickerFooter}>
              <TouchableOpacity
                style={[s.ghostBtn, { flex: 1 }]}
                onPress={() => setPickerVisible(false)}
                activeOpacity={0.8}
              >
                <Text style={s.ghostBtnText}>✕ Затвори</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.ghostBtn, { flex: 1, borderColor: "#f97316" }]}
                onPress={clearMatch}
                activeOpacity={0.8}
              >
                <Text style={[s.ghostBtnText, { color: "#f97316" }]}>
                  🆕 Нов продукт
                </Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Post-save next step
  // ═══════════════════════════════════════════════════════════════════════════

  if (phase === "postSave" && postSaveState) {
    const { deliveryId: savedDeliveryId, supplierName, requiresCompanion, missingDetailsCount } =
      postSaveState;

    return (
      <SafeAreaView style={s.container} edges={["top", "bottom"]}>
        <View style={s.navHeader}>
          <TouchableOpacity
            onPress={() => setPhase("preview")}
            style={s.backBtn}
          >
            <Ionicons name="chevron-back" size={22} color={colors.accentAlt} />
            <Text style={s.backBtnText}>Назад</Text>
          </TouchableOpacity>
          <Text style={s.navHeaderTitle}>Следваща стъпка</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={s.postSaveScroll}>
          <LinearGradient
            colors={["rgba(123,240,191,0.24)", "rgba(27,34,48,0.96)", "rgba(10,10,20,1)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.postSaveHeroCard}
          >
            <View style={s.postSaveHeroIconWrap}>
              <Ionicons name="checkmark-circle" size={38} color={colors.success} />
            </View>
            <Text style={s.postSaveHeroEyebrow}>Записана чакаща доставка</Text>
            <Text style={s.postSaveHeroTitle}>#{savedDeliveryId} • {supplierName}</Text>
            <Text style={s.postSaveHeroText}>
              {requiresCompanion
                ? "Фактурата е записана. Сега довършваме липсващите данни по най-сигурния път."
                : "Фактурата е записана и е готова за следващия оперативен етап."}
            </Text>
          </LinearGradient>

          <View style={s.postSaveStatusCard}>
            <Text style={s.postSaveStatusLabel}>Какво вече е готово</Text>
            <Text style={s.postSaveStatusTitle}>Фактурата е запазена като чакаща доставка</Text>
            <Text style={s.postSaveStatusText}>
              {requiresCompanion
                ? `Остават ${missingDetailsCount} ${missingDetailsCount === 1 ? "ред" : "реда"} без пълна партида или срок. Сега системата не показва приемане, защото първо трябва да довършиш тези данни.`
                : "Всички ключови данни са записани. Можеш да продължиш директно към приемането в склада."}
            </Text>
          </View>

          {requiresCompanion ? (
            <>
              <View style={s.postSaveNextActionCard}>
                <Text style={s.postSaveNextActionLabel}>Следваща стъпка</Text>
                <Text style={s.postSaveNextActionTitle}>Сканирай втори документ</Text>
                <Text style={s.postSaveNextActionText}>
                  Най-бързият начин да попълниш липсващите партиди и срокове е с
                  придружителен документ.
                </Text>
                <View style={s.postSaveStepList}>
                  <Text style={s.postSaveStepItem}>1. Добавяш снимка или PDF.</Text>
                  <Text style={s.postSaveStepItem}>2. Системата опитва автоматично попълване.</Text>
                  <Text style={s.postSaveStepItem}>3. Ако трябва, довършваш ръчно само липсите.</Text>
                </View>
              </View>

              {companionScanning ? (
                <View style={s.companionLoading}>
                  <ActivityIndicator size="large" color={colors.accent} />
                  <Text style={s.loadingSub}>Сканиране на втория документ...</Text>
                </View>
              ) : (
                <View style={s.askOptions}>
                  <TouchableOpacity
                    onPress={() => {
                      Alert.alert(
                        "Избери източник",
                        "Как искате да добавите документа?",
                        [
                          {
                            text: "Камера",
                            onPress: () => scanCompanion("camera"),
                          },
                          {
                            text: "Галерия",
                            onPress: () => scanCompanion("gallery"),
                          },
                          { text: "Отказ", style: "cancel" },
                        ],
                      );
                    }}
                    style={s.optionCardPrimary}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name="document-text-outline"
                      size={28}
                      color="#ffffff"
                    />
                    <View style={s.flex1}>
                      <Text style={s.optionTitleOnAccent}>Сканирай втори документ</Text>
                      <Text style={s.optionSubOnAccent}>
                        Добави придружителен документ и попълни липсите автоматично.
                      </Text>
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => setPhase("manual")}
                    style={s.optionCard}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name="create-outline"
                      size={28}
                      color={colors.warning}
                    />
                    <View style={s.flex1}>
                      <Text style={s.optionTitle}>Попълни ръчно</Text>
                      <Text style={s.optionSub}>
                        Ако нямаш документ под ръка, въведи датите и партидите сам.
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            <View style={s.doneActions}>
              <TouchableOpacity
                onPress={() => navigation.navigate("IncomingGoods" as never)}
                style={s.successBtn}
                activeOpacity={0.8}
              >
                <View style={s.btnRow}>
                  <Ionicons name="arrow-forward-circle-outline" size={20} color="#ffffff" />
                  <Text style={s.accentBtnText}>Към приемане</Text>
                </View>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={resetAll}
                style={s.ghostBtn}
                activeOpacity={0.8}
              >
                <Text style={s.ghostBtnText}>Сканирай друга фактура</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Manual batch/expiry entry
  // ═══════════════════════════════════════════════════════════════════════════

  if (phase === "manual") {
    return (
      <SafeAreaView style={s.container} edges={["top"]}>
        <View style={s.navHeader}>
          <TouchableOpacity onPress={() => setPhase("postSave")} style={s.backBtn}>
            <Ionicons name="chevron-back" size={22} color={colors.accentAlt} />
            <Text style={s.backBtnText}>Назад</Text>
          </TouchableOpacity>
          <Text style={s.navHeaderTitle}>Дати на годност</Text>
          <View style={{ width: 64 }} />
        </View>

        <View style={s.manualIntroCard}>
          <Text style={s.manualIntroEyebrow}>Ръчно довършване</Text>
          <Text style={s.manualIntroTitle}>Попълни само липсващите партиди и срокове</Text>
          <Text style={s.manualHint}>
            Пиши само ден и месец (напр. 1904 → 19.04.2026). Ако има дата, партидата може да се
            генерира автоматично.
          </Text>
        </View>

        <KeyboardAvoidingView
          style={s.flex1}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={100}
        >
          <ScrollView
            style={s.flex1}
            contentContainerStyle={s.scrollPad}
            keyboardShouldPersistTaps="handled"
          >
            {/* Auto-generate batches button */}
            <TouchableOpacity
              onPress={() => {
                const updated = items.map((item) => {
                  if (item.expiry_date && !item.batch_number) {
                    return {
                      ...item,
                      batch_number: autoBatchFromExpiry(item.expiry_date),
                    };
                  }
                  return item;
                });
                setItems(updated);
              }}
              style={s.autoGenerateBtn}
              activeOpacity={0.8}
            >
              <Ionicons name="flash" size={18} color="#ffffff" />
              <Text style={s.autoGenerateBtnText}>Генерирай партиди автоматично</Text>
            </TouchableOpacity>

            {items.map((item, i) => (
              <View key={i} style={s.manualItemCard}>
                <View style={s.manualCardHeader}>
                  <View style={s.flex1}>
                    <Text style={s.itemCardEyebrow}>Ред {i + 1}</Text>
                    <Text style={s.itemName} numberOfLines={1}>
                      {item.name_bg || item.product_name}
                    </Text>
                    {item.name_en && item.name_en !== item.name_bg && (
                      <Text style={s.itemSubname} numberOfLines={1}>
                        {item.name_en}
                      </Text>
                    )}
                  </View>
                  <Text style={s.manualQty}>
                    {item.quantity} {item.unit}
                  </Text>
                </View>

                <View style={s.manualMetaRow}>
                  <View style={s.manualMetaPill}>
                    <Text style={s.manualMetaPillText}>
                      {item.batch_number ? `Партида ${item.batch_number}` : "Липсва партида"}
                    </Text>
                  </View>
                  <View style={s.manualMetaPill}>
                    <Text style={s.manualMetaPillText}>
                      {item.expiry_date ? `Срок ${item.expiry_date}` : "Липсва срок"}
                    </Text>
                  </View>
                </View>

                {/* Expiry date */}
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>ДАТА НА ГОДНОСТ</Text>
                  <TextInput
                    value={item.expiry_date}
                    onChangeText={(raw) => {
                      const updated = [...items];
                      updated[i] = { ...updated[i], expiry_date: raw };
                      setItems(updated);
                    }}
                    onBlur={() => {
                      const updated = [...items];
                      const formatted = formatSmartExpiry(
                        updated[i].expiry_date,
                      );
                      const batch =
                        !updated[i].batch_number && formatted
                          ? autoBatchFromExpiry(formatted)
                          : updated[i].batch_number;
                      updated[i] = {
                        ...updated[i],
                        expiry_date: formatted,
                        batch_number: batch,
                      };
                      setItems(updated);
                    }}
                    placeholder="ДД.ММ.ГГГГ"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numeric"
                    style={s.input}
                  />
                </View>

                {/* Batch number */}
                <View>
                  <Text style={s.fieldLabel}>ПАРТИДА</Text>
                  <TextInput
                    value={item.batch_number}
                    onChangeText={(v) => {
                      const updated = [...items];
                      updated[i] = { ...updated[i], batch_number: v };
                      setItems(updated);
                    }}
                    placeholder="авто от датата на годност"
                    placeholderTextColor={colors.textMuted}
                    style={s.input}
                  />
                </View>
              </View>
            ))}
            <View style={{ height: 24 }} />
          </ScrollView>
        </KeyboardAvoidingView>

        <View
          style={[
            s.footer,
            { paddingBottom: Math.max(insets.bottom, 16) + 70 },
          ]}
        >
          <TouchableOpacity
            onPress={saveBatches}
            disabled={savingBatches}
            style={[s.successBtn, savingBatches && s.btnDisabled]}
            activeOpacity={0.8}
          >
            {savingBatches ? (
              <ActivityIndicator color="white" />
            ) : (
              <View style={s.btnRow}>
                <Ionicons name="checkmark-circle" size={20} color="#ffffff" />
                <Text style={s.accentBtnText}>Запази датите</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 5: Done
  // ═══════════════════════════════════════════════════════════════════════════

  if (phase === "done") {
    return (
      <SafeAreaView style={s.container} edges={["top", "bottom"]}>
        <View style={s.doneBody}>
          <View style={s.doneIconWrap}>
            <Ionicons
              name="checkmark-circle"
              size={72}
              color={colors.success}
            />
          </View>
          <Text style={s.doneTitle}>Доставката е записана!</Text>
          <Text style={s.doneSub}>
            {scanned?.supplier_name
              ? `Фактура от ${scanned.supplier_name}`
              : "Фактурата е обработена успешно"}
          </Text>

          <View style={s.doneActions}>
            <TouchableOpacity
              onPress={resetAll}
              style={s.accentBtn}
              activeOpacity={0.8}
            >
              <View style={s.btnRow}>
                <Ionicons name="scan-outline" size={20} color="#ffffff" />
                <Text style={s.accentBtnText}>Сканирай друга фактура</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => navigation.goBack()}
              style={s.ghostBtn}
              activeOpacity={0.8}
            >
              <Text style={s.ghostBtnText}>Готово</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Fallback (shouldn't reach here)
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// STYLES
// ═════════════════════════════════════════════════════════════════════════════

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex1: {
    flex: 1,
  },
  scrollPad: {
    paddingHorizontal: 16,
  },

  // ── Header ─────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    alignItems: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
  },
  navHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  navHeaderTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  backBtnText: {
    color: colors.accentAlt,
    fontSize: 15,
    fontWeight: "500",
    marginLeft: 2,
  },

  // ── Phase 1: Camera ───────────────────────────────────────────────────
  cameraBody: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
  },
  primaryBtnTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 12,
  },
  primaryBtnSub: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    marginTop: 4,
  },
  secondaryBtn: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  secondaryBtnTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 12,
  },
  secondaryBtnSub: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
  },

  // ── Loading ────────────────────────────────────────────────────────────
  loadingBody: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  loadingTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 20,
  },
  loadingStage: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 6,
  },
  loadingSub: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 8,
  },
  progressContainer: {
    width: "80%",
    marginTop: 20,
  },
  progressTrack: {
    height: 8,
    backgroundColor: "#1e1e2e",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: 8,
    backgroundColor: "#6366f1",
    borderRadius: 4,
  },
  loadingTime: {
    color: colors.textMuted ?? colors.textSecondary,
    fontSize: 12,
    marginTop: 10,
  },

  // ── Cards ──────────────────────────────────────────────────────────────
  card: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  supplierName: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 16,
  },
  detail: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },

  // ── Items ──────────────────────────────────────────────────────────────
  itemCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemCardConfirmed: {
    borderColor: "#22c55e",
  },
  itemCardNameMatch: {
    borderColor: "#3b82f6",
  },
  itemCardSuggested: {
    borderColor: "#eab308",
  },
  itemCardNew: {
    borderColor: "#f97316",
  },
  matchBadgeGreen: {
    color: "#22c55e",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
  },
  matchBadgeBlue: {
    color: "#3b82f6",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
  },
  matchBadgeYellow: {
    color: "#eab308",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
  },
  matchBadgeOrange: {
    color: "#f97316",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 6,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  itemRight: {
    alignItems: "flex-end",
    marginLeft: 8,
  },
  itemName: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 15,
    lineHeight: 21,
  },
  itemCardEyebrow: {
    color: "#c6ae72",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  itemSubname: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
  },
  itemInvoiceCode: {
    color: colors.accentAlt,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 6,
  },
  itemCardHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 14,
  },
  itemHeaderRightColumn: {
    alignItems: "flex-end",
    gap: 6,
  },
  itemQty: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  itemLineTotal: {
    color: "#f4f7ff",
    fontSize: 13,
    fontWeight: "700",
  },
  itemStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  itemStatusPillText: {
    color: colors.textLight,
    fontSize: 11,
    fontWeight: "700",
  },
  itemStatusConfirmed: {
    borderColor: "rgba(123,240,191,0.35)",
    backgroundColor: "rgba(34,197,94,0.16)",
  },
  itemStatusInfo: {
    borderColor: "rgba(129,140,248,0.32)",
    backgroundColor: "rgba(99,102,241,0.14)",
  },
  itemStatusWarning: {
    borderColor: "rgba(244,213,141,0.3)",
    backgroundColor: "rgba(251,191,36,0.14)",
  },
  itemStatusNew: {
    borderColor: "rgba(249,115,22,0.3)",
    backgroundColor: "rgba(249,115,22,0.12)",
  },
  matchedProductCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    marginBottom: 12,
  },
  matchedProductLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  matchedProductName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  matchedProductMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 3,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  priceLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    marginRight: 8,
  },
  priceCompareRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    paddingTop: 4,
    flexWrap: "wrap",
  },
  priceCompareLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    marginRight: 4,
  },
  priceCompareValue: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "600",
    marginRight: 4,
  },
  priceCompareSep: {
    color: colors.textSecondary,
    fontSize: 11,
    marginHorizontal: 6,
  },
  priceCompareOk: {
    color: "#22c55e",
    fontSize: 11,
    fontWeight: "700",
  },
  priceCompareDiff: {
    color: "#f97316",
    fontSize: 11,
    fontWeight: "700",
  },
  priceInput: {
    backgroundColor: colors.background,
    color: colors.accentAlt,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 14,
    fontWeight: "700",
    width: 80,
    textAlign: "right",
  },
  priceCurrency: {
    color: colors.textSecondary,
    fontSize: 12,
    marginLeft: 4,
  },
  lineTotal: {
    color: "#7bf0bf",
    fontSize: 13,
    fontWeight: "700",
  },
  priceSummaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 2,
  },
  priceSummaryCard: {
    minWidth: "30%",
    flexGrow: 1,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  priceSummaryLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  priceSummaryValue: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  discountSummaryRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  discountSummaryText: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  discountSummaryWarning: {
    fontSize: 12,
    color: colors.warning,
    fontWeight: "700",
  },
  discountSummaryDivider: {
    fontSize: 12,
    color: colors.textMuted,
  },
  batchFollowUpNote: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: "rgba(244,213,141,0.08)",
    borderWidth: 1,
    borderColor: "rgba(244,213,141,0.16)",
  },
  batchFollowUpText: {
    flex: 1,
    color: "#f2e3ba",
    fontSize: 12,
    lineHeight: 18,
  },
  reviewHeroCard: {
    borderRadius: 28,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 14,
  },
  reviewHeroHeader: {
    gap: 14,
  },
  reviewHeroCopy: {
    gap: 8,
  },
  reviewHeroEyebrow: {
    color: "#d6bc7a",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  reviewHeroTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 30,
  },
  reviewHeroText: {
    color: "rgba(233,238,255,0.8)",
    fontSize: 14,
    lineHeight: 21,
  },
  reviewHeroStatusPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  reviewHeroStatusText: {
    color: colors.textLight,
    fontSize: 12,
    fontWeight: "700",
  },
  reviewHeroMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 18,
  },
  reviewHeroMetaCard: {
    minWidth: "30%",
    flexGrow: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  reviewHeroMetaLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  reviewHeroMetaValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  reviewHeroMetaHint: {
    color: "rgba(233,238,255,0.65)",
    fontSize: 11,
    marginTop: 4,
  },
  reviewSummaryCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  reviewSummaryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 8,
  },
  reviewSummaryLabel: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  reviewSummaryBadge: {
    color: "#e7d7ab",
    fontSize: 11,
    fontWeight: "700",
  },
  reviewSummaryTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 6,
  },
  reviewSummaryText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },
  sectionHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  sectionHeadingTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  sectionHeadingCount: {
    color: "#d6bc7a",
    fontSize: 14,
    fontWeight: "700",
  },

  // ── Phase 3: Post-save ────────────────────────────────────────────────
  reviewNextStepCard: {
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewNextStepLabel: {
    color: colors.accentAlt,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  reviewNextStepTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6,
  },
  reviewNextStepText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  postSaveScroll: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    gap: 16,
  },
  postSaveHero: {
    alignItems: "center",
    paddingTop: 8,
  },
  postSaveHeroCard: {
    borderRadius: 28,
    padding: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: 4,
  },
  postSaveHeroIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(123,240,191,0.12)",
    borderWidth: 1,
    borderColor: "rgba(123,240,191,0.16)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  postSaveHeroEyebrow: {
    color: "#9fe8c7",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  postSaveHeroTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    lineHeight: 30,
    marginBottom: 8,
  },
  postSaveHeroText: {
    color: "rgba(233,238,255,0.78)",
    fontSize: 14,
    lineHeight: 21,
  },
  postSaveStatusCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  postSaveStatusLabel: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  postSaveStatusTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  postSaveStatusText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  postSaveNextActionCard: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: 6,
  },
  postSaveNextActionLabel: {
    color: colors.accentAlt,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  postSaveNextActionTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  postSaveNextActionText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  postSaveStepList: {
    marginTop: 8,
    gap: 6,
  },
  postSaveStepItem: {
    color: "rgba(233,238,255,0.78)",
    fontSize: 13,
    lineHeight: 18,
  },
  askOptions: {
    gap: 12,
  },
  optionCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  optionCardPrimary: {
    backgroundColor: colors.accent,
    borderRadius: 18,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  optionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  optionTitleOnAccent: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
  optionSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  optionSubOnAccent: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 12,
    marginTop: 2,
  },
  companionLoading: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 12,
  },

  // ── Phase 4: Manual ───────────────────────────────────────────────────
  manualIntroCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 22,
    padding: 18,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: colors.border,
  },
  manualIntroEyebrow: {
    color: "#d6bc7a",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  manualIntroTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 6,
  },
  manualHint: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  autoGenerateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#22c55e",
    borderRadius: 16,
    paddingVertical: 13,
    marginBottom: 16,
    gap: 8,
  },
  autoGenerateBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 14,
  },
  manualItemCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  manualMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  manualMetaPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  manualMetaPillText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
  },
  manualCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  manualQty: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    marginLeft: 8,
  },
  fieldGroup: {
    marginBottom: 12,
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.background,
    color: colors.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: 14,
  },

  // ── Phase 5: Done ─────────────────────────────────────────────────────
  doneBody: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  doneIconWrap: {
    marginBottom: 20,
  },
  doneTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  doneSub: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 32,
  },
  doneActions: {
    width: "100%",
    gap: 12,
  },

  // ── Buttons ────────────────────────────────────────────────────────────
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border || "rgba(255,255,255,0.08)",
  },
  accentBtn: {
    backgroundColor: colors.accent,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  accentBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 16,
  },
  successBtn: {
    backgroundColor: colors.success,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  ghostBtn: {
    backgroundColor: "transparent",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostBtnText: {
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 15,
  },
  btnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btnDisabled: {
    opacity: 0.6,
  },

  // ── Product Picker Modal ──────────────────────────────────────────────
  pickerContainer: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  pickerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  pickerCloseBtn: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 8,
    padding: 8,
  },
  pickerSearchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceElevated,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickerSearchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 12,
  },
  pickerSuggestion: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    backgroundColor: colors.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#c29b57",
  },
  pickerSuggestionLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 4,
  },
  pickerSuggestionText: {
    color: "#c29b57",
    fontSize: 13,
    fontWeight: "600",
  },
  pickerEmpty: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: "center",
    marginTop: 32,
  },
  pickerProductCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickerProductSelected: {
    borderColor: "#c29b57",
    borderWidth: 2,
  },
  pickerProductName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  pickerProductMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  pickerProductPrice: {
    color: colors.textLight,
    fontSize: 14,
    fontWeight: "600",
    marginLeft: 8,
  },
  pickerFooter: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  // ── Duplicate Modal Styles ──────────────────────────────────
  dupOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  dupCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: 24,
    padding: 28,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.warningLight,
    shadowColor: colors.warning,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 20,
  },
  dupIconContainer: {
    marginBottom: 16,
  },
  dupIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.warningLight,
    justifyContent: "center",
    alignItems: "center",
  },
  dupTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 20,
    letterSpacing: 0.3,
  },
  dupInfoCard: {
    width: "100%",
    backgroundColor: colors.surfaceElevated,
    borderRadius: 14,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  dupInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dupInfoLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    flex: 0,
  },
  dupInfoValue: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    flex: 1,
    textAlign: "right",
  },
  dupQuestion: {
    fontSize: 15,
    color: colors.textSecondary,
    marginBottom: 24,
    textAlign: "center",
  },
  dupButtons: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  dupBtnCancel: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dupBtnCancelText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  dupBtnContinue: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: colors.warning,
    shadowColor: colors.warning,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  dupBtnContinueText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#000",
  },
});
