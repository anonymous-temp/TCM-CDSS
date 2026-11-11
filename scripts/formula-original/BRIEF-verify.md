# 任务简报：逐方核对「原方组成」（方名 + 出处书 → 原书原文里的组成）

你是一个核对员。我们在给中医临床决策系统建一张**权威原方组成表**：键是（方名, 出处书），值是**原书原文**里这首方的药味、原文炮制、煎服法里的药引，每条都要带**可逐字核对的原文摘句**。
背景：系统现有方剂目录里有 545 条来自深圳《中药方剂编码规则》（调剂标准），药名是调剂品名（姜天麻、煅石决明、黄芩片），组成有的被现代改过（人参养荣汤被写成含枸杞子、首乌藤而无肉桂），出处却标原书。以后「原方」只认这张表。

你只负责**一批**目标，文件是 `/var/tmp/r1057/batches/<批号>.json`（批号在派给你的话里）。不要改任何仓库文件，不要动别的批次。

## 0. 禁令（所有工人必须遵守）

- **禁止部署**：不得运行任何部署、发布、docker、构建上线类命令。
- **禁止 ssh 到服务器**：不得 ssh / scp / rsync 到任何远程主机（包括 evimed、evimed-lab 及任何 IP）。
- **禁止 git push**：不得 push、不得改远程；也不要 commit、不要改 `/var/tmp/r1057/wt` 或 `/home/coder/workspace` 下任何仓库文件。
- **禁止读取密钥和 ~/.ssh**：不得读取 `~/.ssh`、任何 `.env*`、`secrets` 目录、`~/runlogs/customer-cases`、`~/.claude` 等凭据或隐私位置。
- 只在 `/var/tmp/r1057/` 这个任务目录里工作：只读 `batches/`、`jc/`、`BRIEF.md`、`tools/` 和简报点名的本地教材语料；只写 `out/<批号>.json`、`reports/<批号>.md`、`webpages/<批号>/`。
- 联网只用于查古籍/教材原文网页（curl 抓取、搜索），不向任何外部服务发送本机文件内容。

## 1. 输入（每个 target）

- `name`、`book`：要核的（方名, 出处书）。`book` 为空 = 来源没写出处，由你判断通行的原书（《方剂学》教材署的出处）。
- `catalog`：系统目录里同名同书的条目（`ingredients` 是现有组成，`sourceClass=official_local_formula_standard` 就是深圳标准条目，**不能当原方依据**）。
- `snippets`：程序预先找到的片段，仅供参考，**可能找错了条目，也可能不全**：
  - `src=jicheng`：jicheng.tw（中醫笈成）全文缓存里的片段，`sameBook=true` 是目标那本书；`text[0]` 是命中行，后面是其后的几行。
  - `jingfang_canonical`、`national_catalog`（国家古代经典名方目录，含原文 `text`）、`fangjixue`（《方剂学》教材【组成】）、`textbook_appendix`（教材方剂索引行，OCR 有粘连和断行）、`name_catalog`（方名大辞典式名录的同名条目，只有药名，**同名异方很多**）。
- `autoParse`：程序对第一个同书片段的自动解析（可能有错，别照抄）。
- `triage`：`diff` = 自动解析与目录组成不一致；`auto_only` = 目录没有这条；`unparsed` = 找到了同书片段但没解析出来；`other_sources`/`nothing` = 同书里没定位到。

## 2. 你能用的资料

1. **jicheng 全库简体缓存**：`/var/tmp/r1057/jc/<书名>.txt`（1323 本，一行一段，标题行以 `#h2 `/`#h3 ` 开头；多卷的书分成 `书名.txt`、`书名_1.txt`、`书名_2.txt`）。直接 `grep -n` / `grep -rl`。书名列表 `ls /var/tmp/r1057/jc`。
   原书里的方名常和通行名不同（《丹溪心法》大补阴丸叫「大补丸」，《医宗金鉴》的方常写在歌诀注文里、写成「(理中汤) …本方加丁香吴茱萸」），要按药味和主治去找，不要只 grep 方名。
2. **本地教材语料**：`/var/tmp/r1057/wt/中医补充数据/灵丹GitHub/TCM Educational Materials.txt`（UTF-8，一行一段；含《方剂学》【组成】与各科教材的方剂索引「方名（《书》）：药 药 药」）。
3. **联网**：jicheng 没有的书用 WebSearch / WebFetch 找原文所在网页（zh.wikisource.org、ctext.org、jicheng.tw 其它路径、国学/中医古籍站等）。**作为证据的网页必须能被 curl 存下来**：
   `python3 /var/tmp/r1057/tools/savepage.py '<url>' <批号>` → 打印保存路径（如 `w103/ab12cd34ef56.txt`，简体纯文本），你再从保存的文件里摘句。存不下来的网页（被拦、要登录）不能当证据。

## 3. 每个 target 产出一行

写到 `/var/tmp/r1057/out/<批号>.json`：`{"batch": "<批号>", "rows": [ ... ]}`，**顺序与输入一致，一条不少**。

