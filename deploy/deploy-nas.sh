#!/usr/bin/env bash
#
# 一键发布到 NAS：
#   本机构建产物 → rsync 同步 → NAS 上重建并重启容器 → 健康检查
#
# 用法：
#   npm run deploy:nas
#   bash deploy/deploy-nas.sh
#   bash deploy/deploy-nas.sh --seed   # 发布时补齐缺失的预置食材/菜品（不覆盖已有数据）
#
# 可用环境变量覆盖默认值：
#   NAS_HOST=nas                    SSH 主机别名（见 ~/.ssh/config）
#   NAS_DIR=/opt/mealtime   NAS 上的安装目录
#   APP_PORT=8787                   容器对外端口
#   BIND_ADDR=0.0.0.0               容器端口绑定地址（默认全网卡，家人手机同 Wi-Fi 直连；
#                                   设 127.0.0.1 = 只本机，外部只走 Tailscale，见 deploy/tailscale.md）
#   SKIP_BUILD=1                    跳过构建，只用现有产物同步
#
# 关于安装位置：
#   建议放在已纳入备份计划的持久化目录下。
#   注意若宿主盘没有文件系统快照，数据库的一致性由应用自身保证：
#   每天用 VACUUM INTO 在 data/auto-backup/ 里产出一份快照，随整目录备份一起被带走。

set -euo pipefail

NAS_HOST="${NAS_HOST:-nas}"
NAS_DIR="${NAS_DIR:-/opt/mealtime}"
APP_PORT="${APP_PORT:-8787}"
# 默认 0.0.0.0：compose 里缺省是只绑本机（安全默认），但「家人手机同 Wi-Fi 直连」
# 是本应用的主要内容入口，所以走发布脚本时显式放开；要收紧就 BIND_ADDR=127.0.0.1。
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SEED="${SEED:-0}"

for arg in "$@"; do
  case "${arg}" in
    --seed) SEED=1 ;;
    *)      echo "未知参数：${arg}（可用：--seed）" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$1" >&2; exit 1; }

# SSH 统一选项：~/.ssh/config 里 nas 用了 UserKnownHostsFile /dev/null，
# 不加 LogLevel=ERROR 的话每条命令都会刷一遍 known_hosts 警告。
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=8)
nssh() { ssh "${SSH_OPTS[@]}" "${NAS_HOST}" "$@"; }

# ---------- 0. 前置检查 ----------
step "检查环境"
command -v ssh   >/dev/null || die "缺少 ssh"
command -v rsync >/dev/null || die "缺少 rsync（macOS 自带）"
nssh 'echo ready' >/dev/null 2>&1 \
  || die "连不上 ${NAS_HOST}，请确认 SSH 配置（~/.ssh/config 里的 nas）"
ok "能连上 ${NAS_HOST}"

# ---------- 1. 构建产物 ----------
if [ "${SKIP_BUILD}" != "1" ]; then
  step "构建前端与后端产物"
  ( cd "${REPO_ROOT}" && npm run build:deploy )
else
  step "跳过构建（SKIP_BUILD=1）"
fi

[ -f "${REPO_ROOT}/server/dist/server.cjs" ] || die "缺少 server/dist/server.cjs，构建可能失败了"
[ -f "${REPO_ROOT}/web/dist/index.html" ]    || die "缺少 web/dist/index.html，构建可能失败了"
ok "产物就绪：server.cjs $(du -h "${REPO_ROOT}/server/dist/server.cjs" | cut -f1)、web/dist $(du -sh "${REPO_ROOT}/web/dist" | cut -f1)"

# ---------- 1.5 写入构建信息（版本戳）----------
# 让「线上跑的到底是哪一版」可查：git 短哈希 + 打包时间 + 是否有未提交改动
step "写入构建信息"
COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=false
if ! git -C "${REPO_ROOT}" diff --quiet 2>/dev/null || ! git -C "${REPO_ROOT}" diff --cached --quiet 2>/dev/null; then
  DIRTY=true
fi
printf '{"commit":"%s","builtAt":"%s","dirty":%s}\n' \
  "${COMMIT}" "$(date '+%Y-%m-%d %H:%M:%S')" "${DIRTY}" \
  > "${REPO_ROOT}/server/dist/build-info.json"
ok "版本戳：${COMMIT}$([ "${DIRTY}" = true ] && echo '（含未提交改动）')"

# ---------- 2. 同步到 NAS ----------
# 注意：data/ 被排除，rsync 不会删除它（--delete 默认不处理被排除项），
# 所以远端数据库是安全的。
step "同步到 ${NAS_HOST}:${NAS_DIR}"
nssh "mkdir -p '${NAS_DIR}'"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.playwright-cli' \
  --exclude 'generated-images' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  "${REPO_ROOT}/" "${NAS_HOST}:${NAS_DIR}/"
ok "代码与产物已同步"

