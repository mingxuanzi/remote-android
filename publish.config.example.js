/**
 * 复制本文件为 publish.config.js 后填写飞牛 NAS 信息：
 *   copy publish.config.example.js publish.config.js
 *
 * publish.config.js 含密码，已加入 .gitignore，不要提交。
 *
 * compose 中的 {{IMAGE_API}} / {{IMAGE_WEB}} 会在发布时替换为
 * 「本地镜像名:version.txt 版本号」，对应 docker load 后 NAS 上的本地镜像，不走仓库拉取。
 */
module.exports = {
  // 飞牛 NAS SSH
  host: '192.168.0.40',
  port: 22,
  username: 'your-username',
  password: 'your-password',
  sudo: true,

  // 镜像 tar 与 docker-compose.yml 上传目录
  remoteDir: '/vol1/1000/Docker/RemoteAndroid',

  // 本地构建的两个镜像名(不含 tag,tag 使用 version.txt)
  images: {
    api: 'remote-android-api',   // 后端:实例编排 + 推流网关(Dockerfile 在 server/)
    web: 'remote-android-web'    // 前端:nginx 托管 + 反代(Dockerfile 在 web/)
  },

  // 可选:构建平台,飞牛 NAS 一般为 linux/amd64
  // platform: 'linux/amd64',

  // 随发布包一起推送到 NAS 的镜像(NAS 拉不动 Docker Hub 时由本机代拉;
  // NAS 上已存在这些镜像后可改为 [] 节省每次发布的上传流量)
  seedImages: ['redroid/redroid:12.0.0-latest'],

  // 上传到 NAS 后用于 docker compose 的内容
  // 注意:web 的 nginx 反代固定指向服务名 api:8080,不要改服务名
  compose: `
services:
  api:
    image: '{{IMAGE_API}}'
    pull_policy: never
    container_name: ra-api
    restart: unless-stopped
    environment:
      PORT: 8080
      DOCKER_SOCKET: /var/run/docker.sock
      DOCKER_NETWORK: remote-android-net
      REDROID_IMAGE: redroid/redroid:12.0.0-latest
      GPU_DEVICE: /dev/dri
      SCRCPY_BITRATE: 8000000
      SCRCPY_FPS: 30
    volumes:
      # 编排宿主机 Docker:创建/销毁 redroid 实例
      - /var/run/docker.sock:/var/run/docker.sock
      - /vol1/1000/Docker/RemoteAndroid/data:/app/data
    networks:
      - remote-android-net

  web:
    image: '{{IMAGE_WEB}}'
    pull_policy: never
    container_name: ra-web
    restart: unless-stopped
    depends_on:
      - api
    environment:
      # HTTPS 自签证书的 CN/SAN(填 NAS 的局域网 IP)
      CERT_CN: 192.168.0.40
      CERT_SAN: IP:192.168.0.40
    ports:
      - "8443:8443"   # 单端口双协议:HTTP 与 HTTPS 同走 8443(stream 层 TLS 嗅探分流)
    volumes:
      - /vol1/1000/Docker/RemoteAndroid/certs:/etc/nginx/certs
    networks:
      - remote-android-net

networks:
  # 固定网络名:api 动态创建的 redroid 实例也加入这个网络
  remote-android-net:
    name: remote-android-net
    driver: bridge
`.trim()
}
