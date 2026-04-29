import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

import type { User } from "../types";

const TOKEN_KEY = "mertm_jwt_token";
const USER_KEY = "mertm_user";

export const authStore = {
  async getToken(): Promise<string | null> {
    try {
      return await SecureStore.getItemAsync(TOKEN_KEY);
    } catch {
      return AsyncStorage.getItem(TOKEN_KEY);
    }
  },

  async saveToken(token: string): Promise<void> {
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
    } catch {
      await AsyncStorage.setItem(TOKEN_KEY, token);
    }
  },

  async clearToken(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } catch {
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
    await AsyncStorage.removeItem(USER_KEY);
  },

  async saveUser(user: User): Promise<void> {
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  async getUser(): Promise<User | null> {
    const raw = await AsyncStorage.getItem(USER_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as User;
    } catch {
      return null;
    }
  },
};
