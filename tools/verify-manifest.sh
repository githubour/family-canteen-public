#!/bin/sh
# 公开仓完整性校验：确认这份仓库与导出清单逐字节一致。
#
# 公开仓由私有仓 scripts/export-public.sh 单向生成（git archive → overlay → 脱敏替换 → 本清单），
# 所以这里出现的任何「内容不一致 / 多出文件 / 缺文件」都只可能是有人手改了公开仓——直接失败，
# 让「公开仓只读生成」这条约定有 CI 兜底，而不是靠人记得。
#
# 用法：
#   sh tools/verify-manifest.sh            # 校验（CI 与本地同口径）
#   sh tools/verify-manifest.sh --write    # 重新生成清单（只由 export-public.sh 调用）
set -eu

MANIFEST="${MANIFEST:-PUBLIC-MANIFEST.txt}"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 参与导出的文件：排除本地状态与构建产物（与 deploy-nas.sh 的 rsync 排除清单同一口径）
list_files() {
  find . -type f \
    -not -path './.git/*' \
    -not -path '*/node_modules/*' \
    -not -path './data/*' \
    -not -path '*/dist/*' \
    -not -path './generated-images/*' \
    -not -name '.DS_Store' \
    -not -name '.env' \
    -not -name '*.log' \
    -not -name "$MANIFEST" \
    | sed 's|^\./||' | LC_ALL=C sort
}

if [ "${1:-}" = "--write" ]; then
  tmp="$(mktemp)"
  {
    printf '# 公开仓完整性清单：由私有仓 scripts/export-public.sh 生成，改公开仓内容必须先重新导出。\n'
    printf '# source-commit\t%s\n' "${SOURCE_COMMIT:-unknown}"
    list_files | while IFS= read -r f; do
      printf '%s\t%s\n' "$(hash_file "$f")" "$f"
    done
  } >"$tmp"
  mv "$tmp" "$MANIFEST"
  echo "  已生成 ${MANIFEST}（$(list_files | wc -l | tr -d ' ') 个文件，源提交 ${SOURCE_COMMIT:-unknown}）"
  exit 0
fi

[ -f "$MANIFEST" ] || {
  echo "✗ 缺少 ${MANIFEST}：这不是一次正常导出的产物" >&2
  exit 1
}

ACTUAL="$(mktemp)"
EXPECTED="$(mktemp)"
trap 'rm -f "$ACTUAL" "$EXPECTED"' EXIT

list_files >"$ACTUAL"
awk -F'\t' 'length($1) == 64 { print $2 }' "$MANIFEST" | LC_ALL=C sort >"$EXPECTED"

if ! diff -q "$EXPECTED" "$ACTUAL" >/dev/null 2>&1; then
  echo "✗ 文件清单与导出清单不一致（公开仓只能由导出脚本生成）：" >&2
  diff "$EXPECTED" "$ACTUAL" | sed -n 's/^< /  清单里有、仓库里没有：/p; s/^> /  仓库里有、清单里没有：/p' >&2 || true
  exit 1
fi

fail=0
while IFS="$(printf '\t')" read -r want path; do
  case "$want" in '#'*|'') continue ;; esac
  [ -f "$path" ] || {
    echo "  ✗ 缺失：$path" >&2
    fail=1
    continue
  }
  got="$(hash_file "$path")"
  if [ "$got" != "$want" ]; then
    echo "  ✗ 内容被改动：$path" >&2
    fail=1
  fi
done <"$MANIFEST"

if [ "$fail" -ne 0 ]; then
  echo "✗ 公开仓与导出清单不一致：请回到私有仓重新执行 npm run export:public，不要直接改公开仓" >&2
  exit 1
fi
echo "✓ 公开仓与导出清单一致（$(wc -l <"$ACTUAL" | tr -d ' ') 个文件）"
