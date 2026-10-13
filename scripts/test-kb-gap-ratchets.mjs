// 方剂/药味知识库缺口的常驻判据（2026-09-30，甲方要求「发现一个问题解决一类问题」）。
//
// 这一轮联网核对逐类补的缺口，每一类都留一条判据，防止它悄悄长回来：
//   ① 解析残片：药名里混进剂量/用法文字（人参少则用、白酒一斗、竹叶二把）或单字残片（硝、米、叶…）
//   ② 章节标题冒充方名：「治…方」型名称、组成 ≥8 味 = 一节多首单方并成一份，必须整批隔离，不得保留方名锁定与检索资格
//   ③ 出处栏写的不是书：作者名/简称/错字（景岳、金匮、东垣、《外台》、《三因极—…》），不得再出现
//   ④ 受治理药名补充里的后缀式炮制名（栀子炭、艾叶炭…）归一到基原药后，炮制说明不能丢
//   ⑤ 儿童剂量档位表与依据的教材原文一致（另有 test:pediatric-dose-rule 逐档钉死）
//   ⑦ 伤寒/金匮方出处记成后世转引书（2026-10-12：68 首，含四逆辈、桂枝汤类方），以及原书方在目录里整首缺失
//   ⑧ 常用方的主治栏是占位句（2026-10-13：六味地黄丸、补中益气汤、丹栀逍遥散），按表现召回不到
//
// 每条断言都带反证：先在合成输入上证明判据抓得到，再对真实目录断言为零，最后钉住「已核对后仍保留」的名单。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const catalog = read("src/data/tcm-formula-governed-catalog.json");
const entries = catalog.entries;

const failures = [];
let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 700) }); }
};

// ── ① 药名里的剂量/用法文字 ───────────────────────────────────────────
// 「少则用」「已上」这类用法文字，或「药名(≥2字)+数词+量词」结尾。量词不含「钱」，前缀至少 2 字：三七根、半两钱是真药名。
const QTY_TAIL = /^(.{2,}?)([一二三四五六七八九十两半]+(?:粒|枚|个|片|把|根|条|斤|斗|升|滴|盏|匙|茎|寸|尺|张|块|杯))$/;
const DOSE_TEXT_IN_NAME = {
  test(name) {
    return /(?:少则用|多则用|已上|已下)|\d/.test(name) || QTY_TAIL.test(name);
  },
};

check("1.1 判据本身：抓得到已知的坏名字，不误伤真药名（反证）", () => {
  for (const bad of ["人参少则用", "多则用", "甘草已上", "白酒一斗", "竹叶二把", "老葱三根", "桃仁十四粒", "生姜汁四滴", "五味子十四粒", "史国公药酒方三十斤"]) {
    assert.equal(DOSE_TEXT_IN_NAME.test(bad), true, `${bad} 必须被判为夹带剂量/用法文字`);
  }
  for (const good of ["三七", "九节菖蒲", "七叶一枝花", "五味子", "六神曲", "八月札", "九香虫", "四叶参", "半夏曲", "百合", "合欢皮", "十大功劳叶", "王不留行", "白酒", "三七根", "半两钱"]) {
    assert.equal(DOSE_TEXT_IN_NAME.test(good), false, `${good} 是真药名，不得误伤`);
  }
});

check("1.2 目录里没有任何药名夹带剂量/用法文字（受治理目录全量）", () => {
  const hits = [];
  for (const entry of entries) {
    for (const name of [...entry.ingredients, ...entry.ingredientLinks.map((link) => link.rawName)]) {
      if (DOSE_TEXT_IN_NAME.test(name)) hits.push(`${entry.name}:${name}`);
    }
  }
  assert.deepEqual([...new Set(hits)], [], "药名里混进剂量/用法文字——回源重录该方组成，不要在药名上打补丁");
});

