#!/usr/bin/env bash
# 生产部署（2026-08-05 落库版）。
#
# 此前这个脚本一直放在 /tmp/gy/ 下，/tmp 被清理后整套部署能力当场丢失，只能凭记忆重建。
# 部署是发布链路的一部分，必须与源码同版本管理——放在仓库里，改了有 diff，丢了能找回。
#
# 三条来之不易的约束，改动前先读：
#  1) rsync 用**白名单**而不是 --exclude：仓库根下有 4.6GB 数据资产，黑名单式排除是打地鼠，
#     实测一次同步跑了两小时；换白名单后 20 秒。新增需要上线的目录必须显式加进 SYNC_PATHS。
#  2) compose 必须走 --env-file：`source .env` 会把 JSON 值的引号剥掉，
#     实测导致 tcm_treatment_capabilities_invalid_json、strictReady=false。
#  3) 构建前先 prune：服务器磁盘被镜像塞满时，nginx 写不了 >8KB 的请求体，
#     M04 会在 0.3 秒内返回 500——看起来像模型问题，其实是磁盘满。
#  4) compose 必须显式 `-p tcm-cdss-prod`：不指定项目名时 compose 按目录名推导，
#     会另建一套容器并与在跑的实例撞端口（实测 Bind for 127.0.0.1:3016 failed）。
#  5) 任何一步都不许用 `| tail` 吞掉退出码：本脚本第一版就因为管道掩盖了 compose 失败，
#     在部署实际失败的情况下打印了「部署完成」。宁可日志长，不可谎报成功。
set -euo pipefail

HOST="${DEPLOY_HOST:-82.156.128.153}"
USER="${DEPLOY_USER:-ubuntu}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/evimed_deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/ubuntu/tcm-cdss/releases/20260801-vocab-deduction}"
TAG="${IMAGE_TAG:?IMAGE_TAG 必须显式指定且不可复用——镜像 tag 必须不可变，否则无法证明线上跑的是哪一版}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=20"

COMMIT="$(git rev-parse HEAD)"
DIGEST="$(node scripts/build-source-digest.mjs 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[\"digest\"])")"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 白名单：只同步应用源码与构建所需文件。artifacts/ deeptest/ test-results/ 与数据资产不上线。
SYNC_PATHS=(
  src package.json package-lock.json next.config.ts tsconfig.json
  postcss.config.mjs eslint.config.mjs components.json Dockerfile docker-compose.yml
  scripts public
)

echo "=== sync (commit=${COMMIT:0:12} digest=${DIGEST:0:12}) ==="
rsync -az --delete -e "$SSH" "${SYNC_PATHS[@]}" "$USER@$HOST:$REMOTE_DIR/"

echo "=== prune (保留 24h 内镜像与运行中容器) ==="
$SSH "$USER@$HOST" "docker image prune -af --filter 'until=24h' >/dev/null 2>&1 || true; df -h / | tail -1"

echo "=== build ==="
$SSH "$USER@$HOST" "cd $REMOTE_DIR && DOCKER_BUILDKIT=1 docker build \
  --build-arg NODE_OPTIONS=--max-old-space-size=6144 \
  --build-arg CDSS_BUILD_COMMIT=$COMMIT \
  --build-arg CDSS_BUILD_SOURCE_DIGEST=$DIGEST \
  --build-arg CDSS_BUILD_TIMESTAMP=$STAMP \
  -t tcm-cdss:$TAG ." 2>&1 | tail -12
$SSH "$USER@$HOST" "docker image inspect tcm-cdss:$TAG >/dev/null" || { echo "!! 构建失败：镜像 $TAG 不存在" >&2; exit 1; }

echo "=== deploy ==="
$SSH "$USER@$HOST" "cd $REMOTE_DIR && IMAGE_TAG=$TAG docker compose -p tcm-cdss-prod --env-file ./.env.prod.runtime up -d"

# 只有真正跑起来的镜像与本次 tag 一致，才算部署完成——否则上面任何一步失败都可能被读成成功。
RUNNING="$($SSH "$USER@$HOST" "docker inspect --format '{{.Config.Image}}' tcm-cdss-prod-tcm-cdss-1 2>/dev/null || true")"
if [ "$RUNNING" != "tcm-cdss:$TAG" ]; then
  echo "!! 部署未生效：容器实际镜像为 ${RUNNING:-<无>}，期望 tcm-cdss:$TAG" >&2
  exit 1
fi
echo "=== 部署完成 tag=$TAG commit=${COMMIT:0:12} 容器镜像=$RUNNING ==="
