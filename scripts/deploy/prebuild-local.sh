#!/usr/bin/env bash
# 本机预编译（2026-09-21 起的生产发布路径第一步；原在 ~/runlogs/，2026-09-25 落库）。
#
# 为什么不在生产机上编译：生产机 82.156.128.153 是共享机，白天 MemAvailable 常年低于受限构建所需的 7GB，
# 而 `next build --webpack` 约需 6GB 进程树 RSS；在它上面编译已造成两次整机失联（8/26 约 20 分钟、
# 9/19 约 87 分钟，线上服务一起不可用）。这里在本机编译，生产机只做运行层打包（内存需求几百 MB）。
# 这也是 `npm run verify:release` 不再跑 `npm run build` 的原因：发布产物只从这里来。
#
# 忠实性：编译目录 = 部署同一份源码白名单（common.sh 的 CDSS_DEPLOY_SYNC_PATHS）∩ .dockerignore
# （Docker 在主机上就这样裁剪构建上下文）。**直接在工作树里编译不行**：会把 artifacts/、.claude/ 等
# 本机目录追踪进 standalone——那些绝不能进生产镜像。
# 构建参数与主机旧 build-capped.sh 逐项一致：只传 CDSS_BUILD_* 与堆上限，**不设 NEXT_DEPLOYMENT_ID**——
# 9/13 以来线上镜像都没有 deploymentId，设了会改静态资源地址规则（Next 改用带 dpl 的构建 ID）。
# NEXT_PUBLIC_BASE_PATH / NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE 必须等于 Dockerfile runner 段的
# ARG 缺省值：运行层镜像把后者写进 .next-build-*，容器启动时比对，不一致直接退出（闸门钉住两处相等）。
#
# 用法：scripts/deploy/prebuild-local.sh <SRC 工作树> <TAG> <COMMIT> <DIGEST> <STAMP>
#   COMMIT = git -C <SRC> rev-parse HEAD；DIGEST = node scripts/build-source-digest.mjs 的 digest；
#   STAMP  = date -u +%Y-%m-%dT%H:%M:%SZ
# 产物：${PREBUILT_ROOT:-~/build-prebuilt}/<TAG>/（.next/standalone、.next/static、public、.prebuilt-meta），
# 随后以 PREBUILT_DIR=<该目录> 调 deploy-green-inplace-prebuilt.sh。
set -euo pipefail
SRC="${1:?src}"; TAG="${2:?tag}"; COMMIT="${3:?commit}"; DIGEST="${4:?digest}"; STAMP="${5:?stamp}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$HERE/common.sh"
BUILD="${PREBUILT_ROOT:-$HOME/build-prebuilt}/$TAG"
# 产物必须对应一个干净的已提交版本：未提交改动会被编进去，却贴着 HEAD 的提交号上线。
DIRTY="$(git -C "$SRC" status --porcelain | grep -v '^?? STATUS$' || true)"
[ -z "$DIRTY" ] || { echo "!! 工作树有未提交改动，拒绝预编译：" >&2; echo "$DIRTY" >&2; exit 1; }
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || { echo "!! COMMIT 与工作树 HEAD 不一致" >&2; exit 1; }
rm -rf "$BUILD"; mkdir -p "$BUILD"
cd "$SRC"
# 排除项 = .dockerignore 中落在白名单内的那部分（Docker 在主机上本来就会这样裁剪）。
rsync -a \
  --exclude='/scripts/test-*' --exclude='/scripts/regress-*' \
  --exclude='*.log' --exclude='*.trace.zip' --exclude='*.har' --exclude='.DS_Store' --exclude='npm-debug.log*' \
  "${CDSS_DEPLOY_SYNC_PATHS[@]}" \
  "$BUILD/"
cp -al "$SRC/node_modules" "$BUILD/node_modules"
cd "$BUILD"
env -i PATH="$PATH" HOME="$HOME" NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_BASE_PATH=/tcm-cdss NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE=true \
  CDSS_BUILD_COMMIT="$COMMIT" CDSS_BUILD_SOURCE_DIGEST="$DIGEST" CDSS_BUILD_TIMESTAMP="$STAMP" \
  CDSS_BUILD_NODE_OPTIONS=--max-old-space-size=4096 npm run build
# 部署脚本逐项核对这三项：旧产物贴新标签照样能过 verify:deployed-image（它只比对标签），必须在这里拦住。
printf 'COMMIT=%s\nDIGEST=%s\nSTAMP=%s\n' "$COMMIT" "$DIGEST" "$STAMP" > "$BUILD/.prebuilt-meta"
echo "PREBUILD_OK $BUILD"
