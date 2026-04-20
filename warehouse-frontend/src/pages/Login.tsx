import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { User } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

interface LoginProps {
  redirectTo?: string;
  appTitle?: string;
  subtitle?: string;
  loginHeading?: string;
  theme?: "default" | "owner";
  loginProfile?: "default" | "owner_mobile";
  allowedRoles?: User["role"][];
}

export function Login({
  redirectTo = "/",
  appTitle = "Greek Foods",
  subtitle = "Система за управление на склад",
  loginHeading = "Вход в системата",
  theme = "default",
  loginProfile = "default",
  allowedRoles,
}: LoginProps = {}) {
  const { login, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const isOwnerTheme = theme === "owner";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const loggedInUser = await login(email, password, {
        profile: loginProfile,
      });

      if (allowedRoles && !allowedRoles.includes(loggedInUser.role)) {
        logout();
        setError("Този профил няма достъп до owner мобилната версия.");
        return;
      }

      navigate(redirectTo);
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: { error?: string; message?: string };
          status?: number;
        };
      };
      const serverMsg =
        axiosErr.response?.data?.error || axiosErr.response?.data?.message;
      if (serverMsg) {
        setError(
          serverMsg === "Invalid email or password"
            ? "Грешен имейл или парола"
            : serverMsg,
        );
      } else {
        setError("Грешка при вход. Моля, опитайте отново.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={cn(
        "relative min-h-screen flex items-center justify-center overflow-hidden",
        isOwnerTheme
          ? "bg-[#090c18]"
          : "bg-gradient-to-br from-[#1a1a2e] to-[#16213e]",
      )}
    >
      {isOwnerTheme && (
        <>
          <div className="pointer-events-none absolute -top-20 -right-20 h-72 w-72 rounded-full bg-[#4f7cff]/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 -left-20 h-72 w-72 rounded-full bg-[#25c38b]/12 blur-3xl" />
        </>
      )}

      <div className="relative z-10 w-full max-w-md mx-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <div
            className={cn(
              "inline-flex items-center justify-center h-16 w-16 rounded-2xl mb-4",
              isOwnerTheme
                ? "border border-[#243055] bg-[#12162a] text-[#4f7cff]"
                : "bg-[#6c3dff] text-white",
            )}
          >
            <span className="font-bold text-2xl">GF</span>
          </div>
          <h1 className="text-2xl font-bold text-white">{appTitle}</h1>
          <p className={cn("mt-1", isOwnerTheme ? "text-[#9aa8d6]" : "text-white/60")}>
            {subtitle}
          </p>
        </div>

        {/* Card */}
        <div
          className={cn(
            "rounded-2xl p-8",
            isOwnerTheme
              ? "bg-[#12162a] border border-[#243055] shadow-[0_20px_60px_rgba(5,8,16,0.45)]"
              : "bg-white shadow-2xl",
          )}
        >
          <h2
            className={cn(
              "text-xl font-semibold mb-6",
              isOwnerTheme ? "text-[#f3f6ff]" : "text-gray-900",
            )}
          >
            {loginHeading}
          </h2>

          {error && (
            <div
              className={cn(
                "mb-4 p-3 rounded-md text-sm border",
                isOwnerTheme
                  ? "bg-[rgba(242,111,111,0.12)] border-[rgba(242,111,111,0.35)] text-[#f7a5a5]"
                  : "bg-red-50 border-red-200 text-red-700",
              )}
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className={isOwnerTheme ? "text-[#9aa8d6]" : ""}>
                Имейл
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="email@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className={
                  isOwnerTheme
                    ? "border-[#243055] bg-[#161c34] text-[#f3f6ff] placeholder:text-[#9aa8d6] focus-visible:ring-[#4f7cff]"
                    : ""
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className={isOwnerTheme ? "text-[#9aa8d6]" : ""}>
                Парола
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className={cn(
                    "pr-10",
                    isOwnerTheme
                      ? "border-[#243055] bg-[#161c34] text-[#f3f6ff] placeholder:text-[#9aa8d6] focus-visible:ring-[#4f7cff]"
                      : "",
                  )}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className={cn(
                    "absolute right-3 top-1/2 -translate-y-1/2 transition-colors",
                    isOwnerTheme
                      ? "text-[#9aa8d6] hover:text-[#f3f6ff]"
                      : "text-gray-400 hover:text-gray-600",
                  )}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className={cn(
                "w-full mt-2",
                isOwnerTheme ? "bg-[#4f7cff] hover:bg-[#4672ec] text-white" : "",
              )}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Spinner
                    size="sm"
                    className={isOwnerTheme ? "border-white/30 border-t-white" : ""}
                  />
                  Влизане...
                </>
              ) : (
                "Вход"
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
