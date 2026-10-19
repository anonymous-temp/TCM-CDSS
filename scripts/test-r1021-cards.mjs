// 中医外治覆盖 r1021 第九轮 WP9-D（2026-10-19 晚）。
//
// 依据是第八轮 qwen 评审 H 集（89.2%）里「没有针刺方案、只给居家穴位按揉」的那一类，逐例查选卡链路后定位到的服务端缺陷；
// 材料与逐例诊断在 ~/runlogs/r1018/work/r1021/cards（diagnosis.md、replay-cards.mjs、plan-dump.mjs、base*/new*）。
// 每条断言都带对照（不该变的输入保持不变）；反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 9/cards/）。
//
//   1 病名到教材节：教材该节自己写明的又名、范围与西医对应补进别名表（generator EXTRA_ACUPUNCTURE_ALIASES，带书名行号），
//     五迟/五软 → 小儿脑性瘫痪，倒经/鼻出血 → 鼻衄，内痔/外痔/混合痔 → 痔疮，流行性腮腺炎 → 痄腮，积滞 → 小儿积滞，
//     注意力缺陷多动障碍 → 注意力缺陷多动症，踝关节外侧韧带损伤 → 急性踝关节扭伤，乳蛾 → 咽喉肿痛，暴聋/突发性耳聋 → 耳鸣、耳聋；
//     针刺节的西医主干整词相等从 3 字放宽到 2 字（鼻衄待查）；小儿专节不对成年人取；教材没有的病（噎膈、汗证、子痈）照旧不编
//   2 频次：针刺、艾灸卡本节没写频次时写教材总论通行的次数与疗程（《针灸学》治疗常规、《刺法灸法学》施灸疗程），
//     次序 本节 > 联网诊疗方案 > 另一本教材同名节 > 总论；重症加次的限定句不当常规次数
//   3 主证与兼证：目录证型配穴只对上兼证、教材按主证配了穴时用教材（H-tri-12291）；食疗先主证（主证有型而无可给的方时不拿兼证的型顶替）
//   4 囟门：2 岁以下，或 2～11 岁病历写明囟门未闭，针刺卡不列头顶部腧穴，并写明
import assert from "node:assert/strict";
import { createJiti } from "jiti";

process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,auricular,moxibustion,cupping,tuina,diet_therapy";
delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const failures = [];
const check = (name, run) => {
  cases += 1;
  try {
    run();
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const cap = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");

const project = (projectCode, input) => plan.textbookTreatmentPlan({ projectCode, westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const acupuncture = (input) => project("acupuncture", input);
const names = (result) => (result?.points || []).map((point) => point.name);
const signedPrior = (disease, syndromeText, fact, western = disease, therapy = {}, secondary = []) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndromeText, secondarySyndromes: secondary, primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: fact },
  westernDiagnosis: { primary: { name: western, supportingFacts: [] } },
  therapy: { overallPrinciple: "", overallMethod: "", subTherapies: [], ...therapy },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: syndromeText, pathogenesis: fact, therapyDirection: "" }], uncertainties: [] },
});
const compile = (prior, chief, present, proposals, patient = { sex: "男", age: 45 }, extra = {}) => cap.compileTcmTreatmentRecommendations(
  proposals, prior, { chiefComplaint: chief, symptoms: { 现病史: present }, patient, safetyGate: { status: "ready", redFlags: [] }, ...extra });
const acuProposal = [{ projectCode: "acupuncture", targetRef: "P1" }];
const card = (cards, code) => cards.find((item) => item.projectCode === code);
const bare = (sites) => (sites || []).map((site) => String(site).replace(/（.*$/u, ""));
const section = (result, title) => new RegExp(`「${title}」节`, "u").test(result?.protocolSource || "");

