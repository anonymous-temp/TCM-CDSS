#!/usr/bin/env bash
# 生产部署：预编译产物 + green 容器原地替换（2026-09-21 起的现行路径；原在 ~/runlogs/，2026-09-25 落库，
# 同时删除了已失效的 scripts/deploy-prod.sh）。
#
# ── 线上拓扑（照着旧 deploy-prod.sh 做会「看起来成功、实际没上线」）───────────────────────────
# 线上自 2026-09-11 起不是 `-p tcm-cdss-prod`，而是 blue/green 建的 compose 项目
# `tcm-cdss-deepseek-green-20260911`（端口 3020，叠加发布目录里 release-ops/production.override.yml），
# nginx 的 proxy_pass 指向 3020。旧脚本把项目名与容器名写死，直接跑会另起一套容器且 nginx 不指向它。
# 本脚本原地替换这个容器：端口不变 ⇒ nginx 无需改动；重建期间有数秒 502（owner 已知悉，2026-09-13）。
#
# ── 两步走 ────────────────────────────────────────────────────────────────────────────────
#   1) scripts/deploy/prebuild-local.sh <工作树> <TAG> <COMMIT> <DIGEST> <STAMP>   # 本机编译
#   2) IMAGE_TAG=<TAG> PREBUILT_DIR=~/build-prebuilt/<TAG> \
#      DEPLOY_REMOTE_DIR=/home/ubuntu/tcm-cdss/releases/20260919-qwen38-flash-max \
#      DEPLOY_OVERRIDE_REL=artifacts/tencent-release-20260924-dsfirst/release-ops/production.override.yml \
#      scripts/deploy/deploy-green-inplace-prebuilt.sh
#   之后：npm run verify:deployed-image（commit+digest+strictReady+模型实调）与 npm run regress:prod-smoke。
#   部署前另行归档遥测：原地替换会清掉容器 stdout 里的 model_task 账本（本机 cron 工具
#   ~/telemetry-archive/pull-tcm-cdss-telemetry.sh，不在仓库里）。
#
# ── 为什么主机不编译 ─────────────────────────────────────────────────────────────────────
# 生产机是共享机；`next build` 约 6GB，在它上面编译已两次整机失联（8/26 约 20 分钟、9/19 约 87 分钟）。
# 这里以正在运行的镜像 /app 为底稿、rsync --checksum 只传变化文件，主机只做运行层打包（约 41s、几百 MB）。
#
# ── 参数 ──────────────────────────────────────────────────────────────────────────────────
# 必填（缺省值会陈旧，陈旧的代价都实测过）：
#   IMAGE_TAG            不可变镜像标签；复用标签就无法证明线上跑的是哪一版。
#   PREBUILT_DIR         本机预编译产物目录（含 .prebuilt-meta）。
#   DEPLOY_REMOTE_DIR    发布目录（compose 工作目录）。缺省目录陈旧时 src/data 481MB 会全量冷传 40 分钟。
#   DEPLOY_OVERRIDE_REL  发布目录内的 production.override.yml 相对路径（线上模型分档就在这里）。
#                        指旧的会静默改掉线上模型配置——例如指 20260919-qwen38 会把首轮退回 Qwen。
#                        2026-09-24 起在用：artifacts/tencent-release-20260924-dsfirst/release-ops/production.override.yml
# 可选（缺省 = 2026-09-25 的生产现值）：
#   DEPLOY_HOST=82.156.128.153  DEPLOY_USER=ubuntu  DEPLOY_KEY=<见 common.sh 的候选>
#   DEPLOY_SRC=<本仓库根>  DEPLOY_SEED_DIR=/home/ubuntu/tcm-cdss/releases/20260919-qwen38-flash-max
#   DEPLOY_RUNTIME_ENV=/home/ubuntu/tcm-cdss/.env.prod.runtime
#   DEPLOY_TOKEN_BASELINE_PATH=/home/ubuntu/tcm-cdss/.cdss-api-token.sha256
#   DEPLOY_PROJECT=tcm-cdss-deepseek-green-20260911  DEPLOY_CONTAINER=<项目名>-tcm-cdss-1
#   DEPLOY_APP_PORT=3020  DEPLOY_RATE_LIMIT=60  DEPLOY_KEEP_IMAGES=3  DEPLOY_MIN_FREE_GB=12
#   DEPLOY_PREBUILT_CTX_ROOT=/home/ubuntu/tcm-cdss/prebuilt
#
# ── 承重检查（改动前先读；test:deploy-runtime-env-protection 钉住顺序与形状）────────────────────
#  1) 预编译产物的 .prebuilt-meta 必须与待部署的 commit + 源摘要逐项一致：旧产物贴新标签照样能过
#     verify:deployed-image（它只比对标签），必须在这里拦住。
#  2) 受保护运行时配置（.env.prod.runtime）放在发布目录之外；同步前后比对摘要，同步改动了它就停。
#  3) rsync 用白名单（common.sh）：仓库根 4.6GB 数据资产，黑名单式排除实测一次同步两小时。
#  4) compose 走 --env-file 且在 `env -i` 空环境里解析：`source .env` 会剥掉 JSON 值的引号
#     （tcm_treatment_capabilities_invalid_json、strictReady=false）；远端会话残留的 CDSS_API_TOKEN
#     会静默覆盖稳定文件。
#  5) 接口 Token 三方一致（compose 最终值 / 运行中容器 / 独立基线文件），切流后再比一次；基线文件
#     必须是部署用户所有、0600；基线缺失一律拒绝（原地替换总有旧容器与既有基线，不存在「首次部署」）。
#     全程只比哈希，不打印 Token 或哈希。
#  6) 构建前先按**个数**回收 tcm-cdss 镜像（不按时间：8/9 一天 5 次部署把根分区吃满，容器写不了
#     runtime-data 缓存，strict health 503 看起来像上游挂了），并校验磁盘下限；只回收自己的镜像，
#     同机还跑着别的服务。
#  7) 主机可用内存 ≥ 1.5GB 才打包；运行层 Dockerfile 由 derive-runtime-dockerfile.sh 从刚同步的
#     仓库 Dockerfile 派生。
#  8) 任何一步都不许用 `| tail` 吞掉退出码（第一版部署脚本因此在失败时打印了「部署完成」）；
#     远端 build 的输出截尾后，必须再以 `docker image inspect` 独立确认镜像存在。
#  9) 只有真正在跑的镜像等于本次标签、且切流后 Token 仍一致，才算部署完成。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"

