<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 中医 CDSS — 给 AI 编码代理的说明

**项目指南的唯一来源是仓库根目录的 `CLAUDE.md`，动手前通读它。** 本文件只保留上面的 Next.js 提示
和下面几条硬规则。2026-09-25 之前这里是 `CLAUDE.md` 大半内容的中文平行副本，两份至少有六处
互相矛盾（如审方权威、完整度、闸门组成、部署脚本）；改说明请只改 `CLAUDE.md`。

硬规则（详见 `CLAUDE.md`）：

1. 绝不读取或提交真实密钥文件 `.env.local` / `.env.development.local`。
2. 系统只提供建议：每条结论须能追溯到患者事实、确定性规则或知识库条目；模型不做安全决策，
   不得绕过确定性安全层（`src/lib/diagnosis-safety.ts`）。
3. 没有 `middleware.ts`：请求门控在 `src/proxy.ts`。新 API 路由必须在其 matcher 覆盖内。
4. 改 `src/lib` 后跑 `npm run typecheck`（脚本自带内存参数，裸跑 tsc 会 OOM）；发布前总闸
   `npm run verify:release`；闸门不能与 dev server 并发（内存）。
5. `src/data/*.json` 是生成物，改生成器或其 `*.source.json` 输入，不手改产物。
