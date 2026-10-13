import axios from 'axios';

export interface Instance {
  id: string;
  name: string;
  image: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  orientation: 'natural' | 'landscape' | 'portrait';
  cpus: number;
  memoryMb: number;
  ownerId: string;
  status: 'creating' | 'starting' | 'stopping' | 'restarting' | 'running' | 'stopped' | 'error';
  message: string;
  createdAt: number;
}

export interface Template {
  id: string;
  name: string;
  imageRef: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  sourceInstance: string;
  note: string;
  createdAt: number;
}

export interface UserInfo {
  id: string;
  username: string;
  role: 'admin' | 'user';
  maxInstances: number;
}

export interface CreatePayload {
  name?: string;
  image?: string;
  width: number;
  height: number;
  dpi: number;
  gpuMode: 'host' | 'guest';
  count: number;
  cpus: number;
  memoryMb: number;
}

export interface PlatformConfig {
  redroidImage: string;
  gpuDevice: string;
  scrcpyBitrate: number;
  scrcpyFps: number;
  scrcpyVersion: string;
}

const TOKEN_KEY = 'ra_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

const http = axios.create({ baseURL: '/api', timeout: 300_000 });

http.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

http.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401 && location.pathname !== '/login') {
      clearToken();
      location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export const api = {
  // 认证
  login: (username: string, password: string) =>
    http.post<{ token: string; user: UserInfo }>('/auth/login', { username, password }).then((r) => r.data),
  me: () => http.get<UserInfo>('/auth/me').then((r) => r.data),
  changePassword: (oldPassword: string, newPassword: string) =>
    http.post('/auth/change-password', { oldPassword, newPassword }).then((r) => r.data),

  // 实例
  listInstances: () => http.get<Instance[]>('/instances').then((r) => r.data),
  createInstances: (p: CreatePayload) => http.post<Instance[]>('/instances', p).then((r) => r.data),
  action: (id: string, action: 'start' | 'stop' | 'restart') =>
    http.post(`/instances/${id}/${action}`).then((r) => r.data),
  remove: (id: string) => http.delete(`/instances/${id}`).then((r) => r.data),
  batch: (action: 'start' | 'stop' | 'delete', ids: string[]) =>
    http.post<Record<string, string>>('/instances/batch', { action, ids }).then((r) => r.data),
  installApk: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('apk', file);
    return http.post<{ ok: boolean; output: string }>(`/instances/${id}/install`, fd).then((r) => r.data);
  },
  rtcStart: (id: string) =>
    http.post<{ whepUrl: string }>(`/instances/${id}/rtc/start`).then((r) => r.data),
  rtcReset: (id: string) =>
    http.post(`/instances/${id}/rtc/reset`).then((r) => r.data),
  setOrientation: (id: string, orientation: 'natural' | 'landscape' | 'portrait') =>
    http.patch(`/instances/${id}/orientation`, { orientation }).then((r) => r.data),

  // 快照模板
  listTemplates: () => http.get<Template[]>('/templates').then((r) => r.data),
  snapshot: (id: string, name: string, note?: string) =>
    http.post<Template>(`/instances/${id}/snapshot`, { name, note }).then((r) => r.data),
  spawnFromTemplate: (id: string, name: string, count: number) =>
    http.post<Instance[]>(`/templates/${id}/spawn`, { name, count }).then((r) => r.data),
  removeTemplate: (id: string) => http.delete(`/templates/${id}`).then((r) => r.data),

  // 用户管理(admin)
  listUsers: () => http.get<UserInfo[]>('/users').then((r) => r.data),
  createUser: (username: string, password: string, role: string, maxInstances: number) =>
    http.post('/users', { username, password, role, maxInstances }).then((r) => r.data),
  updateUser: (id: string, patch: { maxInstances?: number; role?: string; password?: string }) =>
    http.patch(`/users/${id}`, patch).then((r) => r.data),
  removeUser: (id: string) => http.delete(`/users/${id}`).then((r) => r.data),

  config: () => http.get<PlatformConfig>('/config').then((r) => r.data),
};
