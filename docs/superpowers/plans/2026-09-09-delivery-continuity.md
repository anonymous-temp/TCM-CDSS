# 连续交付与证据重排 Implementation Plan

> For agentic workers: Use subagent-driven-development for independent tasks, with spec review then code quality review. Follow the repository's Node/assert regression conventions and TDD checkpoints. Never overwrite another worker's edits.

**Goal:** 融合现有修复，保留个体化诊疗内容，取消M04质量失败对手动重试的依赖，在不改变锁方/准入和凭证的前提下实测证据重排。

**Architecture:** 在现有M01–M05流水线内修改：事实和语境沿已有共享模块修正；M04以已完成候选的版本化快照和统一收尾保护连续交付；重排作为既有检索池内短时限可回退的排序步骤。外部NDJSON和结构化合同兼容，不能签名或展示虚构成功。

**Tech Stack:** Next.js 16、TypeScript、Node test/assert+jiti、百炼HTTP rerank API。

## Task 1: 取得并核对用户提交

- [x] 核对本机ef000456及生产容器公开配置；生产模型key仅确认存在，不输出值。
- [x] 查验本机和既有生产SSH的指定worktree；未发现3ec22b4，已向用户索取主机/绝对路径或bundle。
- [ ] 获取提交后先读完整diff、测试及基线；独立复核PHI、剂量/体液掩码、混合极性、人口适用性及HIS状态一致性。
- [ ] 在当前codex分支吸收已核实的提交，保留原提交可追溯性；不修改原worktree、不重写其历史。
- [ ] 运行其203套件及反证对应目标；本地停用审方结果不冒充生产审方结果。

## Task 2: 证据池内重排

**Files:** 新增src/lib/evidence-rerank.ts、scripts/test-evidence-rerank.mjs；修改src/lib/evimed-guide.ts、.env.example、docker-compose.yml和测试脚本注册。

- [x] 按官方HTTP契约用生产已有百炼凭证做无病历探针：200、271ms、66tokens，普通眩晕证据排在化疗指南之前；这只证明可用性。
- [x] RED：编写并执行以下行为断言，失败须来自新能力不存在而非缺依赖；提交RED checkpoint。

```js
assert.deepEqual(result.order, [1, 0]); // 只接受候选池内的唯一整数索引
assert.deepEqual(failed.order, [0, 1]); // 超时/429/非法响应保持原序
assert.equal(callsAfterAbort, 0);      // 已取消不发请求
assert.equal(networkAttempts, 1);     // 无SDK/网络重试放大
assert.equal(originalRecords[0].title, savedTitle); // 不改写证据内容
```

- [x] 实现`rerankEvidenceDocuments(query, documents, options?)`，返回order/status/durationMs/model/usage；status明确区分ranked、disabled、not_configured、cancelled、timeout、invalid_response、upstream_error。真实排序是全候选置换，缺项/重复/越界/非有限分数均回原序；不使用跨请求相关度阈值。
- [x] HTTPS端点固定为同地域dashscope.aliyuncs.com/compatible-api/v1/reranks，model=qwen3-rerank，沿已有Bailian配置取key。redirect:error，3秒总时限、外层取消传导、响应体大小上限；不更改provider配置，不记录query/documents/key。
- [x] 只排序guide/literature已有池，原始检索结果的ID与内容绑定不变；instruction、准入、锁方路径不变。请求使用既有脱敏方法，query/title/summary有界，不发送整个CaseState。禁用或失败逐字保持原行为。
- [x] 开关默认关闭，不增加strictReady依赖；19项及相邻套件通过、GREEN checkpoint和独立复审完成。生产启用仍待真实证据池对照。
- [ ] 真实EviMed证据池live对照尚未完成；已完成合成8场景实调8/8，113–214ms、1016tokens，只证明合成检索相关性。

## Task 3: M04零修复和截止时间连续交付

**Files:** src/lib/diagnosis-api.ts、src/lib/m04-repair-policy.ts、src/lib/m04-proposal-compiler.ts及既有流式/修复回归；候选快照如需新文件，仅承载该状态。

- [x] 使用只读调用链调查确定第一个丢失点，记录代码路径和测试入口。
- [ ] 与3ec22b4新增course逻辑核对，原提交尚未取得。
- [x] RED：同候选T2首轮+零质量预算应直接批注；上一版有效而修订截断/终审超时不得清空；客户端主动取消与服务器deadline分开；验证signature/revision一致，不能以参考页冒充候选。
- [x] 在已有归一和验证之后保存可交付候选快照；禁止从残缺JSON拼造药味、补剂量或把过期复核绑定新版本。质量意见与是否曾修复脱钩。
- [x] deadline收尾读取最后可交付快照，保留个体化正文、候选和具体提示，不调用通用模板覆盖；没有候选时保留已有真实阶段内容并如实说明未完成，不能假报处方成功。
- [x] 按调查修订恢复策略：复用本请求已完成候选，不在180秒耗尽后起新轮或后台Promise；保持总预算与一个END，取消立即结束。没有新增依赖额外模型预算的恢复轮。
- [x] GREEN：14项流式/候选回归及相邻合同/签名测试通过；规格与独立代码审查发现的输出标记、归因和原始事实问题均已修复并复审。

## Task 4: 补齐两份报告的交集与遗漏

- [ ] 对照3ec22b4实际改动：HIS部分字段覆盖、B+ready清空、否认妊娠横幅、未来条件改写和部位污染，不能用新根因掩盖前次已证实根因。
- [ ] 每类用既有真实输入/纯函数反证；同源修复而非新增逐句特判；知识源冲突通过source校勘记录重建，不手改生成物。
- [ ] 黄金断言同时检查字段存在、warnings准确和状态一致；伪造历史PASS/医生身份不能仅靠`!undefined`算通过。提示不清空可读内容。

## Task 5: 完整验证与交付状态

- [x] npm run typecheck、npm run lint、正常202/202与JITI_FS_CACHE=false 202/202、npm run build全部通过。
- [x] 当前已实施差异独立代码审查通过；不代表尚未融合的HIS等遗留问题已关闭。
- [ ] 甲方原始病例与本轮失败用例完整M03→M04→审方→HIS实测；黄金222例以匹配的真实审方环境完成，不因本地无依赖而调整业务结论。
- [ ] 报告所有尝试总耗时、首个有用内容、有效候选率和错误提示率；不只统计成功样本，不重试到绿覆盖原结果。
- [x] 提交状态、推送状态、部署状态分别核实：仅本地提交，未push/部署。生产带鉴权健康200、strictReady=true，仍为ef000456，限流60，重排关闭。缺失3ec22b4及真实复验明确保留为未完成。
