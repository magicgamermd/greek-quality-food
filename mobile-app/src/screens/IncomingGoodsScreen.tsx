import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { apiClient } from "../api/client";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useIncomingGoodsByDate,
  useSuppliers,
  useProducts,
  useCreateIncomingGoods,
  useConfirmIncomingGoods,
  useIncomingGoodsById,
} from "../hooks/useQueries";
import { Card } from "../components/Card";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { ErrorView } from "../components/ErrorView";
import { useAuth } from "../hooks/useAuth";
import {
  formatDate,
  formatCurrency,
  formatUnit,
  formatQuantity,
} from "../utils/format";
import { colors } from "../theme/colors";
import type {
  IncomingGoods,
  CreateIncomingGoodsRequest,
  Product,
} from "../types";

// ─── Helper: Get today's date in YYYY-MM-DD ────────────────────────────────────
function getTodayString(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const statusMap: Record<string, { bg: string; text: string; label: string }> =
    {
      draft: { bg: "#f59e0b", text: "#fff", label: "Чернова" },
      pending: { bg: "#f59e0b", text: "#fff", label: "Очаква" },
      received: { bg: "#3b82f6", text: "#fff", label: "Получена" },
      confirmed: { bg: "#10b981", text: "#fff", label: "Потвърдена" },
      cancelled: { bg: "#ef4444", text: "#fff", label: "Отказана" },
    };

  const s = statusMap[status] || statusMap.pending;

  return (
    <View
      className="px-2 py-1 rounded-full"
      style={{ backgroundColor: s.bg + "20" }}
    >
      <Text className="text-xs font-semibold" style={{ color: s.bg }}>
        {s.label}
      </Text>
    </View>
  );
}

// ─── Helper: Auto-format date input as DD.MM.YYYY ────────────────────────────
function autoFormatDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

