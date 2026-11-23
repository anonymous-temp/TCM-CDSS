// 第五十七轮（2026-11-23）：同源饮片表整类建表。
// 起因：一张处方方中有玄明粉、加减又「加芒硝」——同一味药（《中药学》：「芒硝经风化失去结晶水而成白色粉末称玄明粉」），
// tcm-same-source-herbs.source.json 当时只有逐个病例补进去的四组（姜、参、瓜蒌、合欢），没有拦住。
// 现在把系统能开的饮片里所有可能出自同一药材的两两组合列成候选（scripts/build-same-source-herb-candidates.mjs →
// scripts/fixtures/same-source-herb-candidates.json），每一对都必须在表里归一类：
//   groups                同源（或同类代用）同用，同方只留一味（运行时读这一类）；
//   sameOriginDistinctUse 同源而功用不同、可以同用（运行时不读，只为证明已判过）；
//   notRelated            并不同源（名称偶合、教材附药并列）。
//  A 候选对与已提交的生成物一致，且每一对恰好归一类，没有过期条目；
//  B 每一组、每一项同源异用都有出处与原文，本地引文逐字核对（教材语料 ±3 行、药典功效补充表、知识库功能条目）；
//  C 组内药名都是知识库认得的饮片身份，各组不重叠，交付可见的 reason 是一句临床话；
//  D 行为：方中玄明粉、加减「加芒硝」这一行不列；芒硝与玄明粉同在方中只留一味；目录原方两味都有时不动。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const lib = await jiti.import("./lib/same-source-herb-candidates.mjs");
const build = await jiti.import("./build-same-source-herb-candidates.mjs");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const pruning = await jiti.import("../src/lib/m04-modification-safety.ts");

const TABLE_PATH = `${root}/src/data/tcm-same-source-herbs.source.json`;
const table = JSON.parse(fs.readFileSync(TABLE_PATH, "utf8"));
const committed = JSON.parse(fs.readFileSync(build.CANDIDATES_PATH, "utf8"));
const corpusPath = `${root}/${lib.TEXTBOOK_CORPUS_REF}`;
const corpusLines = process.env.SAME_SOURCE_HERB_CORPUS !== "none" && fs.existsSync(corpusPath) ? fs.readFileSync(corpusPath, "utf8").split("\n") : undefined;

