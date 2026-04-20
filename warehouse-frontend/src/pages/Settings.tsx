import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Plus, Edit2, Download, FileSpreadsheet } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ConfirmDialog";
import type { Category, User } from "@/types";
import { useAuth } from "@/contexts/AuthContext";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingOverlay, ErrorMessage, Spinner } from "@/components/ui/spinner";

interface CompanySettings {
  company_name?: string;
  address?: string;
  eik?: string;
  vat_number?: string;
  iban?: string;
  bank_name?: string;
  bic?: string;
  mol?: string;
  phone?: string;
  email?: string;
  // Fiscal printer settings
  fiscal_enabled?: boolean;
  fiscal_connection_type?: "fpgate" | "serial";
  fiscal_fpgate_url?: string;
  fiscal_printer_id?: string;
  fiscal_serial_port?: string;
  fiscal_auto_print?: boolean;
  fiscal_operator_id?: string;
  fiscal_operator_password?: string;
}

export function Settings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<
    "categories" | "users" | "company" | "fiscal" | "export" | "data"
  >("categories");
  const [exportFrom, setExportFrom] = useState(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .split("T")[0],
  );
  const [exportTo, setExportTo] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [exportType, setExportType] = useState<"all" | "sales" | "purchases">(
    "all",
  );
  const [exporting, setExporting] = useState(false);
  const [fiscalTestLoading, setFiscalTestLoading] = useState(false);
  const [resetStockLoading, setResetStockLoading] = useState(false);
  const [fiscalStatusLoading, setFiscalStatusLoading] = useState(false);
  const [fiscalStatus, setFiscalStatus] = useState<any>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [categoryForm, setCategoryForm] = useState({
    name_bg: "",
    name_en: "",
  });
  const [userForm, setUserForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "warehouse",
  });
  const [successMessage, setSuccessMessage] = useState("");

  // Categories
  const { data: categories = [], isLoading: categoriesLoading } = useQuery<
    Category[]
  >({
    queryKey: ["categories"],
    queryFn: () =>
      api.get("/categories").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  // Users
  const { data: users = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: () =>
      api.get("/users").then((r) => {
        const d = r.data;
        return Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
      }),
  });

  // Company settings
  const { data: companyData = {}, isLoading: companyLoading } =
    useQuery<CompanySettings>({
      queryKey: ["settings"],
      queryFn: () => api.get("/settings").then((r) => r.data ?? {}),
    });

  const [companyForm, setCompanyForm] = useState<CompanySettings>(companyData);

  // Sync form when data loads from API
  useEffect(() => {
    if (companyData && Object.keys(companyData).length > 0) {
      setCompanyForm(companyData);
    }
  }, [companyData]);

  // Mutations
  const addCategoryMutation = useMutation({
    mutationFn: () => api.post("/categories", categoryForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setCategoryForm({ name_bg: "", name_en: "" });
      setShowAddCategory(false);
      showSuccess("Категория добавена");
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      showSuccess("Категория изтрита");
    },
  });

  const addUserMutation = useMutation({
    mutationFn: () => api.post("/users", userForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setUserForm({ name: "", email: "", password: "", role: "warehouse" });
      setShowAddUser(false);
      showSuccess("Потребител добавен");
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      showSuccess("Потребител изтрит");
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) =>
      api.patch(`/users/${userId}/role`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      showSuccess("Роля променена");
    },
  });

  const saveCompanyMutation = useMutation({
    mutationFn: () => api.post("/settings", companyForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      showSuccess("Фирмени данни запазени");
    },
  });

  const showSuccess = (msg: string) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(""), 3000);
  };

  const handleCompanyFormChange = (field: string, value: string) => {
    setCompanyForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Настройки</h1>
        <p className="text-gray-500 text-sm mt-1">
          Управление на категории, потребители и фирмени данни
        </p>
      </div>

      {successMessage && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-green-700 text-sm">
          ✓ {successMessage}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200">
        <button
          onClick={() => setActiveTab("categories")}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === "categories"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Категории
        </button>
        <button
          onClick={() => setActiveTab("users")}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === "users"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Потребители
        </button>
        <button
          onClick={() => setActiveTab("company")}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === "company"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Фирмени данни
        </button>
        <button
          onClick={() => setActiveTab("fiscal")}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === "fiscal"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Фискален принтер
        </button>
        <button
          onClick={() => setActiveTab("export")}
          className={`px-4 py-2 font-medium border-b-2 transition-colors ${
            activeTab === "export"
              ? "border-[#6c3dff] text-[#6c3dff]"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Експорт
        </button>
        {user?.role === "admin" && (
          <button
            onClick={() => setActiveTab("data")}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === "data"
                ? "border-[#6c3dff] text-[#6c3dff]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Управление на данни
          </button>
        )}
      </div>

      {/* TAB 1: Categories */}
      {activeTab === "categories" && (
        <div className="space-y-4">
          <Button onClick={() => setShowAddCategory(true)}>
            <Plus className="h-4 w-4" />
            Нова категория
          </Button>

          <Card>
            <CardContent className="p-0 max-h-96 overflow-y-auto">
              {categoriesLoading ? (
                <LoadingOverlay />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Назва (BG)</TableHead>
                      <TableHead>Назва (EN)</TableHead>
                      <TableHead className="text-right">Действия</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categories.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="text-center text-gray-400 py-8"
                        >
                          Няма категории
                        </TableCell>
                      </TableRow>
                    ) : (
                      categories.map((cat) => (
                        <TableRow key={cat.id}>
                          <TableCell>{cat.name_bg}</TableCell>
                          <TableCell>
                            {cat.name_en && cat.name_en !== cat.name_bg ? (
                              cat.name_en
                            ) : (
                              <span className="text-gray-400 italic">
                                Не е зададено
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                const ok = await confirm({
                                  title: "Изтриване на категория",
                                  description:
                                    "Сигурен ли си че искаш да изтриеш тази категория?",
                                  confirmText: "Изтрий",
                                  variant: "danger",
                                });
                                if (ok) {
                                  deleteCategoryMutation.mutate(cat.id);
                                }
                              }}
                              disabled={deleteCategoryMutation.isPending}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Add Category Dialog */}
          <Dialog open={showAddCategory} onOpenChange={setShowAddCategory}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Нова категория</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Назва (България)</Label>
                  <Input
                    value={categoryForm.name_bg}
                    onChange={(e) =>
                      setCategoryForm((c) => ({
                        ...c,
                        name_bg: e.target.value,
                      }))
                    }
                    placeholder="Например: Масла"
                  />
                </div>
                <div>
                  <Label>Назва (English)</Label>
                  <Input
                    value={categoryForm.name_en}
                    onChange={(e) =>
                      setCategoryForm((c) => ({
                        ...c,
                        name_en: e.target.value,
                      }))
                    }
                    placeholder="E.g. Oils"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowAddCategory(false)}
                >
                  Отказ
                </Button>
                <Button
                  onClick={() => addCategoryMutation.mutate()}
                  disabled={
                    addCategoryMutation.isPending || !categoryForm.name_bg
                  }
                >
                  {addCategoryMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Добавяне...
                    </>
                  ) : (
                    "Добави"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* TAB 2: Users */}
      {activeTab === "users" && (
        <div className="space-y-4">
          <Button onClick={() => setShowAddUser(true)}>
            <Plus className="h-4 w-4" />
            Нов потребител
          </Button>

          <Card>
            <CardContent className="p-0">
              {usersLoading ? (
                <LoadingOverlay />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Име</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Роля</TableHead>
                      <TableHead>Дата на създаване</TableHead>
                      <TableHead className="text-right">Действия</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-gray-400 py-8"
                        >
                          Няма потребители
                        </TableCell>
                      </TableRow>
                    ) : (
                      users.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="font-medium">
                            {u.name}
                          </TableCell>
                          <TableCell>{u.email}</TableCell>
                          <TableCell>
                            <Select
                              value={u.role}
                              onChange={(e) =>
                                changeRoleMutation.mutate({
                                  userId: u.id,
                                  role: e.target.value,
                                })
                              }
                              disabled={
                                changeRoleMutation.isPending ||
                                u.id === user?.id
                              }
                            >
                              <option value="admin">Admin</option>
                              <option value="warehouse">Warehouse</option>
                              <option value="accountant">Accountant</option>
                            </Select>
                          </TableCell>
                          <TableCell className="text-sm text-gray-500">
                            {formatDate(u.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                if (u.id === user?.id) {
                                  toast.error(
                                    "Не можеш да изтриеш собствения си акаунт",
                                  );
                                  return;
                                }
                                const ok = await confirm({
                                  title: "Изтриване на потребител",
                                  description:
                                    "Сигурен ли си че искаш да изтриеш този потребител?",
                                  confirmText: "Изтрий",
                                  variant: "danger",
                                });
                                if (ok) {
                                  deleteUserMutation.mutate(u.id);
                                }
                              }}
                              disabled={
                                deleteUserMutation.isPending ||
                                u.id === user?.id
                              }
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Add User Dialog */}
          <Dialog open={showAddUser} onOpenChange={setShowAddUser}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Нов потребител</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Име</Label>
                  <Input
                    value={userForm.name}
                    onChange={(e) =>
                      setUserForm((u) => ({ ...u, name: e.target.value }))
                    }
                    placeholder="Име на потребителя"
                  />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={userForm.email}
                    onChange={(e) =>
                      setUserForm((u) => ({ ...u, email: e.target.value }))
                    }
                    placeholder="email@example.com"
                  />
                </div>
                <div>
                  <Label>Пароля</Label>
                  <Input
                    type="password"
                    value={userForm.password}
                    onChange={(e) =>
                      setUserForm((u) => ({ ...u, password: e.target.value }))
                    }
                    placeholder="Силна пароля"
                  />
                </div>
                <div>
                  <Label>Роля</Label>
                  <Select
                    value={userForm.role}
                    onChange={(e) =>
                      setUserForm((u) => ({ ...u, role: e.target.value }))
                    }
                  >
                    <option value="admin">Admin</option>
                    <option value="warehouse">Warehouse</option>
                    <option value="accountant">Accountant</option>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAddUser(false)}>
                  Отказ
                </Button>
                <Button
                  onClick={() => addUserMutation.mutate()}
                  disabled={
                    addUserMutation.isPending ||
                    !userForm.name ||
                    !userForm.email ||
                    !userForm.password
                  }
                >
                  {addUserMutation.isPending ? (
                    <>
                      <Spinner size="sm" />
                      Добавяне...
                    </>
                  ) : (
                    "Добави"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* TAB 3: Company Info */}
      {activeTab === "company" && (
        <Card>
          <CardHeader>
            <CardTitle>Фирмени данни</CardTitle>
          </CardHeader>
          <CardContent>
            {companyLoading ? (
              <LoadingOverlay />
            ) : (
              <form className="space-y-4 max-w-2xl">
                <div>
                  <Label>Назва на фирма</Label>
                  <Input
                    value={companyForm.company_name || ""}
                    onChange={(e) =>
                      handleCompanyFormChange("company_name", e.target.value)
                    }
                    placeholder="Например: МЕРТ-М ЕООД"
                  />
                </div>

                <div>
                  <Label>Адрес</Label>
                  <Textarea
                    value={companyForm.address || ""}
                    onChange={(e) =>
                      handleCompanyFormChange("address", e.target.value)
                    }
                    placeholder="Пълния адрес на фирмата"
                    rows={3}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label>EIK</Label>
                    <Input
                      value={companyForm.eik || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("eik", e.target.value)
                      }
                      placeholder="Единен идентификационен код"
                    />
                  </div>

                  <div>
                    <Label>ДДС номер</Label>
                    <Input
                      value={companyForm.vat_number || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("vat_number", e.target.value)
                      }
                      placeholder="VAT номер"
                    />
                  </div>
                </div>

                <div>
                  <Label>IBAN</Label>
                  <Input
                    value={companyForm.iban || ""}
                    onChange={(e) =>
                      handleCompanyFormChange("iban", e.target.value)
                    }
                    placeholder="Номер на банкова сметка"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label>Банка</Label>
                    <Input
                      value={companyForm.bank_name || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("bank_name", e.target.value)
                      }
                      placeholder="Име на банката"
                    />
                  </div>

                  <div>
                    <Label>BIC</Label>
                    <Input
                      value={companyForm.bic || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("bic", e.target.value)
                      }
                      placeholder="BIC код"
                    />
                  </div>
                </div>

                <div>
                  <Label>МОЛ (материално отговорно лице)</Label>
                  <Input
                    value={companyForm.mol || ""}
                    onChange={(e) =>
                      handleCompanyFormChange("mol", e.target.value)
                    }
                    placeholder="Име на МОЛ"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label>Телефон</Label>
                    <Input
                      value={companyForm.phone || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("phone", e.target.value)
                      }
                      placeholder="Телефонен номер"
                    />
                  </div>

                  <div>
                    <Label>Email</Label>
                    <Input
                      type="email"
                      value={companyForm.email || ""}
                      onChange={(e) =>
                        handleCompanyFormChange("email", e.target.value)
                      }
                      placeholder="contact@example.com"
                    />
                  </div>
                </div>

                <div className="pt-4 flex gap-2">
                  <Button
                    type="button"
                    onClick={() => saveCompanyMutation.mutate()}
                    disabled={saveCompanyMutation.isPending}
                  >
                    {saveCompanyMutation.isPending ? (
                      <>
                        <Spinner size="sm" />
                        Запазване...
                      </>
                    ) : (
                      "Запази"
                    )}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* TAB 4: Fiscal Printer */}
      {activeTab === "fiscal" && (
        <Card>
          <CardHeader>
            <CardTitle>Фискален принтер — DAISY Compact M</CardTitle>
          </CardHeader>
          <CardContent>
            {companyLoading ? (
              <LoadingOverlay />
            ) : (
              <form className="space-y-6 max-w-2xl">
                {/* Enable toggle */}
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="fiscal_enabled"
                    checked={companyForm.fiscal_enabled || false}
                    onChange={(e) =>
                      setCompanyForm((prev) => ({
                        ...prev,
                        fiscal_enabled: e.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-gray-300 text-[#6c3dff]"
                  />
                  <Label htmlFor="fiscal_enabled">
                    Активирай фискален принтер
                  </Label>
                </div>

                {companyForm.fiscal_enabled && (
                  <>
                    {/* Connection type */}
                    <div>
                      <Label>Тип връзка</Label>
                      <Select
                        value={companyForm.fiscal_connection_type || "fpgate"}
                        onChange={(e) =>
                          handleCompanyFormChange(
                            "fiscal_connection_type",
                            e.target.value,
                          )
                        }
                      >
                        <option value="fpgate">
                          FPGate (REST API — препоръчително)
                        </option>
                        <option value="serial">Директна серийна връзка</option>
                      </Select>
                    </div>

                    {/* FPGate settings */}
                    {(companyForm.fiscal_connection_type || "fpgate") ===
                      "fpgate" && (
                      <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
                        <h4 className="font-medium text-sm text-gray-700">
                          FPGate настройки
                        </h4>
                        <div>
                          <Label>FPGate URL</Label>
                          <Input
                            value={
                              companyForm.fiscal_fpgate_url ||
                              "http://localhost:8182"
                            }
                            onChange={(e) =>
                              handleCompanyFormChange(
                                "fiscal_fpgate_url",
                                e.target.value,
                              )
                            }
                            placeholder="http://localhost:8182"
                          />
                        </div>
                        <div>
                          <Label>Printer ID</Label>
                          <Input
                            value={companyForm.fiscal_printer_id || ""}
                            onChange={(e) =>
                              handleCompanyFormChange(
                                "fiscal_printer_id",
                                e.target.value,
                              )
                            }
                            placeholder="ID на принтера във FPGate"
                          />
                        </div>
                      </div>
                    )}

                    {/* Serial settings */}
                    {companyForm.fiscal_connection_type === "serial" && (
                      <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
                        <h4 className="font-medium text-sm text-gray-700">
                          Серийна връзка
                        </h4>
                        <div>
                          <Label>Сериен порт</Label>
                          <Input
                            value={companyForm.fiscal_serial_port || ""}
                            onChange={(e) =>
                              handleCompanyFormChange(
                                "fiscal_serial_port",
                                e.target.value,
                              )
                            }
                            placeholder="COM3 или /dev/ttyUSB0"
                          />
                        </div>
                      </div>
                    )}

                    {/* Operator settings */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label>Номер на оператор</Label>
                        <Input
                          value={companyForm.fiscal_operator_id || "1"}
                          onChange={(e) =>
                            handleCompanyFormChange(
                              "fiscal_operator_id",
                              e.target.value,
                            )
                          }
                          placeholder="1"
                        />
                      </div>
                      <div>
                        <Label>Парола на оператор</Label>
                        <Input
                          type="password"
                          value={companyForm.fiscal_operator_password || ""}
                          onChange={(e) =>
                            handleCompanyFormChange(
                              "fiscal_operator_password",
                              e.target.value,
                            )
                          }
                          placeholder="0000"
                        />
                      </div>
                    </div>

                    {/* Auto-print toggle */}
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="fiscal_auto_print"
                        checked={companyForm.fiscal_auto_print || false}
                        onChange={(e) =>
                          setCompanyForm((prev) => ({
                            ...prev,
                            fiscal_auto_print: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 rounded border-gray-300 text-[#6c3dff]"
                      />
                      <Label htmlFor="fiscal_auto_print">
                        Автоматичен печат при изпълнение на поръчка
                      </Label>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-3 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={fiscalStatusLoading}
                        onClick={async () => {
                          setFiscalStatusLoading(true);
                          setFiscalStatus(null);
                          try {
                            const res = await api.get("/fiscal/status");
                            setFiscalStatus(res.data);
                          } catch (err: any) {
                            setFiscalStatus({
                              connected: false,
                              error: err.response?.data?.error || err.message,
                            });
                          } finally {
                            setFiscalStatusLoading(false);
                          }
                        }}
                      >
                        {fiscalStatusLoading ? (
                          <>
                            <Spinner size="sm" />
                            Проверка...
                          </>
                        ) : (
                          "Тест на връзката"
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={fiscalTestLoading}
                        onClick={async () => {
                          setFiscalTestLoading(true);
                          try {
                            await api.post("/fiscal/test");
                            showSuccess("Тестов бон отпечатан успешно");
                          } catch (err: any) {
                            toast.error(
                              `Грешка: ${err.response?.data?.details || err.message}`,
                            );
                          } finally {
                            setFiscalTestLoading(false);
                          }
                        }}
                      >
                        {fiscalTestLoading ? (
                          <>
                            <Spinner size="sm" />
                            Печат...
                          </>
                        ) : (
                          "Тестов бон"
                        )}
                      </Button>
                    </div>

                    {/* Status display */}
                    {fiscalStatus && (
                      <div
                        className={`rounded-lg border p-4 text-sm ${
                          fiscalStatus.connected
                            ? "bg-green-50 border-green-200 text-green-700"
                            : "bg-red-50 border-red-200 text-red-700"
                        }`}
                      >
                        <p className="font-medium">
                          {fiscalStatus.connected
                            ? "Свързан успешно"
                            : "Няма връзка с принтера"}
                        </p>
                        {fiscalStatus.connected && (
                          <ul className="mt-1 space-y-0.5">
                            <li>
                              Хартия:{" "}
                              {fiscalStatus.paperOk ? "OK" : "Няма/Малко"}
                            </li>
                            <li>
                              Отворен бон:{" "}
                              {fiscalStatus.fiscalReceiptOpen ? "Да" : "Не"}
                            </li>
                            <li>
                              Грешки: {fiscalStatus.hasError ? "Да" : "Няма"}
                            </li>
                          </ul>
                        )}
                        {fiscalStatus.error && (
                          <p className="mt-1">{fiscalStatus.error}</p>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Save button */}
                <div className="pt-4 flex gap-2">
                  <Button
                    type="button"
                    onClick={() => saveCompanyMutation.mutate()}
                    disabled={saveCompanyMutation.isPending}
                  >
                    {saveCompanyMutation.isPending ? (
                      <>
                        <Spinner size="sm" />
                        Запазване...
                      </>
                    ) : (
                      "Запази настройки"
                    )}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* TAB 5: Data Management (admin only) */}
      {/* TAB: Export to Delta Pro */}
      {activeTab === "export" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-[#6c3dff]" />
              Експорт за Делта Про
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm text-gray-500">
              Генерирайте файл за импорт в счетоводна програма Делта Про.
              Изберете период и тип на документите.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>От дата</Label>
                <Input
                  type="date"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>До дата</Label>
                <Input
                  type="date"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Тип</Label>
                <Select
                  value={exportType}
                  onChange={(e) =>
                    setExportType(e.target.value as typeof exportType)
                  }
                >
                  <option value="all">Всички (продажби + покупки)</option>
                  <option value="sales">Само продажби</option>
                  <option value="purchases">Само покупки</option>
                </Select>
              </div>
            </div>

            {/* Quick period buttons */}
            <div className="flex flex-wrap gap-2">
              {[
                {
                  label: "Този месец",
                  fn: () => {
                    const now = new Date();
                    setExportFrom(
                      new Date(now.getFullYear(), now.getMonth(), 1)
                        .toISOString()
                        .split("T")[0],
                    );
                    setExportTo(now.toISOString().split("T")[0]);
                  },
                },
                {
                  label: "Миналия месец",
                  fn: () => {
                    const now = new Date();
                    const first = new Date(
                      now.getFullYear(),
                      now.getMonth() - 1,
                      1,
                    );
                    const last = new Date(now.getFullYear(), now.getMonth(), 0);
                    setExportFrom(first.toISOString().split("T")[0]);
                    setExportTo(last.toISOString().split("T")[0]);
                  },
                },
                {
                  label: "Това тримесечие",
                  fn: () => {
                    const now = new Date();
                    const qStart = Math.floor(now.getMonth() / 3) * 3;
                    setExportFrom(
                      new Date(now.getFullYear(), qStart, 1)
                        .toISOString()
                        .split("T")[0],
                    );
                    setExportTo(now.toISOString().split("T")[0]);
                  },
                },
                {
                  label: "Тази година",
                  fn: () => {
                    const now = new Date();
                    setExportFrom(
                      new Date(now.getFullYear(), 0, 1)
                        .toISOString()
                        .split("T")[0],
                    );
                    setExportTo(now.toISOString().split("T")[0]);
                  },
                },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={p.fn}
                  className="px-3 py-1.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <Button
              onClick={async () => {
                setExporting(true);
                try {
                  const res = await api.get(
                    `/export/delta-pro?from=${exportFrom}&to=${exportTo}&type=${exportType}`,
                    { responseType: "blob" },
                  );
                  const blob = new Blob([res.data], {
                    type: "application/octet-stream",
                  });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `export_${exportFrom}_${exportTo}.txt`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  setTimeout(() => URL.revokeObjectURL(url), 5000);
                } catch (err: any) {
                  let msg = "Грешка при експорт";
                  try {
                    if (err?.response?.data instanceof Blob) {
                      const text = await err.response.data.text();
                      const json = JSON.parse(text);
                      if (json.error) msg = json.error;
                    } else if (err?.response?.data?.error) {
                      msg = err.response.data.error;
                    }
                  } catch {}
                  toast.error(msg);
                } finally {
                  setExporting(false);
                }
              }}
              disabled={exporting || !exportFrom || !exportTo}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {exporting ? (
                <Spinner size="sm" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {exporting ? "Експортиране..." : "Изтегли файл за Делта Про"}
            </Button>
          </CardContent>
        </Card>
      )}

      {activeTab === "data" && user?.role === "admin" && (
        <Card>
          <CardHeader>
            <CardTitle>Управление на данни</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 max-w-2xl">
            <div className="p-4 border border-red-200 bg-red-50 rounded-lg space-y-3">
              <h3 className="font-semibold text-red-800">
                Нулиране на наличности
              </h3>
              <p className="text-sm text-red-700">
                Тази операция ще нулира количествата на ВСИЧКИ продукти в
                склада. Продуктите, цените и кодовете ще бъдат запазени.
                Използвайте при стартиране на нов бизнес със съществуващ
                каталог.
              </p>
              <Button
                variant="destructive"
                disabled={resetStockLoading}
                onClick={async () => {
                  const first = await confirm({
                    title: "Нулиране на наличности",
                    description:
                      "Сигурни ли сте? Това ще нулира ВСИЧКИ наличности!",
                    confirmText: "Продължи",
                    variant: "danger",
                  });
                  if (!first) return;
                  const second = await confirm({
                    title: "ПОСЛЕДНО ПОТВЪРЖДЕНИЕ",
                    description:
                      "Наличностите на всички продукти ще станат 0. Продължавате ли?",
                    confirmText: "Да, нулирай",
                    variant: "danger",
                  });
                  if (!second) return;

                  setResetStockLoading(true);
                  try {
                    await api.post("/inventory/reset-stock");
                    qc.invalidateQueries({ queryKey: ["products"] });
                    qc.invalidateQueries({ queryKey: ["inventory"] });
                    showSuccess("Всички наличности са нулирани успешно");
                  } catch (err: any) {
                    toast.error(
                      `Грешка: ${err.response?.data?.error || err.message}`,
                    );
                  } finally {
                    setResetStockLoading(false);
                  }
                }}
              >
                {resetStockLoading ? (
                  <>
                    <Spinner size="sm" />
                    Нулиране...
                  </>
                ) : (
                  "Нулиране на наличности"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
