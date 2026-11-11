# 原方组成表的建表流水线（第四十二轮，2026-11-10）

`src/data/tcm-formula-original-compositions.source.json` 是这条流水线的产物，也是今后手工维护的输入：
改它之后跑 `npm run build:formula-original-compositions`（生成运行时 JSON 并校验），再跑
`npm run report:formula-original-reconciliation` 看目录对账是否仍为零。**日常维护不需要重跑这里的脚本。**

这里留的是当时怎么建出来的，供以后整批补书、重核时照做。脚本里的工作目录写死为 `/var/tmp/r1057`
（`wt/` 是仓库工作树，`jc/` 是古籍全文缓存，`out/` 是核对员产出，`recon/` 是对账裁决，`work/` 是中间文件）。

| 步骤 | 脚本 | 做什么 |
|---|---|---|
| 1 | `targets.py` | 要核的（方名, 出处书）清单：受治理目录、教材行署的出处、方名名录 |
| 2 | `jc_fetch.py`、`bookmap.py` | 从 jicheng.tw 取古籍全文，转简体，按书名建缓存；书名别名表 |
| 3 | `harvest.py`、`auto_rows.py` | 在原书里定位方名、解析药味行；与目录一致的自动成行（`review: auto_agree`） |
| 4 | `mkbatches.py`、`swarm_loop.sh` | 其余的分批交核对员（Claude 子代理、Codex、Kimi、DeepSeek），简报 `BRIEF-verify.md` |
| 5 | `check_rows.py` | 核对员产出的硬校验：摘句逐字在原文里、药名写法在摘句里、药名是已知药 |
| 6 | `merge_rows.py` | 合并成 source JSON（书名归一、药引不重复进药味、应用 `work/overlay.json` 的修订） |
| 7 | `mk_recon.py`、`recon_loop.sh`、`check_recon.py` | 目录 × 原方表的差异分批裁决，简报 `BRIEF-reconcile.md`；常用方另用 `BRIEF-common-tier.md` 由更强的模型复核 |
| 8 | `apply_recon.py`、`apply_collation.py` | 裁决落地：改表（overlay）、改目录（订正通道 `ADJ-ORIG-20261110`）、保留差异清单（reconciliation source） |

给外部工人（Codex / Kimi / DeepSeek）的简报第 0 节都是同一组禁令：禁止部署、禁止 ssh 到服务器、禁止 git push、禁止读取密钥。

证据校验：仓库里的生成器在本机有古籍语料时核 `kind: local` 的摘句；设 `FORMULA_ORIGINAL_JICHENG_CACHE=<jc 目录>`
时连 `kind: jicheng` 的摘句一起核（建表时 4430 条 jicheng 摘句、131 条本地摘句全部逐字命中）；
`kind: web` 的网页存档不进仓库，归档在 `~/runlogs/r1018/work/r1057/`。
