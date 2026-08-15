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
# 部署密钥：显式 DEPLOY_KEY 优先，否则在候选里挑**本机真实存在**的那一把。
# 硬编码单一路径作默认值在多端协同下必断——2026-08-16 实测：一端把默认从 evimed_deploy
# 改成 tcm_cdss_deploy_ed25519，另一端立刻 Permission denied(publickey)，DEPLOY_EXIT=255，
# 因为那把钥匙只在改动方机器上。候选顺序不代表优先级，只代表历史先后。
KEY="${DEPLOY_KEY:-}"
if [ -z "$KEY" ]; then
  for candidate in "$HOME/.ssh/tcm_cdss_deploy_ed25519" "$HOME/.ssh/evimed_deploy"; do
    if [ -f "$candidate" ]; then KEY="$candidate"; break; fi
  done
fi
if [ -z "$KEY" ] || [ ! -f "$KEY" ]; then
  echo "找不到可用的部署密钥。显式指定：DEPLOY_KEY=/path/to/key IMAGE_TAG=... ./scripts/deploy-prod.sh" >&2
  exit 1
fi
echo "=== 部署密钥：$KEY ==="
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/home/ubuntu/tcm-cdss/releases/20260801-vocab-deduction}"
TAG="${IMAGE_TAG:?IMAGE_TAG 必须显式指定且不可复用——镜像 tag 必须不可变，否则无法证明线上跑的是哪一版}"
# 保留几个历史 tcm-cdss 镜像用于回滚。3 个 ≈ 3GB，够回滚两版；再多只是占磁盘。
KEEP_IMAGES="${DEPLOY_KEEP_IMAGES:-3}"
# 构建前的可用空间下限。一次构建约需 3-4GB，运行时还要写 runtime-data 缓存。
MIN_FREE_GB="${DEPLOY_MIN_FREE_GB:-12}"
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

echo "=== prune (保留最近 $KEEP_IMAGES 个 tcm-cdss 镜像 + 运行中容器) ==="
# `until=24h` 单独用是不够的：一天之内部署多次时，当天的镜像一个都不会被回收。
# 实测 2026-08-09 一天 5 次部署把根分区吃到 100%，后果不是构建失败那么直白——
# 容器写不了 /app/runtime-data/controlled-terminology-cache.json，失败被 probeCache 缓存 5 分钟，
# strict health 返回 503，看起来像上游依赖挂了。所以这里按**保留个数**回收，不按时间。
#
# 只回收 tcm-cdss 自己的镜像：同一台机器上还跑着 rxai-offline / evimed-* / searxng，
# 全局 `docker image prune -a` 会连它们一起清掉。
$SSH "$USER@$HOST" "
  set -e
  running=\$(docker inspect --format '{{.Config.Image}}' tcm-cdss-prod-tcm-cdss-1 2>/dev/null || true)
  keep=\$(docker images --filter reference='tcm-cdss:*' --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
    | sort -k2 -r | head -n $KEEP_IMAGES | cut -f1)
  for img in \$(docker images --filter reference='tcm-cdss:*' --format '{{.Repository}}:{{.Tag}}'); do
    [ \"\$img\" = \"\$running\" ] && continue
    echo \"\$keep\" | grep -qx \"\$img\" && continue
    echo \"  - 回收旧镜像 \$img\"
    docker rmi \"\$img\" >/dev/null 2>&1 || true
  done
  docker image prune -f --filter 'until=24h' >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  df -h / | tail -1
"
# 构建前显式校验可用空间。磁盘满导致的故障全都表现为别的东西（500、503、模型超时），
# 排查成本极高——宁可在这里以一句人话失败。
AVAIL_GB="$($SSH "$USER@$HOST" "df -BG --output=avail / | tail -1 | tr -dc '0-9'")"
if [ "${AVAIL_GB:-0}" -lt "$MIN_FREE_GB" ]; then
  echo "!! 磁盘可用空间仅 ${AVAIL_GB}G，低于 ${MIN_FREE_GB}G 下限；构建会成功但运行时写缓存会失败。" >&2
  echo "   先在服务器上腾空间（docker system df 看占用大头），不要降低本阈值绕过。" >&2
  exit 1
fi

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
