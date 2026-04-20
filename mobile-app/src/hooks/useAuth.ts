import { useState, useCallback, createContext, useContext } from "react";
import { authApi } from "../api/endpoints";
import { authStore } from "../store/authStore";
import type { User } from "../types";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  isLoading: true,
  login: async () => {},
  logout: async () => {},
  setUser: () => {},
  setToken: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthState() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const login = useCallback(
    async (email: string, password: string, _remember: boolean) => {
      const res = await authApi.login({ email, password });
      await authStore.saveToken(res.token);
      await authStore.saveUser(res.user);
      setToken(res.token);
      setUser(res.user);
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {}
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
    setIsLoading: setIsLoading as (value: boolean) => void,
  };
}
