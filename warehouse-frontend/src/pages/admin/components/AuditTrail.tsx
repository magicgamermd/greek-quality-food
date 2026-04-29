import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface AuditEvent {
  id: number;
  action: string;
  actor_email: string;
  diff: {
    user_id?: string;
    permission?: string;
    action?: "grant" | "revoke" | "reset_to_default";
    new?: boolean;
    reason?: string | null;
    new_role?: string;
    previous_role?: string;
  } | null;
  created_at: string;
}

interface AuditTrailProps {
  userId: string;
}

export function AuditTrail({ userId }: AuditTrailProps) {
  const { data, isLoading } = useQuery<AuditEvent[]>({
    queryKey: ["audit", "user", userId],
    queryFn: () =>
      api
        .get(`/users/${userId}/audit?limit=10`)
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
    enabled: !!userId,
    retry: false,
  });

  if (isLoading)
    return <div className="text-sm text-gray-500">Зареждане...</div>;
  if (!data || data.length === 0) {
    return (
      <div className="text-sm text-gray-500">Няма история на промените.</div>
    );
  }

  return (
    <ul className="space-y-2">
      {data.map((e) => (
        <li key={e.id} className="text-sm border rounded p-2 bg-white">
          <div className="text-xs text-gray-400">
            {new Date(e.created_at).toLocaleString("bg-BG")}
          </div>
          <div>
            <strong>{e.actor_email}</strong>{" "}
            {e.diff?.action === "grant"
              ? "грантна"
              : e.diff?.action === "revoke"
                ? "отне"
                : "ресетна"}{" "}
            <code className="text-xs">{e.diff?.permission}</code>
            {e.diff?.reason && (
              <em className="ml-2 text-gray-500">— „{e.diff.reason}"</em>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
