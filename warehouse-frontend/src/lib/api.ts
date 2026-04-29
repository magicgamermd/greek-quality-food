import axios from "axios";
import { toast } from "sonner";

// Use VITE_API_URL env var if set, otherwise use relative /api (proxied by Vite in dev, nginx in prod)
const BASE_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: BASE_URL,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 403 &&
      error.response.data?.required_permission
    ) {
      window.dispatchEvent(new CustomEvent("permissions:revoked"));
      try {
        toast.warning("Разрешенията ти са променени. Опитай пак.");
      } catch {
        // toast lib not loaded — ignore
      }
    }
    if (
      error.response?.status === 401 &&
      !error.config?.url?.includes("/auth/")
    ) {
      // Dispatch event so AuthContext handles logout via React state
      // instead of hard window.location redirect which destroys SPA state
      window.dispatchEvent(new Event("auth:unauthorized"));
    }
    return Promise.reject(error);
  },
);
