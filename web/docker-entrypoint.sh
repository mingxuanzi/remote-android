#!/bin/sh
# web 容器入口:无证书则生成自签证书(带 SAN),然后启动 nginx
set -e

CERT_DIR=/etc/nginx/certs
CERT_FILE=$CERT_DIR/server.crt
KEY_FILE=$CERT_DIR/server.key

# 证书 Subject/SAN:CERT_CN 默认取 NAS_HOST,否则 remote-android
CN="${CERT_CN:-${NAS_HOST:-remote-android}}"
SAN="${CERT_SAN:-IP:127.0.0.1}"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[entrypoint] 生成自签证书 CN=$CN SAN=$SAN"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY_FILE" -out "$CERT_FILE" \
    -days 3650 -subj "/CN=$CN" -addext "subjectAltName=$SAN"
fi

exec nginx -g 'daemon off;'