// ── ① 单字残片：已逐条回源核对后仍保留的名单（每一条都写明为什么保留）──────────────
const REVIEWED_SINGLE_CHAR = {
  "哭来笑去散": ["硝"],   // 惠直堂原文只写「硝」，同书朴硝/芒硝/火硝并存，无旁证不映射
  "塞耳丹": ["砒"],       // 三因方原文单写「砒」，砒石/砒霜未指明；按毒性药品处理
  "桃红散": ["坯"],       // 各版本均只见单字「坯」，原书残缺
  "神效丸": ["桂", "砂"], // 「桂」各传本肉桂/桂枝/官桂不一致；「砂」= 硇砂已核，但目录写法仍是残字
  "地榆绢煎": ["绢"],     // 原文就是「绢」（绢一片入煎），真药味
  "铅汞丹": ["铅"],       // 原文就是铅（炼丹原料），非残片
  "银粉散": ["锡"],       // 原文就是锡
  "香港脚疼痛方三十五": ["葱"], // 原文写「葱」，未指明葱白
  // 已被隔离的章节合抄条目（见 ②）里的残片：随整条隔离，不再单列核对
  "治中风诸急及风热方": ["桂"], "治天行诸病方": ["马"], "治小便难及遗尿、尿频方": ["鸡"],
  "治疥及疠疡风方": ["曲"], "治诸出血方": ["芎"], "治马咋踏及诸马物伤人方": ["水"],
};
check("1.3 单字残片只剩已逐条回源核对后保留的名单；新出现的残片必须先核对（棘轮）", () => {
  const actual = Object.fromEntries(entries.filter((entry) => entry.corruptIngredientNames.length > 0)
    .map((entry) => [entry.name, [...entry.corruptIngredientNames].sort()]));
  const expected = Object.fromEntries(Object.entries(REVIEWED_SINGLE_CHAR).map(([name, tokens]) => [name, [...tokens].sort()]));
  assert.deepEqual(actual, expected);
});

check("1.4 反证：残片未核对前，含残片且可锁定的条目不得取得剂量编译资格", () => {
  const leaking = entries.filter((entry) => entry.corruptIngredientNames.length > 0 && entry.doseCompilationEligible)
    .map((entry) => entry.name);
  assert.deepEqual(leaking, [], "含未核对残片的方不得进剂量编译");
});

