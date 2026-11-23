// 第五十七轮（2026-11-23）：开方保底（src/lib/m04-salvage.ts）与口语寒热表现。模型调用一律不发生。
//  S1 登记表闭合：开方安全合同（m04SafetyContractIssue 及它委托的各判据）能返回的每一个原因码，都在 M04_SALVAGE_RULES 里登记了处理方式或「不保底」的理由。
//  S2–S9 处理方式逐类：药味指向已撤回的病机节点（f06）、单味不合格去掉、唯一君药由臣药接任、普通药味压上沿、十八反、重复、服法算术、加减行。
//  S10 只删不加：处理后药味是原药味的子集，剂量不升；处理不了的原因（整方禁忌、不足 3 味、唯一君药无臣药接任）返回 undefined。
//  S11 两处接线：路由终审与流层修复耗尽后都先保底再驳回。
//  C 寒热表现表认口语写法（手脚发凉、热水袋捂着能好点）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const salvage = await jiti.import("../src/lib/m04-salvage.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
const parse = await jiti.import("../src/lib/diagnosis-parse.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const check = async (id, title, run) => {
  if (process.env.R1075_CHECK && process.env.R1075_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const fixtures = JSON.parse(fs.readFileSync(`${root}/scripts/fixtures/m04-salvage/delivered-pairs.json`, "utf8")).cases;
const wrap = (payload) => `## 候选方药\n\n${START}\n${JSON.stringify(payload, null, 2)}\n${END}\n`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)).trim());
const clone = (value) => JSON.parse(JSON.stringify(value));
const t1 = (prior, context) => (content) => contract.m04SafetyContractIssue(parse.parseReasoningV2(content), prior, {
  isKnownHerbName: knowledge.isKnownTcmHerbName, trustedWorkbenchEdit: false, auditedClinicalRisksAreAdvisory: false, clinicalContext: context, waiveTherapyCoverageAnnotated: true,
}) || undefined;
const run = (key, mutateM04, { mutateM03, context } = {}) => {
  const fixture = fixtures[key];
  const m03 = clone(fixture.m03);
  if (mutateM03) mutateM03(m03);
  const m04 = clone(fixture.m04);
  mutateM04(m04);
  const prior = parse.parseReasoningV2(wrap(m03));
  const clinicalContext = context ?? fixture.record;
  const issueOf = t1(prior, clinicalContext);
  const content = wrap(m04);
  return { before: issueOf(content), result: salvage.salvageM04Content(content, { prior, clinicalContext, issueOf }), issueOf, m04 };
};
const herbsOf = (content) => unwrap(content).formula.candidates[0].herbs;

