<template>
  <el-container class="layout">
    <el-header class="header" height="auto">
      <span class="logo" @click="$router.push('/')">📱 RemoteAndroid 云模拟器</span>
      <el-tag size="small" type="info" class="subtitle">Web 端安卓模拟器多开平台:一键创建 · 实时投屏 · 批量管理</el-tag>
      <div class="spacer" />
      <el-button
        circle :icon="theme.isDark ? Sunny : Moon"
        :title="theme.isDark ? '切换到日间模式' : '切换到夜间模式'"
        @click="theme.toggle()"
      />
      <template v-if="auth.user">
        <el-dropdown @command="onUserCmd">
          <span class="user">
            {{ auth.user.username }}
            <el-tag v-if="auth.isAdmin" size="small" type="warning">管理员</el-tag>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="pwd">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </el-header>
    <el-main class="main">
      <router-view />
    </el-main>

    <el-dialog v-model="pwdVisible" title="修改密码" width="380px">
      <el-form label-width="80px">
        <el-form-item label="原密码">
          <el-input v-model="pwdForm.old" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.next" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" :loading="pwdLoading" @click="onChangePwd">确定</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Sunny, Moon } from '@element-plus/icons-vue';
import { api } from './api';
import { useAuthStore } from './stores/auth';
import { useThemeStore } from './stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const pwdVisible = ref(false);
const pwdLoading = ref(false);
const pwdForm = reactive({ old: '', next: '' });

function onUserCmd(cmd: string) {
  if (cmd === 'logout') {
    auth.logout();
    router.push('/login');
  } else if (cmd === 'pwd') {
    pwdForm.old = pwdForm.next = '';
    pwdVisible.value = true;
  }
}

async function onChangePwd() {
  pwdLoading.value = true;
  try {
    await api.changePassword(pwdForm.old, pwdForm.next);
    ElMessage.success('密码已修改');
    pwdVisible.value = false;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? '修改失败');
  } finally {
    pwdLoading.value = false;
  }
}

onMounted(() => {
  theme.apply();
  auth.fetchMe();
});
</script>

<style>
html, body, #app { height: 100%; margin: 0; }
body { background: var(--el-bg-color-page); }
.layout { height: 100%; }
.header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  background: #1d1e1f; color: #fff; padding: 10px 20px; min-height: 60px; box-sizing: border-box;
}
.logo { font-size: 18px; font-weight: 600; cursor: pointer; }
.spacer { flex: 1; }
.user { color: #fff; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.main { background: var(--el-bg-color-page); }
/* 弹窗在窄屏下不超出视口 */
.el-dialog { max-width: 94vw; }
.el-message-box { max-width: 94vw; }

/* 手机竖屏适配 */
@media (max-width: 768px) {
  .header { gap: 8px; padding: 8px 10px; }
  .logo { font-size: 15px; }
  .subtitle { display: none; }
  .main { padding: 8px !important; }
  .el-tabs__content { padding: 8px !important; }
}
</style>