// ── ② 章节标题冒充方名 ──────────────────────────────────────────────────
const HEADING_NAME = /^(?:治|主治|疗|疗治|论治)[^〔（(]{2,30}方$/;
check("2.1 「治…方」型名称、组成 ≥8 味：整批隔离（不得锁定方名、不得进检索）", () => {
  const big = entries.filter((entry) => HEADING_NAME.test(entry.name) && entry.ingredients.length >= 8);
  assert.ok(big.length >= 30, `样本不足（${big.length}），判据可能空转`);
  const leaking = big.filter((entry) => entry.identityLockEligible || entry.retrievalEligible).map((entry) => entry.name);
  assert.deepEqual(leaking, [], "章节标题式名称且组成≥8味必须整批隔离");
  assert.ok(big.every((entry) => entry.identityBlockingReasons.includes("composition_is_collated_chapter_requires_source_split")));
});

check("2.2 反证：同名型但只有几味的条目仍是真单方，不得被误隔离", () => {
  const small = entries.filter((entry) => HEADING_NAME.test(entry.name) && entry.ingredients.length < 8 && entry.identityLockEligible);
  assert.ok(small.length >= 20, `小条目样本不足（${small.length}）`);
});

check("2.3 已核实为章节合抄伪方并整条删除的条目不在目录里", () => {
  const removed = ["噎膈方", "外敷方", "治众蛇螫人方", "治发背经验方", "治妊娠胎动及胎不长方", "治尸厥方", "治服石虚热水肿方",
    "治熊虎伤人疮方", "治牙齿病方", "治狂犬咬人方", "治胎死欲令出方", "治霍乱转筋及杂治方", "火牙方", "疯狗咬方"];
  const names = new Set(entries.map((entry) => entry.name));
  assert.deepEqual(removed.filter((name) => names.has(name)), []);
  const dropped = new Set((catalog.summary.collatedChapterDropped || []).map((key) => String(key).split("@")[0]));
  assert.deepEqual(removed.filter((name) => !dropped.has(name)), [], "删除必须留在 summary.collatedChapterDropped 里可追溯");
});

// ── ③ 出处栏必须是书 ──────────────────────────────────────────────────────
// 简称/别称/错字 → 规范书名。国家《古代经典名方目录》来源条目的出处栏是国家目录自己的写法，不在此列。
const NON_BOOK_TITLES = new Set(["外台", "局方", "金匮", "仲景", "景岳", "三因", "三因方", "本事", "本事方", "圣济", "总录", "此事知难",
  "太平惠民合剂局方", "黄帝素问宣明方论", "秘传眼科龙目论", "三因极—病证方论", "药蔹启秘", "类编朱氏集验方", "东垣", "洁古", "丹溪", "河间", "子和", "钱乙", "严氏", "严用和"]);
const titlesOf = (source) => {
  const inBrackets = [...String(source || "").matchAll(/《([^》]+)》/g)].map((match) => match[1]);
  return inBrackets.length > 0 ? inBrackets : [String(source || "").replace(/[（）()。\s]/g, "")];
};
// 已逐条回源核对、确认无法（或不应）改写的：作者名 + 书名未指明、原书查无此名。每一条注明原因。
const REVIEWED_NON_BOOK_SOURCES = new Set([
  "养胃增液汤|验方",   // 现代验方，无可追溯的书
  "驱蛔汤|经验方",     // 现代经验方，无可追溯的书
]);
check("3.1 判据本身：抓得到简称/错字，不误伤规范书名（反证）", () => {
  for (const bad of ["《外台》卷三十三", "景岳", "《三因极—病证方论》", "《药蔹启秘》", "东垣", "《局方》"]) {
    assert.equal(titlesOf(bad).some((title) => NON_BOOK_TITLES.has(title)), true, `${bad} 必须被判为非规范书名`);
  }
  for (const good of ["《外台秘要》卷三十三", "《景岳全书》", "《三因极一病证方论》", "《药奁启秘》", "《太平惠民和剂局方》卷九", "《脾胃论》"]) {
    assert.equal(titlesOf(good).some((title) => NON_BOOK_TITLES.has(title)), false, `${good} 是规范书名`);
  }
});
check("3.2 目录出处栏不再出现简称/作者名/错字书名（受治理目录全量，非国家目录条目）", () => {
  const offenders = entries.filter((entry) => entry.sourceClass !== "official_classic_catalog")
    .filter((entry) => titlesOf(entry.source).some((title) => NON_BOOK_TITLES.has(title)))
    .map((entry) => `${entry.name}|${entry.source}`)
    .filter((key) => !REVIEWED_NON_BOOK_SOURCES.has(key));
  assert.deepEqual(offenders, [], "出处栏写的不是书：回源找到真正的书名，或逐条核对后登记进 REVIEWED_NON_BOOK_SOURCES 并写明原因");
});

// ── ④ 后缀式炮制名归一后仍保留炮制说明 ─────────────────────────────────────
check("4.1 受治理药名补充里的炮制品（艾叶炭/栀子炭…）都登记了 preparation，编译时才不会丢炮制说明", () => {
  const supplements = read("src/data/tcm-herb-identity-supplements.json").entries.filter((entry) => entry.batch === "ADJ-WEB-20260930-HERB");
  assert.ok(supplements.length >= 30, `本批药名补充只有 ${supplements.length} 条，样本疑似丢失`);
  const suffixForms = supplements.filter((entry) => /炭$/.test(entry.inputName));
  assert.ok(suffixForms.length >= 8, "炭类样本不足");
  for (const entry of suffixForms) assert.ok(entry.preparation, `${entry.inputName} 必须登记炮制说明（preparation）`);
});
check("4.2 端到端：艾叶炭 → 艾叶 + 炮制「炒炭」，炮制说明随编译保留", () => {
  // 同步包一层：jiti 同步 API
  const compiler = jiti("../src/lib/m04-proposal-compiler.ts");
  const proposal = {
    candidate: {
      name: "本例辨证组方", applicable: "崩漏下血。", notApplicable: "无。",
      herbs: [{ name: "艾叶炭", dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "温经止血", processing: null, isToxic: false, decoctionRequirement: null }],
      formulaAnalysis: "艾叶炭温经止血。",
      decoction: { doseCount: "3剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "3日复诊" },
    },
    patentAndWestern: [], modifications: [],
    nonPharma: { diet: "清淡。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
  };
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "冲任不固证", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "经血淋漓", pathogenesis: "冲任不固", therapyDirection: "温经止血" }] },
    therapy: { overallMethod: "温经止血", overallPrinciple: "急则治标" },
  };
  const herb = compiler.compileM04Proposal(proposal, prior)?.formula?.candidates?.[0]?.herbs?.[0];
  assert.equal(herb?.name, "艾叶");
  assert.match(herb?.processing || "", /炭/);
});