TAG="${IMAGE_TAG:?IMAGE_TAG 必须显式指定且不可复用}"
PREBUILT_DIR="${PREBUILT_DIR:?PREBUILT_DIR 必须指向本机预编译产物目录（scripts/deploy/prebuild-local.sh）}"
NEW_DIR="${DEPLOY_REMOTE_DIR:?DEPLOY_REMOTE_DIR 必须显式指定（缺省目录陈旧，src/data 481MB 会全量冷传）}"
OVERRIDE_REL="${DEPLOY_OVERRIDE_REL:?DEPLOY_OVERRIDE_REL 必须显式指定（指旧 override 会静默改掉线上模型分档）}"
HOST="${DEPLOY_HOST:-82.156.128.153}"
USER="${DEPLOY_USER:-ubuntu}"
SRC="${DEPLOY_SRC:-$(cd "$HERE/../.." && pwd)}"
OLD_DIR="${DEPLOY_SEED_DIR:-/home/ubuntu/tcm-cdss/releases/20260919-qwen38-flash-max}"  # 2026-09-21 清理后唯一保留的发布目录
RUNTIME_ENV="${DEPLOY_RUNTIME_ENV:-/home/ubuntu/tcm-cdss/.env.prod.runtime}"
TOKEN_BASELINE_PATH="${DEPLOY_TOKEN_BASELINE_PATH:-/home/ubuntu/tcm-cdss/.cdss-api-token.sha256}"
PROJECT="${DEPLOY_PROJECT:-tcm-cdss-deepseek-green-20260911}"
CONTAINER="${DEPLOY_CONTAINER:-$PROJECT-tcm-cdss-1}"
APP_PORT="${DEPLOY_APP_PORT:-3020}"
RATE_LIMIT="${DEPLOY_RATE_LIMIT:-60}"
KEEP_IMAGES="${DEPLOY_KEEP_IMAGES:-3}"
MIN_FREE_GB="${DEPLOY_MIN_FREE_GB:-12}"
CTX_ROOT="${DEPLOY_PREBUILT_CTX_ROOT:-/home/ubuntu/tcm-cdss/prebuilt}"
KEY="$(cdss_deploy_key)"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=20"
echo "=== 部署密钥：$KEY ==="

