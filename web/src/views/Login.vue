<template>
  <div class="login-page">
    <el-card class="login-card">
      <div class="brand">📱 RemoteAndroid</div>
      <div class="slogan">云端安卓模拟器多开管理平台</div>
      <el-form @submit.prevent="onLogin">
        <el-form-item>
          <el-input v-model="username" size="large" placeholder="用户名" :prefix-icon="User" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="password" size="large" type="password" placeholder="密码"
            :prefix-icon="Lock" show-password @keyup.enter="onLogin"
          />
        </el-form-item>
        <el-button type="primary" size="large" class="btn" :loading="loading" @click="onLogin">
          登 录
        </el-button>
      </el-form>
      <div class="tip">默认账号 admin / admin123(首次登录后请修改)</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { User, Lock } from '@element-plus/icons-vue';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const loading = ref(false);

async function onLogin() {
  if (!username.value || !password.value) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    ElMessage.success(`欢迎,${auth.user?.username}`);
    router.push('/');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.error ?? '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  height: 100%; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #1d1e1f 0%, #2b3a55 100%);
}
.login-card { width: min(380px, 92vw); }
.brand { font-size: 24px; font-weight: 700; text-align: center; }
.slogan { color: #909399; text-align: center; margin: 8px 0 24px; font-size: 13px; }
.btn { width: 100%; }
.tip { margin-top: 16px; color: #c0c4cc; font-size: 12px; text-align: center; }
</style>
