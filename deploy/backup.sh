#!/usr/bin/env bash
# SQLite 在线备份脚本：做一致性快照 + 打包菜品实拍图，并按天数轮转。
#
# 用法：
#   ./deploy/backup.sh [数据库路径] [备份目录] [保留天数]
# 默认（路径都由脚本自身位置推导，仓库挪到哪都能用）：
#   DB=<仓库>/data/mealtime.db
#   BACKUP_DIR=<仓库>/data/backups
#   KEEP_DAYS=14
#
# 产物成对出现，恢复时必须一起还原，否则数据库里的 image_url 全是破图：
#   mealtime-<时间戳>.db.gz        数据库一致性快照（gzip）
#   uploads-<时间戳>.tar.gz        <数据库目录>/uploads 整个打包
#
# 一致性怎么保证：优先 sqlite3 的 .backup（WAL 模式下安全）；没有 sqlite3 时退到
# node:sqlite 的 VACUUM INTO。两者都不可用时**直接失败**，绝不 cp 主库文件——
# WAL 模式下 mealtime.db 可能只是个空壳（数据在 -wal 里），拷出来的是残缺副本。
#
# NAS 上建议每天定时跑一次；Mac 侧可再 rsync 一份做异地副本。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DB_PATH="${1:-${REPO_ROOT}/data/mealtime.db}"
BACKUP_DIR="${2:-${REPO_ROOT}/data/backups}"
KEEP_DAYS="${3:-14}"

if [ ! -f "${DB_PATH}" ]; then
  echo "[backup] 找不到数据库：${DB_PATH}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/mealtime-${STAMP}.db"
DB_DIR="$(cd "$(dirname "${DB_PATH}")" && pwd)"
UPLOADS_DIR="${DB_DIR}/uploads"

if command -v sqlite3 >/dev/null 2>&1; then
  # 一致性快照，WAL 模式下也安全
  sqlite3 "${DB_PATH}" ".backup '${TARGET}'"
elif command -v node >/dev/null 2>&1; then
  # 没有 sqlite3 命令行：用 Node 内置的 node:sqlite（项目要求 Node ≥ 24，无需额外依赖）。
  # 具体 SQL 放在脚本里，避免在这里和 shell 引号打架（VACUUM INTO 的目标必须是单引号字符串）
  echo "[backup] 未安装 sqlite3，改用 node:sqlite 做 VACUUM INTO" >&2
  node "${SCRIPT_DIR}/sqlite-snapshot.cjs" "${DB_PATH}" "${TARGET}"
else
  cat >&2 <<'EOF'
[backup] 既没有 sqlite3 也没有 node，无法生成一致性快照。
         直接 cp 主库在 WAL 模式下会得到残缺副本（数据还在 -wal 里），所以这里选择失败。
         请任选其一：
           1) 安装 sqlite3（如 apt-get install sqlite3 / opkg install sqlite3-cli）；
           2) 装 Node 24 后重跑；
           3) 直接用应用自带的每日快照：<数据库目录>/auto-backup/mealtime-YYYYMMDD.db（含 .uploads 图片目录）。
EOF
  exit 1
fi

gzip -f "${TARGET}"
echo "[backup] 已生成 ${TARGET}.gz"

# 图片与数据库成对备份：恢复时少任何一个都会破图
if [ -d "${UPLOADS_DIR}" ]; then
  tar -czf "${BACKUP_DIR}/uploads-${STAMP}.tar.gz" -C "${DB_DIR}" uploads
  echo "[backup] 已生成 ${BACKUP_DIR}/uploads-${STAMP}.tar.gz"
else
  echo "[backup] ${UPLOADS_DIR} 不存在（还没有传过实拍图），跳过图片打包"
fi

# 轮转：删除超过 KEEP_DAYS 天的备份（数据库与图片各按各的时间戳删）
find "${BACKUP_DIR}" -name 'mealtime-*.db.gz' -type f -mtime "+${KEEP_DAYS}" -delete
find "${BACKUP_DIR}" -name 'uploads-*.tar.gz' -type f -mtime "+${KEEP_DAYS}" -delete
echo "[backup] 已清理 ${KEEP_DAYS} 天前的备份，当前保留："
ls -1 "${BACKUP_DIR}" | tail -5