// ── ⑤ 儿童剂量表与教材原文一致 ─────────────────────────────────────────────
check("5.1 儿童剂量数据文件登记的教材原文里确有 1/6、1/3、1/2、2/3 四个数（改数必须回原文）", () => {
  const data = read("src/data/tcm-pediatric-dose-rule.source.json");
  const quoted = data.sourceRefs.map((ref) => ref.quote).join("\n");
  for (const text of ["1/6", "1/3", "1/2", "2/3"]) assert.ok(quoted.includes(text), `教材引文里缺 ${text}`);
  const table = Object.fromEntries(data.stages.map((stage) => [stage.code, `${stage.numerator}/${stage.denominator}`]));
  assert.deepEqual(table, { neonate: "1/6", infant: "1/3", toddler: "1/2", preschool: "1/2", school: "2/3", adolescent: "1/1" });
});

// ── ⑥ 别名错链：A 药被归成 B 药 ─────────────────────────────────────────────
// 2026-09-30 新生儿黄疸回放暴露：身份目录把「茵陈蒿」（=茵陈）归成青蒿，茵陈蒿汤的君药被换成另一味药；同源数据里还有
// 大附子→狼毒、汉防己→北豆根、沙参→银柴胡、葵子→天葵子、关木通→木通、广防己→穿山龙、雷公藤→杠板归……
// 错因是一类：本地别名数据集里中等置信度的「同名异物」被按「唯一来源」自动落药。整类判据分三层。
const identity = jiti("../src/lib/tcm-herb-identity.ts");
const knowledge = read("src/data/tcm-knowledge.json");
const identityCatalog = read("src/data/tcm-herb-identity-catalog.json");
const standardNames = identityCatalog.entries.map((entry) => entry.standardName);
const riskHerbs = new Set(knowledge.herbs.filter((herb) => herb.entries.some((item) => item.type === "herbRisk")).map((herb) => herb.name));
const resolveName = (name) => identity.resolveGovernedTcmHerbIdentity(name);

check("6.1 已核对的错链逐条钉死（茵陈蒿→茵陈、大附子→附子、汉防己→防己、葵子→冬葵子）", () => {
  assert.equal(resolveName("茵陈蒿").canonicalName, "茵陈");
  assert.equal(resolveName("大附子").canonicalName, "附子");
  assert.equal(resolveName("汉防己").canonicalName, "防己");
  assert.equal(resolveName("葵子").canonicalName, "冬葵子");
  assert.equal(resolveName("紫金皮").canonicalName, "紫荆皮");
  // 反证：正名自己仍是自己，青蒿没有被顺带改坏
  assert.equal(resolveName("茵陈").canonicalName, "茵陈");
  assert.equal(resolveName("青蒿").canonicalName, "青蒿");
  assert.equal(resolveName("附子").canonicalName, "附子");
});

check("6.2 同名异物不自动落一种：沙参(南/北)、大茴香、南木香、胡麻子必须是多候选、不可自动落药", () => {
  for (const [name, candidates] of [["沙参", ["南沙参", "北沙参"]], ["大茴香", ["八角茴香", "小茴香"]], ["南木香", ["木香", "土木香"]], ["胡麻子", ["黑芝麻", "亚麻子"]]]) {
    const resolved = resolveName(name);
    assert.equal(resolved.canonicalName, undefined, `${name} 不得自动落药`);
    assert.equal(resolved.status, "ambiguous");
    assert.deepEqual([...resolved.candidates].sort(), [...candidates].sort());
  }
});

