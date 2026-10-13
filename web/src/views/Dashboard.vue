<template>
  <div>
    <el-tabs v-model="tab" type="border-card">
      <!-- ================= 实例 ================= -->
      <el-tab-pane label="实例" name="instances">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="createVisible = true">新建实例</el-button>
          <el-button :disabled="!selected.length" @click="onBatch('start')">批量启动</el-button>
          <el-button :disabled="!selected.length" @click="onBatch('stop')">批量停止</el-button>
          <el-button type="danger" :disabled="!selected.length" @click="onBatch('delete')">批量删除</el-button>
          <el-button :icon="Refresh" circle @click="store.refresh()" />
          <span class="hint">共 {{ store.list.length }} 个实例 · 运行中 {{ runningCount }}</span>
        </div>

        <el-table
          :data="store.list" v-loading="store.loading" row-key="id" class="inst-table"
          @selection-change="(rows: Instance[]) => (selected = rows)"
        >
          <el-table-column v-if="!compact" type="selection" width="45" />
          <el-table-column label="实例" :min-width="compact ? 130 : 170">
            <template #default="{ row }">
              <router-link :to="`/instance/${row.id}`">{{ row.name }}</router-link>
              <div class="sub">{{ row.image }}</div>
            </template>
          </el-table-column>
          <el-table-column v-if="!compact" label="分辨率" width="130">
            <template #default="{ row }">{{ row.width }}×{{ row.height }} @{{ row.dpi }}dpi</template>
          </el-table-column>
          <el-table-column v-if="!compact" label="资源" width="90">
            <template #default="{ row }">{{ row.cpus }}C/{{ (row.memoryMb / 1024).toFixed(0) }}G</template>
          </el-table-column>
          <el-table-column v-if="!compact" label="GPU" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.gpuMode === 'host' ? 'success' : 'info'">
                {{ row.gpuMode === 'host' ? '硬件' : '软渲' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="105">
            <template #default="{ row }">
              <el-tag
                :type="statusType(row.status)"
                :effect="isBusy(row.status) ? 'plain' : 'dark'"
              >
                {{ statusText(row.status) }}
              </el-tag>
              <el-tooltip v-if="row.message" :content="row.message">
                <el-icon class="warn"><Warning /></el-icon>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column v-if="!compact" label="创建时间" width="165">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="操作" :width="compact ? 124 : 250" :fixed="compact ? false : 'right'">
            <template #default="{ row }">
              <div class="ops">
                <el-button
                  v-if="row.status === 'stopped' || row.status === 'error'"
                  size="small" :loading="startingId === row.id" @click="onStart(row)"
                >启动</el-button>
                <el-button
                  v-if="row.status === 'running'" size="small"
                  :loading="stoppingId === row.id" @click="onStop(row)"
                >停止</el-button>
                <el-button
                  v-if="row.status === 'running'" size="small"
                  :loading="restartingId === row.id" @click="onRestart(row)"
                >重启</el-button>
                <el-button
                  v-if="row.status === 'running'" size="small" type="primary"
                  @click="$router.push(`/instance/${row.id}`)"
                >投屏</el-button>
                <el-button
                  v-if="row.status === 'running'" size="small" type="warning" plain
                  @click="openSnapshot(row)"
                >存快照</el-button>
                <el-popconfirm title="删除该实例及其容器?" @confirm="store.remove(row.id)">
                  <template #reference>
                    <el-button size="small" type="danger" :disabled="isBusy(row.status)">删除</el-button>
                  </template>
                </el-popconfirm>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ================= 快照模板 ================= -->
      <el-tab-pane label="快照模板" name="templates">
        <div class="toolbar">
          <el-button :icon="Refresh" circle @click="loadTemplates" />
          <span class="hint">快照 = 实例当前状态的完整镜像(含已装应用与数据),可秒级克隆新实例</span>
        </div>
        <el-table :data="templates" v-loading="templatesLoading" row-key="id">
          <el-table-column prop="name" label="模板名" min-width="150" />
          <el-table-column label="分辨率" width="140">
            <template #default="{ row }">{{ row.width }}×{{ row.height }} @{{ row.dpi }}dpi</template>
          </el-table-column>
          <el-table-column prop="sourceInstance" label="来源实例" width="140" />
          <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
          <el-table-column label="创建时间" width="165">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="操作" :width="compact ? 150 : 240" :fixed="compact ? false : 'right'">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="openSpawn(row)">克隆实例</el-button>
              <el-popconfirm title="删除模板镜像?" @confirm="onRemoveTemplate(row.id)">
                <template #reference><el-button size="small" type="danger">删除</el-button></template>
              </el-popconfirm>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ================= 用户管理(admin) ================= -->
      <el-tab-pane v-if="auth.isAdmin" label="用户管理" name="users">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="openCreateUser">新建用户</el-button>
          <el-button :icon="Refresh" circle @click="loadUsers" />
        </div>
        <el-table :data="users" v-loading="usersLoading" row-key="id">
          <el-table-column prop="username" label="用户名" min-width="140" />
          <el-table-column label="角色" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.role === 'admin' ? 'warning' : 'info'">
                {{ row.role === 'admin' ? '管理员' : '用户' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="实例配额" width="130">
            <template #default="{ row }">
              <el-input-number
                v-model="row.maxInstances" :min="1" :max="999" size="small"
                @change="(v: number) => onUpdateUser(row.id, { maxInstances: v })"
              />
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="180">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200">
            <template #default="{ row }">
              <el-button size="small" @click="openResetPwd(row)">重置密码</el-button>
              <el-popconfirm title="删除该用户?(其实例保留归 admin)" @confirm="onRemoveUser(row.id)">
                <template #reference>
                  <el-button size="small" type="danger" :disabled="row.id === auth.user?.id">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 新建实例 -->
    <el-dialog v-model="createVisible" title="新建模拟器实例" width="480px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="名称前缀">
          <el-input v-model="form.name" placeholder="留空自动生成(多开时自动编号)" />
        </el-form-item>
        <el-form-item label="安卓镜像">
          <el-select v-model="form.image" style="width: 100%">
            <el-option v-for="img in imageOptions" :key="img" :label="img" :value="img" />
          </el-select>
        </el-form-item>
        <el-form-item label="分辨率">
          <el-select v-model="resolution" style="width: 100%">
            <el-option label="1080 × 1920(竖屏手机)" value="1080x1920" />
            <el-option label="1920 × 1080(横屏平板)" value="1920x1080" />
            <el-option label="720 × 1280(低占密开)" value="720x1280" />
            <el-option label="1600 × 900(横屏轻量)" value="1600x900" />
          </el-select>
        </el-form-item>
        <el-form-item label="DPI">
          <el-input-number v-model="form.dpi" :min="160" :max="640" />
        </el-form-item>
        <el-form-item label="CPU 核心">
          <el-input-number v-model="form.cpus" :min="1" :max="32" />
        </el-form-item>
        <el-form-item label="内存 MB">
          <el-input-number v-model="form.memoryMb" :min="512" :max="65536" :step="1024" />
        </el-form-item>
        <el-form-item label="GPU 渲染">
          <el-radio-group v-model="form.gpuMode">
            <el-radio value="host">宿主机 GPU(推荐)</el-radio>
            <el-radio value="guest">软件渲染</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="多开数量">
          <el-input-number v-model="form.count" :min="1" :max="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="onCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 存快照 -->
    <el-dialog v-model="snapshotVisible" title="保存实例快照" width="420px">
      <el-form label-width="90px">
        <el-form-item label="来源实例">
          <el-input :model-value="snapshotTarget?.name" disabled />
        </el-form-item>
        <el-form-item label="模板名">
          <el-input v-model="snapshotForm.name" placeholder="如 wechat-ready" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="snapshotForm.note" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="snapshotVisible = false">取消</el-button>
        <el-button type="primary" :loading="snapshotting" @click="onSnapshot">保存</el-button>
      </template>
    </el-dialog>

    <!-- 从模板克隆 -->
    <el-dialog v-model="spawnVisible" title="从模板克隆实例" width="420px">
      <el-form label-width="90px">
        <el-form-item label="模板">
          <el-input :model-value="spawnTarget?.name" disabled />
        </el-form-item>
        <el-form-item label="名称前缀">
          <el-input v-model="spawnForm.name" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="spawnForm.count" :min="1" :max="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="spawnVisible = false">取消</el-button>
        <el-button type="primary" :loading="spawning" @click="onSpawn">克隆</el-button>
      </template>
    </el-dialog>

    <!-- 新建用户 -->
    <el-dialog v-model="userVisible" title="新建用户" width="420px">
      <el-form label-width="90px">
        <el-form-item label="用户名">
          <el-input v-model="userForm.username" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="userForm.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="userForm.role">
            <el-radio value="user">用户</el-radio>
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="实例配额">
          <el-input-number v-model="userForm.maxInstances" :min="1" :max="999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userVisible = false">取消</el-button>
        <el-button type="primary" :loading="userSaving" @click="onCreateUser">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重置密码 -->
    <el-dialog v-model="resetPwdVisible" :title="`重置密码:${resetPwdTarget?.username}`" width="380px">
      <el-input v-model="resetPwdValue" type="password" show-password placeholder="新密码,至少 6 位" />
      <template #footer>
        <el-button @click="resetPwdVisible = false">取消</el-button>
        <el-button type="primary" @click="onResetPwd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Refresh, Warning } from '@element-plus/icons-vue';
import { api, Instance, Template, UserInfo } from '../api';
import { useInstanceStore } from '../stores/instance';
import { useAuthStore } from '../stores/auth';

const store = useInstanceStore();
const auth = useAuthStore();
const tab = ref('instances');

/* 手机竖屏/窄屏模式:隐藏次要列、操作列不吸附,避免 fixed 列在小屏重叠 */
const mq = window.matchMedia('(max-width: 768px)');
const compact = ref(mq.matches);
const onMq = () => { compact.value = mq.matches; };
mq.addEventListener('change', onMq);
onUnmounted(() => mq.removeEventListener('change', onMq));

/* ---------- 实例 ---------- */
const selected = ref<Instance[]>([]);
const createVisible = ref(false);
const creating = ref(false);

const form = reactive({
  name: '', image: '', dpi: 440,
  gpuMode: 'host' as 'host' | 'guest',
  count: 1, width: 1080, height: 1920,
  cpus: 2, memoryMb: 2048,
});
const resolution = ref('1080x1920');
watch(resolution, (v) => {
  const [w, h] = v.split('x').map(Number);
  form.width = w; form.height = h;
});

const imageOptions = computed(() => {
  const base = 'redroid/redroid';
  const tags = ['11.0.0-latest', '12.0.0-latest', '13.0.0-latest', '14.0.0-latest', '15.0.0-latest'];
  return tags.map((t) => `${base}:${t}`);
});

const runningCount = computed(() => store.list.filter((i) => i.status === 'running').length);

const BUSY = new Set(['creating', 'starting', 'stopping', 'restarting']);
const isBusy = (s: Instance['status']) => BUSY.has(s);

function statusType(s: Instance['status']) {
  return {
    creating: 'warning', starting: 'warning', stopping: 'warning', restarting: 'warning',
    running: 'success', stopped: 'info', error: 'danger',
  }[s] as 'warning' | 'success' | 'info' | 'danger';
}
function statusText(s: Instance['status']) {
  return {
    creating: '创建中', starting: '启动中', stopping: '停止中', restarting: '重启中',
    running: '运行中', stopped: '已停止', error: '异常',
  }[s];
}

/** 停止/重启/启动:后端已受理即返回过渡态,轮询实时刷新状态;按钮 loading 到状态翻转为止 */
const stoppingId = ref('');
const restartingId = ref('');
const startingId = ref('');

async function onStart(row: Instance) {
  startingId.value = row.id;
  try {
    await store.act(row.id, 'start');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
    startingId.value = '';
  }
}

async function onStop(row: Instance) {
  stoppingId.value = row.id;
  try {
    await store.act(row.id, 'stop');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
    stoppingId.value = '';
  }
}

async function onRestart(row: Instance) {
  restartingId.value = row.id;
  try {
    await store.act(row.id, 'restart');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
    restartingId.value = '';
  }
}

watch(
  () => store.list.map((i) => `${i.id}:${i.status}`).join(','),
  () => {
    const done = (id: string) =>
      id && !isBusy(store.list.find((i) => i.id === id)?.status ?? 'stopped');
    if (done(stoppingId.value)) stoppingId.value = '';
    if (done(restartingId.value)) restartingId.value = '';
    if (done(startingId.value)) startingId.value = '';
  },
);

async function onCreate() {
  creating.value = true;
  try {
    await store.create({
      name: form.name || undefined, image: form.image || undefined,
      width: form.width, height: form.height, dpi: form.dpi,
      gpuMode: form.gpuMode, count: form.count,
      cpus: form.cpus, memoryMb: form.memoryMb,
    });
    createVisible.value = false;
    ElMessage.success('创建任务已提交');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    creating.value = false;
  }
}

async function onBatch(action: 'start' | 'stop' | 'delete') {
  try {
    await store.batch(action, selected.value.map((i) => i.id));
    ElMessage.success('批量操作完成');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  }
}

/* ---------- 快照模板 ---------- */
const templates = ref<Template[]>([]);
const templatesLoading = ref(false);
const snapshotVisible = ref(false);
const snapshotting = ref(false);
const snapshotTarget = ref<Instance | null>(null);
const snapshotForm = reactive({ name: '', note: '' });
const spawnVisible = ref(false);
const spawning = ref(false);
const spawnTarget = ref<Template | null>(null);
const spawnForm = reactive({ name: '', count: 1 });

async function loadTemplates() {
  templatesLoading.value = true;
  try {
    templates.value = await api.listTemplates();
  } finally {
    templatesLoading.value = false;
  }
}

function openSnapshot(row: Instance) {
  snapshotTarget.value = row;
  snapshotForm.name = '';
  snapshotForm.note = '';
  snapshotVisible.value = true;
}

async function onSnapshot() {
  if (!snapshotForm.name) {
    ElMessage.warning('请填写模板名');
    return;
  }
  snapshotting.value = true;
  try {
    await api.snapshot(snapshotTarget.value!.id, snapshotForm.name, snapshotForm.note);
    ElMessage.success('快照已保存(commit 期间实例会短暂卡顿)');
    snapshotVisible.value = false;
    await loadTemplates();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    snapshotting.value = false;
  }
}

function openSpawn(row: Template) {
  spawnTarget.value = row;
  spawnForm.name = '';
  spawnForm.count = 1;
  spawnVisible.value = true;
}

async function onSpawn() {
  spawning.value = true;
  try {
    await api.spawnFromTemplate(spawnTarget.value!.id, spawnForm.name, spawnForm.count);
    ElMessage.success('克隆任务已提交');
    spawnVisible.value = false;
    tab.value = 'instances';
    await store.refresh();
    store.startPolling();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    spawning.value = false;
  }
}

async function onRemoveTemplate(id: string) {
  try {
    await api.removeTemplate(id);
    ElMessage.success('模板已删除');
    await loadTemplates();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  }
}

/* ---------- 用户管理 ---------- */
const users = ref<UserInfo[]>([]);
const usersLoading = ref(false);
const userVisible = ref(false);
const userSaving = ref(false);
const userForm = reactive({ username: '', password: '', role: 'user', maxInstances: 5 });
const resetPwdVisible = ref(false);
const resetPwdTarget = ref<UserInfo | null>(null);
const resetPwdValue = ref('');

async function loadUsers() {
  usersLoading.value = true;
  try {
    users.value = await api.listUsers();
  } finally {
    usersLoading.value = false;
  }
}

function openCreateUser() {
  userForm.username = '';
  userForm.password = '';
  userForm.role = 'user';
  userForm.maxInstances = 5;
  userVisible.value = true;
}

async function onCreateUser() {
  userSaving.value = true;
  try {
    await api.createUser(userForm.username, userForm.password, userForm.role, userForm.maxInstances);
    ElMessage.success('用户已创建');
    userVisible.value = false;
    await loadUsers();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  } finally {
    userSaving.value = false;
  }
}

async function onUpdateUser(id: string, patch: { maxInstances?: number }) {
  try {
    await api.updateUser(id, patch);
    ElMessage.success('已更新');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  }
}

function openResetPwd(row: UserInfo) {
  resetPwdTarget.value = row;
  resetPwdValue.value = '';
  resetPwdVisible.value = true;
}

async function onResetPwd() {
  try {
    await api.updateUser(resetPwdTarget.value!.id, { password: resetPwdValue.value });
    ElMessage.success('密码已重置');
    resetPwdVisible.value = false;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  }
}

async function onRemoveUser(id: string) {
  try {
    await api.removeUser(id);
    ElMessage.success('已删除');
    await loadUsers();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? String(e));
  }
}

watch(tab, (t) => {
  if (t === 'templates') void loadTemplates();
  if (t === 'users' && auth.isAdmin) void loadUsers();
});

onMounted(async () => {
  const cfg = await api.config().catch(() => null);
  if (cfg) form.image = cfg.redroidImage;
  await store.refresh();
  store.startPolling();
});
onUnmounted(() => store.stopPolling());
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.hint { margin-left: auto; color: #909399; font-size: 13px; }
.sub { color: #909399; font-size: 12px; }
.warn { color: #e6a23c; margin-left: 4px; vertical-align: middle; }
.ops { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
.ops :deep(.el-button + .el-button) { margin-left: 0; }

/* 手机竖屏:工具栏收紧 */
@media (max-width: 768px) {
  .hint { display: none; }
  .toolbar { gap: 6px; }
}
</style>