const check = async (id, title, run) => {
  if (process.env.R1075_CHECK && process.env.R1075_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};

const sameDrug = (left, right) => {
  const a = provenance.compositionIdentityName(left);
  return Boolean(a) && a === provenance.compositionIdentityName(right);
};
const candidateKeys = new Set(committed.candidates.map((item) => lib.pairKey(...item.herbs)));

// ───── A ─────
await check("A1", "候选对按当前语料与知识库重算，与已提交的 scripts/fixtures/same-source-herb-candidates.json 一致（不一致就重跑生成脚本并逐对归类）", async () => {
  const { output, corpusAvailable } = await build.computeSameSourceHerbCandidates();
  if (!corpusAvailable) console.log("  （本机无教材语料：教材部分沿用已提交的记录，只重算身份映射与构词候选）");
  assert.deepEqual(output.candidates, committed.candidates);
  assert.deepEqual(output.textbookRecords, committed.textbookRecords);
  assert.deepEqual(output.textbookStatements, committed.textbookStatements);
  assert.ok(committed.candidates.length >= 250, `候选对 ${committed.candidates.length} 对，少得反常`);
});

await check("A2", "每一个候选对恰好归入三类之一；不是候选对的成对只允许出现在同一味药的炮制品之间，或连通的同用组/按功用收的组里", () => {
  const decided = lib.decidedPairs(table);
  const missing = [...candidateKeys].filter((key) => !decided.has(key));
  assert.deepEqual(missing, [], `未归类的候选对：${missing.join("；")}`);
  const twice = [...decided].filter(([, list]) => list.length > 1).map(([key, list]) => `${key}→${list.map((item) => item.kind).join("+")}`);
  assert.deepEqual(twice, [], `同一对归了两处：${twice.join("；")}`);
  const groupById = new Map(table.groups.map((group) => [group.id, group]));
  const stale = [...decided].filter(([key, list]) => {
    if (candidateKeys.has(key)) return false;
    const [left, right] = key.split("|");
    if (sameDrug(left, right)) return false;
    return !list.every((item) => item.kind === "groups" && groupById.has(item.id));
  }).map(([key, list]) => `${key}（${list[0].kind}:${list[0].id}）`);
  assert.deepEqual(stale, [], `过期或无依据的成对（既不是候选，也不是同一味药的炮制品）：${stale.join("；")}`);
});

await check("A3", "每一组按候选对或炮制品关系连通（参类这类按功用收的组须写 basis=same_function 并给出处）", () => {
  for (const group of table.groups) {
    if (group.basis === "same_function") {
      assert.ok(group.basisNote && group.source && group.quote, `${group.id} 按功用收组须写 basisNote/source/quote`);
      continue;
    }
    const linked = (left, right) => candidateKeys.has(lib.pairKey(left, right)) || sameDrug(left, right);
    const seen = new Set([group.herbs[0]]);
    for (let changed = true; changed;) {
      changed = false;
      for (const herb of group.herbs) {
        if (!seen.has(herb) && [...seen].some((other) => linked(herb, other))) { seen.add(herb); changed = true; }
      }
    }
    assert.equal(seen.size, group.herbs.length, `${group.id} 不连通：${group.herbs.filter((herb) => !seen.has(herb)).join("、")} 与组内其余各味既无同源候选关系也不是炮制品`);
    assert.ok(group.herbs.some((left, i) => group.herbs.slice(i + 1).some((right) => candidateKeys.has(lib.pairKey(left, right)))), `${group.id} 没有一对同源候选`);
  }
});

// ───── B ─────
const SUPP = JSON.parse(fs.readFileSync(`${root}/src/data/tcm-herb-function-supplements.source.json`, "utf8")).entries;
const KB = JSON.parse(fs.readFileSync(`${root}/src/data/tcm-knowledge.json`, "utf8")).herbs;
const evidenceProblem = (item) => {
  if (!item.quote || !String(item.quote).trim()) return "quote 为空";
  if (typeof item.line === "number") {
    if (!corpusLines) return undefined;
    for (let line = Math.max(1, item.line - 3); line <= Math.min(corpusLines.length, item.line + 3); line += 1) {
      if (corpusLines[line - 1].includes(item.quote)) return undefined;
    }
    return `教材语料第 ${item.line} 行附近找不到「${item.quote}」`;
  }
  if (item.file === "src/data/tcm-herb-function-supplements.source.json") {
    return SUPP.some((entry) => entry.herb === item.herb && entry.basis.includes(item.quote)) ? undefined : `药典功效补充表「${item.herb}」里找不到「${item.quote}」`;
  }
  if (item.file === "src/data/tcm-knowledge.json") {
    const herb = KB.find((entry) => entry.name === item.herb);
    const found = herb?.entries.some((entry) => [entry.functionText, entry.doseText, entry.quote].some((text) => String(text || "").includes(item.quote)));
    return found ? undefined : `知识库「${item.herb}」里找不到「${item.quote}」`;
  }
  if (item.url) return /^https:\/\//u.test(item.url) ? undefined : `网址不是 https：${item.url}`;
  return "evidence 既无 line、file 也无 url";
};
await check("B1", "每一组、每一项同源异用都有 source、quote 与 evidence，quote 是其中一条引文；本地引文逐字核对", () => {
  if (!corpusLines) console.log("  （本机无教材语料：教材行号引文跳过逐字核对）");
  const problems = [];
  for (const [kind, entries] of [["groups", table.groups], ["sameOriginDistinctUse", table.sameOriginDistinctUse]]) {
    for (const entry of entries) {
      const label = `${kind}:${entry.id}`;
      if (!entry.source || !entry.quote || !Array.isArray(entry.evidence) || entry.evidence.length === 0) { problems.push(`${label} 缺 source/quote/evidence`); continue; }
      if (!entry.evidence.some((item) => item.quote === entry.quote)) problems.push(`${label} 的 quote 不在 evidence 里`);
      for (const item of entry.evidence) {
        const problem = evidenceProblem(item);
        if (problem) problems.push(`${label}：${problem}`);
      }
    }
  }
  for (const entry of table.notRelated) if (!entry.reason) problems.push(`notRelated 缺 reason：${JSON.stringify(entry)}`);
  assert.deepEqual(problems, []);
});

// ───── C ─────
await check("C1", "组内与各项里的药名都是知识库认得的饮片身份（canonicalTcmHerbIdentity 的不动点），各组互不重叠", () => {
  const owner = new Map();
  const bad = [];
  const herbsOf = (entry) => [...(entry.herbs || []), ...(entry.between || []).flat()];
  for (const [kind, entries] of [["groups", table.groups], ["sameOriginDistinctUse", table.sameOriginDistinctUse], ["notRelated", table.notRelated]]) {
    for (const entry of entries) {
      for (const herb of herbsOf(entry)) {
        if (contract.canonicalTcmHerbIdentity(herb) !== herb || !knowledge.isKnownTcmHerbName(herb)) bad.push(`${kind}:${entry.id || entry.reason}:${herb}→${contract.canonicalTcmHerbIdentity(herb)}`);
      }
    }
  }
  assert.deepEqual(bad, [], `不是饮片身份的写法（别名应归到身份，如全瓜蒌→瓜蒌）：${bad.join("；")}`);
  for (const group of table.groups) {
    for (const herb of group.herbs) {
      assert.ok(!owner.has(herb), `${herb} 同时在 ${owner.get(herb)} 与 ${group.id} 两组：各组独立只留一味，重叠会留错`);
      owner.set(herb, group.id);
    }
  }
});

await check("C2", "交付可见的 reason（写进「按本例情况已去除：X（与Y…）」）是一句临床话：不带轮次、测评、病历编号等内部记录", () => {
  for (const group of table.groups) {
    assert.match(group.reason, /不重复使用$/u, `${group.id} reason 须以「不重复使用」收尾`);
    assert.doesNotMatch(group.reason, /第[^，。；]{0,4}轮|测评|复测|病历\s*\d|r\d{4}|\d{1,2}\.\d{2}/u, `${group.id} reason 带了内部记录：${group.reason}`);
    for (const herb of group.herbs) assert.ok(!new RegExp(`^同出${herb}(?:[，、。（]|一物|$)`, "u").test(group.reason), `${group.id} reason「与${herb}${group.reason}」读不通`);
    assert.doesNotMatch(group.reason, /[（）()]/u, `${group.id} reason 带括号，写进「X（与Y…）」后成了套括号`);
  }
});

// ───── D ─────
const m04Content = (name, herbs, modifications = []) => `前文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [{ name, herbs, formulaAnalysis: herbs.map((herb) => herb.name).join("、"), notApplicable: "" }], modifications } })}\n<!-- DIAGNOSIS_JSON_END -->`;
const m04Candidate = (text) => JSON.parse(text.slice(text.indexOf("<!-- DIAGNOSIS_JSON_START -->") + 29, text.indexOf("<!-- DIAGNOSIS_JSON_END -->"))).formula.candidates[0];

await check("D1", "方中有玄明粉，加减「加芒硝」不列（原因记为与处方药味冲突）；加莱菔子照列（对照）", () => {
  const reasons = [];
  const kept = compiler.withoutMutuallyIncompatibleAdditions([
    { action: "加", herbName: "芒硝", trigger: "本例已见大便干结" },
    { action: "加", herbName: "莱菔子", trigger: "本例已见腹胀" },
  ], ["大黄", "玄明粉", "枳实", "甘草"], reasons);
  assert.deepEqual(kept.map((item) => item.herbName), ["莱菔子"]);
  assert.deepEqual(reasons, ["action_conflicts_with_candidate"]);
  // 反过来：方中芒硝、加玄明粉也不列；两条加减各加一味也只留前一条
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions([{ action: "加", herbName: "玄明粉", trigger: "x" }], ["大黄", "芒硝"]).length, 0);
  assert.deepEqual(compiler.withoutMutuallyIncompatibleAdditions([{ action: "加", herbName: "芒硝", trigger: "x" }, { action: "加", herbName: "玄明粉", trigger: "y" }], ["大黄"]).map((item) => item.herbName), ["芒硝"]);
});