// ── 1 病名到教材节 ───────────────────────────────────────────────────────────
check("1.1 五迟、五软、五迟五软、脑瘫（《针灸治疗学》第 11210 行「属中医学五迟五软等范畴」）接上小儿脑性瘫痪节：肝肾不足加肝俞、肾俞；噎膈、汗证、子痈教材没有的病照旧不编（对照）", () => {
  for (const name of ["五迟", "五软", "五迟五软", "脑瘫", "小儿脑瘫"]) {
    const result = acupuncture({ diseaseNames: [name], signedSyndromeText: "肝肾不足证", currentFacts: "发育迟缓，筋骨痿弱，目无神采", patientAgeYears: 3 });
    assert.ok(section(result, "小儿脑性瘫痪"), `${name}：${result?.protocolSource}`);
    assert.ok(names(result).includes("肝俞") && names(result).includes("肾俞"), JSON.stringify(names(result)));
  }
  const west = acupuncture({ diseaseNames: ["肉瘤"], westernNames: ["脑性瘫痪"], patientAgeYears: 2 });
  assert.ok(section(west, "小儿脑性瘫痪"), "西医名脑性瘫痪（教材又名）");
  assert.equal(acupuncture({ diseaseNames: ["噎膈"], westernNames: ["食管恶性肿瘤"], signedSyndromeText: "痰气交阻证", currentFacts: "噎食半年", patientAgeYears: 50 }), undefined);
  assert.equal(acupuncture({ diseaseNames: ["汗证"], westernNames: ["原发性多汗症"], signedSyndromeText: "肺卫不固证", currentFacts: "自汗", patientAgeYears: 45 }), undefined);
  assert.equal(acupuncture({ diseaseNames: ["子痈"], westernNames: ["急性睾丸炎"], signedSyndromeText: "湿热下注证", currentFacts: "睾丸坠胀", patientAgeYears: 36 }), undefined);
});

check("1.2 内痔、外痔、混合痔 → 痔疮节；流行性腮腺炎 → 痄腮节；乳蛾 → 咽喉肿痛节；注意力缺陷多动障碍 → 注意力缺陷多动症节", () => {
  for (const name of ["内痔", "外痔", "混合痔"]) {
    const result = acupuncture({ diseaseNames: [name], signedSyndromeText: "湿热下注证", currentFacts: "便血，肛门肿痛", patientAgeYears: 45 });
    assert.ok(section(result, "痔疮") && names(result).includes("承山"), `${name}：${JSON.stringify(names(result))}`);
  }
  assert.ok(section(acupuncture({ diseaseNames: ["流行性腮腺炎"], patientAgeYears: 6 }), "痄腮"));
  assert.ok(section(acupuncture({ diseaseNames: ["乳蛾"], signedSyndromeText: "热毒蕴结证", currentFacts: "咽痛", patientAgeYears: 14 }), "咽喉肿痛"));
  const adhd = acupuncture({ diseaseNames: ["注意力缺陷多动障碍"], signedSyndromeText: "肝肾阴虚证", currentFacts: "多动，注意力不集中", patientAgeYears: 9 });
  assert.ok(section(adhd, "注意力缺陷多动症") && names(adhd).includes("太溪"), JSON.stringify(names(adhd)));
  // 对照：近义但教材不是同一个病的名字不接（痔疮节不收肛裂；咽喉肿痛节不收喘证）。
  assert.equal(acupuncture({ diseaseNames: ["肛裂"], currentFacts: "便后肛门疼痛", patientAgeYears: 40 }), undefined);
  assert.equal(acupuncture({ diseaseNames: ["喘证"], westernNames: ["急性支气管炎"], currentFacts: "喘息", patientAgeYears: 40 }), undefined);
});