# ---------- 3. 在 NAS 上重建并启动 ----------
# 先把当前镜像留一份 mealtime:previous，万一新版有问题可以一条命令回滚
step "重建镜像并重启容器"
nssh "docker image tag mealtime:latest mealtime:previous 2>/dev/null || true"
# 容器内已改为非特权 node 用户（uid 1000）运行，data/ 必须归 1000 所有。
# 旧版容器以 root 写过库和上传文件，首次切换时这里完成一次性属主迁移；
# chown 需要管理员权限，ssh 用户不是 root 时自动尝试 sudo -n。
nssh "mkdir -p '${NAS_DIR}/data' && (chown -R 1000:1000 '${NAS_DIR}/data' 2>/dev/null || sudo -n chown -R 1000:1000 '${NAS_DIR}/data')" \
  || die "无法把 ${NAS_DIR}/data 属主改为 1000:1000（容器以 node 用户运行需要写权限）。请手动执行后重试"
nssh "cd '${NAS_DIR}' && BIND_ADDR='${BIND_ADDR}' docker compose -f deploy/docker-compose.yml up -d --build"
nssh "docker image prune -f >/dev/null 2>&1 || true"
ok "容器已启动（上一版保留为 mealtime:previous）"

# ---------- 4. 健康检查 ----------
# ip route get 拿的是默认出口网卡的真实地址，比 hostname -I 可靠（后者常给出 169.254 链路本地地址）
NAS_IP="$(nssh "ip -4 route get 1.1.1.1 2>/dev/null | awk '{print \$7; exit}'" || true)"
[ -n "${NAS_IP}" ] || NAS_IP="192.168.1.10"

step "等待服务就绪"
HEALTH="unknown"
for _ in $(seq 1 30); do
  HEALTH="$(nssh "docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' mealtime 2>/dev/null" || echo missing)"
  [ "${HEALTH}" = "healthy" ] && break
  sleep 1
done
if [ "${HEALTH}" != "healthy" ]; then
  echo
  nssh "docker logs --tail 30 mealtime" || true
  die "服务未在 30 秒内变为 healthy（当前：${HEALTH}）"
fi
ok "容器健康"

# 再从开发机走一次真实网络，确认能访问 + 前端产物确实挂上了。
# 「只推了后端、忘了 web/dist」是发布最常见的翻车，这里直接拦住。
HEALTH_BODY="$(curl -fsS -m 8 "http://${NAS_IP}:${APP_PORT}/api/health" || true)"
if [ -z "${HEALTH_BODY}" ]; then
  die "容器健康但 ${NAS_IP}:${APP_PORT} 访问不到，请检查防火墙 / 端口占用"
fi
case "${HEALTH_BODY}" in
  *'"web":true'*) ok "接口可达，前端产物已挂载" ;;
  *) die "接口可达但前端未挂载（返回：${HEALTH_BODY}）。是不是漏了 npm run build -w web？" ;;
esac

# 核对线上版本与本次构建是否一致——避免「部署看着成功但其实没生效」
REMOTE_COMMIT="$(printf '%s' "${HEALTH_BODY}" | grep -o '"commit":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ "${REMOTE_COMMIT}" = "${COMMIT}" ]; then
  ok "线上版本已确认：${REMOTE_COMMIT}"
else
  die "线上版本不一致：本次构建 ${COMMIT}，线上实际 ${REMOTE_COMMIT:-未知}。可先看 ssh ${NAS_HOST} 'docker logs --tail 40 mealtime'"
fi

# ---------- 4.5 可选：补齐预置数据 ----------
# 默认不跑：seed 只插入缺失项、不覆盖已有食材/菜品，但仍不需要在每次发布时
# 自动改数据库。新增预置数据时显式加 --seed 执行。
if [ "${SEED}" = "1" ]; then
  step "补齐预置数据（显式 --seed）"
  nssh "docker exec mealtime node seed/seed.cjs" \
    || die "seed 没跑成，可手动补：ssh ${NAS_HOST} 'docker exec mealtime node seed/seed.cjs'"
  ok "预置数据已对齐"
else
  step "跳过预置数据补齐（需要时加 --seed）"
fi

# ---------- 5. 打印访问地址 ----------
TS_DOMAIN="$(nssh "tailscale status --json 2>/dev/null | grep -m1 -oE '[a-z0-9-]+\.[a-z0-9]+\.ts\.net'" || true)"
SERVE_URL="$(nssh "tailscale serve status 2>/dev/null | grep -m1 -oE 'https://[^ ]+'" || true)"

step "部署完成"
echo "    局域网：    http://${NAS_IP}:${APP_PORT}"
if [ -n "${SERVE_URL}" ]; then
  echo "    HTTPS：     ${SERVE_URL}"
elif [ -n "${TS_DOMAIN}" ]; then
  echo "    Tailscale： http://${TS_DOMAIN}:${APP_PORT}（尚未开 HTTPS，见 deploy/tailscale.md）"
fi
echo "    NAS 目录：  ${NAS_DIR}"
echo "    查看日志：  ssh ${NAS_HOST} 'docker logs -f mealtime'"
echo "    回滚上一版：ssh ${NAS_HOST} \"docker tag mealtime:previous mealtime:latest && cd ${NAS_DIR} && BIND_ADDR=${BIND_ADDR} docker compose -f deploy/docker-compose.yml up -d\""
echo
