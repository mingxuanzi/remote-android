import { defineStore } from 'pinia';
import { api, UserInfo, setToken, clearToken, getToken } from '../api';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as UserInfo | null,
  }),
  getters: {
    isAdmin: (s) => s.user?.role === 'admin',
  },
  actions: {
    async login(username: string, password: string) {
      const r = await api.login(username, password);
      setToken(r.token);
      this.user = r.user;
    },
    logout() {
      clearToken();
      this.user = null;
    },
    async fetchMe() {
      if (!getToken()) return;
      try {
        this.user = await api.me();
      } catch {
        /* 401 已被拦截器处理 */
      }
    },
  },
});
