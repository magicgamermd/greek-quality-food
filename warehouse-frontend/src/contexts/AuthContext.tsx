import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import type { User } from "@/types";
import { api } from "@/lib/api";

export type AuthSessionProfile = "default" | "owner_mobile";

interface LoginOptions {
  profile?: AuthSessionProfile;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (
    email: string,
    password: string,
    options?: LoginOptions,
  ) => Promise<User>;
  logout: () => void;
  isAuthenticated: boolean;
  sessionProfile: AuthSessionProfile;
  isOwnerMobileSession: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);
const SESSION_PROFILE_KEY = "session_profile";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const stored = localStorage.getItem("user");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem("token"),
  );
  const [sessionProfile, setSessionProfile] = useState<AuthSessionProfile>(
    () => {
      const stored = localStorage.getItem(SESSION_PROFILE_KEY);
      return stored === "owner_mobile" ? "owner_mobile" : "default";
    },
  );

  const login = useCallback(
    async (email: string, password: string, options?: LoginOptions) => {
      const profile = options?.profile ?? "default";
      const res = await api.post("/auth/login", { email, password });
      const { token: newToken, user: newUser } = res.data;
      localStorage.setItem("token", newToken);
      localStorage.setItem("user", JSON.stringify(newUser));
      localStorage.setItem(SESSION_PROFILE_KEY, profile);
      setToken(newToken);
      setUser(newUser);
      setSessionProfile(profile);
      return newUser as User;
    },
    [],
  );

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    localStorage.removeItem(SESSION_PROFILE_KEY);
    setToken(null);
    setUser(null);
    setSessionProfile("default");
    api.post("/auth/logout").catch(() => {});
  }, []);

  // Listen for 401 events from the API interceptor and handle via React state
  // instead of hard window.location redirect which destroys SPA state
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:unauthorized", handler);
    return () => window.removeEventListener("auth:unauthorized", handler);
  }, [logout]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        login,
        logout,
        isAuthenticated: !!token && !!user,
        sessionProfile,
        isOwnerMobileSession: sessionProfile === "owner_mobile",
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