// ─── Helper: Convert DD.MM.YYYY → YYYY-MM-DD ─────────────────────────────────
function ddmmyyyyToIso(val: string): string | null {
  const m = val.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ─── Helper: Convert YYYY-MM-DD → DD.MM.YYYY ─────────────────────────────────
function isoToDdmmyyyy(val: string): string {
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return val;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function DetailModal({
  incomingId,
  onClose,
}: {
  incomingId: number | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useIncomingGoodsById(incomingId);
  const { mutate: confirmMutate, isPending: isConfirming } =
    useConfirmIncomingGoods();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Inline edit state
  const [editingItemIdx, setEditingItemIdx] = useState<number | null>(null);
  const [editBatchNumber, setEditBatchNumber] = useState("");
  const [editExpiryDate, setEditExpiryDate] = useState("");
  const [isSavingBatch, setIsSavingBatch] = useState(false);

  const startEditing = useCallback(
    (idx: number, item: any) => {
      if (editingItemIdx === idx) {
        setEditingItemIdx(null);
        return;
      }
      setEditingItemIdx(idx);
      setEditBatchNumber(item.batch_number || "");
      setEditExpiryDate(
        item.expiry_date ? isoToDdmmyyyy(item.expiry_date) : "",
      );
    },
    [editingItemIdx],
  );

  const handleSaveBatch = useCallback(
    async (item: any) => {
      if (!incomingId) return;

      const isoDate = editExpiryDate ? ddmmyyyyToIso(editExpiryDate) : null;
      if (editExpiryDate && !isoDate) {
        Alert.alert(
          "Грешка",
          "Невалиден формат на дата. Използвайте ДД.ММ.ГГГГ",
        );
        return;
      }

      setIsSavingBatch(true);
      try {
        await apiClient.patch(`/incoming/${incomingId}/batches`, {
          items: [
            {
              product_id: item.product_id || item.product?.id,
              batch_number: editBatchNumber || undefined,
              expiry_date: isoDate || undefined,
            },
          ],
        });
        queryClient.invalidateQueries({ queryKey: ["incoming-goods"] });
        Alert.alert("Запазено!");
        setEditingItemIdx(null);
      } catch (err: any) {
        Alert.alert(
          "Грешка",
          err?.response?.data?.message || "Неуспешно запазване",
        );
      } finally {
        setIsSavingBatch(false);
      }
    },
    [incomingId, editBatchNumber, editExpiryDate, queryClient],
  );

  const handleConfirm = () => {
    if (!incomingId) return;
    Alert.alert(
      "Потвърждение",
      "Сигурни ли сте, че желаете да потвърдите тази доставка?",
      [
        { text: "Отказ", style: "cancel" },
        {
          text: "Потвърди",
          onPress: () => {
            confirmMutate(incomingId, {
              onSuccess: () => {
                Alert.alert("Успешно", "Доставката е потвърдена");
                onClose();
              },
              onError: (err) => {
                Alert.alert("Грешка", "Неуспешно потвърждение на доставката");
              },
            });
          },
        },
      ],
    );
  };

  return (
    <Modal
      visible={incomingId !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-[#0a0a14]">
        {/* Header */}
        <View className="flex-row justify-between items-center px-4 py-5 border-b border-[#252540]">
          <Text className="text-white text-lg font-bold">
            Детайли на доставката
          </Text>
          <TouchableOpacity
            onPress={onClose}
            className="bg-[#1a1a2e] rounded-lg px-3 py-2 border border-[#252540] min-h-[44px] justify-center"
            activeOpacity={0.7}
          >
            <Text className="text-slate-400 text-xs font-semibold">
              Затвори
            </Text>
          </TouchableOpacity>
        </View>

        {isLoading && <LoadingSpinner message="Зареждане..." />}
        {isError && <ErrorView message="Неуспешно зареждане на доставката" />}
        {data && (
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            {/* Header Info */}
            <Card>
              <View className="flex-row justify-between items-start mb-3">
                <View>
                  <Text className="text-slate-400 text-xs">
                    Фактура #{data.invoice_number}
                  </Text>
                  <Text className="text-white text-base font-bold mt-1">
                    {data.supplier_name || data.supplier?.name || "Доставчик"}
                  </Text>
                </View>
                <StatusBadge status={data.status} />
              </View>

              <View className="flex-row justify-between mt-2">
                <View>
                  <Text className="text-slate-400 text-xs">
                    Дата на фактура
                  </Text>
                  <Text className="text-white text-sm mt-1">
                    {formatDate(data.invoice_date)}
                  </Text>
                </View>
                <View>
                  <Text className="text-slate-400 text-xs">Статус</Text>
                  <View className="mt-1">
                    <StatusBadge status={data.status} />
                  </View>
                </View>
              </View>
            </Card>

            {/* Items */}
            <Text className="text-white text-base font-bold mt-6 mb-3">
              Стоки
            </Text>

            {(data.items || []).map((item, idx) => {
              const name =
                item.name_bg ||
                item.name_en ||
                item.product?.name_bg ||
                "Продукт";
              const sku = item.sku || item.product?.sku || "—";
              const unit = formatUnit(item.unit || item.product?.unit);
              const cur = data.currency || "EUR";
              const totalPrice =
                item.total_price ??
                (typeof item.quantity === "number" &&
                typeof item.unit_price === "number"
                  ? item.quantity * item.unit_price
                  : 0);

              // Expiry date warning logic
              let expiryColor = "#94a3b8"; // slate-400
              if (item.expiry_date) {
                const expDate = new Date(item.expiry_date);
                const now = new Date();
                const daysUntilExpiry = Math.ceil(
                  (expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
                );
                if (daysUntilExpiry < 0)
                  expiryColor = "#ef4444"; // red
                else if (daysUntilExpiry <= 30) expiryColor = "#f59e0b"; // orange/amber
              }

              const isEditing = editingItemIdx === idx;

              return (
                <TouchableOpacity
                  key={item.id ?? idx}
                  onPress={() => startEditing(idx, item)}
                  activeOpacity={0.7}
                >
                  <Card className="mb-2">
                    {/* Row 1: Name + Quantity */}
                    <View className="flex-row items-start justify-between">
                      <View className="flex-1 mr-2">
                        <Text
                          className="text-white font-semibold text-sm"
                          numberOfLines={1}
                          ellipsizeMode="tail"
                        >
                          {name}
                        </Text>
                      </View>
                      <View className="flex-row items-center">
                        <Text className="text-indigo-400 font-bold text-sm">
                          {formatQuantity(item.quantity)} {unit}
                        </Text>
                        {item.expiry_date ? (
                          <Text className="text-slate-500 text-xs ml-2">
                            ✏️
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    {/* Row 2: SKU + Unit price */}
                    <View className="flex-row items-center justify-between mt-1">
                      <Text className="text-slate-400 text-xs">SKU: {sku}</Text>
                      <Text className="text-slate-400 text-xs">
                        {formatCurrency(item.unit_price, cur)} / {unit}
                      </Text>
                    </View>

                    {/* Row 3: Batch + Expiry (conditional) */}
                    {(item.batch_number || item.expiry_date) && (
                      <View className="flex-row items-center justify-between mt-2">
                        {item.batch_number ? (
                          <View className="bg-[#252540] rounded-full px-2 py-0.5">
                            <Text className="text-slate-400 text-xs">
                              Партида:{" "}
                              <Text className="text-white">
                                {item.batch_number}
                              </Text>
                            </Text>
                          </View>
                        ) : (
                          <View />
                        )}
                        {item.expiry_date ? (
                          <View
                            className="rounded-full px-2 py-0.5"
                            style={{ backgroundColor: expiryColor + "18" }}
                          >
                            <Text
                              className="text-xs"
                              style={{ color: expiryColor }}
                            >
                              Годност: {formatDate(item.expiry_date)}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    )}

                    {/* Missing expiry hint */}
                    {!item.expiry_date && (
                      <View className="mt-2">
                        <Text className="text-xs" style={{ color: "#f59e0b" }}>
                          ➕ Добави годност
                        </Text>
                      </View>
                    )}

                    {/* Discount (conditional) */}
                    {item.discount_percent || item.discount_amount ? (
                      <View className="mt-1">
                        <Text className="text-amber-400 text-xs">
                          Отстъпка:{" "}
                          {item.discount_percent
                            ? `${item.discount_percent}%`
                            : formatCurrency(item.discount_amount, cur)}
                        </Text>
                      </View>
                    ) : null}

                    {/* Row 4: Total price */}
                    <View className="flex-row justify-end mt-2 pt-2 border-t border-[#252540]">
                      <Text className="text-emerald-400 font-bold text-sm">
                        Общо: {formatCurrency(totalPrice, cur)}
                      </Text>
                    </View>

                    {/* Inline Edit Form */}
                    {isEditing && (
                      <View
                        className="mt-3 pt-3 border-t border-[#252540] rounded-lg p-3"
                        style={{ backgroundColor: "#1a1a2e" }}
                      >
                        {/* Batch Number */}
                        <Text className="text-slate-400 text-xs font-semibold mb-1">
                          Партида
                        </Text>
                        <TextInput
                          value={editBatchNumber}
                          onChangeText={setEditBatchNumber}
                          placeholder="Номер на партида"
                          placeholderTextColor="#475569"
                          className="bg-[#252540] rounded-lg px-3 py-2 text-white border border-[#2d2d4e] mb-3"
                        />

                        {/* Expiry Date */}
                        <Text className="text-slate-400 text-xs font-semibold mb-1">
                          Срок на годност
                        </Text>
                        <TextInput
                          value={editExpiryDate}
                          onChangeText={(val) =>
                            setEditExpiryDate(autoFormatDateInput(val))
                          }
                          placeholder="ДД.ММ.ГГГГ"
                          placeholderTextColor="#475569"
                          keyboardType="number-pad"
                          maxLength={10}
                          className="bg-[#252540] rounded-lg px-3 py-2 text-white border border-[#2d2d4e] mb-3"
                        />

                        {/* Action Buttons */}
                        <View className="flex-row justify-end gap-2">
                          <TouchableOpacity
                            onPress={() => setEditingItemIdx(null)}
                            className="bg-[#252540] rounded-lg px-4 py-2 border border-[#2d2d4e]"
                            activeOpacity={0.7}
                          >
                            <Text className="text-slate-400 text-xs font-semibold">
                              Отказ
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleSaveBatch(item)}
                            disabled={isSavingBatch}
                            className={`bg-indigo-500 rounded-lg px-4 py-2 ${isSavingBatch ? "opacity-60" : ""}`}
                            activeOpacity={0.7}
                          >
                            {isSavingBatch ? (
                              <ActivityIndicator color="#fff" size="small" />
                            ) : (
                              <Text className="text-white text-xs font-semibold">
                                Запази
                              </Text>
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </Card>
                </TouchableOpacity>
              );
            })}

            {/* Delivery Total */}
            {(data.items || []).length > 0 && (
              <Card className="mt-2 mb-4">
                <View className="flex-row justify-between items-center">
                  <Text className="text-white font-bold text-sm">
                    Обща стойност
                  </Text>
                  <Text className="text-emerald-400 font-bold text-base">
                    {formatCurrency(
                      (data.items || []).reduce((sum, item) => {
                        const t =
                          item.total_price ??
                          (typeof item.quantity === "number" &&
                          typeof item.unit_price === "number"
                            ? item.quantity * item.unit_price
                            : 0);
                        return (
                          sum + (typeof t === "number" ? t : parseFloat(t) || 0)
                        );
                      }, 0),
                      data.currency || "EUR",
                    )}
                  </Text>
                </View>
              </Card>
            )}

            {/* Confirm Button */}
            {data.status === "pending" &&
              (user?.role === "admin" || user?.role === "warehouse") && (
                <TouchableOpacity
                  onPress={handleConfirm}
                  disabled={isConfirming}
                  className={`bg-emerald-500 rounded-xl py-4 items-center mt-6 ${isConfirming ? "opacity-60" : ""}`}
                  activeOpacity={0.7}
                >
                  {isConfirming ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text className="text-white text-base font-bold">
                      ✓ Потвърди доставката
                    </Text>
                  )}
                </TouchableOpacity>
              )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

// ─── Create/Edit Modal ─────────────────────────────────────────────────────────
type DeliveryItem = {
  product_id?: number | null;
  product_name?: string; // used for scanned / new products
  name_bg?: string;
  product_code?: string | null;
  matched_product_id?: number | null;
  matched_product_name?: string | null;
  matched_product_sku?: string | null;
  match_confidence?: number | null;
  match_source?: string | null;
  quantity: number;
  unit_price: number;
  batch_number?: string;
  expiry_date?: string;
  unit?: string;
};

function isMatchedForAutoLink(item: DeliveryItem): boolean {
  if (item.matched_product_id == null) return false;
  if (item.match_source === "alias" || item.match_source === "sku") return true;
  return (item.match_confidence ?? 0) >= 0.75;
}

function CreateModal({ onClose }: { onClose: () => void }) {
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [supplierName, setSupplierName] = useState<string>("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState<string>(getTodayString());
  const [items, setItems] = useState<DeliveryItem[]>([
    { product_id: null, quantity: 1, unit_price: 0 },
  ]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");

  const { data: suppliers, isLoading: suppliersLoading } = useSuppliers();
  const { data: products, isLoading: productsLoading } = useProducts();
  const { mutate: createMutate, isPending: isCreating } =
    useCreateIncomingGoods();
  const { user } = useAuth();

  const canEdit = user?.role === "admin" || user?.role === "warehouse";
  if (!canEdit) {
    return null;
  }

  const handleScanInvoice = async () => {
    setScanError("");
    // Ask user: camera or gallery
    Alert.alert("Скенирай фактура", "Изберете начин на въвеждане:", [
      {
        text: "📷 Камера",
        onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== "granted") {
            Alert.alert("Грешка", "Необходимо е разрешение за камера");
            return;
          }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: "images",
            quality: 0.8,
          });
          if (!result.canceled && result.assets[0]) {
            await uploadForScan(result.assets[0]);
          }
        },
      },
      {
        text: "🖼 Галерия / PDF",
        onPress: async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: "images",
            quality: 0.9,
          });
          if (!result.canceled && result.assets[0]) {
            await uploadForScan(result.assets[0]);
          }
        },
      },
      { text: "Отказ", style: "cancel" },
    ]);
  };

  const uploadForScan = async (asset: ImagePicker.ImagePickerAsset) => {
    setScanning(true);
    try {
      const formData = new FormData();
      const ext = asset.uri.split(".").pop()?.toLowerCase() || "jpg";
      const mimeMap: Record<string, string> = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        pdf: "application/pdf",
        heic: "image/heic",
        heif: "image/heif",
      };
      formData.append("file", {
        uri: asset.uri,
        type: asset.mimeType || mimeMap[ext] || "image/jpeg",
        name: `invoice.${ext === "heic" || ext === "heif" ? "jpg" : ext}`,
      } as any);

      const res = await apiClient.post("/incoming/scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      const d = res.data ?? {};

      // Pre-fill form from scan result
      if (d.invoice_number) setInvoiceNumber(d.invoice_number);
      if (d.invoice_date) setInvoiceDate(d.invoice_date.split("T")[0]);
      if (d.supplier_name) setSupplierName(d.supplier_name);

      // Try to find supplier by name
      if (d.supplier_eik) {
        const found = (suppliers || []).find((s) => s.eik === d.supplier_eik);
        if (found) setSupplierId(found.id);
      }

      // Build items from scanned line items
      const scannedItems = (d.items || d.line_items || []).map((li: any) => ({
        product_name: li.product_name || li.name_en || li.name || "",
        name_bg: li.name_bg || li.name || "",
        product_code: li.product_code ?? null,
        matched_product_id: li.matched_product_id ?? null,
        matched_product_name: li.matched_product_name ?? null,
        matched_product_sku: li.matched_product_sku ?? null,
        match_confidence:
          li.match_confidence != null ? Number(li.match_confidence) : null,
        match_source: li.match_source ?? null,
        quantity: li.quantity ?? li.quantity ?? 1,
        unit_price: li.unit_price ?? li.price ?? 0,
        unit: li.unit || "кг",
        batch_number: li.batch_number || li.batch || "",
        expiry_date: li.expiry_date || li.expiry || "",
      }));

      if (scannedItems.length > 0) {
        setItems(scannedItems);
        Alert.alert(
          "✅ Сканирано успешно",
          `Намерени ${scannedItems.length} продукта. Прегледай и потвърди.`,
        );
      } else {
        setScanError("AI не откри продукти в документа");
      }
    } catch (err) {
      setScanError("Грешка при сканиране. Провери връзката с сървъра.");
    } finally {
      setScanning(false);
    }
  };

  const handleAddItem = () => {
    setItems([...items, { product_id: null, quantity: 1, unit_price: 0 }]);
  };

  const handleRemoveItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const handleUpdateItem = (idx: number, field: string, value: any) => {
    const newItems = [...items];
    newItems[idx] = { ...newItems[idx], [field]: value };
    setItems(newItems);
  };

  const isScannedMode = items.some((i) => i.product_name && !i.product_id);

  const handleSave = () => {
    if (!supplierId && !supplierName) {
      Alert.alert("Грешка", "Моля, изберете или въведете доставчик");
      return;
    }
    if (!invoiceNumber.trim()) {
      Alert.alert("Грешка", "Моля, въведете номер на фактура");
      return;
    }
    if (!invoiceDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
      Alert.alert("Грешка", "Моля, въведете дата в формат YYYY-MM-DD");
      return;
    }
    if (
      !isScannedMode &&
      items.some((item) => !item.product_id || item.quantity <= 0)
    ) {
      Alert.alert(
        "Грешка",
        "Всички стоки трябва да имат избран продукт и количество",
      );
      return;
    }

    const request: any = {
      supplier_id: supplierId || undefined,
      supplier_name: supplierName || undefined,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      document_type: "invoice",
      items: items.map((item) => {
        const matched = isMatchedForAutoLink(item);
        return {
          product_id:
            (matched ? item.matched_product_id : item.product_id) || undefined,
          product_name: item.product_name || undefined,
          name_bg: item.name_bg || undefined,
          product_code: item.product_code || undefined,
          quantity: item.quantity,
          unit_price: item.unit_price,
          unit: item.unit || undefined,
          batch_number: item.batch_number || undefined,
          expiry_date: item.expiry_date || undefined,
        };
      }),
    };

    createMutate(request, {
      onSuccess: () => {
        Alert.alert("Успешно", "Доставката е създадена");
        onClose();
      },
      onError: (err) => {
        Alert.alert("Грешка", "Неуспешно създаване на доставката");
      },
    });
  };

  return (
    <Modal visible={true} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-[#0a0a14]">
        {/* Header */}
        <View className="flex-row justify-between items-center px-4 py-5 border-b border-[#252540]">
          <Text className="text-white text-lg font-bold">Нова доставка</Text>
          <TouchableOpacity
            onPress={onClose}
            className="bg-[#1a1a2e] rounded-lg px-3 py-2 border border-[#252540] min-h-[44px] justify-center"
            activeOpacity={0.7}
          >
            <Text className="text-slate-400 text-xs font-semibold">
              Затвори
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {/* Scan Invoice Button */}
          <TouchableOpacity
            onPress={handleScanInvoice}
            disabled={scanning}
            className="bg-indigo-600 rounded-xl p-4 mb-5 flex-row items-center justify-center gap-3"
            activeOpacity={0.8}
          >
            {scanning ? (
              <ActivityIndicator color="white" size="small" />
            ) : (
              <Text className="text-2xl">📷</Text>
            )}
            <Text className="text-white font-bold text-base">
              {scanning ? "Сканиране..." : "Скенирай фактура с камера"}
            </Text>
          </TouchableOpacity>
          {scanError ? (
            <Text className="text-red-400 text-sm mb-3 text-center">
              {scanError}
            </Text>
          ) : null}
          {isScannedMode && (
            <View className="bg-green-900/30 border border-green-700 rounded-xl p-3 mb-4">
              <Text className="text-green-400 text-sm font-semibold">
                ✅ Фактурата е сканирана — {items.length} продукта
              </Text>
              <Text className="text-green-300/70 text-xs mt-1">
                Провери данните и натисни "Запази"
              </Text>
            </View>
          )}

          {/* Supplier Selection */}
          <Text className="text-white text-sm font-bold mb-2">Доставчик</Text>
          {suppliersLoading ? (
            <ActivityIndicator color="#6366f1" />
          ) : (
            <View className="bg-[#1a1a2e] rounded-xl border border-[#252540] mb-4">
              {(suppliers || []).map((sup, idx) => (
                <TouchableOpacity
                  key={sup.id}
                  onPress={() => setSupplierId(sup.id)}
                  className={`py-3 px-4 border-b border-[#252540] ${
                    supplierId === sup.id ? "bg-indigo-500 bg-opacity-10" : ""
                  }`}
                  activeOpacity={0.7}
                >
                  <Text
                    className={`text-sm font-${supplierId === sup.id ? "semibold" : "normal"} ${
                      supplierId === sup.id ? "text-indigo-400" : "text-white"
                    }`}
                  >
                    {sup.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Invoice Number */}
          <Text className="text-white text-sm font-bold mb-2">
            Номер на фактура
          </Text>
          <TextInput
            value={invoiceNumber}
            onChangeText={setInvoiceNumber}
            placeholder="Въведете номер на фактура"
            placeholderTextColor="#475569"
            className="bg-[#1a1a2e] rounded-xl px-4 py-3 text-white border border-[#252540] mb-4"
          />

          {/* Invoice Date */}
          <Text className="text-white text-sm font-bold mb-2">
            Дата на фактура (YYYY-MM-DD)
          </Text>
          <TextInput
            value={invoiceDate}
            onChangeText={setInvoiceDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#475569"
            className="bg-[#1a1a2e] rounded-xl px-4 py-3 text-white border border-[#252540] mb-4"
          />

          {/* Items */}
          <Text className="text-white text-sm font-bold mb-3">Стоки</Text>
          {items.map((item, idx) => (
            <Card key={idx} className="mb-3">
              <View className="flex-row justify-between items-center mb-3">
                <Text className="text-white font-semibold">
                  Стока #{idx + 1}
                </Text>
                {items.length > 1 && (
                  <TouchableOpacity
                    onPress={() => handleRemoveItem(idx)}
                    className="bg-red-500 bg-opacity-20 px-2 py-1 rounded-lg"
                    activeOpacity={0.7}
                  >
                    <Text className="text-red-400 text-xs font-semibold">
                      Премахни
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {/* Product Selection */}
              <Text className="text-slate-400 text-xs font-semibold mb-1">
                Продукт
              </Text>
              {productsLoading ? (
                <ActivityIndicator color="#6366f1" />
              ) : (
                <View className="bg-[#252540] rounded-lg border border-[#2d2d4e] mb-3 max-h-40">
                  {(products || []).slice(0, 5).map((prod) => (
                    <TouchableOpacity
                      key={prod.id}
                      onPress={() =>
                        handleUpdateItem(idx, "product_id", prod.id)
                      }
                      className={`py-2 px-3 border-b border-[#2d2d4e] ${
                        item.product_id === prod.id
                          ? "bg-indigo-500 bg-opacity-10"
                          : ""
                      }`}
                      activeOpacity={0.7}
                    >
                      <Text
                        className={`text-xs font-${
                          item.product_id === prod.id ? "semibold" : "normal"
                        } ${
                          item.product_id === prod.id
                            ? "text-indigo-400"
                            : "text-white"
                        }`}
                        numberOfLines={1}
                      >
                        {prod.name_bg}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Quantity */}
              <Text className="text-slate-400 text-xs font-semibold mb-1">
                Количество
              </Text>
              <TextInput
                value={String(item.quantity)}
                onChangeText={(val) =>
                  handleUpdateItem(idx, "quantity", parseInt(val) || 0)
                }
                placeholder="Количество"
                placeholderTextColor="#475569"
                keyboardType="number-pad"
                className="bg-[#252540] rounded-lg px-3 py-2 text-white border border-[#2d2d4e] mb-3"
              />

              {/* Unit Price */}
              <Text className="text-slate-400 text-xs font-semibold mb-1">
                Единична цена (лв.)
              </Text>
              <TextInput
                value={String(item.unit_price)}
                onChangeText={(val) =>
                  handleUpdateItem(idx, "unit_price", parseFloat(val) || 0)
                }
                placeholder="Цена"
                placeholderTextColor="#475569"
                keyboardType="decimal-pad"
                className="bg-[#252540] rounded-lg px-3 py-2 text-white border border-[#2d2d4e]"
              />
            </Card>
          ))}

          {/* Add Item Button */}
          <TouchableOpacity
            onPress={handleAddItem}
            className="bg-[#1a1a2e] rounded-xl py-3 items-center border border-indigo-500 mb-5"
            activeOpacity={0.7}
          >
            <Text className="text-indigo-400 text-sm font-bold">
              + Добави стока
            </Text>
          </TouchableOpacity>

          {/* Save Button */}
          <TouchableOpacity
            onPress={handleSave}
            disabled={isCreating}
            className={`bg-indigo-500 rounded-xl py-4 items-center ${isCreating ? "opacity-60" : ""}`}
            activeOpacity={0.7}
          >
            {isCreating ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text className="text-white text-base font-bold">Запази</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ───────────────────────────────────────────────────────────────
export function IncomingGoodsScreen() {
  const { user } = useAuth();
  const navigation = useNavigation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const handleNewDelivery = () => {
    Alert.alert("Нова доставка", "Изберете начин на въвеждане", [
      {
        text: "📷 Сканирай фактура",
        onPress: () => navigation.navigate("CameraInvoice" as never),
      },
      {
        text: "✏️ Ръчно въвеждане",
        onPress: () => setShowCreateModal(true),
      },
      { text: "Отказ", style: "cancel" },
    ]);
  };

  const today = getTodayString();
  const { data, isLoading, isError, refetch, isFetching } =
    useIncomingGoodsByDate(today, today);

  if (isLoading) return <LoadingSpinner message="Зареждане на доставки..." />;
  if (isError) return <ErrorView onRetry={refetch} />;

  const canCreate = user?.role === "admin" || user?.role === "warehouse";

  const renderItem = ({ item }: { item: IncomingGoods }) => {
    const itemCount = item.item_count ?? (item.items || []).length;

    return (
      <TouchableOpacity
        onPress={() => setSelectedId(item.id)}
        className="mb-2"
        activeOpacity={0.7}
      >
        <Card>
          <View className="flex-row items-start justify-between">
            {/* Left side */}
            <View className="flex-1">
              <Text
                className="text-white font-semibold text-sm"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                Фактура #{item.invoice_number}
              </Text>
              <Text
                style={{ color: "#9090b8", fontSize: 12, marginTop: 4 }}
                numberOfLines={1}
              >
                {item.supplier_name || item.supplier?.name || "Доставчик"}
              </Text>
              <Text style={{ color: "#9090b8", fontSize: 12, marginTop: 4 }}>
                {formatDate(item.invoice_date)}
              </Text>
            </View>

            {/* Right side */}
            <View className="items-end">
              <StatusBadge status={item.status} />
              <Text className="text-indigo-400 text-xs font-bold mt-2">
                {itemCount} {itemCount === 1 ? "стока" : "стоки"}
              </Text>
            </View>
          </View>
        </Card>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView
      className="flex-1 bg-[#0a0a14]"
      edges={["top", "left", "right"]}
    >
      {/* Header */}
      <View className="px-4 pt-2 pb-3 flex-row justify-between items-center border-b border-[#252540]">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            className="mr-3 min-h-[44px] min-w-[44px] justify-center items-center"
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={24} color="#f0f0ff" />
          </TouchableOpacity>
          <Text style={{ color: "#f0f0ff", fontSize: 18, fontWeight: "700" }}>
            Входящи доставки
          </Text>
        </View>
        {canCreate && (
          <TouchableOpacity
            onPress={handleNewDelivery}
            className="rounded-lg px-3 py-2 min-h-[44px] justify-center"
            style={{ backgroundColor: "#6366f1" }}
            activeOpacity={0.7}
          >
            <Text className="text-white text-xs font-bold">+ Нова</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* List */}
      <FlatList
        data={data || []}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16 }}
        removeClippedSubviews={true}
        ListEmptyComponent={
          <View className="flex-1 items-center pt-20">
            <Ionicons name="cube-outline" size={48} color="#9090b8" />
            <Text style={{ color: "#9090b8", fontSize: 15, marginTop: 12 }}>
              Няма доставки за днес
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl
            refreshing={isFetching && !isLoading}
            onRefresh={refetch}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
      />

      {/* Modals */}
      <DetailModal
        incomingId={selectedId}
        onClose={() => setSelectedId(null)}
      />
      {showCreateModal && (
        <CreateModal onClose={() => setShowCreateModal(false)} />
      )}
    </SafeAreaView>
  );
}