check("1.3 西医名「踝关节外侧韧带损伤」（教材急性踝关节扭伤节第 11808 行「踝关节软组织韧带损伤」）与「突发性耳聋」（耳鸣、耳聋节第 116890 行暴聋）对上本节", () => {
  const ankle = acupuncture({ diseaseNames: ["筋出槽"], westernNames: ["左踝关节外侧韧带损伤"], currentFacts: "踝关节肿胀疼痛", patientAgeYears: 58 });
  assert.ok(section(ankle, "急性踝关节扭伤") && names(ankle).includes("丘墟"), JSON.stringify(names(ankle)));
  const ear = acupuncture({ diseaseNames: ["耳胀"], westernNames: ["突发性耳聋待查"], signedSyndromeText: "风热犯表证", currentFacts: "突发听力下降2天，耳闷胀，畏寒发热", patientAgeYears: 23 });
  assert.ok(section(ear, "耳鸣、耳聋") && names(ear).includes("外关") && names(ear).includes("合谷"), JSON.stringify(names(ear)));
  assert.equal(acupuncture({ diseaseNames: ["耳胀"], westernNames: ["分泌性中耳炎"], currentFacts: "耳闷胀", patientAgeYears: 23 }), undefined, "对照：中耳炎教材无节");
});

check("1.4 积滞接小儿积滞节（儿科病名省去「小儿」）：6 岁取乳食内积加梁门、建里；成年人不取（小儿专节年龄门），年龄未知照取（对照）", () => {
  const child = acupuncture({ diseaseNames: ["积滞"], signedSyndromeText: "乳食内积证", currentFacts: "呕吐，腹胀，大便酸臭", patientAgeYears: 6 });
  assert.ok(section(child, "小儿积滞") && names(child).includes("梁门") && names(child).includes("建里"), JSON.stringify(names(child)));
  assert.equal(acupuncture({ diseaseNames: ["积滞"], signedSyndromeText: "食积证", currentFacts: "腹胀", patientAgeYears: 40 }), undefined);
  assert.ok(section(acupuncture({ diseaseNames: ["积滞"], signedSyndromeText: "食积证", currentFacts: "腹胀" }), "小儿积滞"), "年龄未知（对照）");
  assert.equal(acupuncture({ diseaseNames: ["五迟"], signedSyndromeText: "肝肾不足证", currentFacts: "发育迟缓", patientAgeYears: 35 }), undefined, "成年人不取小儿脑性瘫痪节");
  assert.ok(acupuncture({ diseaseNames: ["五迟"], signedSyndromeText: "肝肾不足证", currentFacts: "发育迟缓", patientAgeYears: 17 }), "17 岁照取（对照）");
});

check("1.5 小儿专节年龄门：成年人胃痞 + 西医「功能性消化不良」（等于小儿积滞节的范围）不再引用小儿积滞节；6 岁儿童照引（对照）", () => {
  const adult = acupuncture({ diseaseNames: ["胃痞"], westernNames: ["功能性消化不良"], signedSyndromeText: "肝郁气滞证", currentFacts: "上腹胀满", patientAgeYears: 52 });
  assert.ok(adult, "成年人仍有呕吐节等");
  assert.ok(section(adult, "呕吐"), adult.protocolSource);
  const child = acupuncture({ diseaseNames: ["胃痞"], westernNames: ["功能性消化不良"], signedSyndromeText: "食积证", currentFacts: "上腹胀满", patientAgeYears: 6 });
  // 同名节只在来源里写行号（「《针灸治疗学》同名节（教材原文第11124行）」，11124 是小儿积滞节的行号）。
  assert.match(child?.protocolSource || "", /第11124行/u, child?.protocolSource);
  assert.doesNotMatch(adult.protocolSource, /第11124行/u, adult.protocolSource);
  assert.equal(plan.pediatricSectionExcludes("小儿积滞", 18), true);
  assert.equal(plan.pediatricSectionExcludes("小儿积滞", 17), false);
  assert.equal(plan.pediatricSectionExcludes("小儿积滞", undefined), false);
  assert.equal(plan.pediatricSectionExcludes("积滞", 40), false, "节名不以小儿起头的不拦");
  assert.equal(plan.textbookPlanExistsForDisease("acupuncture", "积滞", undefined, 40), false);
  assert.equal(plan.textbookPlanExistsForDisease("acupuncture", "积滞", undefined, 6), true);
});