await check("D2", "芒硝与玄明粉同在方中只留一味：芒硝作唯一君药时留芒硝、去玄明粉并写明原因；芒硝作臣时另有「不能与他药同煎」一条先拿掉芒硝，仍只剩一味", () => {
  const out = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", [
    { name: "芒硝", role: "君", dose: "9g" }, { name: "大黄", role: "臣", dose: "10g" }, { name: "玄明粉", role: "佐", dose: "6g" },
    { name: "厚朴", role: "佐", dose: "10g" }, { name: "甘草", role: "使", dose: "6g" },
  ]), "大便秘结5天，腹胀满痛。"));
  assert.deepEqual(out.herbs.map((herb) => herb.name), ["芒硝", "大黄", "厚朴", "甘草"]);
  assert.match(out.notApplicable, /玄明粉（与芒硝同为咸寒泻下软坚之品，玄明粉由芒硝风化而成，不重复使用）/u);
  const chen = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", [
    { name: "大黄", role: "君", dose: "10g" }, { name: "芒硝", role: "臣", dose: "9g" }, { name: "玄明粉", role: "佐", dose: "6g" }, { name: "甘草", role: "使", dose: "6g" },
  ]), "大便秘结5天，腹胀满痛。"));
  assert.equal(chen.herbs.filter((herb) => ["芒硝", "玄明粉"].includes(herb.name)).length, 1);
  // 同组另一类（这一轮新收的）：陈皮、橘红同在方中留一味
  const peel = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", [
    { name: "半夏", role: "君", dose: "9g" }, { name: "陈皮", role: "臣", dose: "9g" }, { name: "茯苓", role: "佐", dose: "10g" },
    { name: "橘红", role: "佐", dose: "6g" }, { name: "甘草", role: "使", dose: "3g" },
  ]), "咳嗽痰多色白1周。"));
  assert.deepEqual(peel.herbs.map((herb) => herb.name), ["半夏", "陈皮", "茯苓", "甘草"]);
  assert.match(peel.notApplicable, /橘红（与陈皮同为理气燥湿化痰的橘皮类，不重复使用）/u);
  // 同源异用不删：桑叶与桑白皮、茯苓与茯苓皮同在方中都留
  const morus = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", [
    { name: "桑叶", role: "君", dose: "10g" }, { name: "桑白皮", role: "臣", dose: "10g" }, { name: "茯苓皮", role: "佐", dose: "15g" },
    { name: "茯苓", role: "佐", dose: "10g" }, { name: "甘草", role: "使", dose: "3g" },
  ]), "咳嗽伴面浮1周。"));
  assert.deepEqual(morus.herbs.map((herb) => herb.name), ["桑叶", "桑白皮", "茯苓皮", "茯苓", "甘草"]);
});

await check("D3", "目录原方本来就含同组两味时不动（生姜泻心汤：生姜、干姜）；自拟方里同一对仍只留一味（对照）", () => {
  const herbs = [{ name: "生姜", role: "君", dose: "12g" }, { name: "半夏", role: "臣", dose: "9g" }, { name: "黄芩", role: "臣", dose: "9g" },
    { name: "黄连", role: "佐", dose: "3g" }, { name: "干姜", role: "佐", dose: "3g" }, { name: "人参", role: "佐", dose: "9g" }, { name: "炙甘草", role: "使", dose: "9g" }, { name: "大枣", role: "使", dose: "10g" }];
  const kept = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("生姜泻心汤", herbs), "心下痞硬，干噫食臭，腹中雷鸣下利。"));
  assert.ok(kept.herbs.some((herb) => herb.name === "干姜") && kept.herbs.some((herb) => herb.name === "生姜"));
  const selfMade = m04Candidate(pruning.dropSafetyConflictingM04CandidateHerbs(m04Content("自拟方", herbs), "心下痞硬，干噫食臭，腹中雷鸣下利。"));
  assert.equal(selfMade.herbs.filter((herb) => ["干姜", "生姜"].includes(herb.name)).length, 1);
});
