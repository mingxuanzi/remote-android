<template>
  <div class="detail">
    <el-card shadow="never" class="panel">
      <div class="head">
        <el-button :icon="Back" @click="$router.push('/')">返回列表</el-button>
        <span class="title">{{ instance?.name ?? id }}</span>
        <el-tag v-if="instance" :type="instance.status === 'running' ? 'success' : 'info'">
          {{ statusText(instance.status) }}
        </el-tag>
        <div class="spacer" />
        <el-button
          size="small" :loading="orienting"
          @click="toggleOrientation"
        >{{ instance?.orientation === 'landscape' ? '↺ 横屏' : instance?.orientation === 'portrait' ? '↻ 竖屏' : '⇄ 自然' }}</el-button>
        <el-radio-group v-model="playerMode" size="small">
          <el-radio-button value="v2">音视频 WS(推荐)</el-radio-button>
          <el-radio-button value="rtc">低延迟 WebRTC(实验)</el-radio-button>
          <el-radio-button value="ws">兼容模式</el-radio-button>
        </el-radio-group>
        <el-upload :show-file-list="false" accept=".apk" :auto-upload="false" :on-change="onApkPick">
          <el-button :loading="installing">安装 APK</el-button>
        </el-upload>
      </div>
      <div class="info" v-if="instance">
        <span>{{ instance.width }}×{{ instance.height }} @{{ instance.dpi }}dpi</span>
        <span>GPU:{{ instance.gpuMode === 'host' ? '宿主机硬渲' : '软件渲染' }}</span>
        <span class="hide-xs">镜像:{{ instance.image }}</span>
      </div>
    </el-card>

    <template v-if="instance?.status === 'running'">
      <PlayerV2 v-if="playerMode === 'v2'" :key="`v2-${instance.id}-${instance.orientation}`" :instance="instance" class="player" />
      <RtcPlayer v-else-if="playerMode === 'rtc'" :key="`rtc-${instance.id}-${instance.orientation}`" :instance="instance" class="player" />
      <Player v-else :key="`ws-${instance.id}-${instance.orientation}`" :instance="instance" class="player" />
    </template>
    <el-empty v-else-if="instance && isBusy(instance.status)" :description="`${statusText(instance.status)},请稍候…`" />
    <el-empty v-else description="实例未在运行,请先在列表页启动" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Back } from '@element-plus/icons-vue';
import type { UploadFile } from 'element-plus';
import { api } from '../api';
import { useInstanceStore } from '../stores/instance';
import Player from '../components/Player.vue';
import PlayerV2 from '../components/PlayerV2.vue';
import RtcPlayer from '../components/RtcPlayer.vue';

const props = defineProps<{ id: string }>();
const store = useInstanceStore();
const installing = ref(false);
const orienting = ref(false);
const playerMode = ref<'v2' | 'rtc' | 'ws'>('v2');

const isBusy = (s: string) => ['creating', 'starting', 'stopping', 'restarting'].includes(s);
const statusText = (s: string) => ({
  creating: '创建中', starting: '启动中', stopping: '停止中', restarting: '重启中',
  running: '运行中', stopped: '已停止', error: '异常',
}[s] ?? s);

/** 横屏/竖屏/自然 循环切换(游戏强制横屏时切到 landscape,视频跟随旋转)
 *  后端热重配推流会话,前端播放器按 key 重挂载自动重连 */
async function toggleOrientation(): Promise<void> {
  const inst = instance.value;
  if (!inst) return;
  const order = ['natural', 'landscape', 'portrait'] as const;
  const next = order[(order.indexOf(inst.orientation) + 1) % order.length];
  orienting.value = true;
  try {
    await api.setOrientation(inst.id, next);
    await store.refresh();
    ElMessage.success(next === 'landscape' ? '已切横屏(视频跟随旋转)' : next === 'portrait' ? '已切竖屏' : '已恢复自然方向');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    orienting.value = false;
  }
}

const instance = computed(() => store.list.find((i) => i.id === props.id));

async function onApkPick(file: UploadFile) {
  if (!file.raw) return;
  installing.value = true;
  try {
    const r = await api.installApk(props.id, file.raw);
    ElMessage.success(`APK 安装完成 ${r.output}`);
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    installing.value = false;
  }
}

onMounted(async () => {
  if (!store.list.length) await store.refresh();
});
</script>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 12px; align-items: center; }
.panel { width: 100%; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.title { font-size: 16px; font-weight: 600; }
.spacer { flex: 1; }
.info { margin-top: 8px; display: flex; gap: 20px; color: #909399; font-size: 13px; flex-wrap: wrap; }
.player { margin-top: 4px; }

/* 手机竖屏:头部控件换行占满,次要信息隐藏 */
@media (max-width: 768px) {
  .head { gap: 8px; }
  .hide-xs { display: none; }
}
</style>
