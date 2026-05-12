import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronRight } from "lucide-react";

interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "warehouse" | "accountant" | "sales";
  has_overrides?: boolean;
  overrides_count?: number;
}

export function UsersListPage() {
  const { data, isLoading, error } = useQuery<AdminUserRow[]>({
    queryKey: ["admin", "users"],
    queryFn: () =>
      api
        .get("/users")
        .then((r) => (Array.isArray(r.data) ? r.data : (r.data?.data ?? []))),
  });

  if (isLoading) return <div className="p-8">Зареждане...</div>;
  if (error)
    return <div className="p-8 text-red-600">Грешка при зареждане.</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Потребители</h1>
        <Link
          to="/settings/users/new"
          className="px-3 py-1.5 rounded bg-[#6c3dff] text-white text-sm"
        >
          + Нов user
        </Link>
      </div>

      <div className="border rounded-lg overflow-hidden bg-white">
        {(data ?? []).map((u) => (
          <Link
            key={u.id}
            to={`/settings/users/${u.id}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 border-b last:border-0"
          >
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-sm text-gray-500">{u.email}</div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm bg-gray-100 px-2 py-1 rounded">
                {u.role}
              </span>
              <span className="text-sm text-gray-500">
                {u.overrides_count
                  ? `${u.overrides_count} overrides`
                  : u.role === "admin"
                    ? "—"
                    : "default"}
              </span>
              <ChevronRight className="h-4 w-4 text-gray-400" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
