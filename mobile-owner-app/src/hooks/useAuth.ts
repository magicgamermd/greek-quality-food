import { createContext, useCallback, useContext, useState } from "react";

import { authApi } from "../api/endpoints";
import { authStore } from "../store/authStore";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setIsLoading: (value: boolean) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  isLoading: true,
  login: async () => {},
  logout: async () => {},
  setUser: () => {},
  setToken: () => {},
  setIsLoading: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthState(): AuthContextValue {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const login = useCallback(async (email: string, password: string) => {
    const auth = await authApi.login({ email, password });
    let resolvedUser = auth.user;

    try {
      const me = await authApi.me();
      resolvedUser = me;
    } catch {
      // Login response user is enough for owner app startup.
    }

    await authStore.saveToken(auth.token);
    await authStore.saveUser(resolvedUser);
    setToken(auth.token);
    setUser(resolvedUser);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore network errors while clearing local session.
    }

    await authStore.clearToken();
    setToken(null);
    setUser(null);
  }, []);

  return {
    user,
    token,
    isLoading,
    login,
    logout,
    setUser,
    setToken,
    setIsLoading,
  };
}