check("6.3 监管已取消标准/剧毒药不得被归成另一味药：关木通、广防己、青木香、马兜铃、天仙藤、寻骨风、朱砂莲、雷公藤、雪上一枝蒿、鬼臼、莽草", () => {
  for (const name of ["关木通", "广防己", "青木香", "马兜铃", "天仙藤", "寻骨风", "朱砂莲", "雷公藤", "雪上一枝蒿", "鬼臼", "莽草", "虾蟆", "蜘蛛"]) {
    assert.equal(resolveName(name).canonicalName, undefined, `${name} 必须不可自动落药（旧目录曾把它归成别的药，等于让它以别的药名过审）`);
  }
  // 反证：正常药不受影响
  for (const name of ["木通", "川木通", "防己", "细辛", "草乌"]) assert.equal(resolveName(name).canonicalName, name);
});

check("6.4 整类判据：带毒性/风险条目的药名，身份解析后不得落到一味没有风险条目的药（防止危险药「换名过审」）", () => {
  const offenders = [];
  for (const name of riskHerbs) {
    const canonical = resolveName(name).canonicalName;
    if (canonical && canonical !== name && !riskHerbs.has(canonical)) offenders.push(`${name}→${canonical}`);
  }
  assert.deepEqual(offenders, []);
  // 判据本身抓得到：把关木通当作「归成木通」的旧行为塞进来，木通没有 herbRisk 条目
  assert.equal(riskHerbs.has("关木通"), true, "关木通在知识库里带风险条目");
  assert.equal(riskHerbs.has("木通"), false, "木通本身没有风险条目——所以关木通→木通会被 6.4 抓到");
});

check("6.5 整类判据：方剂药味「原名含另一味标准药名、归一结果却不含原名」的链，只允许已逐条核对过的名单", () => {
  const REVIEWED = new Set([
    "干地黄->生地黄", "白茯神->茯苓", "沙苑蒺藜->沙苑子", "熟干地黄->熟地黄", "大豆卷->大豆黄卷", "姜炭->炮姜", "旱莲子->墨旱莲",
    "酒洗地黄->生地黄", "瓜蒌根->天花粉", "干生姜->干姜", "赤茯神->茯苓", "梅花冰片->天然冰片（右旋龙脑）", "胡桃仁->核桃仁",
    "瓜蒌仁->瓜蒌子", "黑大豆->黑豆", "藏红花->西红花", "金钱薄荷->连钱草",
  ]);
  const found = new Set();
  for (const entry of entries) {
    for (const link of entry.ingredientLinks) {
      const raw = link.rawName;
      const canonical = link.canonicalName;
      if (!canonical || raw === canonical || raw.includes(canonical) || canonical.includes(raw)) continue;
      if (standardNames.some((name) => name !== canonical && name.length >= 2 && raw.includes(name))) found.add(`${raw}->${canonical}`);
    }
  }
  const unreviewed = [...found].filter((pair) => !REVIEWED.has(pair));
  assert.deepEqual(unreviewed, [], "出现新的「A 药名归成 B 药」链：联网核对后，要么在 tcm-herb-identity-supplements 里改正，要么核对无误后登记进本名单");
  // 判据本身抓得到（反证）：茵陈蒿含标准名「茵陈」，旧归一结果青蒿不含原名
  assert.equal(standardNames.includes("茵陈"), true);
  assert.equal("茵陈蒿".includes("青蒿"), false);
});

check("6.6 整类判据：正名（药味在知识库有剂量边界）被归成另一味药的，只允许已核对的同物异名", () => {
  const withDose = new Set(knowledge.herbs.filter((herb) => herb.entries.some((item) => ["dose", "curatedDose", "routeDose"].includes(item.type))).map((herb) => herb.name));
  const REVIEWED_SAME_DRUG = new Set(["神曲->六神曲"]); // 神曲=六神曲（药典称六神曲），同一味药
  const remapped = [];
  for (const name of withDose) {
    const canonical = resolveName(name).canonicalName;
    if (canonical && canonical !== name) remapped.push(`${name}->${canonical}`);
  }
  const unreviewed = remapped.filter((pair) => !REVIEWED_SAME_DRUG.has(pair));
  assert.deepEqual(unreviewed, [], "知识库里有独立剂量条目的药名被归成了另一味药：核对是同一味药的别名后登记，否则改正");
});

