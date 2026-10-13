# 构建阶段
FROM node:20-bookworm AS build
RUN npm config set registry https://registry.npmmirror.com
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# 运行阶段:nginx 托管静态文件并反代后端;openssl 用于启动时生成自签证书
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/nginx.conf
COPY app-locations.conf /etc/nginx/app-locations.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8443
CMD ["/docker-entrypoint.sh"]
