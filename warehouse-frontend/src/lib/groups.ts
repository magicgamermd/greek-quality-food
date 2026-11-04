// Групи на продукти и партньори (по образец на Microinvest, 04.11.2026).
// Едно и също API за двата вида — разлика е само адресът.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type GroupKind = "product" | "partner";

export interface Group {
  id: number;
  name: string;
  /** Група по доставчик (само при продуктите). */
  supplier_id: number | null;
  member_count: number;
}

export interface GroupsResponse {
  data: Group[];
  total_count: number;
  ungrouped_count: number;
}

/** Филтър по група: "" = всички, "none" = без група, "12" = група 12. */
export type GroupFilter = string;
export const GROUP_FILTER_ALL = "";
export const GROUP_FILTER_NONE = "none";

const GROUP_API: Record<GroupKind, string> = {
  product: "/product-groups",
  partner: "/partner-groups",
};

/** Кои списъци да се презаредят след промяна на групите. */
const MEMBER_QUERY_KEY: Record<GroupKind, string> = {
  product: "products",
  partner: "partners",
};

export const GROUP_WORDS: Record<
  GroupKind,
  { one: string; many: string; none: string }
> = {
  product: { one: "продукт", many: "продукта", none: "Продуктите" },
  partner: { one: "партньор", many: "партньора", none: "Партньорите" },
};

/** „1 продукт“, „5 продукта“. */
export function countLabel(kind: GroupKind, count: number): string {
  const words = GROUP_WORDS[kind];
  return `${count} ${count === 1 ? words.one : words.many}`;
}

export function groupsQueryKey(kind: GroupKind) {
  return ["groups", kind] as const;
}

export function useGroups(kind: GroupKind) {
  return useQuery<GroupsResponse>({
    queryKey: groupsQueryKey(kind),
    queryFn: () =>
      api.get(GROUP_API[kind]).then((response) => {
        const body = response.data ?? {};
        return {
          data: Array.isArray(body.data) ? body.data : [],
          total_count: Number(body.total_count) || 0,
          ungrouped_count: Number(body.ungrouped_count) || 0,
        };
      }),
    staleTime: 30_000,
  });
}

export function useGroupActions(kind: GroupKind) {
  const queryClient = useQueryClient();
  const base = GROUP_API[kind];
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: groupsQueryKey(kind) });
    queryClient.invalidateQueries({ queryKey: [MEMBER_QUERY_KEY[kind]] });
  };

  const create = useMutation({
    mutationFn: (name: string) =>
      api.post(base, { name }).then((response) => response.data.data as Group),
    onSuccess: refresh,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.put(`${base}/${id}`, { name }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${base}/${id}`),
    onSuccess: refresh,
  });

  const merge = useMutation({
    mutationFn: ({ id, targetId }: { id: number; targetId: number }) =>
      api.post(`${base}/${id}/merge`, { target_id: targetId }),
    onSuccess: refresh,
  });

  const move = useMutation({
    mutationFn: ({ ids, groupId }: { ids: number[]; groupId: number | null }) =>
      api
        .post(`${base}/move`, { ids, group_id: groupId })
        .then((response) => Number(response.data?.data?.moved) || 0),
    onSuccess: refresh,
  });

  return { create, rename, remove, merge, move };
}

/** Филтърът като параметър към списъка (`group=none` / `group=12`). */
export function groupFilterParam(filter: GroupFilter): string | null {
  if (filter === GROUP_FILTER_NONE) return GROUP_FILTER_NONE;
  return /^\d+$/.test(filter) ? filter : null;
}