check("6.7 身份被明令封闭（不可自动落药，且没有候选品种）的药味，含它的方不得保留剂量编译资格——与运行时闸门一致", () => {
  const closed = [];
  for (const entry of entries) {
    for (const link of entry.ingredientLinks) {
      if (link.linkageStatus === "ambiguous" && !link.canonicalName && (identityCatalog.resolutionIndex[link.rawName]?.candidates || []).length < 2) {
        closed.push({ formula: entry.name, herb: link.rawName, eligible: entry.doseCompilationEligible });
      }
    }
  }
  assert.ok(closed.length >= 5, `应能找到含封闭身份药味的方（莽草/虾蟆/蜘蛛…），实际 ${closed.length}`);
  assert.deepEqual(closed.filter((row) => row.eligible), [], "含封闭身份药味的方仍拿着 doseCompilationEligible=true");
  const herbs = new Set(closed.map((row) => row.herb));
  for (const herb of ["莽草", "虾蟆", "蜘蛛"]) assert.ok(herbs.has(herb), `${herb} 应是封闭身份`);
});

// ── ⑦ 伤寒/金匮方出处与缺失（2026-10-12）────────────────────────────────────────
// 目录里有 68 首仲景方组成与原文一致（或残缺），出处却记成转引它的后世书（《绛雪园古方选注》《医方考》《古今名医方论》
// 《三因方》《医方集解》…），于是「出处=伤寒论/金匮」的流派归属全落空（扶阳学派的四逆辈因此一首都归不上），
// HIS 里的出处也是错的；另有 50 首原书内服方整首缺失（桂枝加龙骨牡蛎汤、薯蓣丸、四逆加人参汤…）。
// 原书方目与组成见 tcm-jingfang-canonical.source.json（宋本原文 + 维基文库交叉核对）。
const jingfang = read("src/data/tcm-jingfang-canonical.source.json").books;
const JINGFANG_HERB_EQ = { 炙甘草: "甘草", 白芍: "芍药", 赤芍: "芍药", 白芍药: "芍药", 炮附子: "附子", 制附子: "附子", 熟附子: "附子", 附片: "附子", 生附子: "附子", 大附子: "附子",
  山药: "薯蓣", 干地黄: "地黄", 生地黄: "地黄", 熟地黄: "地黄", 生地黄汁: "地黄", 法半夏: "半夏", 姜半夏: "半夏", 清半夏: "半夏", 苦杏仁: "杏仁", 燀苦杏仁: "杏仁",
  香豉: "豉", 淡豆豉: "豉", 淡豉: "豉", 豆豉: "豉", 栝楼根: "栝蒌根", 天花粉: "栝蒌根", 瓜蒌根: "栝蒌根", 瓜蒌: "栝蒌实", 栝楼实: "栝蒌实", 全瓜蒌: "栝蒌实", 葶苈子: "葶苈",
  桂心: "桂枝", 肉桂: "桂枝", 浓朴: "厚朴", 姜厚朴: "厚朴", 旋复花: "旋覆花", 丹皮: "牡丹皮", 饴糖: "胶饴", 麦冬: "麦门冬", 天冬: "天门冬", 茵陈蒿: "茵陈",
  代赭石: "代赭", 赭石: "代赭", 党参: "人参", 炒枳实: "枳实", 麸炒枳实: "枳实", 土鳖虫: "䗪虫", 炮姜: "干姜", 火麻仁: "麻子仁", 麻仁: "麻子仁", 陈皮: "橘皮",
  葱: "葱白", 生葛: "葛根", 甘李根白皮: "甘李根皮", 酒萸肉: "山茱萸", 白茯苓: "茯苓", 生巴豆: "巴豆", 神曲: "曲" };
