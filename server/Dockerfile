# 后端镜像:Node.js + adb + scrcpy-server.jar
FROM node:20-bookworm AS base

# npm 国内镜像加速
RUN npm config set registry https://registry.npmmirror.com

# adb(android-platform-tools) + curl
RUN apt-get update \
  && apt-get install -y --no-install-recommends adb curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# scrcpy-server:1.x(WS 推流)+ 2.x(WebRTC 链路带音频 socket)本地 COPY,避免构建期访问 GitHub
COPY assets/scrcpy-server.jar assets/scrcpy-server.jar
COPY assets/scrcpy-server-2.4.jar assets/scrcpy-server-2.4.jar

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8080 \
    SCRCPY_SERVER_PATH=/app/assets/scrcpy-server.jar \
    SCRCPY2_SERVER_PATH=/app/assets/scrcpy-server-2.4.jar

EXPOSE 8080
CMD ["node", "dist/index.js"]
