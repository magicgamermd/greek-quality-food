import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { isToastWorthy } from "@/lib/notificationTypes";

export interface NotificationItem {
  id: string;
  type: string;
  message: string;
  severity?: "info" | "warning" | "critical";
  payload?: any;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
}

interface NotificationsResponse {
  data: NotificationItem[];
  count: number;
}

export function useNotificationsPolling(
  opts: { onClickPayload?: (payload: any, type: string) => void } = {},
) {
  const seenIds = useRef<Set<string>>(new Set());
  const isFirstRun = useRef(true);

  const query = useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: () => api.get("/notifications").then((r) => r.data),
    refetchInterval: 30000,
    staleTime: 0,
  });

  useEffect(() => {
    const items = query.data?.data ?? [];
    if (items.length === 0) {
      isFirstRun.current = false;
      return;
    }

    if (isFirstRun.current) {
      // Prime the set without toasting on initial mount
      for (const n of items) seenIds.current.add(n.id);
      isFirstRun.current = false;
      return;
    }

    for (const n of items) {
      if (seenIds.current.has(n.id)) continue;
      seenIds.current.add(n.id);
      if (n.is_read) continue;
      if (!isToastWorthy(n.type)) continue;
      toast.success(n.message, {
        action: opts.onClickPayload
          ? {
              label: "Виж",
              onClick: () => opts.onClickPayload!(n.payload, n.type),
            }
          : undefined,
      });
    }
  }, [query.data, opts.onClickPayload]);

  return query;
}