const jingfangByName = new Map();
for (const [book, list] of Object.entries(jingfang)) {
  for (const formula of list) {
    const herbs = new Set(formula.ingredients.map((name) => JINGFANG_HERB_EQ[name] || name));
    for (const name of [formula.name, ...(formula.variants || [])]) {
      if (!jingfangByName.has(name)) jingfangByName.set(name, []);
      jingfangByName.get(name).push({ book, herbs });
    }
  }
}
const isOriginalBook = (source) => /伤寒|金匮|金匱/.test(source || "");
// 国家《古代经典名方目录》与 SZJG 标准方的出处栏是外部标准原文，按 9/29 口径不改（见 tcm-formula-catalog-collation 的说明）。
const isExternalStandard = (entry) => /SZJG|古代经典名方目录/.test(entry.sourceCatalog || "");
function misattributedJingfang(rows) {
  return rows.filter((entry) => {
    if (isOriginalBook(entry.source) || isExternalStandard(entry)) return false;
    const herbs = new Set((entry.ingredients || []).map((name) => JINGFANG_HERB_EQ[name] || name));
    return (jingfangByName.get(entry.name) || []).some((original) =>
      original.herbs.size === herbs.size && [...herbs].every((name) => original.herbs.has(name)));
  }).map((entry) => `${entry.name}@${entry.source}`);
}

check("7.1 判据能抓到：与原书同名同组成、出处却是后世书的条目（合成输入）", () => {
  const synthetic = [
    { name: "白通汤", source: "《医方考》", ingredients: ["葱白", "干姜", "附子"], sourceCatalog: "project_verified_supplement" },
    { name: "桂枝加附子汤", source: "《医方考》", ingredients: ["桂枝", "白芍", "炙甘草", "生姜", "大枣", "附子"], sourceCatalog: "project_verified_supplement" },
    { name: "猪苓散", source: "《银海精微》", ingredients: ["猪苓", "木通", "大黄"], sourceCatalog: "project_verified_supplement" },
  ];
  assert.deepEqual(misattributedJingfang(synthetic), ["白通汤@《医方考》", "桂枝加附子汤@《医方考》"], "同名异方（组成不同）不得被当成转引");
});

check("7.2 真实目录：仲景方不得再记成后世转引书（同名异方与外部标准条目除外）", () => {
  assert.deepEqual(misattributedJingfang(entries), []);
});

check("7.3 原书内服方不得整首缺失（外用、历史方、含十八反药对的赤丸等逐条列明不收）", () => {
  const names = new Set(entries.flatMap((entry) => [entry.name, entry.displayName].filter(Boolean)));
  const NOT_COLLECTED = new Set([
    "蜜煎导方", "猪胆汁方", "百合洗方", "雄黄熏方", "头风摩散", "矾石汤", "矾石丸", "蛇床子散", "狼牙汤", "小儿疳虫蚀齿方", // 外用
    "烧裈散", "鸡屎白散", "紫石寒食散", "还魂汤", "甘草粉蜜汤", // 历史方 / 「粉」所指不明 / 民间急救
    "赤丸", // 乌头、半夏同方（十八反）且以真朱为色
    "长服诃黎勒丸", // 原书自注「疑非仲景方」
    "治马坠及一切筋骨损方", // 无专名
    "升麻鳖甲汤去雄黄蜀椒", // 方名不成方形，基方升麻鳖甲汤在册
    "桂枝救逆汤", // 即伤寒论桂枝去芍药加蜀漆牡蛎龙骨救逆汤，目录已有
  ]);
  const missing = Object.values(jingfang).flat()
    .filter((formula) => ![formula.name, ...(formula.variants || [])].some((name) => names.has(name)))
    .map((formula) => formula.name)
    .filter((name) => !NOT_COLLECTED.has(name));
  assert.deepEqual([...new Set(missing)], []);
});

