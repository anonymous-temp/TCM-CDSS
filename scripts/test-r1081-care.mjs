import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": process.cwd() + "/src",
  "server-only": process.cwd() + "/node_modules/next/dist/compiled/server-only/empty.js",
} });
const { reviewedTreatmentCard } = await jiti.import("../src/lib/tcm-treatment-card-review.ts");
const { reviewTreatmentCards } = await jiti.import("../src/lib/tcm-treatment-card-review.server.ts");
const { clinicalTreatmentScheduleWording } = await jiti.import("../src/lib/treatment-schedule-wording.ts");
const { clinicalContextForAuthoring } = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
const card = { projectCode: "acupuncture", treatmentContent: "本例见头痛，取太阳或率谷。", suggestedSitesOrPoints: ["太阳或率谷（EX-HN5）"],
  pointProvenance: [{ point: "太阳或率谷（按疼痛部位复核）" }] };
const review = (row) => reviewTreatmentCards([card], "头痛", "", undefined, async (...args) => args[4](JSON.stringify({ cards: [{ project: card.projectCode, cautions: [], ...row }] })));
const selected = reviewedTreatmentCard(card, await review({ keep: true, choices: [1] }));
assert.deepEqual([selected.suggestedSitesOrPoints[0], selected.pointProvenance[0].point, selected.treatmentContent], ["率谷（GB8）", "率谷", "本例见头痛，取率谷。"]);
assert.equal(reviewedTreatmentCard(card, await review({ keep: false, choices: [] })), undefined);
assert.equal(reviewedTreatmentCard(card, await review({ keep: true, choices: [9] })), card);
const control = { ...card, treatmentContent: "另一次编译的卡" };
assert.equal(reviewedTreatmentCard(control, await review({ keep: false, choices: [] })), control);
assert.equal(clinicalTreatmentScheduleWording("针灸治疗常规为一日治疗一次；根据病情和实际情况，也可一日两次或两日一次。"), "常规每日治疗一次。");
const context = clinicalContextForAuthoring({ patient: { age: 40 }, symptoms: { exams: "血红蛋白偏低" }, reasoningDiagnose: {
  westernDiagnosis: { primary: { name: "缺铁性贫血", status: "考虑", suggestedChecks: ["复查铁蛋白"] } }
} }, "", "", "", [], "");
assert.ok(["缺铁性贫血", "血红蛋白偏低", "复查铁蛋白", "含铁量高", "4周内复查"].every((phrase) => context.includes(phrase)));
const cautionCard = { ...card, suggestedSitesOrPoints: [], techniqueBoundary: "禁忌：骨折；严重心肺疾病。注意保暖。", requiredChecks: ["出血史"] };
const cautionReview = await reviewTreatmentCards([cautionCard], "无骨折", "", undefined, async (...args) =>
  args[4](JSON.stringify({ cards: [{ project: cautionCard.projectCode, keep: true, choices: [], cautions: [1] }] })));
const reviewed = reviewedTreatmentCard(cautionCard, cautionReview);
assert.deepEqual([reviewed.techniqueBoundary, reviewed.requiredChecks], ["禁忌：严重心肺疾病。注意保暖。", ["出血史"]]);
const { migrateDeliveredHerbCautions } = await jiti.import("../src/lib/candidate-boundary-text.ts");
const profile = (herb) => ({ herb, isToxic: false, toxicity: [], populationRules: [] });
const oldCaution = (herb, population) => `${herb}${population}慎用；本例有${population}记录，使用前请医生确认`;
const adult = { reproductive: true, ageYears: 35 };
assert.equal(migrateDeliveredHerbCautions([oldCaution("甲", "月经期"), oldCaution("乙", "月经期"), oldCaution("丙", "儿童/婴幼儿")].join("；"),
  ["甲", "乙", "丙"].map(profile), adult), "甲、乙在月经期情况下须慎用，请医生核对后使用");
