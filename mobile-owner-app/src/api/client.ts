import axios from "axios";

import { authStore } from "../store/authStore";

const BASE_URL =
  (process.env.EXPO_PUBLIC_API_BASE_URL as string) || "http://localhost:3003";

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});

client.interceptors.request.use(async (config) => {
  const token = await authStore.getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await authStore.clearToken();
    }
    return Promise.reject(error);
  },
);

export default client;