// ── ⑧ 主治栏是占位句的常用方（2026-10-13）────────────────────────────────────
// 六味地黄丸、补中益气汤、丹栀逍遥散三首的主治原是生成器里手写的占位句（「肝肾阴虚相关表现；丸剂身份不得…」），
// 龙胆泻肝汤只有两个证名。M03 按患者表现召回候选方读的就是主治原文，里面没有任何表现，这几首最常用的方
// 因此进不了候选：甲方腰痛·肾阴虚例的短名单里没有六味地黄丸，六次都锁了主治里逐字写着「腰膝酸软、口燥咽干」的七味都气丸。
// 现取《方剂学》教材【主治】原文。
const PLACEHOLDER_INDICATION = /相关表现|须结合患者事实确认|须按病历事实|不得自动等同于同名/;
check("8.1 判据能抓到占位主治（合成输入），真实目录全量为零", () => {
  assert.ok(PLACEHOLDER_INDICATION.test("肝肾阴虚相关表现；丸剂身份不得自动等同于同名汤剂或加味变方"));
  assert.ok(PLACEHOLDER_INDICATION.test("脾胃气虚或气虚下陷相关表现；须结合患者事实确认"));
  assert.ok(!PLACEHOLDER_INDICATION.test("肾阴精不足证。腰膝酸软，头晕目眩，舌红少苔，脉沉细数"), "反证：真主治不被判成占位");
  const placeholders = entries.filter((entry) => (entry.indications || []).some((text) => PLACEHOLDER_INDICATION.test(text)));
  assert.deepEqual(placeholders.map((entry) => entry.name), []);
});
check("8.2 端到端：教材典型表现能把教材主方召回到候选前三（改前四例一例都召不回）", () => {
  const { retrieveTcmFormulaIndicationCandidates } = jiti("../src/lib/tcm-formula-indications.ts");
  const recall = (caseState) => retrieveTcmFormulaIndicationCandidates({ id: "kb-gap-recall", conversation: [], ...caseState }, 8).map((item) => item.name);
  const cases = [
    ["六味地黄丸", { patient: { sex: "男", age: 68 }, chiefComplaint: "腰痛半年", symptoms: { presentHistory: "患者半年前无明显诱因出现腰部隐隐作痛,酸软无力,缠绵不愈,口燥咽干" }, tongue: "舌红少苔", pulse: "脉细数" }],
    ["补中益气汤", { patient: { sex: "女", age: 48 }, chiefComplaint: "内脏下垂伴乏力气短半年", symptoms: { presentHistory: "子宫脱垂 II 度,久站加重,乏力少气,纳少便溏" }, tongue: "舌淡苔薄白", pulse: "细弱" }],
    ["丹栀逍遥散", { patient: { sex: "女", age: 42 }, chiefComplaint: "烦躁易怒、月经不调3月", symptoms: { presentHistory: "烦躁易怒，颊赤口干，头痛目涩，月经不调，少腹胀痛，自汗盗汗" }, tongue: "舌红苔薄黄", pulse: "脉弦虚数" }],
    ["龙胆泻肝汤", { patient: { sex: "男", age: 40 }, chiefComplaint: "头痛目赤、胁痛口苦3天", symptoms: { presentHistory: "头痛目赤，胁痛，口苦，耳肿" }, tongue: "舌红苔黄", pulse: "脉弦数有力" }],
  ];
  for (const [formula, caseState] of cases) {
    const names = recall(caseState);
    assert.ok(names.slice(0, 3).includes(formula), `${formula} 应在候选前三，实得：${names.join(" > ")}`);
  }
  // 反证：与这些方无关的表现不会把它们带出来（修的是主治缺失，不是给这四首方加权）。
  const unrelated = recall({ patient: { sex: "男", age: 30 }, chiefComplaint: "恶寒发热1天", symptoms: { presentHistory: "恶寒发热，无汗，头痛身痛，鼻塞流清涕" }, tongue: "舌淡红苔薄白", pulse: "脉浮紧" });
  for (const formula of ["六味地黄丸", "补中益气汤", "丹栀逍遥散", "龙胆泻肝汤"]) {
    assert.ok(!unrelated.includes(formula), `风寒表实不应召回 ${formula}：${unrelated.join(" > ")}`);
  }
});

// check 4.2 是同步的（jiti 同步导入），这里不需要 await；保留 async 只为读起来对称
console.log(JSON.stringify({ suite: "kb-gap-ratchets", checks, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