// ───── S1 登记表闭合 ─────
const contractSource = fs.readFileSync(`${root}/src/lib/diagnosis-stage-contract.ts`, "utf8");
const functionBody = (source, name) => {
  const at = source.search(new RegExp(`function ${name}\\s*\\(`));
  assert.ok(at >= 0, `找不到函数 ${name}`);
  const open = source.indexOf("{", source.indexOf(")", source.indexOf("(", at)) );
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") { depth -= 1; if (depth === 0) return source.slice(open, index + 1); }
  }
  throw new Error(`函数 ${name} 未闭合`);
};
const returnedCodes = (body) => [...body.matchAll(/return\s+(?:`([^`]+)`|"([a-z_][a-z0-9_:]*)")/g)].map((match) => match[1] ?? match[2]);
await check("S1", "开方安全合同能返回的每一个原因码都在保底登记表里（处理方式或不保底的理由）", () => {
  const delegations = new Set();
  const samples = new Set();
  for (const name of ["m04SafetyContractIssue", "crossStageReasoningIssue", "m04ModificationSafetyIssue"]) {
    for (const template of returnedCodes(functionBody(contractSource, name))) {
      // `candidate_${candidateIndex}_${xIssue}` 一类是委托给下级判据的：下级判据的码在下面逐个拼上前缀
      const delegated = template.match(/^candidate_(?:\$\{candidateIndex\}|0)_\$\{(\w+)\}$/);
      if (delegated) { delegations.add(delegated[1]); continue; }
      samples.add(template.replace(/\$\{(?:candidateIndex|herbIndex|modificationIndex|index)\}/g, "0").replace(/\$\{[^}]+\}/g, "x"));
    }
  }
  // 委托的下级判据：各自的返回码（与源码同一处读）。
  assert.ok(delegations.has("specialPopulationIssue") && delegations.has("highImpactIssue") && delegations.has("regimenIssue") && delegations.has("coverageIssue"), [...delegations].join(","));
  for (const code of ["herb_0_special_population_high_risk_pregnancy", "herb_0_unsupported_high_impact_heat_clear", "transparent_therapy_herb_0_unsupported_high_impact_yang_warm", "transparent_therapy_contract_missing", "transparent_therapy_herbs_missing"]) samples.add(`candidate_0_${code}`);
  for (const code of returnedCodes(functionBody(fs.readFileSync(`${root}/src/lib/prescription-regimen-contract.ts`, "utf8"), "prescriptionRegimenIssue"))) samples.add(`candidate_0_${code}`);
  for (const code of returnedCodes(functionBody(fs.readFileSync(`${root}/src/lib/tcm-formula-provenance.ts`, "utf8"), "formulaCompilationContractIssue"))) samples.add(code.replace(/\$\{[^}]+\}/g, "x"));
  samples.add("named_formula_positive_sufficiency_missing:七福饮");
  const unregistered = [...samples].filter((code) => !salvage.m04SalvageRuleFor(code));
  assert.deepEqual(unregistered, [], `未登记的原因码：${unregistered.join("、")}`);
  assert.ok(samples.size >= 35, `扫到的原因码太少（${samples.size}），扫描可能失效`);
  // 处理方式不是 none 的必须真有实现（登记表里写了动作，applyRule 却没分支，等于没登记）
  const salvageSource = fs.readFileSync(`${root}/src/lib/m04-salvage.ts`, "utf8");
  for (const rule of salvage.M04_SALVAGE_RULES) {
    if (rule.action !== "none") assert.ok(salvageSource.includes(`case "${rule.action}"`), `动作 ${rule.action} 没有实现`);
    assert.ok(rule.why && rule.why.length >= 6, `登记缺理由：${rule.pattern}`);
  }
});

// ───── S2 药味指向已撤回的病机节点（f06 第五十六轮 b4：P2 被撤回后白术仍写 P2，整页无剂量）─────
await check("S2", "药味指向不存在的病机节点：按已签名 M03 重指（君药 P1，其余取最接近者），药味与剂量不变", () => {
  const { before, result, issueOf } = run("f06", () => {}, {
    mutateM03: (m03) => { m03.pathogenesis.chain = m03.pathogenesis.chain.slice(0, 1); },
  });
  assert.match(before, /^candidate_0_herb_\d+_target_ref_invalid$/);
  assert.ok(result, "应当保底成功");
  assert.equal(issueOf(result.content), undefined);
  const herbs = herbsOf(result.content);
  const original = fixtures.f06.m04.formula.candidates[0].herbs;
  assert.deepEqual(herbs.map((herb) => [herb.name, herb.dose]), original.map((herb) => [herb.name, herb.dose]));
  assert.ok(herbs.filter((herb) => herb.targetKind === "pathogenesis_node").every((herb) => herb.targetRef === "P1"));
  assert.ok(result.steps.every((step) => step.action === "repoint_target"));
});

// ───── S3 单味不合格：去掉这一味，写明原因 ─────
await check("S3", "认不出的药名、不能同煎的药：去掉这一味并在不适用说明里写明，其余药味与剂量不变", () => {
  const { before, result, issueOf } = run("f06", (m04) => {
    m04.formula.candidates[0].herbs.push({ ...clone(m04.formula.candidates[0].herbs[5]), name: "无名草", dose: "9g" });
  });
  assert.match(before, /_unknown$/);
  assert.ok(result);
  assert.equal(issueOf(result.content), undefined);
  const candidate = unwrap(result.content).formula.candidates[0];
  assert.ok(!candidate.herbs.some((herb) => herb.name === "无名草"));
  assert.equal(candidate.herbs.length, fixtures.f06.m04.formula.candidates[0].herbs.length);
  assert.match(candidate.notApplicable, /按本例情况已去除：无名草（未查到这一味的规范药名/u);
});

// ───── S4 唯一君药冲突：臣药接任 ─────
await check("S4", "唯一君药与本例安全边界冲突（华法林 + 活血君药）：臣药升君、写明；没有可接任的臣药时不保底", () => {
  const context = `${fixtures.f31.record}；用药史：长期口服华法林 3mg 每日1次`;
  const { before, result, issueOf } = run("f31", (m04) => {
    const herbs = m04.formula.candidates[0].herbs;
    herbs[1].role = "臣"; // 只留一味君药
    herbs[0].name = "丹参"; herbs[0].dose = "15g";
  }, { context });
  assert.match(before, /special_population/);
  assert.ok(result, "应当保底成功");
  assert.equal(issueOf(result.content), undefined);
  const candidate = unwrap(result.content).formula.candidates[0];
  assert.ok(!candidate.herbs.some((herb) => herb.name === "丹参"));
  const emperors = candidate.herbs.filter((herb) => herb.role === "君");
  assert.equal(emperors.length, 1);
  assert.equal(emperors[0].targetRef, "P1");
  assert.match(candidate.notApplicable, /已去除：丹参（[^）]+）[，,].+改作君药/u);
  // 没有臣药可接任：不保底
  const none = run("f31", (m04) => {
    const herbs = m04.formula.candidates[0].herbs;
    herbs[1].role = "佐"; herbs[2].role = "佐"; herbs[3].role = "佐";
    herbs[0].name = "丹参"; herbs[0].dose = "15g";
  }, { context });
  assert.match(none.before, /special_population/);
  assert.equal(none.result, undefined);
});

// ───── S5 剂量超出可核对范围的有毒药：不自动减量，去掉这一味 ─────
await check("S5", "有毒药味剂量超出范围（苍耳子 40g）：系统不自动减量，去掉这一味并写明；普通药味超上沿本由编译器压量、合同不驳回", () => {
  for (const key of ["f06", "f31"]) {
    const toxic = run(key, (m04) => {
      const herbs = m04.formula.candidates[0].herbs;
      const herb = herbs.find((item) => item.role === "佐" && item.targetKind === "pathogenesis_node");
      herb.name = "苍耳子"; herb.dose = "40g";
    });
    assert.match(toxic.before, /herb_\d+_(?:dose_outside_conservative_range|dose_sanity_ceiling|unsupported_high_impact_\w+)$/, `${key}: ${toxic.before}`);
    assert.ok(toxic.result, key);
    assert.equal(toxic.issueOf(toxic.result.content), undefined);
    assert.ok(!herbsOf(toxic.result.content).some((item) => item.name === "苍耳子"));
    assert.match(unwrap(toxic.result.content).formula.candidates[0].notApplicable, /已去除：苍耳子（/u);
  }
  // 普通药味超上沿：合同不驳回（编译器压量的那条路），保底无事可做
  const ordinary = run("f06", (m04) => { m04.formula.candidates[0].herbs.find((item) => item.name === "茯苓").dose = "60g"; });
  assert.equal(ordinary.before, undefined);
});

// ───── S6 十八反、同一味药重复 ─────
await check("S6", "方内十八反去掉地位较低的一味；同一味药写两次留地位高的一行", () => {
  const pair = run("f06", (m04) => {
    const herbs = m04.formula.candidates[0].herbs;
    herbs.push({ ...clone(herbs[6]), name: "川乌", dose: "3g", role: "使" }); // 半夏反乌头
  });
  assert.ok(pair.before, "应当有不合格项");
  if (/high_risk_pair_incompatibility$/.test(pair.before)) {
    assert.ok(pair.result);
    assert.ok(!herbsOf(pair.result.content).some((herb) => herb.name === "川乌"));
    assert.ok(herbsOf(pair.result.content).some((herb) => herb.name === "姜半夏"));
  }
  const duplicate = run("f06", (m04) => {
    const herbs = m04.formula.candidates[0].herbs;
    herbs.push({ ...clone(herbs[3]), role: "佐" });
  });
  assert.match(duplicate.before, /duplicate_herb$/);
  assert.ok(duplicate.result);
  assert.equal(herbsOf(duplicate.result.content).filter((herb) => herb.name === "茯苓").length, 1);
  assert.equal(herbsOf(duplicate.result.content).find((herb) => herb.name === "茯苓").role, "臣");
});

// ───── S7 服法算术 ─────
await check("S7", "剂数、疗程、每日次数对不上：按受控格式重算（剂数保留，每日 1 剂，每剂分 2 次）", () => {
  const { before, result, issueOf } = run("f06", (m04) => {
    const decoction = m04.formula.candidates[0].decoction;
    decoction.doseCount = "7剂"; decoction.course = "10日";
  });
  assert.match(before, /course_inconsistent$/);
  assert.ok(result);
  assert.equal(issueOf(result.content), undefined);
  const decoction = unwrap(result.content).formula.candidates[0].decoction;
  assert.equal(decoction.doseCount, "7剂");
  assert.equal(decoction.course, "7日");
  assert.ok(decoction.administrationTimesPerDay >= decoction.dosesPerDay);
});

// ───── S8 加减行 ─────
await check("S8", "随证加减一条不合格（未收载的药）：只去掉这一条，其余加减与处方不变", () => {
  const { before, result, issueOf } = run("f06", (m04) => {
    m04.formula.modifications = [...m04.formula.modifications, { ...clone(m04.formula.modifications[0]), herbName: "无名草" }];
  });
  assert.match(before, /^modification_\d+_/);
  assert.ok(result);
  assert.equal(issueOf(result.content), undefined);
  const rows = unwrap(result.content).formula.modifications;
  assert.equal(rows.length, fixtures.f06.m04.formula.modifications.length);
  assert.ok(!rows.some((row) => row.herbName === "无名草"));
});

// ───── S9 归属 M03 的字段被改写 ─────
await check("S9", "M04 改写了 M03 的总病机：按已签名 M03 逐字回绑", () => {
  const { before, result, issueOf } = run("f06", (m04) => { m04.overview.overallPathogenesis = `${m04.overview.overallPathogenesis}（改写）`; });
  assert.equal(before, "pathogenesis_drift");
  assert.ok(result);
  assert.equal(issueOf(result.content), undefined);
  assert.equal(unwrap(result.content).overview.overallPathogenesis, fixtures.f06.m03.overview.overallPathogenesis);
});

// ───── S10 只删不加、处理不了就交还 ─────
await check("S10", "处理只删不加（药味为原药味子集、剂量不升）；整方禁忌、不足 3 味、未登记的原因交还原有路径", () => {
  const original = fixtures.f06.m04.formula.candidates[0].herbs;
  const { result } = run("f06", (m04) => {
    m04.formula.candidates[0].herbs.push({ ...clone(m04.formula.candidates[0].herbs[5]), name: "无名草", dose: "9g" });
    m04.formula.candidates[0].herbs.find((item) => item.name === "砂仁").dose = "60g";
  });
  assert.ok(result);
  const doseOf = (herbs, name) => Number.parseFloat(herbs.find((herb) => herb.name === name)?.dose || "0");
  for (const herb of herbsOf(result.content)) {
    assert.ok(original.some((item) => item.name === herb.name), `新增了药味 ${herb.name}`);
    assert.ok(doseOf(herbsOf(result.content), herb.name) <= Math.max(doseOf(original, herb.name), 60), `剂量升高 ${herb.name}`);
  }
  // 不足 3 味：不删
  const small = run("f31", (m04) => {
    const herbs = m04.formula.candidates[0].herbs;
    m04.formula.candidates[0].herbs = [herbs[0], herbs[2], { ...clone(herbs[3]), name: "无名草" }];
  });
  assert.equal(small.result, undefined);
  // 登记为不保底与未登记的原因
  assert.equal(salvage.m04SalvageRuleFor("candidate_0_classic_contraindication_hypertension").action, "none");
  assert.equal(salvage.salvageM04Content(wrap(fixtures.f06.m04), { prior: parse.parseReasoningV2(wrap(fixtures.f06.m03)), clinicalContext: "", issueOf: () => "candidate_0_classic_contraindication_x" }), undefined);
  assert.equal(salvage.salvageM04Content(wrap(fixtures.f06.m04), { prior: parse.parseReasoningV2(wrap(fixtures.f06.m03)), clinicalContext: "", issueOf: () => "some_new_unregistered_code" }), undefined);
  // 已经合格：原样返回、无步骤
  const clean = salvage.salvageM04Content(wrap(fixtures.f06.m04), { prior: parse.parseReasoningV2(wrap(fixtures.f06.m03)), clinicalContext: fixtures.f06.record, issueOf: t1(parse.parseReasoningV2(wrap(fixtures.f06.m03)), fixtures.f06.record) });
  assert.deepEqual(clean.steps, []);
});

// ───── S11 两处接线 ─────
await check("S11", "路由终审与流层修复耗尽后都先保底、处理不了才驳回", () => {
  const route = fs.readFileSync(`${root}/src/app/api/diagnosis/prescribe/route.ts`, "utf8");
  const salvageAt = route.indexOf("const salvaged = salvageM04Content(directionPruned, {");
  const throwAt = route.indexOf("throw new Error(`finalized_prescription_${safetyIssue}`)");
  assert.ok(salvageAt > 0 && throwAt > salvageAt, "终审保底须在驳回之前");
  assert.match(route.slice(salvageAt, throwAt), /issueOf: \(candidateContent\) => finalSafetyIssueOf\(candidateContent\)/);
  assert.match(route.slice(salvageAt, throwAt), /if \(salvaged\) \{\n\s+directionPruned = salvaged\.content;/);
  const api = fs.readFileSync(`${root}/src/lib/diagnosis-api.ts`, "utf8");
  const declassifiedAt = api.indexOf("M04 classic identity declassified after repair exhaustion");
  const streamSalvageAt = api.indexOf("const salvaged = salvageM04Content(declassifiedContent, {");
  assert.ok(declassifiedAt > 0 && streamSalvageAt > declassifiedAt, "流层保底须紧跟透明降级之后");
  assert.match(api.slice(streamSalvageAt - 2400, streamSalvageAt), /transparentFallbackInput\.completedRepairAttempts >= 1/);
  assert.match(api.slice(streamSalvageAt, streamSalvageAt + 2400), /await attestM04Candidate\(salvagedReasoning, salvaged\.content\)/);
});

// ───── C 寒热表现表的口语写法 ─────
await check("C", "寒热表现认口语写法：手脚发凉、热水袋捂着能好点、怕热；被否认的不算", () => {
  const record = "胃痛2天，喝了凉啤酒后出现，用热水袋捂着能好点，手脚发凉；拉了两次稀便。";
  const support = summary.natureAxisElementSupport(["寒"], "用热水袋捂着能好点，手脚发凉；拉了两次稀便", record);
  assert.deepEqual(support.unsupported, []);
  assert.ok(summary.recordColdHeatSupport("手脚冰凉，热敷后缓解", "cold").dimensions.size >= 2);
  assert.ok(summary.recordColdHeatSupport("胃痛，用热水袋捂着能好点", "cold").dimensions.has("胸腹喜恶"));
  assert.ok(summary.recordColdHeatSupport("腹痛得热则舒", "cold").dimensions.has("胸腹喜恶"));
  assert.ok(summary.recordColdHeatSupport("平素怕热，喜冷饮", "heat").terms.includes("怕热"));
  assert.equal(summary.recordColdHeatSupport("无手脚发凉，热敷无缓解", "cold").dimensions.has("四肢手足"), false);
  // 手脚心发热是热象，不是寒象
  assert.equal(summary.recordColdHeatSupport("手脚心发热", "cold").dimensions.size, 0);
  assert.ok(summary.recordColdHeatSupport("手脚心发热", "heat").dimensions.has("四肢手足"));
});

// ───── S12 已剥离方名的「自拟方」交付前后同一个判定（留出集 h10：交付后再核一次判方名漂移，整页成「尚未形成候选方药」）─────
await check("S12", "服务端剥离过身份的「自拟方」（identityDeclassified）合同认作已剥离；模型自己写的「自拟方」照旧要过方名锁定", () => {
  const prior = parse.parseReasoningV2(wrap(fixtures.f31.m03));
  assert.deepEqual(prior.overview.recommendedFormulaNames, ["不换金正气散"]);
  const issueWith = (patch) => {
    const m04 = clone(fixtures.f31.m04);
    Object.assign(m04.formula.candidates[0], { name: "自拟方", formulaNames: [], baseFormulas: [], constructionType: "self_devised" }, patch);
    return t1(prior, fixtures.f31.record)(wrap(m04));
  };
  assert.equal(issueWith({ identityDeclassified: true }), undefined);
  assert.equal(issueWith({}), "formula_direction_drift");
  assert.equal(issueWith({ name: "本例辨证组方" }), undefined);
  assert.equal(contract.isDeclassifiedSelfDevisedCandidate({ name: "自拟方", formulaNames: [], constructionType: "self_devised", identityDeclassified: true }), true);
  // 交付面写成「X加减」的已剥离候选同样算（第五十七轮回放 C012）
  assert.equal(contract.isDeclassifiedSelfDevisedCandidate({ name: "茵陈蒿汤加减", formulaNames: [], constructionType: "self_devised", identityDeclassified: true }), true);
  assert.equal(contract.isDeclassifiedSelfDevisedCandidate({ name: "茵陈蒿汤加减", formulaNames: [], constructionType: "self_devised" }), false);
  assert.equal(contract.isDeclassifiedSelfDevisedCandidate({ name: "自拟方", formulaNames: [], constructionType: "self_devised" }), false);
  assert.equal(contract.isDeclassifiedSelfDevisedCandidate({ name: "自拟方", formulaNames: ["不换金正气散"], constructionType: "self_devised", identityDeclassified: true }), false);
});

await check("S13", "交付面把「本例辨证组方」改成「自拟方」时标上服务端剥离标记，交付后再过合同不判方名漂移", async () => {
  const surface = await jiti.import("../src/lib/delivered-surface.ts");
  const prior = parse.parseReasoningV2(wrap(fixtures.f31.m03));
  const m04 = clone(fixtures.f31.m04);
  // 组成改到不再是不换金正气散（交付面不会按组成恢复方名），模型写的就是内部自拟写法
  const unrelated = ["黄芪", "党参", "当归", "白芍", "熟地黄", "川芎", "大枣", "炙甘草"];
  m04.formula.candidates[0].herbs.forEach((herb, index) => { herb.name = unrelated[index % unrelated.length]; herb.function = "补益气血"; });
  Object.assign(m04.formula.candidates[0], { name: "本例辨证组方", formulaNames: [], baseFormulas: [], constructionType: "self_devised" });
  assert.notEqual(t1(prior, fixtures.f31.record)(wrap(m04)), "formula_direction_drift");
  const projected = surface.projectDeliveredReasoning(parse.parseReasoningV2(wrap(m04)), { recordText: fixtures.f31.record });
  const candidate = projected.formula.candidates[0];
  assert.equal(candidate.name, "自拟方");
  assert.equal(candidate.identityDeclassified, true);
  assert.notEqual(t1(prior, fixtures.f31.record)(wrap(projected)), "formula_direction_drift");
});

await check("S14", "交付闸门核对不通过时先保底：药味指向不存在的节点被重指后照常交付，不退成「尚未形成候选方药」；没有保底时照旧退回", async () => {
  const barrierModule = await jiti.import("../src/lib/delivery-final-content.server.ts");
  const policyModule = await jiti.import("../src/lib/delivery-gate-policy.ts");
  const m03 = clone(fixtures.f06.m03);
  m03.pathogenesis.chain = m03.pathogenesis.chain.slice(0, 1);
  const prior = parse.parseReasoningV2(wrap(m03));
  const issueOf = t1(prior, fixtures.f06.record);
  const content = wrap(fixtures.f06.m04);
  assert.match(issueOf(content), /target_ref_invalid$/);
  const make = (withSalvage) => barrierModule.createFinalDeliveryBarrier({
    stage: "prescribe", caseState: {}, priorM03: prior, signal: new AbortController().signal, deadline: () => Date.now() + 5000,
    policy: policyModule.deliveryGatePolicy({}), prepare: (value) => value, render: (value) => value,
    accept: (value) => !issueOf(value), sign: (value) => value, fallback: () => "退回无剂量页",
    ...(withSalvage ? { salvage: (value) => salvage.salvageM04Content(value, { prior, clinicalContext: fixtures.f06.record, issueOf })?.content } : {}),
  });
  const delivered = await make(true).run(content);
  assert.ok(delivered.includes("<!-- DIAGNOSIS_JSON_START -->"), delivered.slice(0, 80));
  assert.equal(issueOf(delivered), undefined);
  assert.equal(await make(false).run(content), "退回无剂量页");
  // diagnosis-api 给开方闸门接上了保底，剥离方名用交付形态（不再出现内部写法「本例辨证组方」）
  const api = fs.readFileSync(`${root}/src/lib/diagnosis-api.ts`, "utf8");
  const barrierAt = api.indexOf("createFinalDeliveryBarrier({");
  assert.match(api.slice(barrierAt, barrierAt + 4000), /salvage: opts\.structuredStage === "prescribe"[\s\S]+declassify: \(candidateContent\) => deliveredFormDeclassification\(candidateContent, prior\)/);
  // 已呈现为自拟（方名表为空）的只补标记、方名照留
  const shown = clone(fixtures.f31.m04);
  Object.assign(shown.formula.candidates[0], { name: "不换金正气散加减", formulaNames: [], constructionType: "self_devised" });
  const marked = unwrap(salvage.deliveredFormDeclassification(wrap(shown), parse.parseReasoningV2(wrap(fixtures.f31.m03)))).formula.candidates[0];
  assert.equal(marked.name, "不换金正气散加减");
  assert.equal(marked.identityDeclassified, true);
  const declassified = unwrap(salvage.deliveredFormDeclassification(wrap(fixtures.f31.m04), parse.parseReasoningV2(wrap(fixtures.f31.m03))));
  assert.equal(declassified.formula.candidates[0].name, "自拟方");
  assert.equal(declassified.formula.candidates[0].identityDeclassified, true);
  assert.deepEqual(declassified.formula.candidates[0].declassifiedFromFormulaNames, ["不换金正气散"]);
});

// ───── W 中医病名栏写了西医病名：确定性触发，按主症重写一次 ─────
await check("W", "中医病名栏写西医病名（2型糖尿病、慢性胃炎、高血压）时按主症重写；教材病名、教材写明对应中医病名的西医节名、国标中医病名、症状名不触发", async () => {
  const normalization = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
  for (const name of ["2型糖尿病", "慢性胃炎", "高血压", "腰椎间盘突出症"]) assert.equal(normalization.tcmDiseaseFieldHoldsWesternName(name), true, name);
  // 口臭、咳嗽是 ICD 症状一章的名字，中医也作病名；多囊卵巢综合征是教材保留原名的节（政策见 tcm-textbook-section-names sectionNamesKeptVerbatim）；
  // 骨质疏松症、急性阑尾炎交付时换成骨痿、肠痈；颈椎病是国标中医病名。
  for (const name of ["口臭", "咳嗽", "胃痛", "消渴", "多囊卵巢综合征", "骨质疏松症", "急性阑尾炎", "颈椎病"]) assert.equal(normalization.tcmDiseaseFieldHoldsWesternName(name), false, name);
  const visit = await jiti.import("../src/lib/m03-visit-reason-check.server.ts");
  const instruction = visit.westernNameInTcmFieldRedrawInstruction("2型糖尿病", ["消渴", "虚劳"]);
  assert.match(instruction, /「2型糖尿病」/u);
  assert.match(instruction, /「消渴」/u);
  const route = fs.readFileSync(`${root}/src/app/api/diagnosis/diagnose/route.ts`, "utf8");
  const triggerAt = route.indexOf("if (redraw && tcmDiseaseFieldHoldsWesternName(disease)) {");
  const historyAt = route.indexOf("if (visit.status !== \"not_covered\" && historyRedraw && historyStatedUnique");
  assert.ok(triggerAt > 0 && historyAt > triggerAt, "西医病名的重写排在其余病名核对之前");
  assert.match(route.slice(triggerAt, historyAt), /const adopted = Boolean\(redrawn && redrawnDisease && !tcmDiseaseFieldHoldsWesternName\(redrawnDisease\)\);/);
});

// ───── S15 同一首方的两种写法（目录条目名 vs 教材写法）合同按同一首认（留出集 f27：此前 11 次全是不给剂量页）─────
await check("S15", "方名写教材写法「麻杏甘石汤」、方名表记目录条目名「麻黄杏仁甘草石膏汤」：方名展示与锁定方向两处核对都按同一首方；不同的方照旧算不一致", async () => {
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  assert.equal(provenance.sameGovernedFormula("麻杏甘石汤", "麻黄杏仁甘草石膏汤"), true);
  assert.equal(provenance.sameGovernedFormula("麻杏甘石汤", "白虎汤"), false);
  assert.equal(provenance.candidateNameMentionsFormula("黄连解毒汤合麻杏甘石汤加减", "麻黄杏仁甘草石膏汤"), true);
  assert.equal(provenance.candidateNameMentionsFormula("黄连解毒汤加减", "麻黄杏仁甘草石膏汤"), false);
  assert.equal(contract.formulaReferenceAlignsWithPrior(["黄连解毒汤", "麻黄杏仁甘草石膏汤"], ["黄连解毒汤", "麻杏甘石汤"], "combined"), true);
  assert.equal(contract.formulaReferenceAlignsWithPrior(["黄连解毒汤", "白虎汤"], ["黄连解毒汤", "麻杏甘石汤"], "combined"), false);
  assert.equal(contract.formulaReferenceAlignsWithPrior(["麻黄杏仁甘草石膏汤"], ["麻杏甘石汤", "银翘散"], "alternatives"), true);
  // 合同整体（f27 本轮交付、方名表改回目录条目名写法）：方名「黄连解毒汤合麻杏甘石汤加减」与方名表、锁定方向都按同一首方认，整份合同通过
  const f27 = fixtures.f27;
  assert.equal(t1(parse.parseReasoningV2(wrap(f27.m03)), `${f27.record}\n年龄：1岁\n性别：男`)(wrap(f27.m04)), undefined);
  // 不同的方照旧不一致：f31 的不换金正气散写成别的方名
  const prior = parse.parseReasoningV2(wrap(fixtures.f31.m03));
  const m04 = clone(fixtures.f31.m04);
  m04.formula.candidates[0].name = "白虎汤加减";
  assert.equal(t1(prior, fixtures.f31.record)(wrap(m04)), "formula_reference_display_mismatch");
});
