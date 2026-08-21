#!/usr/bin/env bash
# EVE-Dealer 提交并推送脚本
# 用法: npm run push -- "提交信息"
#       bash scripts/push.sh "提交信息"
# 不传提交信息时默认使用时间戳。
#
# Token 解析顺序：
#   1. 环境变量 GITHUB_TOKEN
#   2. 项目根目录 .github-token 文件（已在 .gitignore 中排除，不会上传）
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-更新 $(date '+%Y-%m-%d %H:%M')}"
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .github-token ]; then
  TOKEN="$(tr -d '[:space:]' < .github-token)"
fi
if [ -z "$TOKEN" ]; then
  echo "错误: 未找到 GitHub token（设置 GITHUB_TOKEN 环境变量或创建 .github-token 文件）" >&2
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "没有需要提交的改动"
  exit 0
fi

git commit -m "$MSG"
git push "https://x-access-token:${TOKEN}@github.com/tqxy/EVE-Dealer.git" main:main
echo "已提交并推送到 GitHub: $MSG"