cd "$SRC"
COMMIT="$(git rev-parse HEAD)"
DIGEST="$(node scripts/build-source-digest.mjs | python3 -c 'import json,sys; print(json.load(sys.stdin)["digest"])')"
test -f "$PREBUILT_DIR/.prebuilt-meta" || { echo "!! 产物缺少 .prebuilt-meta，无法证明它对应哪个版本" >&2; exit 1; }
META_COMMIT="$(sed -n 's/^COMMIT=//p' "$PREBUILT_DIR/.prebuilt-meta")"
META_DIGEST="$(sed -n 's/^DIGEST=//p' "$PREBUILT_DIR/.prebuilt-meta")"
STAMP="$(sed -n 's/^STAMP=//p' "$PREBUILT_DIR/.prebuilt-meta")"
if [ "$META_COMMIT" != "$COMMIT" ] || [ "$META_DIGEST" != "$DIGEST" ]; then
  echo "!! 预编译产物（$META_COMMIT / $META_DIGEST）与待部署版本（$COMMIT / $DIGEST）不一致，拒绝部署" >&2; exit 1
fi
for part in .next/standalone .next/static public; do
  test -e "$PREBUILT_DIR/$part" || { echo "!! 预编译产物缺失：$PREBUILT_DIR/$part" >&2; exit 1; }
done
echo "=== commit=$COMMIT digest=$DIGEST tag=$TAG dir=$NEW_DIR override=$OVERRIDE_REL ==="

CLEAN_COMPOSE_ENV="env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# 远端取值一律 `|| true` 再显式判空：否则 set -e 会在命令替换失败时无声退出，看不出是哪一关拦的。
ENV_DIGEST_BEFORE="$($SSH "$USER@$HOST" "test -s '$RUNTIME_ENV' && sha256sum '$RUNTIME_ENV' | cut -d' ' -f1" || true)"
[ -n "$ENV_DIGEST_BEFORE" ] || { echo "!! 受保护运行时配置缺失：$RUNTIME_ENV；拒绝同步与部署" >&2; exit 1; }

echo "=== 播种发布目录（硬链接，避免 481MB 冷传）+ 备份旧 compose ==="
# 回滚必须「旧镜像 + 旧 compose」一起用：例如开关缺省值变了时，旧镜像配新 compose 会给每一例扣剂量。
# rsync 写临时文件再改名，硬链接不会把种子目录一起改坏。
$SSH "$USER@$HOST" "set -e; test -d '$OLD_DIR'; if [ ! -d '$NEW_DIR' ]; then cp -al '$OLD_DIR' '$NEW_DIR'; fi
  test -f '$NEW_DIR/$OVERRIDE_REL'
  if [ -f '$NEW_DIR/docker-compose.yml' ] && [ ! -e '$NEW_DIR/docker-compose.yml.pre-${COMMIT:0:7}' ]; then
    cp -p '$NEW_DIR/docker-compose.yml' '$NEW_DIR/docker-compose.yml.pre-${COMMIT:0:7}'
  fi"

echo "=== 同步源码白名单 ==="
rsync -az --delete -e "$SSH" "${CDSS_DEPLOY_SYNC_PATHS[@]}" "$USER@$HOST:$NEW_DIR/"

ENV_DIGEST_AFTER="$($SSH "$USER@$HOST" "test -s '$RUNTIME_ENV' && sha256sum '$RUNTIME_ENV' | cut -d' ' -f1" || true)"
[ "$ENV_DIGEST_AFTER" = "$ENV_DIGEST_BEFORE" ] || { echo "!! 源码同步改变了受保护运行时配置；拒绝继续" >&2; exit 1; }

