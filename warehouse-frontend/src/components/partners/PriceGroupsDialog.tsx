import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { getApiErrorMessage } from "@/lib/utils";
import {
  formatPercent,
  PRICE_GROUPS_QUERY_KEY,
  usePriceGroups,
  type PriceGroupDiscount,
} from "@/lib/priceGroups";

// Стабилен празен списък — иначе `= []` дава нов масив на всяко
// изобразяване и ефектът по-долу се върти, докато данните се зареждат.
const NO_GROUPS: PriceGroupDiscount[] = [];

function parsePercent(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * Ценовите групи с отстъпката на всяка. Отстъпката влиза сама в новите
 * редове на поръчка за партньорите в групата (своята на партньора е с
 * предимство).
 */
export function PriceGroupsDialog({
  open,
  onClose,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = usePriceGroups();
  const groups = data ?? NO_GROUPS;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDrafts(
        Object.fromEntries(
          groups.map((group) => [
            group.price_group,
            formatPercent(group.discount_percent),
          ]),
        ),
      );
    }
  }, [open, groups]);

  const changed = groups.filter((group) => {
    const draft = drafts[group.price_group];
    if (draft === undefined) return false;
    const value = parsePercent(draft);
    return value === null || value !== group.discount_percent;
  });
  const invalid = changed.filter(
    (group) => parsePercent(drafts[group.price_group] ?? "") === null,
  );

  const save = async () => {
    if (invalid.length > 0 || changed.length === 0) return;
    setSaving(true);
    try {
      for (const group of changed) {
        await api.put("/partners/price-groups", {
          price_group: group.price_group,
          discount_percent: parsePercent(drafts[group.price_group] ?? "") ?? 0,
        });
      }
      await queryClient.invalidateQueries({ queryKey: PRICE_GROUPS_QUERY_KEY });
      toast.success("Отстъпките на ценовите групи са записани");
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Отстъпката не е записана"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ценови групи</DialogTitle>
          <DialogDescription>
            Отстъпката на групата влиза сама в новите редове на поръчка за
            партньорите в нея. Ако партньорът има своя отстъпка, важи неговата.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-2 font-medium">Ценова група</th>
                  <th className="py-2 pr-2 text-right font-medium">
                    Партньори
                  </th>
                  <th className="w-32 py-2 text-right font-medium">
                    Отстъпка %
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const draft = drafts[group.price_group] ?? "";
                  const bad = parsePercent(draft) === null;
                  return (
                    <tr
                      key={group.price_group}
                      className="border-b border-gray-100"
                    >
                      <td className="py-2 pr-2 text-gray-900">
                        {group.price_group}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums text-gray-500">
                        {group.partner_count}
                      </td>
                      <td className="py-1.5 text-right">
                        <Input
                          inputMode="decimal"
                          className={`ml-auto h-8 w-24 text-right ${
                            bad ? "border-red-500 text-red-600" : ""
                          }`}
                          value={draft}
                          disabled={!canManage || saving}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [group.price_group]: event.target.value,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void save();
                          }}
                          aria-label={`Отстъпка % за ${group.price_group}`}
                          aria-invalid={bad || undefined}
                          title={bad ? "Между 0 и 100" : undefined}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {canManage ? "Отказ" : "Затвори"}
          </Button>
          {canManage && (
            <Button
              onClick={() => void save()}
              disabled={saving || changed.length === 0 || invalid.length > 0}
            >
              {saving ? <Spinner size="sm" /> : null}
              Запази
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
