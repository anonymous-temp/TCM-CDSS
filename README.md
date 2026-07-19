# 中医 CDSS

面向门诊场景的中医辅助诊疗系统，支持一诉五史、生命体征、四诊信息采集，基于安全门控完成追问、辨病辨证、证候病机拆解、候选方药、处方风险提示与随访建议。

## 运行

```bash
npm install
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000)，根路径会进入 `/diagnosis`。

## 常用命令

```bash
npm run lint
npx tsc --noEmit
npm run regress:tcm-cdss
npm run build
```

## Docker 发布

生产镜像固定构建在 `/tcm-cdss` 基础路径。发布前从 `.env.example` 生成受控环境文件，至少配置真实的 `OPENAI_API_KEY`、`CDSS_API_TOKEN`、证据检索密钥和灵犀审方参数；不要把环境文件打进镜像。

```bash
IMAGE_TAG=20260710095116 \
CDSS_API_TOKEN='replace-with-secret' \
OPENAI_API_KEY='replace-with-secret' \
CASE_SNAPSHOT_ENCRYPTION_KEY='replace-with-dedicated-random-secret' \
docker compose build

IMAGE_TAG=20260710095116 \
CDSS_API_TOKEN='replace-with-secret' \
OPENAI_API_KEY='replace-with-secret' \
CASE_SNAPSHOT_ENCRYPTION_KEY='replace-with-dedicated-random-secret' \
docker compose up -d
```

`IMAGE_TAG` 必须是不可变发布标签。病例恢复开启时必须使用独立的随机 `CASE_SNAPSHOT_ENCRYPTION_KEY`，不得与访问口令或模型密钥复用。容器健康检查会带内部访问 token 调用 `/tcm-cdss/api/diagnosis/health?strict=1`，只有模型、证据、审方与加密快照配置达到 `strictReady=true` 才判定健康。回滚时使用上一发布标签重新执行 `docker compose up -d`。

生产环境还必须显式设置 `CDSS_TRUST_PROXY_HEADERS=true`，且仅能在 Nginx/Caddy 已清除客户端传入的转发头、重新写入 `X-Real-IP` 和 `X-Forwarded-Proto/Host` 时启用。该条件不满足时严格健康检查会拒绝发布，避免所有直连用户共享同一限流身份。

## 主要目录

- `src/app/diagnosis`：中医 CDSS 前端页面
- `src/app/api/diagnosis`：M01-M05 推理与 HIS 方案接口
- `src/app/api/tcm-knowledge`：中医药知识库检索接口
- `src/lib/diagnosis-*`：病例状态、提示词、流式解析、安全门控
- `src/lib/tcm-knowledge.ts`：本地中医药知识库与后置处方风险提示
- `src/data/tcm-knowledge.json`：本地知识库数据
