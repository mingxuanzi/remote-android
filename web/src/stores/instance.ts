import { defineStore } from 'pinia';
import { api, Instance, CreatePayload } from '../api';

/** 过渡态:操作已受理、容器尚未落定,轮询直到状态稳定 */
const TRANSITIONAL = new Set<Instance['status']>(['creating', 'starting', 'stopping', 'restarting']);

export const useInstanceStore = defineStore('instances', {
  state: () => ({
    list: [] as Instance[],
    loading: false,
    timer: 0 as number,
  }),
  actions: {
    async refresh() {
      this.loading = true;
      try {
        this.list = await api.listInstances();
      } finally {
        this.loading = false;
      }
    },
    /** 有实例处于过渡态(creating/starting/stopping/restarting)时自动轮询 */
    startPolling() {
      this.stopPolling();
      this.timer = window.setInterval(() => {
        if (this.list.some((i) => TRANSITIONAL.has(i.status))) void this.refresh();
      }, 2_000);
    },
    stopPolling() {
      if (this.timer) window.clearInterval(this.timer);
      this.timer = 0;
    },
    async create(p: CreatePayload) {
      await api.createInstances(p);
      await this.refresh();
      this.startPolling();
    },
    async act(id: string, action: 'start' | 'stop' | 'restart') {
      await api.action(id, action);
      await this.refresh();
      this.startPolling();
    },
    async remove(id: string) {
      await api.remove(id);
      await this.refresh();
    },
    async batch(action: 'start' | 'stop' | 'delete', ids: string[]) {
      await api.batch(action, ids);
      await this.refresh();
      this.startPolling();
    },
  },
});
