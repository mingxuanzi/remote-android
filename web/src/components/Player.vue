<template>
  <div class="player-wrap">
    <div class="screen" ref="screenRef" :style="screenStyle">
      <canvas v-show="useWebCodecs" ref="canvasRef" class="canvas" />
      <div v-if="!connected" class="overlay">{{ overlayText }}</div>

      <!-- 触控层(Pointer Events:同时支持鼠标与手机触屏) -->
      <div
        class="touch-layer"
        @pointerdown.prevent="onTouch(0, $event)"
        @pointermove.prevent="dragging && onTouch(2, $event)"
        @pointerup.prevent="onTouch(1, $event)"
        @pointercancel.prevent="dragging && onTouch(1, $event)"
        @wheel.prevent="onWheel"
        @contextmenu.prevent
      />
    </div>

    <div class="controls">
      <el-button circle title="返回" @click="tapKey(4)">⬅</el-button>
      <el-button circle title="主页" @click="tapKey(3)">🏠</el-button>
      <el-button circle title="多任务" @click="tapKey(187)">▦</el-button>
      <el-button circle title="电源" @click="tapKey(26)">⏻</el-button>
      <el-button circle title="音量+" @click="tapKey(24)">🔊</el-button>
      <el-button circle title="音量-" @click="tapKey(25)">🔉</el-button>
      <el-input
        v-model="text" placeholder="输入文本回车注入" size="small" class="text-input"
        @keyup.enter="injectText"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Instance, getToken } from '../api';
import { H264Decoder, parseWireFrame } from '../player/h264';
import { BroadwaySink, hasWebCodecs } from '../player/broadway';

const props = defineProps<{ instance: Instance }>();

const screenRef = ref<HTMLDivElement>();
const canvasRef = ref<HTMLCanvasElement>();
const connected = ref(false);
const overlayText = ref('正在连接推流…');
const dragging = ref(false);
const text = ref('');
/** 初始画布按方向模式取实例规格:landscape 时视频流宽高互换,避免等 WS meta
 *  的数秒里画面框先竖屏后跳横屏(meta 到达后仍会以实测值校正) */
const landscape = props.instance.orientation === 'landscape';
const devW = ref(landscape ? props.instance.height : props.instance.width);
const devH = ref(landscape ? props.instance.width : props.instance.height);
const useWebCodecs = hasWebCodecs; // HTTP 非安全上下文 → broadway 软解

/** 画布尺寸按宽高比自适应:竖屏限宽 420px,横屏放宽到 780px */
const screenStyle = computed(() => ({
  aspectRatio: `${devW.value} / ${devH.value}`,
  width: devW.value >= devH.value ? 'min(780px, 92vw)' : 'min(420px, 90vw)',
}));

let ws: WebSocket | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let broadway: BroadwaySink | null = null;

const decoder = new H264Decoder();
decoder.onFrame = (frame) => {
  const canvas = canvasRef.value;
  if (!canvas || !ctx) { frame.close(); return; }
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }
  ctx.drawImage(frame, 0, 0);
  frame.close();
};

function send(obj: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/** 屏幕坐标 → 设备坐标(鼠标/触屏通用) */
interface PointLike { clientX: number; clientY: number; }

function toDevice(e: PointLike & { currentTarget?: EventTarget | null }): { x: number; y: number } {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * devW.value)),
    y: Math.max(0, Math.round(((e.clientY - rect.top) / rect.height) * devH.value)),
  };
}

function onTouch(action: 0 | 1 | 2, e: PointerEvent): void {
  if (action === 0) {
    dragging.value = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  if (action === 1) dragging.value = false;
  const { x, y } = toDevice(e);
  send({ t: 'touch', action, id: 0, x, y });
}

function onWheel(e: WheelEvent): void {
  const { x, y } = toDevice(e as unknown as PointLike);
  // 120 一档 → scrcpy 滚动单位 1
  send({ t: 'scroll', x, y, hScroll: 0, vScroll: -Math.sign(e.deltaY) });
}

function tapKey(keycode: number): void {
  send({ t: 'key', action: 0, keycode });
  send({ t: 'key', action: 1, keycode });
}

function injectText(): void {
  if (!text.value) return;
  send({ t: 'text', text: text.value });
  text.value = '';
}

/** 物理键盘 → Android 键码(常用子集),可打印字符走文本注入 */
const KEY_MAP: Record<string, number> = {
  Backspace: 67, Enter: 66, Tab: 61, Escape: 111,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Delete: 112, Home: 122, End: 123, PageUp: 92, PageDown: 93,
  F1: 131, F2: 132, F3: 133, F4: 134,
};
function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
  const code = KEY_MAP[e.key];
  if (code !== undefined) {
    e.preventDefault();
    send({ t: 'key', action: e.type === 'keydown' ? 0 : 1, keycode: code });
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    send({ t: 'text', text: e.key });
  }
}
function onKeyup(e: KeyboardEvent): void {
  const code = KEY_MAP[e.key];
  if (code !== undefined) send({ t: 'key', action: 1, keycode: code });
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/stream/${props.instance.id}?token=${encodeURIComponent(getToken())}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => { connected.value = true; };
  ws.onclose = (e) => {
    connected.value = false;
    overlayText.value = e.reason ? `连接断开:${e.reason}` : '连接断开,5 秒后重试…';
    setTimeout(connect, 5_000);
  };
  ws.onerror = () => { connected.value = false; };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const meta = JSON.parse(ev.data);
      if (meta.type === 'meta') { devW.value = meta.width; devH.value = meta.height; }
      return;
    }
    const frame = parseWireFrame(ev.data);
    if (useWebCodecs) decoder.decode(frame);
    else broadway?.decode(frame);
  };
}

onMounted(() => {
  if (useWebCodecs) {
    ctx = canvasRef.value?.getContext('2d') ?? null;
  } else {
    broadway = new BroadwaySink(devW.value, devH.value);
    screenRef.value?.insertBefore(broadway.canvas, screenRef.value.firstChild);
  }
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keyup', onKeyup);
  connect();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keyup', onKeyup);
  ws?.close();
  decoder.destroy();
  broadway?.destroy();
});
</script>

<style scoped>
.player-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; }
.screen {
  position: relative; max-height: 78vh; margin: 0 auto;
  background: #000; border-radius: 10px; overflow: hidden;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.canvas { width: 100%; height: 100%; display: block; }
.overlay {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, 0.6); font-size: 14px; pointer-events: none;
}
.touch-layer { position: absolute; inset: 0; cursor: pointer; touch-action: none; z-index: 1; }
.controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.text-input { width: 220px; }

@media (max-width: 768px) {
  .text-input { width: 150px; }
}
</style>
