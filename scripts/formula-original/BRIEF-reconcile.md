# 任务简报：目录 × 原方组成表 对账裁决

## 0. 禁令（所有工人必须遵守）

- **禁止部署**；**禁止 ssh 到服务器**；**禁止 git push**（也不要 commit、不要改任何仓库文件）；**禁止读取密钥和 ~/.ssh**（含任何 `.env*`、`secrets`、`~/runlogs/customer-cases`、`~/.claude`）。
- 只在 `/var/tmp/r1057/` 任务目录里工作：只读 `recon/`、`jc/`、`out/`、`BRIEF*.md`、`tools/` 与简报点名的本地教材语料；只写 `recon/out/<批号>.json`、`recon/reports/<批号>.md`、`webpages/<批号>/`。
- 联网只用于查古籍/教材原文网页，不向外发送本机文件内容。

## 1. 背景

系统有一份受治理方剂目录（3000 余条），其中 545 条来自深圳《中药方剂编码规则》（调剂标准，`sourceClass=official_local_formula_standard`），药名是调剂品名、组成有的被现代改过，出处却标原书；另有 2300 条来自项目补充（`verified_reference_catalog`，多取自方名辞典式名录）和 171 条国家经典名方目录（`official_classic_catalog`）。

我们刚建了一张**原方组成表**：键（方名, 出处书），药味逐字摘自原书原文（上一步的核对员产出，带摘句）。现在把目录条目与原方表里**同名同书**的条目按药味逐味比，凡不一致的要逐条裁决：是目录错了（改目录）、是原书异文（两种写法都算原方）、是原方含今天不用的药（保留差异并写明理由）、还是原方表这一行摘错了（改表）。

你只处理**一批**差异：`/var/tmp/r1057/recon/batches/<批号>.json`。

## 2. 输入（每个 item）

- `name`、`book`、`catalog`：目录条目（`id`、`sourceClass`、`source`、`ingredients` 现有组成、`prescriptionOriginal` 目录自带的原文，可能为空）。
- `row`：原方表这一行（`ingredients[{written, herb, preparation…}]`、`guideHerbs`、`evidence[{kind, book/file/url, quote}]`、`tier`、`note`、`review`）。`review=auto_agree` 是程序解析的行（没有人逐条看过，**优先怀疑它**）；`agent:<批次>` 是核对员逐条写的。
- `extraInCatalog`、`missingInCatalog`：程序按药味身份比出来的差异（目录多的 / 目录缺的；已忽略生姜大枣位置、调剂品名、品种未分的古名、犀角→水牛角这类登记过的替代）。
- `fangjixue`：《方剂学》教材这首方的【组成】原文（有才给）。
- `sameBookNameCatalog`：方名名录里同名同书条目的药味（有才给，仅供参考）。
- `verifierNote`：上一步核对员对这条目录差异写的评语（有才给）。

## 3. 你能用的资料

同核对步骤：jicheng 全库简体缓存 `/var/tmp/r1057/jc/<书名>.txt`（`grep -n`；多卷书 `书名_1.txt`…）、本地教材语料 `/var/tmp/r1057/wt/中医补充数据/灵丹GitHub/TCM Educational Materials.txt`、联网（作为证据的网页必须能用 `python3 /var/tmp/r1057/tools/savepage.py '<url>' <批号>` 存下来）。
**每条都要回到原文看一眼**（至少看 row.evidence 的摘句所在段落：药味行、方后注、煎服法），不要只看输入里的差异清单就下结论。

## 4. 每个 item 给一个裁决

写到 `/var/tmp/r1057/recon/out/<批号>.json`：`{"batch": "<批号>", "decisions": [ ... ]}`，顺序与输入一致，一条不少。

```json
{"name": "人参养荣汤", "book": "太平惠民和剂局方", "catalogId": "TCM-FORMULA-3B08FC93959D",
 "decision": "collate",
 "reason": "目录（深圳标准）把原方肉桂换成了枸杞子、首乌藤，是现代改方；局方原文十二味含桂心，方后生姜三片、枣二枚为引。",
 "confidence": "high"}
```

`decision` 取值与各自要填的字段：

- **`collate`**：原方表这一行可靠，目录组成错了（现代改方、抄错、漏药、把随证加的药或别方的药并了进来、同名异方挂错了书）。目录将改成原方组成。**只有 row 的摘句确实是这本书这首方的完整药味行时才用。**
  可选 `ingredients`（字符串数组）：目录改成的药名清单；不填则用 row 的 `herb`（原书写明且通行的炮制会自动带上）。原方里今天不用的药、不入煎的辅料（见下）不要写进去，并在 `reason` 里说明。
- **`alternate`**：原书自注或通行本另有一种组成，目录取的是那一种，**两种都算原方**。必须填 `alternate: {"add": [...], "remove": [...], "basis": "…"}`（相对 row 正文的增减，药名用基础名；basis 写依据，如「原书方后小注『别本作细辛』；《方剂学》取别本」），并给 `evidence`（同核对步骤的证据格式，摘出那句自注或《方剂学》【组成】行）。
  只有**原书自己写了异文**、或《方剂学》教材【组成】明确取了另一写法时才用；目录单方面的改动不算。
