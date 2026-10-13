/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

declare module 'broadway-player';

// WebCodecs 类型补充(TS lib 版本不足时的兜底)
interface VideoDecoderConfig {
  codec: string;
  description?: BufferSource;
  optimizeForLatency?: boolean;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