```json
{
  "target": {"name": "人参养荣汤", "book": "太平惠民和剂局方"},
  "status": "verified",
  "name": "人参养荣汤",
  "book": "太平惠民和剂局方",
  "volume": "卷五·淳祐新添方",
  "variant": "",
  "aliases": ["人参养营汤"],
  "tier": "original_text",
  "ingredients": [
    {"written": "白芍药", "herb": "白芍", "dose": "三两"},
    {"written": "当归", "herb": "当归", "dose": "一两"},
    {"written": "桂心", "herb": "肉桂", "note": "去粗皮", "dose": "一两"},
    {"written": "白术", "herb": "白术", "preparation": "煨", "preparationRaw": "煨", "dose": "一两"},
    {"written": "甘草", "herb": "甘草", "preparation": "炙", "preparationRaw": "炙", "dose": "一两"},
    {"written": "熟地黄", "herb": "熟地黄", "note": "制", "dose": "七钱半"},
    {"written": "远志", "herb": "远志", "preparation": "炒", "preparationRaw": "炒", "note": "去心", "dose": "半两"}
  ],
  "guideHerbs": [{"herb": "生姜", "written": "生姜三片"}, {"herb": "大枣", "written": "枣子二枚"}],
  "evidence": [
    {"kind": "jicheng", "book": "太平惠民和剂局方", "url": "https://jicheng.tw/tcm/book/…/index.html",
     "quote": "白芍药（三两） 当归 陈皮 黄耆 桂心（去粗皮） 人参 白术（煨） 甘草（炙，各一两） 熟地黄（制） 五味子 茯苓（各七钱半） 远志（炒，去心，半两）"},
    {"kind": "jicheng", "book": "太平惠民和剂局方", "url": "…", "quote": "上锉散。每服四钱，水一盏半，生姜三片，枣子二枚，煎至七分，去滓温服。"}
  ],
  "catalogDiff": [
    {"id": "TCM-FORMULA-3B08FC93959D", "verdict": "catalog_differs", "extraInCatalog": ["枸杞子", "首乌藤"], "missingInCatalog": ["肉桂"], "comment": "目录条目是现代改过的组成"}
  ],
  "note": ""
}
```
（示例里省略了几味药；你的行要写全。）

### 字段规则

- **status**
  - `verified`：在目标那本书（或它的 jicheng 缓存）原文里找到并摘了句。
  - `verified_other_edition`：目标那本书不在缓存/网上，但在**直接收录、转引它的书**里找到了同一首方（如《伤寒论》方见于《注解伤寒论》，《医学统旨》方见于《证治准绳》引文），`note` 写明是哪本书转引。
  - `modern_formula`：出处是现代书/经验方（20 世纪教材、名医经验集、「经验方」），依据用本地教材语料的方剂索引行或【组成】行（`kind: local`）或可存的网页；`tier` 用 `textbook_appendix` 或 `modern_source`。
  - `not_found`：合理努力后（同书 grep、按药味找、换书名写法、联网 2–3 次）仍找不到可摘句的原文。`note` 写查过哪里。**不要凭记忆写组成。**
  - `not_a_formula`：目标不是一首方（「X合Y」「X加某药」「X加减」这类教材行写法、章节名）。`note` 说明。
- **name / book**：原书里的方名（简体）与规范书名（不带书名号；简称写全：局方→太平惠民和剂局方，济生方→严氏济生方，金匮→金匮要略）。原书方名与目标名不同（大补丸 vs 大补阴丸）时 `name` 用目标名、原书名放 `aliases`，`note` 说明。
  目标 `book` 为空时写你认定的原书；目标的书只是转载（《医方集解》《成方切用》收的局方、仲景方），仍按**目标那本书里的写法**摘（那本书怎么写就怎么记），并在 `note` 里写「原出《XX》」。
- **variant**：同一本书里有几首同名方时（《全生指迷方》有两首白术散），选与 `catalog`/教材片段组成相符的那首，`variant` 写它的主治要点（如「妊娠面目肿」）；否则空串。
- **tier**：`original_text`（原书/转引书原文）、`national_catalog`（只有国家经典名方目录的原文）、`fangjixue`（只有《方剂学》【组成】）、`textbook_appendix`（只有教材方剂索引行）、`modern_source`（现代书/网页）。能用 `original_text` 就不用后面的。
- **ingredients**（原文顺序，一味一项）
  - `written`：原文里的写法，**逐字**（简体缓存里的字形：黄耆、白芍药、桂心、枣子、浓朴），必须出现在你的某条 `quote` 里。
  - `herb`：这味药今天的饮片基础名（《中国药典》/《方剂学》教材通行名，**不带炮制**）：黄耆→黄芪，白芍药→白芍，桂心/官桂→肉桂，干葛→葛根，橘皮→陈皮，生决明→石决明，浓朴→厚朴，山栀子→栀子，枣子→大枣，缩砂→砂仁，栝蒌根→天花粉，生地黄/干地黄→地黄，熟地黄→熟地黄（独立品种），炮姜→炮姜，半夏曲→半夏曲，胆南星→胆南星。
    汉唐方里未分的「芍药」「术」「桂」「枳实」：按《方剂学》教材通行写法（桂枝汤的芍药→白芍，五苓散的桂→桂枝，术→白术），拿不准就让 `herb` = `written` 并在 `note` 说明。
    已不用或需替代的（犀角、虎骨、穿山甲）：`herb` 照写原名（犀角），不要替换成水牛角。
  - `preparation` + `preparationRaw`：原文写明、**会改变饮片名**的炮制才填。`preparation` 取闭集之一：`炙`（蜜炙/炙）、`炒`、`麸炒`、`土炒`、`煅`、`酒`、`盐`、`醋`、`姜`、`炮`、`煨`、`焙`、`制`、`蒸`、`炭`、`焦`、`烧`、`熬`；`preparationRaw` 是原文那几个字（必须在 quote 里）。去皮、去心、去芦、洗、锉、切、研、捣这类净制切制放 `note`，不填 preparation。原文药名自带的（炙甘草、炮附子、熟附子、煨姜）：`written` 照写，`herb` 写基础名，`preparation` 照填、`preparationRaw` 写那个字。
  - `dose`（可选）：原文剂量逐字（「各一两」分摊到每味写「一两」）。
  - 一味药只出现一次；同一饮片两种写法（如同方既有生地黄又有熟地黄）是两味。