- **`accept`**：差异有正当理由、目录不改、原方表也不改。必须填 `category` 与 `reason`：
  - `original_herb_not_dispensed`：原方里的这味药今天不用或系统不为其编制（铅丹、金汁、人尿/童便、黄金、水银、轻粉、砒石、虎骨、穿山甲、麝香、牛黄、羚羊角等禁用/濒危/剧毒药；目录有意不列）。只适用于「目录缺」的是这类药。
  - `vehicle_or_excipient`：原书那味只是赋形、炮制辅料或送服的东西（炼蜜为丸、酒/醋/姜汁调服、面糊、米饭、猪蹄汤、朱砂为衣…），目录不列是对的——**这种情况更应该用 `fix_row` 把它从 row 的药味挪到药引/去掉**；只有拿不准时才 accept。
  - `catalog_follows_modern_standard_substitution`：目录按现行标准用了替代品且有明确依据（如龟甲代穿山甲不算——没有依据就 collate）。
  - `row_low_tier`：row 只有教材索引行/现代转录（`tier` 是 textbook_appendix / modern_source / fangjixue 且没有原书原文），不足以推翻目录；写明两边各是什么。
  - `other`：其它，reason 写清楚。
- **`fix_row`**：原方表这一行摘错或不全（解析漏了药、把煎服法里的药引当成药味或反过来、把方后「加减」里的药算进去、选错了同书同名的另一首、OCR 缺字）。必须给出改好的整行 `row`（字段同核对简报 `/var/tmp/r1057/BRIEF.md` 第 3 节：`status`、`name`、`book`、`variant`、`aliases`、`tier`、`ingredients`、`guideHerbs`、`evidence`、`note`），证据规则相同。改完如果与目录一致了就到此为止；如果仍不一致，再加一个字段 `then`：`"collate"` / `"accept"`（带 `category`）/ `"alternate"`（带 `alternate`）说明剩下的差异怎么办。
- **`drop_row`**：原方表这一行不可靠且你也找不到可摘的原文（比如程序把同名的另一首方当成了它）。`reason` 写清楚。表里没有这首方 = 系统不对它说「原方」，目录不动。
- **`unsure`**：看了原文仍判断不了。`reason` 写你看到了什么、卡在哪。

通用字段：`reason`（必填，一两句，写给后来维护的人看）、`confidence`（high / medium / low）。

### 判断要点

1. **先核 row**。`review=auto_agree` 的行是程序从同书片段里解析的，常见错误：只解析了第一行药味（跨行的漏掉）、把「各等分」「各一两」前后的药漏掉、把同名的另一首当成本方、把加减法里的药算进去。发现就 `fix_row`。
2. **目录多出来的药**：是原书煎服法里的药引（姜、枣、薄荷、葱白、竹叶、灯心、粳米）→ `fix_row` 把它补进 guideHerbs（补完通常就一致了）；是方后「如…加某药」→ `collate`；是别的书的同名方 → 看目录的 `source` 到底该是哪本：目录组成其实是**另一本书**的同名方时仍用 `collate`（目录挂了这本书的名，就应当是这本书的组成），并在 `reason` 里写明目录现有组成实出何书。
3. **目录缺的药**：禁用/剧毒/濒危 → `accept original_herb_not_dispensed`；赋形辅料 → `fix_row`；普通药 → `collate`。
4. **同一味药的不同写法**（熟地黄/地黄未分、赤茯苓/茯苓、桂枝/肉桂/桂心、白术/苍术在宋以前未分、枳实/枳壳）：按原文字面定 row 的 `herb`；目录取了另一种时，若《方剂学》或通行本如此（如汉方「桂」作桂枝、宋方「地黄（酒蒸）」作熟地黄），用 `fix_row` 把 row 的 `herb` 改成通行写法并在 note 说明；若两说并存，用 `alternate`。
5. 国家经典名方目录条目（`official_classic_catalog`）的组成是国家目录原文，通常是对的；它与 row 不一致时多半是 row 取了另一个版本或另一首，倾向 `fix_row` / `drop_row`，不要轻易 `collate`。
6. 宁可 `unsure` 也不要凭印象裁决。

## 5. 自检与总结

- `fix_row` 给的行会被 `python3 /var/tmp/r1057/tools/check_rows.py` 同样的规则核（摘句逐字在原文里、药名写法在摘句里）。写完后运行 `python3 /var/tmp/r1057/tools/check_recon.py /var/tmp/r1057/recon/out/<批号>.json`，改到 `errors 0`。
- 把简短总结写进 `/var/tmp/r1057/recon/reports/<批号>.md`（各 decision 条数；`collate` 清单：方名《书》目录多什么缺什么；`unsure` 清单）。回复只写一行：`<批号> decisions=<条数> collate=<n> alternate=<n> accept=<n> fix_row=<n> drop_row=<n> unsure=<n> errors=<自检错误数>`。
