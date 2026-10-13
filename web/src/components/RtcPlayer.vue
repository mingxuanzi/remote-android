<template>
  <div class="rtc-wrap">
    <div class="screen" :style="screenStyle">
      <video ref="videoRef" class="video" autoplay playsinline :muted="muted" />
      <div v-if="overlay" class="overlay">
        {{ overlay }}
        <el-button v-if="needRetry" size="small" type="primary" @click="start">重试</el-button>
      </div>

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
      <el-button :type="muted ? 'info' : 'success'" size="small" @click="toggleMute">
        {{ muted ? '🔇 取消静音' : '🔊 有声' }}
      </el-button>
      <span class="latency">WebRTC 视频 + WS PCM 音频</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, Instance, getToken } from '../api';
import { parseWireFrame } from '../player/h264';
import { PcmPlayer } from '../player/pcm';

const props = defineProps<{ instance: Instance }>();

const videoRef = ref<HTMLVideoElement>();
const overlay = ref('正在建立 WebRTC 连接…');
const needRetry = ref(false);
const dragging = ref(false);
/** 默认静音:浏览器禁止带声自动播放,未静音 autoplay 会被拦截导致黑屏;
 *  用户点"取消静音"(真实手势)时再出声 */
const muted = ref(true);
/** 初始画布按方向模式取实例规格:landscape 时视频流宽高互换,避免等 meta
 *  的数秒里画面框先竖屏后跳横屏(meta 到达后仍会以实测值校正) */
const landscape = props.instance.orientation === 'landscape';
const devW = ref(landscape ? props.instance.height : props.instance.width);
const devH = ref(landscape ? props.instance.width : props.instance.height);

/** 画布尺寸按宽高比自适应:竖屏限宽 420px,横屏放宽到 780px */
const screenStyle = computed(() => ({
  aspectRatio: `${devW.value} / ${devH.value}`,
  width: devW.value >= devH.value ? 'min(780px, 92vw)' : 'min(420px, 90vw)',
}));

let pc: RTCPeerConnection | null = null;
let ws: WebSocket | null = null;
let destroyed = false;
const pcm = new PcmPlayer();

function send(obj: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ---------- 控制 + 音频通道(WS:触控指令上行,PCM 音频下行 channel 2) ---------- */
function connectControl(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}/ws/stream/${props.instance.id}?mode=rtc&token=${encodeURIComponent(getToken())}`,
  );
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const meta = JSON.parse(ev.data);
        if (meta.type === 'meta') { devW.value = meta.width; devH.value = meta.height; }
      } catch { /* 忽略 */ }
      return;
    }
    const dv = new DataView(ev.data);
    if (dv.getUint8(0) === 2 && ev.data.byteLength >= 13) {
      const size = dv.getUint32(9);
      if (size <= ev.data.byteLength - 13) {
        pcm.feed(parseWireFrame(ev.data.slice(1)).payload);
      }
    }
  };
  ws.onclose = () => {
    if (!destroyed) setTimeout(connectControl, 3_000);
  };
}

/* ---------- WHEP 拉流(纯视频轨;音频走 WS PCM) ---------- */
let resetDone = false; // 硬重置只触发一次,防止循环重置

async function start(): Promise<void> {
  needRetry.value = false;
  overlay.value = '正在建立 WebRTC 连接…';

  // 1. 预热后端会话(scrcpy 2.4 → JS RTP → MediaMTX;服务端会等到首发 IDR 补发完才返回),幂等
  let { whepUrl } = await api.rtcStart(props.instance.id);

  // 2. WHEP 协商(MediaMTX 非 trickle,服务端等 ICE 候选收齐);流未就绪时 404,重试
  //  必须同时带 video+audio 两个 recvonly m-line:实测 MediaMTX 1.9.3 对单视频 m-line
  //  的 WHEP offer 建立会话后不做媒体转发(零包),双流 offer 才正常下发视频;
  //  音频轨没有对应源会被拒绝,实际音频走 WS PCM 通道
  for (let attempt = 1; attempt <= 20 && !destroyed; attempt++) {
    pc = new RTCPeerConnection();
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      if (videoRef.value && e.streams[0]) {
        videoRef.value.srcObject = e.streams[0];
        // 显式播放兜底:静音状态下 autoplay 一定被允许
        videoRef.value.muted = muted.value;
        void videoRef.value.play().catch(() => void 0);
        overlay.value = '';
        armWatchdog();
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'closed'].includes(pc.connectionState)) {
        overlay.value = 'WebRTC 连接断开,重试中…';
        void retryLater();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (res.ok) {
      const answer = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      return;
    }
    pc.close();
    pc = null;

    // 连续失败 → 后端会话可能处于坏状态,硬重置一次(销毁重建;路径代次会变,必须换新地址)
    if (attempt === 8 && !resetDone) {
      resetDone = true;
      overlay.value = '推流会话异常,正在重建…';
      await api.rtcReset(props.instance.id).catch(() => void 0);
      await new Promise((r) => setTimeout(r, 3_000));
      whepUrl = (await api.rtcStart(props.instance.id)).whepUrl;
      continue;
    }

    overlay.value = `流未就绪(HTTP ${res.status}),${attempt} 次重试中…`;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (!destroyed) {
    overlay.value = '连接失败,点击重试';
    needRetry.value = true;
  }
}

function retryLater(): void {
  if (destroyed) return;
  setTimeout(() => { if (!destroyed) void start().catch(() => void 0); }, 3_000);
}

/** 候选不可达时 MediaMTX 会"已建立但零媒体",看门狗 10s 无帧即重连换候选。
 *  10s 而非 6s:首启时"等保温 IDR"是合法等待,6s 太紧会误触发一次重连才能出图 */
let watchdog = 0;
function armWatchdog(): void {
  window.clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    if (destroyed) return;
    const v = videoRef.value;
    if (v && v.currentTime > 0.05) return; // 已出帧,链路正常
    overlay.value = '媒体流未送达,重连中…';
    needRetry.value = false;
    pc?.close();
    pc = null;
    setTimeout(() => { if (!destroyed) void start().catch(() => void 0); }, 1_000);
  }, 10_000);
}

/* ---------- 触控(Pointer Events:鼠标/触屏统一) ---------- */
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

function toggleMute(): void {
  muted.value = !muted.value;
  pcm.setOn(!muted.value);
}

const KEY_MAP: Record<string, number> = {
  Backspace: 67, Enter: 66, Tab: 61, Escape: 111,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Delete: 112, Home: 122, End: 123, PageUp: 92, PageDown: 93,
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

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keyup', onKeyup);
  await pcm.init();
  connectControl();
  try {
    await start();
  } catch (e) {
    overlay.value = `连接失败:${e instanceof Error ? e.message : e}`;
    needRetry.value = true;
  }
});

onUnmounted(() => {
  destroyed = true;
  window.clearTimeout(watchdog);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keyup', onKeyup);
  ws?.close();
  pc?.close();
  pcm.dispose();
});
</script>

<style scoped>
.rtc-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; }
.screen {
  position: relative; max-height: 78vh; margin: 0 auto;
  background: #000; border-radius: 10px; overflow: hidden;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.video { width: 100%; height: 100%; display: block; object-fit: contain; }
.overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center;
  color: #fff; background: rgba(0, 0, 0, 0.6); font-size: 14px;
}
.touch-layer { position: absolute; inset: 0; cursor: pointer; touch-action: none; }
.controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.latency { color: #67c23a; font-size: 12px; }

@media (max-width: 768px) {
  .latency { display: none; }
}
</style>