- **guideHerbs**：煎服法里另加、**不在药味表里**的药引（生姜三片、枣二枚、薄荷少许、葱白、粳米、竹叶、灯心、乌梅、蜜/酒/醋/盐汤送服不算）。`herb` 基础名，`written` 原文那几个字（必须在 quote 里）。原方把生姜、大枣列在药味里的，放 ingredients，不放这里。
- **evidence**：至少一条。`quote` 是原文**连续逐字**的一段（简体缓存字形，可以不含行首 `#h3 `；不要省略号拼接；长度 10–400 字；药味行要摘全，药引所在的煎服法另摘一条）。
  - `{"kind":"jicheng","book":"<缓存文件名去掉.txt>","url":"<片段里的 url 或 https://jicheng.tw/tcm/book/<繁体书名>/index.html>","quote":"…"}`
  - `{"kind":"local","file":"中医补充数据/灵丹GitHub/TCM Educational Materials.txt","line":126978,"quote":"…"}`（行号从 1 起，`grep -n` 的行号）
  - `{"kind":"web","url":"…","saved":"<批号>/<文件名>","quote":"…"}`
  - 只有国家目录时：`{"kind":"national_catalog","quote":"<snippets 里 national_catalog 的 text[0] 原样>"}`
- **catalogDiff**：对 target.catalog 里**每个**条目给结论（没有 catalog 就给空数组）。按**药味身份**比（忽略炮制、调剂品名、去皮去心；生姜大枣在原书是药引而目录列为药味，记 `writing_only` 并在 comment 说明）：
  - `same`、`writing_only`（只是写法/品名/药引位置不同）、`catalog_differs`（目录多了或少了药：填 `extraInCatalog` / `missingInCatalog`，用基础名）、`catalog_is_other_formula`（同名异方，目录这条不是这本书这首）。
  - `comment`：一句话原因（现代改方？抄错？替代品如犀角→水牛角？另一出处的同名方？）。

## 4. 自检（必须做）

写完后运行：`python3 /var/tmp/r1057/tools/check_rows.py /var/tmp/r1057/out/<批号>.json`，改到 `errors 0`。
它核的是：quote 在所指文本里逐字存在；每味药的 `written`、`preparationRaw`、药引的 `written` 都在 quote 里；取值在闭集内。**不要为了过检查去改 quote 的字**——过不了说明你摘错了或写法不是原文，回去看原文。

## 5. 分寸

- 一批约 30 条，别在一条上耗太久：同书定位 → 换写法/按药味找 → 转引书 → 联网 2–3 次，仍无则 `not_found`。
- 宁缺毋滥：拿不准是不是同一首方，写 `not_found` 并在 note 里写你看到了什么。
- 最后回复我一段简短总结（不要贴整份 JSON）：各 status 条数；`catalog_differs` / `catalog_is_other_formula` 的清单（方名《书》：目录多什么、缺什么、一句原因）；你认为可疑、需要我复核的条目；自检结果（errors 0）。

## 6. 二次查证批次（批号以 x 开头）

这些目标上一轮没找到可摘句的原文（每条的 `previousAttempt` 写了查过哪里）。这一轮重点**联网**：
- 先想清楚这首方真正的原出处（教材署的书可能是转引、简称或误署），再去找那本书的全文页；
- 可试：zh.wikisource.org、ctext.org、jicheng.tw（其它卷/其它版本页）、www.theqi.com、www.a-hospital.com（医学百科的古籍全文与方剂条目）、zhongyibaike.com、yibian.hopto.org、国学大师/殆知阁的古籍页；现代经验方可找原书或权威教材的在线全文；
- 作为证据的页面必须能用 `savepage.py` 存下来并在存下的文本里逐字摘句；二手方剂库只有「组成」没有原文的，`tier` 用 `modern_source`，`note` 写明；
- 仍找不到就保持 `not_found`，不要凭记忆写。
