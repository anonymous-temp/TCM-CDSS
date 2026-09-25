# shellcheck shell=bash
# 部署脚本共用定义：被 prebuild-local.sh 与 deploy-green-inplace-prebuilt.sh 以 `source` 引入。
#
# 源码白名单只在这里写一次。本机编译目录（prebuild-local.sh）与主机发布目录（deploy 脚本）
# 必须是同一份源码——两处各写一份就会漂移，漂了之后「编进镜像的」和「发布目录里的」不是同一版。

# 白名单：只同步应用源码与构建所需文件；artifacts/ deeptest/ test-results/ 与仓库根 4.6GB 数据资产不上线。
#  - 用白名单而不是 --exclude：黑名单式排除是打地鼠，实测一次同步跑了两小时；换白名单后 20 秒。
#    新增需要上线的目录必须显式加进来。
#  - .env.example / .dockerignore / docs / AGENTS.md / CLAUDE.md 是发布验证输入（甲方 08cc573 复测第 9 项）：
#    多条确定性套件读它们，源摘要链读 .dockerignore；缺了它们发布目录里跑闸门会中途假红。
#  - 绝不能出现 .env.prod.runtime：运行时密钥的生命周期独立于源码发布（rsync 多源 --delete 曾删掉它，
#    旧容器仍健康，把失败掩盖了）。test:deploy-runtime-env-protection 钉这一条。
# shellcheck disable=SC2034  # 由 source 方使用
CDSS_DEPLOY_SYNC_PATHS=(
  src package.json package-lock.json next.config.ts tsconfig.json
  postcss.config.mjs eslint.config.mjs components.json Dockerfile docker-compose.yml
  scripts public
  .env.example .dockerignore docs AGENTS.md CLAUDE.md
)

# 从 `docker inspect --format '{{json .Config.Env}}'` 的输出里取接口 Token 的 sha256。
# 读的是**不可变的容器配置**而不是 `docker exec`：旧容器停了也能比对，新容器没起来也不会误判成一致。
# 全程不打印 Token 本身。不得含单引号：它被原样嵌进远端 `python3 -c '…'`。
# shellcheck disable=SC2034  # 由 source 方使用
CDSS_DEPLOY_TOKEN_FROM_ENV_PY='import hashlib,json,sys; v=[i.split("=",1)[1] for i in json.load(sys.stdin) if i.startswith("CDSS_API_TOKEN=")]; v or sys.exit(1); print(hashlib.sha256(v[0].encode()).hexdigest())'

# 从 `docker compose … config --format json` 取最终生效的接口 Token 的 sha256（同上，不打印、无单引号）。
# shellcheck disable=SC2034
CDSS_DEPLOY_TOKEN_FROM_COMPOSE_PY='import hashlib,json,sys; print(hashlib.sha256(str(json.load(sys.stdin)["services"]["tcm-cdss"]["environment"]["CDSS_API_TOKEN"]).encode()).hexdigest())'

# 部署密钥：显式 DEPLOY_KEY 优先，否则在候选里挑**本机真实存在**的那一把。
# 硬编码单一路径作默认值在多端协同下必断——2026-08-16 实测：一端把默认从 evimed_deploy 改成
# tcm_cdss_deploy_ed25519，另一端立刻 Permission denied(publickey)。候选顺序只代表历史先后。
cdss_deploy_key() {
  local key="${DEPLOY_KEY:-}" candidate
  if [ -z "$key" ]; then
    for candidate in "$HOME/.ssh/tcm_cdss_deploy_ed25519" "$HOME/.ssh/evimed_deploy"; do
      if [ -f "$candidate" ]; then key="$candidate"; break; fi
    done
  fi
  if [ -z "$key" ] || [ ! -f "$key" ]; then
    echo "!! 找不到可用的部署密钥；显式指定 DEPLOY_KEY=/path/to/key" >&2
    return 1
  fi
  printf '%s\n' "$key"
}
