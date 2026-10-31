#
# 运行时镜像（瘦镜像）：只装构建产物，镜像内不做任何 npm 安装。
#
# 注意：这里刻意不写 `# syntax=docker/dockerfile:1`。
# 那句指令会让 BuildKit 去拉 docker/dockerfile 这个「构建前端镜像」，
# 一旦镜像加速器抽风（实测 daocloud 会返回 502）整个构建就失败。
# 本文件只用普通 COPY/ENV/RUN，不需要任何 BuildKit 专属语法，
# 去掉后构建只依赖本地已有的基础镜像，完全离线可用。
#
# 为什么这样设计：
#   1. 开发机是 arm64、NAS 是 x86_64，镜像必须在 NAS 上构建；
#   2. 后端用 esbuild 打成单个平台无关的 server.cjs（依赖已内联），
#      因此镜像构建 = 拉基础镜像 + 复制文件，不需要访问 npm 源，秒级完成；
#   3. node:sqlite 是 Node 内置模块，无需任何原生依赖编译。
#
# 构建前必须先在本机执行 `npm run build:deploy` 生成产物。
# 一键部署请直接用 `npm run deploy:nas`。

FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    TZ=Asia/Shanghai \
    DB_PATH=/app/data/mealtime.db \
    WEB_DIST=/app/web/dist

# 后端单文件 bundle（依赖已内联，含 express / dotenv）
COPY server/dist/server.cjs ./server/server.cjs
# 幂等 seed bundle：部署脚本在健康检查后跑一次，把新增预置菜/食材补进已有库
COPY server/dist/seed.cjs ./seed/seed.cjs
# 构建信息（git 短哈希 + 打包时间），由 /api/health 暴露，用于确认线上是哪一版
COPY server/dist/build-info.json ./server/dist/build-info.json
# 前端静态产物，由同一个 Express 进程托管
COPY web/dist ./web/dist

# 以非特权 node 用户（uid/gid 1000）运行：服务进程被攻破也不持有 root。
# /app/data 是唯一的可写目录（数据库 / uploads / auto-backup 全在它下面），
# chown 给 node；其余文件保持 root 属主、对 node 只读，收窄写面。
# 注意：NAS 上 data/ 是宿主机 bind mount，历史文件由旧的 root 容器写入，
# 属主是 root——deploy-nas.sh 会在启动前把它们 chown 成 1000:1000。
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.cjs"]