COMPOSE_ARGS="-p '$PROJECT' --env-file '$RUNTIME_ENV' -f '$NEW_DIR/docker-compose.yml' -f '$NEW_DIR/$OVERRIDE_REL'"
COMPOSE_ENV="IMAGE_TAG='$TAG' APP_BIND_IP=127.0.0.1 APP_PORT='$APP_PORT' CDSS_MODEL_RATE_LIMIT_PER_10_MIN='$RATE_LIMIT'"
EXPECTED_TOKEN_HASH="$($SSH "$USER@$HOST" "cd '$NEW_DIR' && $CLEAN_COMPOSE_ENV $COMPOSE_ENV docker compose $COMPOSE_ARGS config --format json | python3 -c '$CDSS_DEPLOY_TOKEN_FROM_COMPOSE_PY'" || true)"
RUNNING_TOKEN_HASH_BEFORE="$($SSH "$USER@$HOST" "docker inspect --format '{{json .Config.Env}}' '$CONTAINER' | python3 -c '$CDSS_DEPLOY_TOKEN_FROM_ENV_PY'" || true)"
TOKEN_BASELINE_HASH="$($SSH "$USER@$HOST" "if test -s '$TOKEN_BASELINE_PATH'; then mode=\$(stat -c %a '$TOKEN_BASELINE_PATH'); owner=\$(stat -c %u '$TOKEN_BASELINE_PATH'); if [ \"\$mode\" = 600 ] && [ \"\$owner\" = \"\$(id -u)\" ]; then tr -d '\\r\\n' < '$TOKEN_BASELINE_PATH'; else printf __INVALID__; fi; fi" || true)"
if [ "$TOKEN_BASELINE_HASH" = "__INVALID__" ]; then
  echo "!! 接口 Token 基线的 owner 或权限不安全（必须为部署用户、0600）；拒绝部署。" >&2; exit 1
fi
if [ -z "$TOKEN_BASELINE_HASH" ]; then
  echo "!! 接口 Token 基线缺失：$TOKEN_BASELINE_PATH；拒绝把本次配置静默当作既有客户凭证。" >&2; exit 1
fi
if [ -z "$EXPECTED_TOKEN_HASH" ] || [ "$EXPECTED_TOKEN_HASH" != "$RUNNING_TOKEN_HASH_BEFORE" ] || [ "$TOKEN_BASELINE_HASH" != "$EXPECTED_TOKEN_HASH" ]; then
  echo "!! 接口 Token 三方不一致（compose 最终值 / 运行中容器 / 基线）；为避免客户凭证被替换，拒绝部署。" >&2; exit 1
fi
echo "=== Token 三方一致 ==="

