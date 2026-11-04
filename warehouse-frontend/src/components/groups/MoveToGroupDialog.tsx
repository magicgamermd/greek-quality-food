import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
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
import { toast } from "@/lib/toast";
import { getApiErrorMessage } from "@/lib/utils";
import {
  countLabel,
  useGroupActions,
  useGroups,
  type GroupKind,
} from "@/lib/groups";

const NONE = "none";
const NEW = "new";

/**
 * Избор на група-цел: за масово местене на избрани редове (с „Без група“
 * и „Нова група“) и за сливане на цяла група в друга.
 */
export function MoveToGroupDialog({
  kind,
  open,
  onClose,
  title,
  description,
  confirmText,
  excludeId,
  allowNone = true,
  allowNew = true,
  onConfirm,
}: {
  kind: GroupKind;
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmText: string;
  /** Групата, която се слива — не може да е цел. */
  excludeId?: number;
  allowNone?: boolean;
  allowNew?: boolean;
  onConfirm: (groupId: number | null) => Promise<void>;
}) {
  const { data } = useGroups(kind);
  const { create } = useGroupActions(kind);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setChoice("");
      setNewName("");
      setFilter("");
      setBusy(false);
    }
  }, [open]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase("bg");
    return (data?.data ?? []).filter(
      (group) =>
        group.id !== excludeId &&
        (!needle || group.name.toLocaleLowerCase("bg").includes(needle)),
    );
  }, [data, excludeId, filter]);

  const canSubmit =
    !busy && (choice === NEW ? newName.trim().length > 0 : choice !== "");

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let groupId: number | null;
      if (choice === NEW) {
        const group = await create.mutateAsync(newName.trim());
        groupId = group.id;
      } else {
        groupId = choice === NONE ? null : Number(choice);
      }
      await onConfirm(groupId);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Неуспешно преместване"));
    } finally {
      setBusy(false);
    }
  };

  const optionClass = (value: string) =>
    `flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
      choice === value
        ? "border-[#6c3dff] bg-[#6c3dff]/5 text-gray-900"
        : "border-gray-200 hover:bg-gray-50 text-gray-700"
    }`;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {(data?.data.length ?? 0) > 8 && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              className="pl-9"
              placeholder="Търси група..."
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label="Търси група"
            />
          </div>
        )}

        <div
          className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1"
          role="radiogroup"
          aria-label="Група"
        >
          {allowNone && (
            <button
              type="button"
              role="radio"
              aria-checked={choice === NONE}
              className={optionClass(NONE)}
              onClick={() => setChoice(NONE)}
            >
              <span className="italic">Без група</span>
            </button>
          )}
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              role="radio"
              aria-checked={choice === String(group.id)}
              className={optionClass(String(group.id))}
              onClick={() => setChoice(String(group.id))}
            >
              <span className="truncate">{group.name}</span>
              <span className="shrink-0 text-xs text-gray-400">
                {countLabel(kind, group.member_count)}
              </span>
            </button>
          ))}
          {groups.length === 0 && !allowNew && (
            <p className="py-2 text-sm text-gray-500">Няма други групи.</p>
          )}
          {allowNew && (
            <div
              className={`rounded-md border px-3 py-2 ${
                choice === NEW
                  ? "border-[#6c3dff] bg-[#6c3dff]/5"
                  : "border-dashed border-gray-300"
              }`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={choice === NEW}
                className="w-full text-left text-sm font-medium text-[#6c3dff]"
                onClick={() => setChoice(NEW)}
              >
                + Нова група
              </button>
              {choice === NEW && (
                <Input
                  autoFocus
                  className="mt-2"
                  placeholder="Име на групата"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                  aria-label="Име на новата група"
                />
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отказ
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Spinner size="sm" /> : null}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
