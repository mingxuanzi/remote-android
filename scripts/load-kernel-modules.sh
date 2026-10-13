#!/usr/bin/env bash
# redroid 依赖 binder / ashmem 内核模块(Android 与宿主机 IPC 必需)
# 用法: sudo bash scripts/load-kernel-modules.sh
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行: sudo bash $0" >&2
  exit 1
fi

modprobe binder_linux devices="binder,hwbinder,vndbinder" 2>/dev/null || true
modprobe ashmem_linux 2>/dev/null || true

# 持久化:开机自动加载
cat >/etc/modules-load.d/redroid.conf <<'EOF'
binder_linux
ashmem_linux
EOF

cat >/etc/udev/rules.d/99-redroid.rules <<'EOF'
KERNEL=="binder",  MODE="0666"
KERNEL=="hwbinder", MODE="0666"
KERNEL=="vndbinder", MODE="0666"
KERNEL=="ashmem",  MODE="0666"
EOF

udevadm trigger 2>/dev/null || true

echo "== 检查结果 =="
ls -l /dev/binder /dev/ashmem 2>/dev/null || true
ls /dev/binderfs 2>/dev/null || true
echo "完成。如果上面没有 binder 设备,请确认内核 ≥5.10 或已编译 CONFIG_ANDROID_BINDERFS/CONFIG_ASHMEM。"
