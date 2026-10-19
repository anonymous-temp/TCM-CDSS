// 10/19 第八轮 WP-A（2026-10-19）：经方方证候选通道。
//
// 背景：X 集（考试题式病例）中医诊断不合格 33/110，其中 17 例的标准答案是《伤寒论》《金匮要略》方证（桂枝汤证、吴茱萸汤证、
// 大陷胸汤证、苓桂术甘汤证…）。系统的 M03 只把内科、妇科等教材的「病—证—法—方」行当候选，教材里没有对应行时模型就近套一个错的行。
// 做法（模型驱动、闭集，与教材病名闭集选择同一模式）：受治理的方证表 → 闭集小任务选方证（病历原文逐字引文 + 证据对核对）
// → 「经方方证候选」段进 M03 中医半提示词 → 锚定不把已选方证的证名改回教材行。
//
//   1 方证表：source 与生成物一致；条文逐字出自本地原文（反证：在临时副本上改一个字/一个主症/一个出处，构建必须报错）；
//             TODO 点名的方证都在表里、方名都能在方剂目录里锁定
//   2 闭集小任务：解析与逐字核对（方证名闭集、症状取自该方证、引文在病历里、否认不当证据）；证据对核对后的条数、泛症、特异度要求；
//             桩模型的两次调用（第二次不给方证名）、缓存、失败返回空
//   3 提示词：没有选出方证时与此前逐字相同；选出时多一段「经方方证候选」，规则在段内
//   4 锚定：证名与方向正是方证表里的一项时不改名、不覆盖治法与方向；未选方证（方向里没有该经方）时照旧锚定到教材行；
//             经方方证与教材行同为「证名—方」的正向依据（trustedModelFormulaIdentityNames）
//   5 接线：diagnose 路由与 M02 预取都调用闭集选择
//
// 反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 8/jingfang/）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const jp = await jiti.import("../src/lib/jingfang-patterns.ts");
const pick = await jiti.import("../src/lib/jingfang-pattern-pick.server.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const memo = await jiti.import("../src/lib/small-task-memo.server.ts");

const BUILD = ["scripts/build-jingfang-patterns.mjs"];
const SOURCE = "src/data/tcm-jingfang-patterns.source.json";
const BOOKS_PRESENT = existsSync("中医补充数据/TCM-Ancient-Books-master/457-伤寒论.txt") && existsSync("中医补充数据/TCM-Ancient-Books-master/499-金匮要略方论.txt");
const runBuild = (extra) => spawnSync(process.execPath, [...BUILD, ...extra, ...(BOOKS_PRESENT ? [] : ["--skip-books"])], { encoding: "utf8", cwd: process.cwd() });

// ───────────────────────────── 1 方证表 ─────────────────────────────

await check("1.1 source 与生成物一致，构建脚本逐条校验通过（条文在原文、主症在条文、证名有来源、区分点有出处）", () => {
  const result = runBuild(["--check"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ok \d+ 个方证/u);
});

await check("1.2 表里至少 100 个方证；TODO 点名的方证都在；每个方名都能在方剂目录里锁定（catalogMissing 为 0）", () => {
  assert.ok(jp.JINGFANG_PATTERNS.length >= 100, `只有 ${jp.JINGFANG_PATTERNS.length} 个`);
  const named = ["桂枝汤", "吴茱萸汤", "枳实栀子豉汤", "大陷胸汤", "苓桂术甘汤", "白头翁汤", "白虎汤", "桔梗汤", "小承气汤", "甘草干姜汤", "桂枝去芍药汤", "半夏散及汤",
    "茯苓桂枝甘草大枣汤", "四逆散", "防己黄芪汤", "小青龙汤", "大黄附子汤", "黄土汤", "麻黄汤", "葛根汤", "大青龙汤", "麻黄杏仁甘草石膏汤", "小柴胡汤", "大柴胡汤", "半夏泻心汤",
    "理中丸", "四逆汤", "真武汤", "五苓散", "猪苓汤", "乌梅丸", "当归四逆汤", "炙甘草汤", "黄连阿胶汤", "茵陈蒿汤", "栀子豉汤", "白虎加人参汤", "调胃承气汤", "大承气汤", "麻子仁丸",
    "桃核承气汤", "抵当汤", "黄芪桂枝五物汤", "肾气丸", "酸枣仁汤", "甘麦大枣汤", "半夏厚朴汤", "枳实薤白桂枝汤", "苓甘五味姜辛汤", "越婢加术汤", "桂枝茯苓丸", "温经汤", "当归芍药散"];
  const formulas = new Set(jp.JINGFANG_PATTERNS.map((pattern) => pattern.formula));
  for (const name of named) assert.ok(formulas.has(name), `缺 ${name}`);
  assert.ok(jp.jingfangPatternByName("苓桂草枣汤证")?.formula === "茯苓桂枝甘草大枣汤", "别名「苓桂草枣汤证」应指到茯苓桂枝甘草大枣汤");
  assert.equal(jp.jingfangPatternByName("桂枝汤证")?.syndromeName, "太阳中风证");
  // 每个方名都能在目录里锁定：identifyKnownFormulaNames 解析成它自己、且有一份可编译的目录基准。
  const unlockable = jp.JINGFANG_PATTERNS.filter((pattern) => {
    const names = provenance.identifyKnownFormulaNames(`${pattern.formula}加减`);
    return !(names.length === 1 && names[0] === pattern.formula && provenance.formulaCompilationReferences(names).length === 1);
  }).map((pattern) => pattern.formula);
  assert.deepEqual(unlockable, [], `这些方名锁不上：${unlockable.join("、")}`);
  assert.equal(jp.JINGFANG_PATTERNS.filter((pattern) => pattern.catalogMissing).length, 0);
});

await check("1.3 条文独立复核：每条条文逐字出自本地原文的 [line,endLine]（不依赖构建脚本的实现）", () => {
  if (!BOOKS_PRESENT) return;
  const source = JSON.parse(readFileSync(SOURCE, "utf8"));
  const lines = new Map(source.books.map((book) => [book.name, new TextDecoder(book.encoding).decode(readFileSync(book.file)).split("\n")]));
  let checked = 0;
  for (const pattern of source.patterns) {
    for (const clause of pattern.clauses) {
      const region = lines.get(clause.book).slice(clause.line - 1, clause.endLine).join("").replace(/\s+/gu, "");
      assert.ok(region.includes(clause.text.replace(/\s+/gu, "")), `${pattern.formula} ${clause.book}:${clause.line}`);
      checked += 1;
    }
    for (const symptom of pattern.keySymptoms) assert.ok(pattern.clauses.some((clause) => clause.text.includes(symptom)), `${pattern.formula} 主症「${symptom}」不在条文里`);
  }
  assert.ok(checked >= 150, `只核了 ${checked} 条`);
  const guizhi = source.patterns.find((pattern) => pattern.formula === "桂枝汤");
  assert.ok(guizhi.clauses.some((clause) => clause.line === 28 && clause.text.includes("鼻鸣干呕者，桂枝汤主之")), "桂枝汤证的首条应是《伤寒论》第 12 条（原文第 28 行）");
});

await check("1.4 构建反证：在临时副本上改一处，构建必须报错（条文错一个字 / 主症不在条文 / 证名无来源 / 区分点对比方证不在表内 / 区分点出处不在条文 / 方名重复 / 行号偏一行）；未改的副本通过（对照）", () => {
  if (!BOOKS_PRESENT) return;
  const dir = mkdtempSync(join(tmpdir(), "jingfang-"));
  const source = JSON.parse(readFileSync(SOURCE, "utf8"));
  const buildWith = (mutate, name) => {
    const copy = structuredClone(source);
    mutate(copy);
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(copy));
    return spawnSync(process.execPath, [...BUILD, `--source=${path}`, `--output=${join(dir, `${name}.out.json`)}`], { encoding: "utf8", cwd: process.cwd() });
  };
  const control = buildWith(() => {}, "control");
  assert.equal(control.status, 0, `${control.stdout}\n${control.stderr}`);
  const expectFail = (name, mutate, pattern) => {
    const result = buildWith(mutate, name);
    assert.notEqual(result.status, 0, `${name}：应当报错`);
    assert.match(result.stderr, pattern, `${name}：${result.stderr.slice(0, 300)}`);
  };
  const first = (data) => data.patterns[0];
  expectFail("clause-char", (data) => { first(data).clauses[0].text = first(data).clauses[0].text.replace("恶风", "恶凤"); }, /条文不在原文/u);
  expectFail("symptom", (data) => { first(data).keySymptoms[0] = "不存在的主症"; }, /不在本方证条文里/u);
  expectFail("syndrome", (data) => { first(data).syndromeName = "杜撰证"; first(data).syndromeSource = { kind: "GB/T 16751.2-2021", term: "杜撰" }; }, /不是 GB\/T 16751\.2 术语/u);
  expectFail("vs", (data) => { first(data).differentiation.vs = "不在表内的方"; }, /不在表内/u);
  expectFail("basis", (data) => { first(data).differentiation.basis = [{ book: "伤寒论", line: 3, }]; }, /不是本方证或对比方证的条文/u);
  expectFail("dup", (data) => { data.patterns[1].formula = first(data).formula; }, /方名重复/u);
  expectFail("line", (data) => { first(data).clauses[0].line += 1; first(data).clauses[0].endLine += 1; }, /条文不在原文|起始行不是/u);
});

// ───────────────────────────── 2 闭集小任务 ─────────────────────────────

// 开发用例：自己按原文条文改写的 20 条门诊口吻病历（不是 X 集病例）。recorded = 2026-10-19 本机真实 deepseek-flash 跑完整两次调用后的最终入选
// （方证名 + [病历原话, 主症] 对子）；null = 未选出（D03 小青龙汤证、D12 黄土汤证：核对后证据不足，宁缺毋滥）。
const DEV_CASES = [
  {"key": "D01", "expect": "桂枝汤证", "chiefComplaint": "怕风、出汗2天", "sex": "男", "age": 35, "presentHistory": "2天前受凉后发热，体温37.8℃，出汗多，一吹风就觉得冷，头痛，鼻子呼呼响，有点想吐，没有咳嗽。", "tongue": "舌淡红，苔薄白", "pulse": "脉浮缓", "recorded": ["桂枝汤证", [["一吹风就觉得冷", "恶风"], ["出汗多", "汗出"], ["脉浮缓", "脉浮缓"], ["鼻子呼呼响", "鼻鸣"]]]},
  {"key": "D02", "expect": "麻黄汤证", "chiefComplaint": "发热恶寒、浑身疼1天", "sex": "男", "age": 28, "presentHistory": "昨天淋雨后发冷发热，一点汗都没有，头痛，腰痛，全身骨头关节都疼，有点喘。", "tongue": "舌苔薄白", "pulse": "脉浮紧", "recorded": ["麻黄汤证", [["脉浮紧", "脉浮紧"], ["全身骨头关节都疼", "骨节疼痛"]]]},
  {"key": "D03", "expect": "小青龙汤证", "chiefComplaint": "咳嗽气喘1周", "sex": "女", "age": 45, "presentHistory": "1周前着凉后咳嗽，吐大量清稀白痰，气喘，发热怕冷，没有汗，恶心想吐，胸口闷，感觉胃里有水。", "tongue": "舌苔白滑", "pulse": "脉浮", "recorded": null},
  {"key": "D04", "expect": "吴茱萸汤证", "chiefComplaint": "头痛呕吐2天", "sex": "女", "age": 38, "presentHistory": "头顶痛，干呕，不停吐清口水，手脚冰凉，一吃东西就想吐，烦躁难受。", "tongue": "舌淡苔白滑", "pulse": "脉弦迟", "recorded": ["吴茱萸汤证", [["头顶痛", "头痛"], ["干呕", "干呕"], ["手脚冰凉", "手足逆冷"]]]},
  {"key": "D05", "expect": "白头翁汤证", "chiefComplaint": "腹痛腹泻3天", "sex": "男", "age": 30, "presentHistory": "大便带脓血，血色鲜红，肚子疼，拉完还想拉，肛门灼热，口渴想喝水，发热。", "tongue": "舌红苔黄", "pulse": "脉弦数", "recorded": ["白头翁汤证", [["大便带脓血，血色鲜红", "下利便脓血"], ["拉完还想拉", "里急后重"], ["肛门灼热", "肛门灼热"], ["口渴想喝水", "口渴"]]]},
  {"key": "D06", "expect": "大承气汤证", "chiefComplaint": "便秘腹胀5天", "sex": "男", "age": 60, "presentHistory": "5天没大便，肚子又胀又满，一按就疼，下午发热明显，手脚心出汗，说胡话，气喘。", "tongue": "舌苔黄燥", "pulse": "脉沉实", "recorded": ["大承气汤证", [["5天没大便", "不大便五六日"], ["下午发热明显", "日晡所发潮热"], ["说胡话", "谵语"]]]},
  {"key": "D07", "expect": "四逆散证", "chiefComplaint": "手脚发凉伴腹痛2周", "sex": "男", "age": 25, "presentHistory": "情绪紧张后手脚发凉，只凉到手腕脚踝，肚子隐隐作痛，大便不成形，总有拉不尽的感觉，偶尔咳嗽、心慌。", "pulse": "脉弦", "recorded": ["四逆散证", [["手脚发凉", "四逆"], ["肚子隐隐作痛", "腹痛"], ["总有拉不尽的感觉", "泄利下重"], ["偶尔咳嗽", "咳嗽"]]]},
  {"key": "D08", "expect": "茵陈蒿汤证", "chiefComplaint": "身黄目黄1周", "sex": "男", "age": 42, "presentHistory": "皮肤和眼睛黄得像橘子色，小便少而黄，肚子微微发胀，只有头上出汗，身上没有汗，口渴想喝水，发热。", "recorded": ["茵陈蒿汤证", [["皮肤和眼睛黄得像橘子色", "身黄如橘子色"], ["口渴想喝水", "渴引水浆"], ["肚子微微发胀", "腹微满"]]]},
  {"key": "D09", "expect": "苓桂术甘汤证", "chiefComplaint": "头晕心慌1月", "sex": "女", "age": 50, "presentHistory": "一站起来就头晕眼花，感觉有气从胃脘往胸口顶，胃脘胀满，心悸，两胁发胀，咳吐清稀痰。", "tongue": "舌苔白滑", "pulse": "脉沉紧", "recorded": ["苓桂术甘汤证", [["一站起来就头晕眼花", "起则头眩"], ["感觉有气从胃脘往胸口顶", "气上冲胸"], ["脉沉紧", "脉沉紧"]]]},
  {"key": "D10", "expect": "甘麦大枣汤证", "chiefComplaint": "情绪低落爱哭2月", "sex": "女", "age": 46, "presentHistory": "总是莫名想哭，很悲伤，常常打哈欠伸懒腰，晚上睡不好，感觉像有什么控制不住自己。", "recorded": ["甘麦大枣汤证", [["总是莫名想哭，很悲伤", "喜悲伤欲哭"], ["常常打哈欠伸懒腰", "数欠伸"]]]},
  {"key": "D11", "expect": "半夏厚朴汤证", "chiefComplaint": "咽部异物感2周", "sex": "女", "age": 40, "presentHistory": "总觉得喉咙里有块东西，吐不出也咽不下，伴胸闷，情绪不好时加重。", "recorded": ["半夏厚朴汤证", [["总觉得喉咙里有块东西，吐不出也咽不下", "咽中如有炙脔"]]]},
  {"key": "D12", "expect": "黄土汤证", "chiefComplaint": "大便带血1月", "sex": "男", "age": 55, "presentHistory": "大便带血，是先拉大便后出血，血色暗淡，手脚不温，面色萎黄。", "tongue": "舌淡苔白", "recorded": null},
  {"key": "D13", "expect": "白虎加人参汤证", "chiefComplaint": "大汗口渴3天", "sex": "男", "age": 50, "presentHistory": "高热退后出了很多汗，口渴得厉害，喝很多水还是不解渴，心烦，背上微微发冷怕风，口干舌燥。", "pulse": "脉洪大", "recorded": ["白虎加人参汤证", [["出了很多汗", "大汗出"], ["脉洪大", "脉洪大"], ["背上微微发冷怕风", "背微恶寒"]]]},
  {"key": "D14", "expect": "栀子豉汤证", "chiefComplaint": "失眠心烦1周", "sex": "男", "age": 45, "presentHistory": "用过退烧药大量出汗、又吐泻之后，心烦得睡不着，翻来覆去，心里懊恼难受，胸口发闷堵得慌。", "recorded": ["栀子豉汤证", [["心烦得睡不着", "心烦不得眠"], ["翻来覆去", "反复颠倒"], ["心里懊恼难受", "心中懊侬"], ["胸口发闷堵得慌", "胸中窒"]]]},
  {"key": "D15", "expect": "当归四逆汤证", "chiefComplaint": "手脚冰冷怕冷1年", "sex": "女", "age": 32, "presentHistory": "手脚冰冷，冬天更重，四肢关节疼痛，痛经，月经量少色暗。", "pulse": "脉细欲绝", "recorded": ["当归四逆汤证", [["手脚冰冷，冬天更重", "手足厥寒"], ["脉细欲绝", "脉细欲绝"], ["四肢关节疼痛", "四肢关节疼痛"]]]},
  {"key": "D16", "expect": "小柴胡汤证", "chiefComplaint": "寒热往来4天", "sex": "男", "age": 33, "presentHistory": "一阵冷一阵热，胸胁胀满，不想吃东西，心烦想吐，口苦。", "pulse": "脉弦细", "recorded": ["小柴胡汤证", [["寒热往来4天", "往来寒热"], ["胸胁胀满", "胸胁苦满"], ["心烦想吐", "心烦喜呕"], ["口苦", "口苦"], ["脉弦细", "脉弦细"]]]},
  {"key": "D17", "expect": "真武汤证", "chiefComplaint": "心慌头晕伴水肿2周", "sex": "男", "age": 62, "presentHistory": "心慌，头晕眼花，全身肌肉跳动，站立不稳，小便少，四肢沉重疼痛，肚子痛，拉稀水。", "tongue": "舌淡苔白", "pulse": "脉沉", "recorded": ["真武汤证", [["心慌，头晕眼花", "心悸"], ["四肢沉重疼痛", "四肢沉重疼痛"], ["肚子痛，拉稀水", "腹痛"], ["小便少", "小便不利"], ["脉沉", "脉沉"]]]},
  {"key": "D18", "expect": "麻子仁丸证", "chiefComplaint": "大便干结半年", "sex": "男", "age": 66, "presentHistory": "大便像羊屎蛋一样硬，小便次数多，肚子没有不舒服，吃饭正常。", "pulse": "脉浮涩", "recorded": ["麻子仁丸证", [["大便像羊屎蛋一样硬", "大便则硬"], ["小便次数多", "小便数"]]]},
  {"key": "D19", "expect": "炙甘草汤证", "chiefComplaint": "心慌心跳不规律1月", "sex": "女", "age": 58, "presentHistory": "心里一阵阵地慌，心跳忽快忽慢、常常漏跳，乏力，气短。", "pulse": "脉结代", "recorded": ["炙甘草汤证", [["心慌心跳不规律1月", "心动悸"], ["脉结代", "脉结代"]]]},
  {"key": "D20", "expect": "枳实栀子豉汤证", "chiefComplaint": "病后劳累后发热心烦5天", "sex": "男", "age": 48, "presentHistory": "大病刚好不久，这几天干活劳累后又发热，口渴，心里懊恼烦闷，胃脘部痞塞堵着，不想吃饭。", "tongue": "舌苔薄黄", "recorded": ["枳实栀子豉汤证", [["病后劳累后发热心烦", "发热"], ["心里懊恼烦闷", "心中懊侬"], ["胃脘部痞塞堵着", "心下痞塞"], ["舌苔薄黄", "舌苔薄黄"]]]},
];

const RECORD_GUIZHI = "主诉：怕风、出汗2天\n现病史：2天前受凉后发热，体温37.8℃，出汗多，一吹风就觉得冷，头痛，鼻子呼呼响，没有咳嗽。\n脉象：脉浮缓";
const evidenceOf = (list) => ({ patterns: list });

await check("2.1 候选解析：方证名在表内（别名归一）、症状取自该方证、引文逐字在病历里；表外方证名、表外症状、病历里没有的引文丢弃（对照：合格的保留）", () => {
  const good = JSON.stringify(evidenceOf([{ pattern: "桂枝汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "一吹风就觉得冷", symptom: "恶风" }] }]));
  const parsed = pick.parseJingfangCandidates(good, RECORD_GUIZHI);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].pattern.patternName, "桂枝汤证");
  assert.deepEqual(parsed[0].evidence.map((item) => item.symptom), ["汗出", "恶风"]);
  const run = (patterns) => pick.parseJingfangCandidates(JSON.stringify(evidenceOf(patterns)), RECORD_GUIZHI);
  assert.deepEqual(run([{ pattern: "杜撰汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "怕风", symptom: "恶风" }] }]), [], "表外方证名");
  assert.equal(run([{ pattern: "桂枝汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "夜间盗汗", symptom: "恶风" }] }])[0].evidence.length, 1, "病历里没有的引文丢弃");
  assert.equal(run([{ pattern: "桂枝汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "头痛", symptom: "不在清单的症状" }] }])[0].evidence.length, 1, "表外症状丢弃");
  assert.equal(run([{ pattern: "苓桂草枣汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }] }]).length, 0, "别名的症状清单是茯苓桂枝甘草大枣汤证的，汗出不在其中");
  assert.equal(pick.parseJingfangCandidates("不是JSON", RECORD_GUIZHI).length, 0);
  assert.equal(pick.parseJingfangCandidates(JSON.stringify({ patterns: "桂枝汤证" }), RECORD_GUIZHI).length, 0);
  assert.equal(pick.parseJingfangCandidates(null, RECORD_GUIZHI).length, 0);
  // 引文带标点、空白也能对上（比对时都去掉）。
  assert.equal(run([{ pattern: "桂枝汤证", evidence: [{ quote: "出汗多，一吹风", symptom: "汗出" }] }]).length, 1);
});

await check("2.2 否认不当证据：引文落在被否认的分句里丢弃；主症本身是否定写法（无汗而喘）且引文同样带否定字时保留；对照：同一个词在肯定分句里保留", () => {
  const record = "主诉：发热恶寒1天\n现病史：昨天淋雨后发冷发热，无汗，头痛，腰痛，没有出汗，也不口渴。";
  const run = (pattern, evidence) => pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern, evidence }])), record);
  // 「汗」落在「无汗」里：对症状「汗出」不能算（桂枝汤证的汗出）。
  assert.equal(run("桂枝汤证", [{ quote: "没有出汗", symptom: "汗出" }]).length, 0, "否认的出汗不能当桂枝汤证的汗出");
  // 主症是否定写法：麻黄汤证的「无汗」，引文「无汗」。
  const negative = run("麻黄汤证", [{ quote: "无汗", symptom: "无汗" }, { quote: "腰痛", symptom: "腰痛" }]);
  assert.equal(negative.length, 1);
  assert.deepEqual(negative[0].evidence.map((item) => item.symptom), ["无汗", "腰痛"]);
  // 肯定分句里的同一个词保留。
  assert.equal(run("麻黄汤证", [{ quote: "腰痛", symptom: "腰痛" }, { quote: "头痛", symptom: "头痛" }])[0].evidence.length, 2);
  // 否定字不属于症状：引文「不口渴」对症状「口渴」丢弃。
  assert.equal(run("白头翁汤证", [{ quote: "不口渴", symptom: "口渴" }]).length, 0);
  // 编出来的否定引文：病历里根本没有「无汗」，模型给「无汗」对「无汗」——逐字核对要拦住（否定写法的主症不走肯定分句那条路）。
  const noSweatMissing = pick.parseJingfangCandidates(JSON.stringify(evidenceOf([{ pattern: "麻黄汤证", evidence: [{ quote: "无汗", symptom: "无汗" }, { quote: "腰痛", symptom: "腰痛" }] }])), "主诉：发热恶寒1天\n现病史：汗出恶风，腰痛，头痛。");
  assert.deepEqual(noSweatMissing[0]?.evidence.map((item) => item.symptom), ["腰痛"], "病历里没有的「无汗」不能凭空成为证据");
});

await check("2.3 证据够不够：条数（默认 2、第二个方证 3、单症方证 1）、至少一条非泛症、特异度之和 ≥ 阈值；人人都有的症状凑不出方证", () => {
  const P = (name) => jp.jingfangPatternByName(name);
  const ev = (...symptoms) => symptoms.map((symptom) => ({ symptom, quote: symptom }));
  const ok = pick.jingfangEvidenceSufficient;
  // 桂枝汤证：汗出 + 恶风 + 鼻鸣（鼻鸣只在这一个方证里）→ 够
  assert.equal(ok(P("桂枝汤证"), ev("汗出", "恶风", "鼻鸣"), true), true);
  // 只有泛症：发热 + 头痛（都在泛症表里）→ 不够，即使条数够
  assert.equal(ok(P("桂枝汤证"), ev("发热", "头痛"), true), false);
  // 条数不够：一条
  assert.equal(ok(P("桂枝汤证"), ev("鼻鸣"), true), false);
  // 特异度不够：汗出 + 恶风（二十多个、十多个方证里都有）→ 低于阈值
  assert.equal(ok(P("桂枝汤证"), ev("汗出", "恶风"), true), false, "汗出+恶风 的特异度之和低于阈值，需要再有一条特异的症状");
  assert.equal(ok(P("桂枝汤证"), ev("汗出", "恶风", "脉浮缓"), true), false, "三条常见症状仍不够");
  // 四条以上互相印证的主症：每个都常见，但条数本身就是证据（教材式桂枝汤证「发热、汗出、恶风、头痛、脉浮缓」）
  assert.equal(ok(P("桂枝汤证"), ev("发热", "汗出", "恶风", "脉浮缓"), true), true);
  assert.equal(ok(P("桂枝汤证"), ev("发热", "头痛", "恶寒", "干呕"), true), false, "四条但全是泛症仍不行");
  // 第二个方证要 3 条
  assert.equal(ok(P("甘麦大枣汤证"), ev("喜悲伤欲哭", "数欠伸"), true), true);
  assert.equal(ok(P("甘麦大枣汤证"), ev("喜悲伤欲哭", "数欠伸"), false), false, "第二个方证只有 2 条");
  assert.equal(ok(P("甘麦大枣汤证"), ev("喜悲伤欲哭", "数欠伸", "象如神灵所作"), false), true);
  // 单症方证：1 条特异症状够；第二个方证仍要 3 条
  assert.equal(P("半夏厚朴汤证").minQuotes, 1);
  assert.equal(ok(P("半夏厚朴汤证"), ev("咽中如有炙脔"), true), true);
  assert.equal(ok(P("半夏厚朴汤证"), ev("咽中如有炙脔"), false), false);
  // 同一症状重复不算两条
  assert.equal(ok(P("桂枝汤证"), [{ symptom: "鼻鸣", quote: "a" }, { symptom: "鼻鸣", quote: "b" }], true), false);
  // 特异度是数据算出来的：鼻鸣只在一个方证里，汗出在很多方证里
  assert.ok(jp.jingfangSymptomSpecificity("鼻鸣") > 0.9);
  assert.ok(jp.jingfangSymptomSpecificity("汗出") < 0.2);
});

await check("2.4 核对结果落地：判否/没回答的证据对丢弃后按要求定最终入选；核对判否把凑出来的方证整条拿掉（对照：判是的保留）", () => {
  const recordPairs = JSON.stringify(evidenceOf([
    { pattern: "桂枝汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "一吹风就觉得冷", symptom: "恶风" }, { quote: "鼻子呼呼响", symptom: "鼻鸣" }] },
  ]));
  const candidates = pick.parseJingfangCandidates(recordPairs, RECORD_GUIZHI);
  const pairs = pick.jingfangEvidencePairs(candidates);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pick.finalizeJingfangPicks(candidates, [true, true, true]).map((item) => item.patternName), ["桂枝汤证"]);
  // 鼻鸣判否 → 剩汗出+恶风，特异度不够 → 整条拿掉
  assert.deepEqual(pick.finalizeJingfangPicks(candidates, [true, true, false]), []);
  assert.deepEqual(pick.finalizeJingfangPicks(candidates, []), [], "没有回答按否");
  // 核对结果的解析：缺项、越界、非 true 都按否
  assert.deepEqual(pick.parseJingfangEvidenceVerdicts(JSON.stringify({ verdicts: [{ id: 1, same: true }, { id: 3, same: "yes" }, { id: 9, same: true }] }), 3), [true, false, false]);
  assert.deepEqual(pick.parseJingfangEvidenceVerdicts("坏的", 2), [false, false]);
  assert.deepEqual(pick.parseJingfangEvidenceVerdicts(null, 2), [false, false]);
});

await check("2.5 桩模型两次调用：第一次给闭集清单（全部方证）与病历，第二次只给证据对、不含任何方证名；结果与缓存；任一次失败返回空", async () => {
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash", CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash", CDSS_SMALL_TASK_MEMO: "true",
  });
  delete process.env.CDSS_JINGFANG_PATTERN_PICK;
  memo.resetSmallTaskMemoForTests();
  const bodies = [];
  let failCheck = false;
  const reply = (content) => new Response(JSON.stringify({ id: "t", object: "chat.completion", model: "deepseek-flash", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const system = body.messages[0].content;
    if (system.includes("症状对应核对器")) {
      if (failCheck) return reply("");
      const input = JSON.parse(body.messages[1].content);
      return reply(JSON.stringify({ verdicts: input.pairs.map((pair) => ({ id: pair.id, same: true })) }));
    }
    return reply(JSON.stringify(evidenceOf([{ pattern: "桂枝汤证", evidence: [
      { quote: "出汗多", symptom: "汗出" }, { quote: "一吹风就觉得冷", symptom: "恶风" }, { quote: "鼻子呼呼响", symptom: "鼻鸣" },
    ] }])));
  };
  try {
    const state = types.normalizeCaseStateInput({ id: "jf-stub", chiefComplaint: "怕风、出汗2天", patient: { sex: "男", age: 35 }, symptoms: { 现病史: "2天前受凉后发热，体温37.8℃，出汗多，一吹风就觉得冷，头痛，鼻子呼呼响，没有咳嗽。" }, pulse: "脉浮缓", conversation: [] });
    const result = await pick.pickJingfangPatternsForCase(state);
    assert.deepEqual(result.map((item) => item.patternName), ["桂枝汤证"]);
    assert.equal(bodies.length, 2, "两次调用");
    const firstUser = JSON.parse(bodies[0].messages[1].content);
    assert.equal(firstUser.patterns.length, jp.JINGFANG_PATTERNS.length, "第一次给全部方证清单");
    assert.ok(firstUser.record.includes("一吹风就觉得冷"));
    assert.equal(bodies[0].temperature, 0);
    const secondText = bodies[1].messages.map((message) => message.content).join("\n");
    assert.ok(!/桂枝汤|太阳中风/u.test(secondText), "第二次不能含任何方证名");
    assert.equal(JSON.parse(bodies[1].messages[1].content).pairs.length, 3);
    // 缓存：同一份病历再调不再请求
    const again = await pick.pickJingfangPatternsForCase(state);
    assert.deepEqual(again, result);
    assert.equal(bodies.length, 2, "命中缓存");
    // 核对调用没有回答：返回空数组，且不进缓存（换一份病历文本避开缓存）
    memo.resetSmallTaskMemoForTests();
    failCheck = true;
    assert.deepEqual(await pick.pickJingfangPatternsForCase(state), []);
    failCheck = false;
    assert.equal((await pick.pickJingfangPatternsForCase(state)).length, 1, "失败不入缓存，恢复后重新得到结果");
    // 开关
    process.env.CDSS_JINGFANG_PATTERN_PICK = "false";
    const before = bodies.length;
    assert.deepEqual(await pick.pickJingfangPatternsForCase(state), []);
    assert.equal(bodies.length, before, "关闭时不发请求");
    // 未配置模型
    delete process.env.CDSS_JINGFANG_PATTERN_PICK;
    for (const key of ["OPENAI_API_KEY", "BAILIAN_QWEN_API_KEY"]) delete process.env[key];
    memo.resetSmallTaskMemoForTests();
    assert.deepEqual(await pick.pickJingfangPatternsForCase(state), []);
    assert.equal(bodies.length, before, "未配置时不发请求");
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    memo.resetSmallTaskMemoForTests();
  }
});

await check("2.6 开发用例 20 条（真实模型的记录输出）：记录的引文都能在脱敏后的病历里逐字找到、方证名在表内，核对全「是」时 18 条选出的就是标准方证，D03/D12 记录为未选出；对照：把任一条的引文改一个字就逐字核对失败", () => {
  let selected = 0;
  for (const dev of DEV_CASES) {
    const state = types.normalizeCaseStateInput({
      id: `jf-${dev.key}`, chiefComplaint: dev.chiefComplaint, patient: { sex: dev.sex, age: dev.age },
      symptoms: { 现病史: dev.presentHistory }, ...(dev.tongue ? { tongue: dev.tongue } : {}), ...(dev.pulse ? { pulse: dev.pulse } : {}), conversation: [],
    });
    const record = pick.jingfangRecordText(state);
    if (!dev.recorded) { assert.ok(["D03", "D12"].includes(dev.key), `${dev.key} 不应是未选出`); continue; }
    const [patternName, pairs] = dev.recorded;
    const content = JSON.stringify(evidenceOf([{ pattern: patternName, evidence: pairs.map(([quote, symptom]) => ({ quote, symptom })) }]));
    const candidates = pick.parseJingfangCandidates(content, record);
    assert.equal(candidates.length, 1, `${dev.key} 记录的引文应全部在病历里逐字找到`);
    assert.equal(candidates[0].evidence.length, pairs.length, `${dev.key} 引文逐字保留`);
    const picks = pick.finalizeJingfangPicks(candidates, pairs.map(() => true));
    assert.deepEqual(picks.map((item) => item.patternName), [dev.expect], `${dev.key}`);
    selected += 1;
    // 对照：任一条引文改一个字，该条证据被逐字核对拦下
    const tampered = JSON.stringify(evidenceOf([{ pattern: patternName, evidence: pairs.map(([quote, symptom], index) => ({ quote: index === 0 ? `${quote}。。缺` : quote, symptom })) }]));
    const tamperedCandidates = pick.parseJingfangCandidates(tampered, record);
    assert.equal(tamperedCandidates[0]?.evidence.length ?? 0, pairs.length - 1, `${dev.key} 改过的引文应被拦下`);
  }
  assert.equal(selected, 18);
  assert.equal(DEV_CASES.length, 20);
});

// ───────────────────────────── 3 提示词 ─────────────────────────────

await check("3.1 没有选出方证时提示词与此前逐字相同；选出时多一段「经方方证候选」（方证名、规范证名、经方、原文、区分点、采用规则），教材候选段仍在", () => {
  assert.equal(jp.buildJingfangCandidateContext(undefined), "");
  assert.equal(jp.buildJingfangCandidateContext([]), "");
  assert.equal(jp.buildJingfangCandidateContext([{ patternName: "不存在的方证", evidence: [] }]), "", "表外方证名不渲染");
  const state = types.normalizeCaseStateInput({ id: "jf-prompt", chiefComplaint: "怕风、出汗2天", patient: { sex: "男", age: 35 }, symptoms: { 现病史: "出汗多，一吹风就觉得冷，鼻子呼呼响。" }, conversation: [] });
  const base = prompts.buildDiagnosePrompt(state, {});
  assert.equal(prompts.buildDiagnosePrompt(state, { jingfangPatternPicks: [] }), base);
  assert.equal(prompts.buildDiagnosePrompt(state, { jingfangPatternPicks: undefined }), base);
  const picks = [{ patternName: "桂枝汤证", evidence: [{ quote: "出汗多", symptom: "汗出" }, { quote: "一吹风就觉得冷", symptom: "恶风" }] }];
  const withPick = prompts.buildDiagnosePrompt(state, { jingfangPatternPicks: picks });
  assert.ok(withPick.length > base.length);
  assert.ok(withPick.includes("【经方方证候选】"));
  assert.ok(withPick.includes("◆ 桂枝汤证｜规范证名：太阳中风证｜经方：桂枝汤"));
  assert.ok(withPick.includes("病历「出汗多」≈汗出；病历「一吹风就觉得冷」≈恶风"));
  assert.ok(withPick.includes("《伤寒论》）：太阳中风，阳浮而阴弱"), "原文条文带书名");
  assert.ok(withPick.includes("与相近方证的区分：桂枝汤证见汗出恶风"));
  // 第九轮 WP9-A 把采用规则从「教材行贴合就用教材行」改成「教材行与方证都贴合时比较区分点」（见 test-r1021-jingfang），下面三条断言随之改写：
  // 教材行区分表现齐全仍用教材行（普通病例）；教材没有贴合行时用方证；只有泛化症状不采用。
  assert.match(withPick, /教材行的主症已经写全这些条文特征症[\s\S]*采用教材行，不采用本段/u, "规则①：教材行已写全条文特征症时用教材行");
  assert.match(withPick, /教材里没有贴合本例的行[\s\S]*逐字写该方证的“规范证名”[\s\S]*recommendedFormulaDirection 写该经方/u, "规则②：教材没有贴合行时用方证");
  assert.match(withPick, /只有泛化症状时，不采用本段/u, "规则③：泛症不采用");
  // 段落夹在患者资料之后、方剂检索之前，且是整段新增（去掉这一段后与基线逐字相同）
  // 第九轮起重要原则第 7 条里也出现「【经方方证候选】」字样（指向该段），所以按段首的整句定位。
  const section = withPick.slice(withPick.indexOf("【经方方证候选】（以下方证"));
  const sectionEnd = section.indexOf("\n4. 病历与方证的区分点相反");
  assert.ok(sectionEnd > 0);
  const stripped = withPick.replace(section.slice(0, section.indexOf("\n", sectionEnd + 1) + 1), "");
  assert.equal(stripped, base, "去掉「经方方证候选」整段后应与基线逐字相同");
});

// ───────────────────────────── 4 锚定 ─────────────────────────────

const reasoningOf = ({ disease, syndrome, direction, method = "温通" }) => ({
  stage: "diagnose",
  overview: {
    tcmDiseaseName: disease,
    primarySyndrome: syndrome,
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: [(jp.JINGFANG_PATTERNS.find((pattern) => pattern.syndromeName === syndrome)?.symptoms || []).slice(0, 6).join("，")],
    tcmDiagnosticRationale: `${syndrome}：心下悸而欲得按。`,
    tcmDiseaseRationale: `${disease}`,
    recommendedFormulaDirection: direction,
    overallTherapy: method,
  },
  therapy: { overallMethod: method },
  pathogenesis: { chain: [], locationDifferentiation: { items: [] } },
});

await check("4.1 证名与方向正是方证表里的一项：不改名、不覆盖治法与方向、方名锁定；对照：同样的病名与证名，方向里没写该经方（自拟）或写了别的经方时，照旧锚定到教材最近的行（证名被改）", () => {
  const overviewOf = (input) => provenance.withDeterministicFormulaReferences(reasoningOf(input)).overview;
  const kept = overviewOf({ disease: "胸痹", syndrome: "心阳虚证", direction: "桂枝甘草汤加减" });
  assert.equal(kept.primarySyndrome, "心阳虚证");
  assert.equal(kept.recommendedFormulaDirection, "桂枝甘草汤加减");
  assert.deepEqual(kept.recommendedFormulaNames, ["桂枝甘草汤"]);
  assert.equal(kept.overallTherapy, "温通", "不覆盖模型写的治法");
  // 本机回放：179 个「方证 × 教材病」组合里，教材最近行会把方证证名改走（桂枝去芍药汤证·心悸 → 教材「心阳不振证」，
  // 真武汤证·痰饮 → 教材「脾肾阳虚证」，并把治法与方向一并锚到那一行）。下面几组各有「保留」和「对照改名」两个方向。
  for (const [disease, syndrome, formula, becomes] of [
    ["心悸", "胸阳不振证", "桂枝去芍药汤", "心阳不振证"],
    ["痰饮", "阳虚水泛证", "真武汤", "脾肾阳虚证"],
    ["痰饮", "脾阳虚中焦水停证", "苓桂术甘汤", "脾阳虚弱证"],
    ["喘证", "表寒里热证", "大青龙汤", "表寒肺热证"],
  ]) {
    const kept2 = overviewOf({ disease, syndrome, direction: `${formula}加减` });
    assert.equal(kept2.primarySyndrome, syndrome, `${disease}·${syndrome} 应保留`);
    assert.equal(kept2.recommendedFormulaDirection, `${formula}加减`);
    assert.ok(kept2.recommendedFormulaNames.includes(formula), `${formula} 应锁定`);
    const selfDevised = overviewOf({ disease, syndrome, direction: "按已锁定病机与治法辨证组方" });
    assert.equal(selfDevised.primarySyndrome, becomes, `对照：自拟方向走教材锚定 ${disease}·${syndrome}`);
    const otherFormula = overviewOf({ disease, syndrome, direction: formula === "四逆汤" ? "理中丸加减" : "四逆汤加减" });
    assert.equal(otherFormula.primarySyndrome, becomes, `对照：方向写了别的经方 ${disease}·${syndrome}`);
  }
  // 同一规范证名对应几个方证（太阳伤寒证：麻黄汤证、葛根汤证）：由方向里的经方定
  assert.equal(jp.jingfangPatternForSignedSyndrome("太阳伤寒证", "葛根汤加减")?.formula, "葛根汤");
  assert.equal(jp.jingfangPatternForSignedSyndrome("太阳伤寒证", "麻黄汤")?.formula, "麻黄汤");
  assert.equal(jp.jingfangPatternForSignedSyndrome("太阳伤寒证", "桂枝汤"), undefined);
  assert.equal(jp.jingfangPatternForSignedSyndrome("风寒束表证", "麻黄汤"), undefined, "教材证名不是方证表的证名");
});

await check("4.2 经方方证与教材行同为「证名—方」的正向依据：证名+方向正是方证表里的一项时，该经方进入 trustedModelFormulaIdentityNames（不必再经功效词对齐）；对照：方向里没有它 / 别的证名 / 未定证型 时不进", () => {
  const trusted = (reasoning, names) => [...indications.trustedModelFormulaIdentityNames(reasoning, names)];
  const hit = reasoningOf({ disease: "胸痹", syndrome: "心阳虚证", direction: "桂枝甘草汤加减" });
  assert.deepEqual(trusted(hit, ["桂枝甘草汤"]), ["桂枝甘草汤"]);
  assert.deepEqual([...jp.jingfangRelationFormulaIdentityNames(hit, ["桂枝甘草汤", "四逆汤"])], ["桂枝甘草汤"]);
  const otherDirection = reasoningOf({ disease: "胸痹", syndrome: "心阳虚证", direction: "四逆汤加减" });
  assert.deepEqual([...jp.jingfangRelationFormulaIdentityNames(otherDirection, ["桂枝甘草汤"])], []);
  const otherSyndrome = reasoningOf({ disease: "胸痹", syndrome: "心血瘀阻证", direction: "桂枝甘草汤加减" });
  assert.deepEqual([...jp.jingfangRelationFormulaIdentityNames(otherSyndrome, ["桂枝甘草汤"])], []);
  const unresolved = reasoningOf({ disease: "胸痹", syndrome: "心阳虚证", direction: "桂枝甘草汤加减" });
  unresolved.overview.primarySyndromeResolution = "unresolved";
  assert.deepEqual([...jp.jingfangRelationFormulaIdentityNames(unresolved, ["桂枝甘草汤"])], []);
});

// ───────────────────────────── 5 接线 ─────────────────────────────

await check("5.1 diagnose 路由在 M03 前置并行任务里调用闭集选择并把结果交给提示词；M02 预取同样调用", () => {
  const route = readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.ok(route.includes('import { pickJingfangPatternsForCase } from "@/lib/jingfang-pattern-pick.server";'));
  assert.match(route, /Promise\.all\(\[\s*normalizeCaseTextForFormulaRecall\(safeState, signal\),\s*assistedPolarityDecisions\(safeState, signal\),\s*pickTextbookDiseasesForCase\(safeState, signal\),\s*pickJingfangPatternsForCase\(safeState, signal\),\s*\]\)/u);
  assert.match(route, /textbookDiseasePicks, jingfangPatternPicks \}/u);
  const prefetch = readFileSync("src/lib/stage-prefetch.server.ts", "utf8");
  assert.ok(prefetch.includes("void pickJingfangPatternsForCase(safeState).catch(() => undefined);"));
  assert.ok(prefetch.includes('import { pickJingfangPatternsForCase } from "./jingfang-pattern-pick.server";'));
  // 锚定与正向依据两处各有一个分支，且只有这一个
  assert.equal((readFileSync("src/lib/tcm-formula-provenance.ts", "utf8").match(/jingfangPatternForSignedSyndrome\(/gu) || []).length, 1);
  assert.equal((readFileSync("src/lib/tcm-formula-indications.ts", "utf8").match(/jingfangRelationFormulaIdentityNames\(/gu) || []).length, 1);
});

console.log(JSON.stringify({ suite: "r1020-jingfang", cases, failures: process.exitCode ? "see above" : 0 }));
