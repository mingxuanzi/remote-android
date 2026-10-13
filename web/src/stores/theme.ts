import { defineStore } from 'pinia';

const KEY = 'ra_theme';

/** 日/夜间模式:写入 localStorage,切换 html.dark class,默认跟随系统 */
export const useThemeStore = defineStore('theme', {
  state: () => {
    const saved = localStorage.getItem(KEY);
    const isDark = saved
      ? saved === 'dark'
      : window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    return { isDark };
  },
  actions: {
    /** 把当前状态应用到 DOM 并持久化(应用启动时也要调一次) */
    apply() {
      document.documentElement.classList.toggle('dark', this.isDark);
      localStorage.setItem(KEY, this.isDark ? 'dark' : 'light');
    },
    toggle() {
      this.isDark = !this.isDark;
      this.apply();
    },
  },
});