check("1.6 针刺节的西医主干与节名/又名整词相等放宽到 2 字（经行吐衄 + 鼻衄待查 → 鼻衄节）；食疗、推拿节不放宽（月经后期 + 痛经 不拿痛经节的食疗方）；中医病名对得上时西医名不抢（对照）", () => {
  const nose = acupuncture({ diseaseNames: ["经行吐衄"], westernNames: ["鼻衄待查"], signedSyndromeText: "肺肾阴虚证", currentFacts: "每遇月经来潮有鼻衄", patientAgeYears: 25 });
  assert.ok(section(nose, "鼻衄") && names(nose).includes("迎香"), JSON.stringify(names(nose)));
  const noseAlias = acupuncture({ diseaseNames: ["经行吐衄"], westernNames: ["经期鼻出血"], signedSyndromeText: "肝火上炎证", currentFacts: "经行鼻衄，头痛眩晕，目赤口苦，烦躁易怒", patientAgeYears: 20 });
  assert.ok(section(noseAlias, "鼻衄") && names(noseAlias).includes("行间"), JSON.stringify(names(noseAlias)));
  assert.equal(project("diet_therapy", { diseaseNames: ["月经后期"], westernNames: ["痛经"], signedSyndromeText: "气滞证", currentFacts: "经行腹痛", patientAgeYears: 35 }), undefined);
  assert.equal(project("diet_therapy", { diseaseNames: ["经行吐衄"], westernNames: ["鼻衄待查"], signedSyndromeText: "肺肾阴虚证", currentFacts: "经行鼻衄", patientAgeYears: 25 }), undefined);
  const stomach = acupuncture({ diseaseNames: ["胃痛"], westernNames: ["鼻衄"], signedSyndromeText: "寒邪客胃证", currentFacts: "胃脘冷痛", patientAgeYears: 40 });
  assert.ok(section(stomach, "胃痛") && !section(stomach, "鼻衄"), stomach?.protocolSource);
});

// ── 2 频次 ───────────────────────────────────────────────────────────────────
check("2.1 针刺卡本节没写频次：写《针灸学》总论的通行次数与疗程；艾灸卡写《刺法灸法学》施灸疗程；本节自己写了频次的卡不变（对照）", () => {
  const vertigo = acupuncture({ diseaseNames: ["眩晕"], signedSyndromeText: "痰湿中阻证", currentFacts: "头晕目眩，头重如裹，呕恶痰涎", patientAgeYears: 50 });
  assert.match(vertigo.scheduleSuggestion, /一日治疗一次/u, vertigo.scheduleSuggestion);
  assert.match(vertigo.scheduleSuggestion, /1～2周为一个疗程（《针灸学》总论）/u, vertigo.scheduleSuggestion);
  assert.doesNotMatch(vertigo.scheduleSuggestion, /重症可每日治疗2次/u, "另一本教材的重症加次不当常规次数");
  const moxa = project("moxibustion", { diseaseNames: ["腱鞘囊肿"], currentFacts: "腕背囊性肿物", patientAgeYears: 40 });
  assert.ok(moxa, "腱鞘囊肿节有灸法");
  assert.match(moxa.scheduleSuggestion, /初灸时，每日1次，3次后改为2～3天1次/u, moxa.scheduleSuggestion);
  assert.match(moxa.scheduleSuggestion, /（《刺法灸法学》总论）/u, moxa.scheduleSuggestion);
  const headache = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "肝阳头痛", currentFacts: "头胀痛，目眩，心烦易怒", patientAgeYears: 40 });
  assert.match(headache.scheduleSuggestion, /头痛急性发作时每日治疗1-2次/u);
  assert.doesNotMatch(headache.scheduleSuggestion, /针灸学》总论/u, "本节写了频次不再并列总论（对照）");
  const cupping = project("cupping", { diseaseNames: ["腰痛"], signedSyndromeText: "寒湿腰痛", currentFacts: "腰部冷痛", patientAgeYears: 50 });
  assert.doesNotMatch(cupping.scheduleSuggestion, /针灸学》总论/u, "拔罐照旧用它自己的总论句（对照）");
});

