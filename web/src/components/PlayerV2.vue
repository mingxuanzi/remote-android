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
      <el-button :type="audioOn ? 'success' : 'info'" size="small" @click="toggleAudio">
        {{ audioOn ? '🔊 音频开' : '🔇 音频关' }}
      </el-button>
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

/**
 * v2 播放器:scrcpy 2.4 over WebSocket
 * 二进制帧:[channel 1B][ptsAndFlags 8B][size 4B][payload]
 *   channel 1 = H264 视频(WebCodecs 硬解)
 *   channel 2 = PCM s16le 48kHz 立体声(AudioWorklet 播放)
 */

const props = defineProps<{ instance: Instance }>();

const screenRef = ref<HTMLDivElement>();
const canvasRef = ref<HTMLCanvasElement>();
const connected = ref(false);
const overlayText = ref('正在连接推流…');
const dragging = ref(false);
const text = ref('');
const audioOn = ref(true);
/** 初始画布按方向模式取实例规格:landscape 时视频流宽高互换,避免等 WS meta
 *  的数秒里画面框先竖屏后跳横屏(meta 到达后仍会以实测值校正) */
const landscape = props.instance.orientation === 'landscape';
const devW = ref(landscape ? props.instance.height : props.instance.width);
const devH = ref(landscape ? props.instance.width : props.instance.height);
const useWebCodecs = hasWebCodecs; // HTTP 非安全上下文 → 走 broadway 软解

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

function decodeVideo(frame: ReturnType<typeof parseWireFrame>): void {
  if (useWebCodecs) decoder.decode(frame);
  else broadway?.decode(frame);
}

/* ---------- PCM 音频(AudioWorklet 环形缓冲,积压超过 0.4s 自动丢弃保延迟) ---------- */
let audioCtx: AudioContext | null = null;
let audioNode: AudioWorkletNode | null = null;
let spNode: ScriptProcessorNode | null = null;

// 降级路径用的主线程环形缓冲
const ring = { buf: new Int16Array(48000 * 2 * 2), w: 0, r: 0 };
function ringPush(d: Int16Array): void {
  for (let i = 0; i < d.length; i++) { ring.buf[ring.w] = d[i]; ring.w = (ring.w + 1) % ring.buf.length; }
  const used = (ring.w - ring.r + ring.buf.length) % ring.buf.length;
  const cap = Math.floor(ring.buf.length * 0.2); // 0.4s
  if (used > cap) ring.r = (ring.w - cap + ring.buf.length) % ring.buf.length;
}

const WORKLET_CODE = `
class RaPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 48000 * 2 * 2; // 2s 环形
    this.buf = new Int16Array(this.size);
    this.w = 0; this.r = 0;
    this.port.onmessage = (e) => {
      const d = new Int16Array(e.data);
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % this.size; }
      const used = (this.w - this.r + this.size) % this.size;
      const cap = Math.floor(this.size * 0.2); // 0.4s
      if (used > cap) this.r = (this.w - cap + this.size) % this.size; // 丢旧保新
    };
  }
  process(_, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      const used = (this.w - this.r + this.size) % this.size;
      if (used >= 2) {
        L[i] = this.buf[this.r] / 32768; this.r = (this.r + 1) % this.size;
        R[i] = this.buf[this.r] / 32768; this.r = (this.r + 1) % this.size;
      } else { L[i] = 0; R[i] = 0; }
    }
    return true;
  }
}
registerProcessor('ra-pcm', RaPcm);
`;

async function initAudio(): Promise<void> {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext({ sampleRate: 48000 });
    if (audioCtx.audioWorklet) {
      // 安全上下文:AudioWorklet 低延迟播放
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      await audioCtx.audioWorklet.addModule(URL.createObjectURL(blob));
      audioNode = new AudioWorkletNode(audioCtx, 'ra-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
      audioNode.connect(audioCtx.destination);
    } else {
      // HTTP 非安全上下文降级:ScriptProcessor + 主线程环形缓冲
      spNode = audioCtx.createScriptProcessor(4096, 0, 2);
      spNode.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : L;
        for (let i = 0; i < L.length; i++) {
          const used = (ring.w - ring.r + ring.buf.length) % ring.buf.length;
          if (used >= 2) {
            L[i] = ring.buf[ring.r] / 32768; ring.r = (ring.r + 1) % ring.buf.length;
            R[i] = ring.buf[ring.r] / 32768; ring.r = (ring.r + 1) % ring.buf.length;
          } else { L[i] = 0; R[i] = 0; }
        }
      };
      spNode.connect(audioCtx.destination);
    }
  } catch (e) {
    console.warn('音频初始化失败(仅视频):', e);
  }
}

function feedAudio(payload: Uint8Array): void {
  if (!audioOn.value) return;
  if (audioNode) {
    const copy = payload.slice().buffer;
    audioNode.port.postMessage(copy, [copy]);
  } else if (spNode) {
    ringPush(new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1));
  }
}

function toggleAudio(): void {
  audioOn.value = !audioOn.value;
  if (audioOn.value && audioCtx?.state === 'suspended') void audioCtx.resume();
}

/* ---------- 控制 ---------- */
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
    send({ t: 'key', action: 0, keycode: code });
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    send({ t: 'text', text: e.key });
  }
}
function onKeyup(e: KeyboardEvent): void {
  const code = KEY_MAP[e.key];
  if (code !== undefined) send({ t: 'key', action: 1, keycode: code });
}

/* ---------- 连接 ---------- */
function parseChannelFrame(buf: ArrayBuffer): { channel: number; frame: ReturnType<typeof parseWireFrame> } {
  const dv = new DataView(buf);
  const channel = dv.getUint8(0);
  // 复用 v1 解析:跳过 channel 字节后是同构的 [ptsAndFlags 8B][size 4B][payload]
  return { channel, frame: parseWireFrame(buf.slice(1)) };
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}/ws/stream/${props.instance.id}?mode=v2&token=${encodeURIComponent(getToken())}`,
  );
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
    const { channel, frame } = parseChannelFrame(ev.data);
    if (channel === 1) decodeVideo(frame);
    else if (channel === 2) feedAudio(frame.payload);
  };
}

onMounted(async () => {
  if (useWebCodecs) {
    ctx = canvasRef.value?.getContext('2d') ?? null;
  } else {
    // HTTP 等非安全上下文:WebCodecs 不可用,挂 broadway 软解画布
    broadway = new BroadwaySink(devW.value, devH.value);
    screenRef.value?.insertBefore(broadway.canvas, screenRef.value.firstChild);
    overlayText.value = '';
  }
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keyup', onKeyup);
  await initAudio();
  connect();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keyup', onKeyup);
  ws?.close();
  decoder.destroy();
  broadway?.destroy();
  spNode?.disconnect();
  void audioCtx?.close();
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
