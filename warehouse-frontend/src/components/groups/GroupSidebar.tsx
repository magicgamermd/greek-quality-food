import { useState } from "react";
import {
  Folder,
  FolderOpen,
  GitMerge,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirm, prompt } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { getApiErrorMessage } from "@/lib/utils";
import {
  countLabel,
  GROUP_FILTER_ALL,
  GROUP_FILTER_NONE,
  GROUP_WORDS,
  useGroupActions,
  useGroups,
  type Group,
  type GroupFilter,
  type GroupKind,
} from "@/lib/groups";
import { MoveToGroupDialog } from "./MoveToGroupDialog";

/**
 * Групите като в Microinvest: списък вляво с броя, избор = филтър, и на
 * място — нова група, преименуване, сливане в друга, изтриване.
 * Без `onSelect` е само за управление (прозорецът „Групи“ при партньорите).
 */
export function GroupSidebar({
  kind,
  selected = GROUP_FILTER_ALL,
  onSelect,
  canManage,
  className = "",
}: {
  kind: GroupKind;
  selected?: GroupFilter;
  onSelect?: (filter: GroupFilter) => void;
  canManage: boolean;
  className?: string;
}) {
  const { data, isLoading } = useGroups(kind);
  const { create, rename, remove, merge } = useGroupActions(kind);
  const [mergeSource, setMergeSource] = useState<Group | null>(null);
  const groups = data?.data ?? [];
  const words = GROUP_WORDS[kind];
  const selectable = typeof onSelect === "function";

  const newGroup = async () => {
    const name = await prompt({
      title: "Нова група",
      placeholder: kind === "product" ? "напр. VLASTI" : "напр. Хотели",
      confirmText: "Създай",
      minLength: 1,
    });
    if (name === null || !name.trim()) return;
    try {
      const group = await create.mutateAsync(name.trim());
      toast.success(`Групата „${group.name}“ е създадена`);
      onSelect?.(String(group.id));
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Групата не е създадена"));
    }
  };

  const renameGroup = async (group: Group) => {
    const name = await prompt({
      title: "Преименувай групата",
      defaultValue: group.name,
      confirmText: "Запази",
      minLength: 1,
    });
    if (name === null || !name.trim() || name.trim() === group.name) return;
    try {
      await rename.mutateAsync({ id: group.id, name: name.trim() });
      toast.success("Групата е преименувана");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Групата не е преименувана"));
    }
  };

  const deleteGroup = async (group: Group) => {
    const ok = await confirm({
      title: `Изтриване на „${group.name}“`,
      description:
        group.member_count > 0
          ? `${countLabel(kind, group.member_count)} остават без група — самите те не се изтриват.`
          : "Групата е празна.",
      confirmText: "Изтрий групата",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(group.id);
      toast.success("Групата е изтрита");
      if (selected === String(group.id)) onSelect?.(GROUP_FILTER_ALL);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Групата не е изтрита"));
    }
  };

  const rowClass = (active: boolean) =>
    `group/row flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
      active
        ? "bg-[#6c3dff]/10 text-[#6c3dff] font-medium"
        : "text-gray-700 hover:bg-gray-100"
    }`;

  const countClass = "ml-auto shrink-0 text-xs tabular-nums text-gray-400";

  return (
    <nav aria-label="Групи" className={className}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Групи
        </h2>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => void newGroup()}
            disabled={create.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            Нова
          </Button>
        )}
      </div>

      <div className="space-y-0.5">
        {selectable && (
          <>
            <button
              type="button"
              className={rowClass(selected === GROUP_FILTER_ALL)}
              onClick={() => onSelect?.(GROUP_FILTER_ALL)}
              aria-current={selected === GROUP_FILTER_ALL ? "true" : undefined}
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              <span className="truncate">Всички</span>
              <span className={countClass}>{data?.total_count ?? ""}</span>
            </button>
            <button
              type="button"
              className={rowClass(selected === GROUP_FILTER_NONE)}
              onClick={() => onSelect?.(GROUP_FILTER_NONE)}
              aria-current={selected === GROUP_FILTER_NONE ? "true" : undefined}
            >
              <Folder className="h-4 w-4 shrink-0 text-gray-300" />
              <span className="truncate italic">Без група</span>
              <span className={countClass}>{data?.ungrouped_count ?? ""}</span>
            </button>
            <div className="my-1.5 border-t border-gray-100" />
          </>
        )}

        {isLoading && (
          <p className="px-2 py-1 text-xs text-gray-400">Зареждане...</p>
        )}
        {!isLoading && groups.length === 0 && (
          <p className="px-2 py-1 text-xs text-gray-400">
            Още няма групи.
            {canManage ? " „+ Нова“ създава първата." : ""}
          </p>
        )}

        {groups.map((group) => {
          const active = selected === String(group.id);
          return (
            <div key={group.id} className={rowClass(active)}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onSelect?.(String(group.id))}
                aria-current={active ? "true" : undefined}
                title={
                  group.supplier_id
                    ? `${group.name} — група по доставчик: новите доставки от него влизат тук`
                    : group.name
                }
                disabled={!selectable}
              >
                {group.supplier_id ? (
                  <Truck className="h-4 w-4 shrink-0 text-gray-400" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-gray-400" />
                )}
                <span className="truncate">{group.name}</span>
              </button>
              <span className={countClass}>{group.member_count}</span>
              {canManage && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-gray-400 opacity-60 hover:bg-white hover:text-gray-700 focus:opacity-100 group-hover/row:opacity-100"
                      aria-label={`Действия с група ${group.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void renameGroup(group)}>
                      <Pencil className="h-4 w-4" />
                      Преименувай
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setMergeSource(group)}>
                      <GitMerge className="h-4 w-4" />
                      Всички в друга група…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600 focus:bg-red-50"
                      onSelect={() => void deleteGroup(group)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Изтрий групата
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </div>

      <MoveToGroupDialog
        kind={kind}
        open={mergeSource !== null}
        onClose={() => setMergeSource(null)}
        title={`Всички от „${mergeSource?.name ?? ""}“ в друга група`}
        description={`${words.none} (${countLabel(kind, mergeSource?.member_count ?? 0)}) отиват в избраната група, а празната „${mergeSource?.name ?? ""}“ се изтрива.`}
        confirmText="Премести всички"
        excludeId={mergeSource?.id}
        allowNone={false}
        allowNew={false}
        onConfirm={async (targetId) => {
          if (!mergeSource || targetId === null) return;
          await merge.mutateAsync({ id: mergeSource.id, targetId });
          toast.success(
            `${countLabel(kind, mergeSource.member_count)} преместени`,
          );
          if (selected === String(mergeSource.id)) onSelect?.(String(targetId));
        }}
      />
    </nav>
  );
}