check("2.2 次序：联网诊疗方案的频次先于另一本教材（老年便秘 70 岁引老年便秘方案）；本节没写频次、同名节另一本教材写了时用另一本（脑瘫「每日1次」，小儿去掉留针时长）", () => {
  const old = acupuncture({ diseaseNames: ["便秘"], westernNames: ["便秘"], signedSyndromeText: "热秘", currentFacts: "大便干结5天", patientAgeYears: 72 });
  assert.match(old.scheduleSuggestion, /老年便秘/u, old.scheduleSuggestion);
  assert.doesNotMatch(old.scheduleSuggestion, /针灸学》总论/u);
  const cp = acupuncture({ diseaseNames: ["五迟"], signedSyndromeText: "肝肾不足证", currentFacts: "发育迟缓", patientAgeYears: 3 });
  assert.match(cp.scheduleSuggestion, /每日1次/u, cp.scheduleSuggestion);
  assert.doesNotMatch(cp.scheduleSuggestion, /留针30分钟/u, "小儿不写留针时长");
  assert.doesNotMatch(cp.scheduleSuggestion, /针灸学》总论/u, "另一本教材写了就不并列总论");
});

// ── 3 主证与兼证 ─────────────────────────────────────────────────────────────
check("3.1 目录证型配穴只对上兼证（湿热中阻），教材泄泻节按主证（脾肾阳虚）配了肾阳虚衰：针刺卡用教材（H-tri-12291）；主证对上目录配穴的照旧（对照）", () => {
  const prior = signedPrior("泄泻", "脾肾阳虚泻", "久泻脾阳受损，运化失司", "腹泻待查", { overallPrinciple: "扶正祛邪", overallMethod: "温补脾肾，升阳举陷，涩肠止泻，清热化湿" }, ["湿热内蕴证"]);
  const acu = card(compile(prior, "泻下一日十数次伴脱肛", "自生后三个月起一年多来泻下一日十数次，伴有脱肛。面色萎黄，手足发凉。大便多次检查有脓细胞。", acuProposal, { sex: "男", age: 2 }), "acupuncture");
  assert.ok(acu, "有针刺卡");
  assert.match(acu.treatmentContent, /肾阳虚衰/u, acu.treatmentContent);
  assert.doesNotMatch(acu.treatmentContent, /湿热中阻/u, acu.treatmentContent);
  assert.ok(bare(acu.suggestedSitesOrPoints).includes("肾俞") && bare(acu.suggestedSitesOrPoints).includes("命门"), JSON.stringify(acu.suggestedSitesOrPoints));
  assert.ok(!bare(acu.suggestedSitesOrPoints).includes("内庭"), "主证阳虚不取清热的内庭");
  const primaryFits = signedPrior("泄泻", "湿热中阻证", "湿热蕴结肠道", "腹泻待查", { overallPrinciple: "实则泻之", overallMethod: "清热利湿" }, ["脾肾阳虚泻"]);
  const control = card(compile(primaryFits, "泄泻3天", "泻下急迫，大便黄褐臭秽，肛门灼热，口渴。", acuProposal, { sex: "男", age: 30 }), "acupuncture");
  assert.match(control.treatmentContent, /按湿热中阻取穴/u, control.treatmentContent);
});

