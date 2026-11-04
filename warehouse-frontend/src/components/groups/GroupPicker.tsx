import { Select } from "@/components/ui/select";
import { prompt } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { getApiErrorMessage } from "@/lib/utils";
import { useGroupActions, useGroups, type GroupKind } from "@/lib/groups";

const NEW_GROUP = "__new__";

/**
 * Избор на група в картата на продукт/партньор + „Нова група…“ на място
 * (без да се затваря картата).
 */
export function GroupPicker({
  kind,
  value,
  onChange,
  disabled,
  canCreate = true,
  id,
}: {
  kind: GroupKind;
  /** id на групата като низ; "" = без група */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  canCreate?: boolean;
  id?: string;
}) {
  const { data } = useGroups(kind);
  const { create } = useGroupActions(kind);
  const groups = data?.data ?? [];

  const createGroup = async () => {
    const name = await prompt({
      title: "Нова група",
      placeholder: kind === "product" ? "напр. VLASTI" : "напр. Хотели",
      confirmText: "Създай",
      minLength: 1,
    });
    if (name === null || !name.trim()) return;
    try {
      const group = await create.mutateAsync(name.trim());
      onChange(String(group.id));
      toast.success(`Групата „${group.name}“ е създадена`);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Групата не е създадена"));
    }
  };

  return (
    <Select
      id={id}
      value={value}
      disabled={disabled || create.isPending}
      onChange={(event) => {
        if (event.target.value === NEW_GROUP) {
          void createGroup();
          return;
        }
        onChange(event.target.value);
      }}
    >
      <option value="">— Без група —</option>
      {groups.map((group) => (
        <option key={group.id} value={String(group.id)}>
          {group.name}
        </option>
      ))}
      {canCreate && <option value={NEW_GROUP}>+ Нова група…</option>}
    </Select>
  );
}
