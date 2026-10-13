import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from '../views/Dashboard.vue';
import Detail from '../views/Detail.vue';
import Login from '../views/Login.vue';
import { getToken } from '../api';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login },
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/instance/:id', name: 'detail', component: Detail, props: true },
  ],
});

router.beforeEach((to) => {
  if (to.path !== '/login' && !getToken()) return '/login';
  if (to.path === '/login' && getToken()) return '/';
  return true;
});