check("3.2 食疗先主证：脾肾阳虚泻兼湿热内蕴证不给湿热伤中型的马齿苋粥；仅湿热内蕴证给；脾胃虚弱兼湿热给脾胃虚弱型（对照）", () => {
  const mixed = project("diet_therapy", { diseaseNames: ["泄泻"], westernNames: ["腹泻待查"], signedSyndromeText: "脾肾阳虚泻；湿热内蕴证", currentFacts: "泻下十数次，大便有脓细胞，手足发凉", patientAgeYears: 2 });
  assert.equal(mixed, undefined, JSON.stringify(mixed?.items));
  const damp = project("diet_therapy", { diseaseNames: ["泄泻"], westernNames: ["腹泻待查"], signedSyndromeText: "湿热内蕴证", currentFacts: "泻下急迫，大便黄褐臭秽，肛门灼热", patientAgeYears: 30 });
  assert.ok(damp && damp.syndromeLabels.includes("湿热伤中"), JSON.stringify(damp?.syndromeLabels));
  const spleen = project("diet_therapy", { diseaseNames: ["泄泻"], westernNames: ["腹泻待查"], signedSyndromeText: "脾胃虚弱证；湿热内蕴证", currentFacts: "大便溏薄，完谷不化，迁延反复，泻下急迫，肛门灼热", patientAgeYears: 30 });
  assert.ok(spleen && spleen.syndromeLabels.includes("脾胃虚弱"), JSON.stringify(spleen?.syndromeLabels));
});

// ── 4 囟门 ───────────────────────────────────────────────────────────────────
check("4.1 2 岁以下、或 2～11 岁病历写明囟门未闭：针刺卡不列百会、四神聪等头顶部腧穴，也不写「四神聪可向百会透刺」，并写明；无记录的 5 岁、有记录的 15 岁照旧（对照）", () => {
  const cp = (age, facts, western = "全面发育迟缓") => card(compile(
    signedPrior("五迟", "肝肾不足证", "肾精不足", western, { overallPrinciple: "虚则补之", overallMethod: "滋养肝肾，填精补髓" }),
    "发育迟缓", facts, acuProposal, { sex: "男", age }), "acupuncture");
  const recorded = cp(5, "发育迟缓，坐立行走迟于同龄小儿，囟门闭合不全。");
  assert.ok(recorded, "有针刺卡");
  assert.ok(!bare(recorded.suggestedSitesOrPoints).includes("百会") && !bare(recorded.suggestedSitesOrPoints).includes("四神聪"), JSON.stringify(recorded.suggestedSitesOrPoints));
  assert.match(recorded.techniqueBoundary, /病历记有囟门未闭，头顶部腧穴不针/u, recorded.techniqueBoundary);
  assert.doesNotMatch(recorded.techniqueBoundary, /四神聪可向百会/u, recorded.techniqueBoundary);
  assert.ok(bare(recorded.suggestedSitesOrPoints).includes("风府") && bare(recorded.suggestedSitesOrPoints).includes("肾俞"), "其余穴位保留");
  const infant = cp(1, "左上下肢活动受限，肌张力高。", "脑性瘫痪");
  assert.ok(!bare(infant.suggestedSitesOrPoints).includes("百会"), JSON.stringify(infant.suggestedSitesOrPoints));
  assert.match(infant.techniqueBoundary, /囟门未闭者头顶部腧穴不针/u);
  assert.doesNotMatch(infant.techniqueBoundary, /四神聪可向百会/u);
  const plain5 = cp(5, "发育迟缓，坐立行走迟于同龄小儿。");
  assert.ok(bare(plain5.suggestedSitesOrPoints).includes("百会"), "5 岁无囟门记录照列（对照）");
  assert.doesNotMatch(plain5.techniqueBoundary, /囟门/u);
  const teen = cp(15, "发育迟缓，囟门未闭。", "脑性瘫痪");
  assert.ok(bare(teen.suggestedSitesOrPoints).includes("百会"), "12 岁以上不适用（对照）");
  assert.equal(cap.fontanelleCardNote("acupuncture", 5, "囟门已闭"), "", "囟门已闭不触发");
  assert.equal(cap.fontanelleCardNote("cupping", 5, "囟门未闭"), "", "只对针刺卡");
});

console.log(JSON.stringify({ suite: "r1021-cards", cases, failures: failures.length }));
if (failures.length > 0) process.exitCode = 1;
