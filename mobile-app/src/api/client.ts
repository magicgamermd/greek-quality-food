import axios from "axios";
import { authStore } from "../store/authStore";

// Base URL must be set via EXPO_PUBLIC_API_BASE_URL in .env
// Example: EXPO_PUBLIC_API_BASE_URL=http://192.168.1.100:3003
const BASE_URL =
  (process.env.EXPO_PUBLIC_API_BASE_URL as string) ||
  "http://localhost:3003"; // dev fallback (only works on simulator, not real device

export const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});

// ─── Request interceptor: attach JWT ─────────────────────────────────────────
apiClient.interceptors.request.use(async (config) => {
  const token = await authStore.getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ─── Response interceptor: handle 401 ────────────────────────────────────────
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await authStore.clearToken();
    }
    return Promise.reject(error);
  }
);

export default apiClient;