const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
const rx = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", formula: { candidates: [], patentAndWestern: [
  { type: "中成药", name: "某丸", positioning: "联合治疗", relationship: "" }] }, nonPharma: { precautions: [
  "您已自服广藿香正气水，服本方期间请停服藿香正气水，以免重复用药。"] } };
const projection = projectDeliveredReasoning(rx, { requiredPrecautions: [{ kind: "self_medication", name: "藿香正气水", base: "藿香正气水", composition: [] }] });
assert.match(projection.formula.patentAndWestern[0].relationship, /医生或药师审核，请勿自行合用/);
assert.ok(projection.nonPharma.precautions.some((line) => line.includes("自服藿香正气水") && line.includes("如仍在服用") && !line.includes("停服")));
const { sanitizeFreeTextForModel } = await jiti.import("../src/lib/diagnosis-safety.ts");
const masked = sanitizeFreeTextForModel("患者李娜，身份证：110101199001010015，2026-07-18本院检查。");
assert.ok(masked.includes("本院检查") && !/李娜|110101199001010015|2026-07-18|日期已泛化/u.test(masked));
const { clinicalWordingForSyntheticPhrases } = await jiti.import("../src/lib/delivered-surface.ts");
assert.equal(clinicalWordingForSyntheticPhrases("本例未见阳虚阴盛阴阳实据"), "本例未见支持阳虚阴盛的四诊表现");
const { requiredPrecautionsForCase } = await jiti.import("../src/lib/required-precautions.server.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const normal = normalizeCaseStateInput({ patient: { age: 61, sex: "男" }, symptoms: { pastHistory: "高血压，长期口服美托洛尔每日一次。" }, chiefComplaint: "头晕" });
const medicineLines = (state) => projectDeliveredReasoning({ ...rx, nonPharma: { precautions: [] } }, {
  requiredPrecautions: requiredPrecautionsForCase(state).filter((item) => item.kind === "current_medications")
}).nonPharma.precautions.join("。");
assert.match(medicineLines(normal), /美托洛尔请按原医嘱继续服用，不要自行停药或加减.*医生或药师确认/);
const urgent = medicineLines({ ...normal, safetyGate: { status: "red_flag", redFlags: ["急诊评估"], missingItems: [] } });
assert.ok(urgent.includes("美托洛尔连同药盒带去就医") && urgent.includes("由急诊医生决定") && !urgent.includes("按原医嘱继续"));
const skinCase = { schemaVersion: rx.schemaVersion, stage: "diagnose", westernDiagnosis: { primary: { name: "丹毒" } },
  management: { followupSafetyNet: "请服完本次的药后复诊。若出现寒战或意识改变请立即就医。" } };
const f33state = { ...normal, clinicalFacts: { semanticStatus: "unavailable", discriminatorScreen: { status: "checked", present: [
  { conceptId: "ctx-fever", quote: "伴发热" }, { conceptId: "ctx-infection-suspected", quote: "局部红肿热痛" }] } } };
const visit = (state) => projectDeliveredReasoning(skinCase, { caseState: state }).management.followupSafetyNet;
assert.match(visit(f33state), /^请在24小时内.*若出现.*立即就医/);
assert.doesNotMatch(visit({ ...f33state, clinicalFacts: { ...f33state.clinicalFacts, discriminatorScreen: { status: "checked", present: [] } } }), /24小时/);
const { textbookTreatmentPlan } = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const gastric = { projectCode: "diet_therapy", diseaseNames: ["胃痛"], signedSyndromeText: "胃阴不足证", patientAgeYears: 42, currentFacts: "胃脘隐痛，口干，舌红少津", westernNames: ["慢性萎缩性胃炎"] };
const dietText = (input) => textbookTreatmentPlan(input)?.treatmentContent || "";
assert.ok(/酒酿/u.test(dietText({ ...gastric, westernNames: [] })) && !/酒酿/u.test(dietText(gastric)));
const ear = textbookTreatmentPlan({ ...gastric, projectCode: "auricular" });
assert.ok(ear.treatmentContent.includes("毫针") && /压丸贴压时可留置3～7天/u.test(ear.scheduleSuggestion));
console.log("care regression passed");

if (process.argv.includes("--replay")) {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
  const { clinicalGroundingText, evaluateSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { requiredPrecautionsForCase } = await jiti.import("../src/lib/required-precautions.server.ts");
  const { projectDeliveredReasoning } = await jiti.import("../src/lib/delivered-surface.ts");
  const { compileTcmTreatmentRecommendations } = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
  const counts = {};
  for (const group of readdirSync("zz-evidence/out")) {
    for (const file of readdirSync("zz-evidence/out/" + group).filter((name) => name.endsWith(".json"))) {
      const sample = JSON.parse(readFileSync("zz-evidence/out/" + group + "/" + file));
      const before = sample.prescribe?.structured;
      if (!before) continue;
      const prior = sample.diagnose?.structured;
      const state = normalizeCaseStateInput(sample.input);
      if (file === "f33.r1.json") {
        const atDiagnosis = { ...state, clinicalFacts: sample.redFlags.body.clinicalFacts, safetyGate: sample.redFlags.body.safetyGate };
        console.log(JSON.stringify({ file, firstVisit: projectDeliveredReasoning(prior, { caseState: atDiagnosis }).management.followupSafetyNet }));
      }
      const cards = before.nonPharma?.tcmTreatments || [];
      if (cards.length && prior) {
        const supplied = { ...state, safetyGate: sample.redFlags?.body?.safetyGate, clinicalFacts: sample.redFlags?.body?.clinicalFacts };
        // 回放只开放原交付页已出现的项目，不假定机构的完整能力。
        process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = cards.map((card) => card.projectCode).join(",");
        const compiled = compileTcmTreatmentRecommendations(cards.map(({projectCode,targetRef}) => ({projectCode,targetRef})), prior, supplied, before.nonPharma?.diet || "", (before.formula?.candidates?.[0]?.herbs || []).map((h) => h.name), (before.nonPharma?.precautions || []).join("；"));
        const text = (rows) => rows.map(({projectCode,treatmentContent,suggestedSitesOrPoints,techniqueBoundary,scheduleSuggestion}) => ({projectCode,treatmentContent,suggestedSitesOrPoints,techniqueBoundary,scheduleSuggestion}));
        if (JSON.stringify(text(cards)) !== JSON.stringify(text(compiled))) {
          counts.recompiled = (counts.recompiled || 0) + 1;
          console.log(JSON.stringify({file, key:"cards", before:text(cards), after:text(compiled)}));
        }
      }
      const opts = { caseState: state, recordText: clinicalGroundingText(state), requiredPrecautions: requiredPrecautionsForCase(state, prior) };
      const after = projectDeliveredReasoning(before, opts);
      const fields = (record) => ({
        warnings: record.formula?.candidates?.map((row) => row.notApplicable),
        relation: record.formula?.patentAndWestern?.filter((m) => m.type === "中成药").map((m) => m.relationship),
        schedule: record.nonPharma?.tcmTreatments?.map((m) => m.scheduleSuggestion),
        precautions: record.nonPharma?.precautions,
      });
      const first = fields(before), last = fields(after);
      for (const key of Object.keys(first)) if (JSON.stringify(first[key]) !== JSON.stringify(last[key])) {
        counts[key] = (counts[key] || 0) + 1;
        console.log(JSON.stringify({file, key, before: first[key], after: last[key]}));
      }
      if (/^(f01|f07|f09|f12|f17|f33|f37|w06|e1029-c0[67]|e1029-c2[12])\./.test(file) || /e1029-c(06|07|21|22)-/.test(file)) {
        console.log(JSON.stringify({file, target: true, drugs: opts.requiredPrecautions.filter((r) => ["self_medication","current_medications"].includes(r.kind)),
          missing: evaluateSafetyGate(state).missingItems, precautions: last.precautions}));
      }
      counts.prescriptions = (counts.prescriptions || 0) + 1;
    }
  }
  console.log(JSON.stringify(counts));
}