echo "=== prune（保留最近 $KEEP_IMAGES 个 tcm-cdss 镜像 + 运行中镜像）+ 磁盘下限 ==="
$SSH "$USER@$HOST" "
  set -e
  running=\$(docker inspect --format '{{.Config.Image}}' '$CONTAINER' 2>/dev/null || true)
  keep=\$(docker images --filter reference='tcm-cdss:*' --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' | sort -k2 -r | head -n $KEEP_IMAGES | cut -f1)
  for img in \$(docker images --filter reference='tcm-cdss:*' --format '{{.Repository}}:{{.Tag}}'); do
    [ \"\$img\" = \"\$running\" ] && continue
    echo \"\$keep\" | grep -qx \"\$img\" && continue
    docker rmi \"\$img\" >/dev/null 2>&1 || true
  done
  docker builder prune -af >/dev/null 2>&1 || true
  df -h / | tail -1
"
AVAIL_GB="$($SSH "$USER@$HOST" "df -BG --output=avail / | tail -1 | tr -dc '0-9'")"
[ "${AVAIL_GB:-0}" -ge "$MIN_FREE_GB" ] || {
  echo "!! 磁盘可用 ${AVAIL_GB}G < ${MIN_FREE_GB}G；先腾空间（docker system df），不要降低阈值绕过" >&2; exit 1; }

echo "=== 运行层打包（本机已编译；主机只拷文件，不编译） ==="
AVAIL_KB="$($SSH "$USER@$HOST" "awk '/MemAvailable/{print \$2}' /proc/meminfo")"
[ "${AVAIL_KB:-0}" -ge 1500000 ] || { echo "!! 可用内存 ${AVAIL_KB}kB < 1.5GB，拒绝打包" >&2; exit 1; }
CTX="$CTX_ROOT/$TAG"
RUNNING_IMAGE="$($SSH "$USER@$HOST" "docker inspect --format '{{.Config.Image}}' '$CONTAINER'")"
echo "底稿镜像：$RUNNING_IMAGE → $CTX（只传变化的文件）"
$SSH "$USER@$HOST" "set -e
  rm -rf '$CTX'; mkdir -p '$CTX/standalone' '$CTX/static' '$CTX/public'
  cid=\$(docker create '$RUNNING_IMAGE')
  trap 'docker rm -f \$cid >/dev/null 2>&1 || true' EXIT
  docker cp \$cid:/app/. '$CTX/standalone/'
  docker cp \$cid:/app/.next/static/. '$CTX/static/'
  docker cp \$cid:/app/public/. '$CTX/public/'
  rm -rf '$CTX/standalone/public' '$CTX/standalone/.next/static' '$CTX/standalone/runtime-data' \
    '$CTX/standalone/.next-build-base-path' '$CTX/standalone/.next-build-persistence-flag'
  du -sh '$CTX'"
for part in standalone static; do
  rsync -rlptz --checksum --delete -e "$SSH" "$PREBUILT_DIR/.next/$part/" "$USER@$HOST:$CTX/$part/"
done
rsync -rlptz --checksum --delete -e "$SSH" "$PREBUILT_DIR/public/" "$USER@$HOST:$CTX/public/"
$SSH "$USER@$HOST" "set -e
  sh '$NEW_DIR/scripts/deploy/derive-runtime-dockerfile.sh' '$NEW_DIR/Dockerfile' > '$CTX/Dockerfile.prebuilt'
  cd '$CTX' && DOCKER_BUILDKIT=1 docker build -f Dockerfile.prebuilt \
    --build-arg CDSS_BUILD_COMMIT='$COMMIT' --build-arg CDSS_BUILD_SOURCE_DIGEST='$DIGEST' --build-arg CDSS_BUILD_TIMESTAMP='$STAMP' \
    -t 'tcm-cdss:$TAG' . 2>&1 | tail -4"
$SSH "$USER@$HOST" "docker image inspect 'tcm-cdss:$TAG' >/dev/null" || { echo "!! 运行层打包失败：镜像 tcm-cdss:$TAG 不存在" >&2; exit 1; }

echo "=== 原地替换 $CONTAINER ==="
$SSH "$USER@$HOST" "cd '$NEW_DIR' && $CLEAN_COMPOSE_ENV $COMPOSE_ENV docker compose $COMPOSE_ARGS up -d"

RUNNING="$($SSH "$USER@$HOST" "docker inspect --format '{{.Config.Image}}' '$CONTAINER' 2>/dev/null || true")"
[ "$RUNNING" = "tcm-cdss:$TAG" ] || { echo "!! 部署未生效：容器实际镜像为 ${RUNNING:-<无>}，期望 tcm-cdss:$TAG" >&2; exit 1; }
RUNNING_TOKEN_HASH_AFTER="$($SSH "$USER@$HOST" "docker inspect --format '{{json .Config.Env}}' '$CONTAINER' | python3 -c '$CDSS_DEPLOY_TOKEN_FROM_ENV_PY'" || true)"
if [ -z "$RUNNING_TOKEN_HASH_AFTER" ] || [ "$RUNNING_TOKEN_HASH_AFTER" != "$EXPECTED_TOKEN_HASH" ]; then
  echo "!! 切流后容器的接口 Token 与受保护运行时配置不一致；部署不可验收" >&2; exit 1
fi
echo "=== 部署完成 tag=$TAG commit=${COMMIT:0:12} 容器=$CONTAINER 镜像=$RUNNING ==="
