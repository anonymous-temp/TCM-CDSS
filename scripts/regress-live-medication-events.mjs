import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  currentMedicationsFromSemanticExtraction,
  extractMedicationEventsWithModel,
} = jiti("../src/lib/medication-event-extractor.ts");

const cases = [
  { id: "historical_colloquial", text: "约莫七年前服过华法林，后来就没再吃", expected: [] },
  { id: "current_aspect", text: "正用着氯吡格雷75mg每日一次", expected: [/氯吡格雷/] },
  { id: "explicit_stop", text: "目前服用阿司匹林100mg，已经把阿司匹林停了", expected: [] },
  { id: "stop_prohibition", text: "请勿停用华法林3mg每日一次", expected: [/华法林/] },
  { id: "restart", text: "阿司匹林停药一周后继续服阿司匹林100mg每日一次", expected: [/阿司匹林/] },
  { id: "replacement", text: "原来吃阿司匹林100mg，后来换成氯吡格雷75mg每日一次", expected: [/氯吡格雷/] },
  { id: "list", text: "当前服药：阿司匹林100mg每日一次、氯吡格雷75mg每日一次", expected: [/阿司匹林/, /氯吡格雷/] },
  { id: "one_of_two_stopped", text: "目前服用阿司匹林和氯吡格雷，两者中的阿司匹林已停用，氯吡格雷照旧", expected: [/氯吡格雷/] },
  { id: "fraction", text: "目前服用华法林二分之一片每日一次", expected: [/华法林/], dose: /二分之一/ },
  { id: "weekly", text: "目前服用甲氨蝶呤10mg，每7天一次", expected: [/甲氨蝶呤/], dose: /每7天一次/ },
  { id: "meal_timing", text: "目前服用阿司匹林100mg，饭后半小时服用", expected: [/阿司匹林/], dose: /饭后半小时/ },
  { id: "family_subject", text: "妻子长期服华法林，患者本人目前只服阿司匹林100mg每日一次", expected: [/阿司匹林/] },
  { id: "referent", text: "阿司匹林和氯吡格雷原来都吃，前一种已经停了，后一种继续", expected: [/氯吡格雷/] },
  { id: "combination_replacement", text: "二甲双胍已经停用，改用恩格列净10mg每天一次", expected: [/恩格列净/] },
  { id: "negative", text: "目前没有服用任何中药、西药或保健品", expected: [] },
  { id: "defer_stop", text: "华法林暂缓停用，仍按原方案口服3mg每天一次", expected: [/华法林/] },
  { id: "all_stopped", text: "之前吃阿司匹林和氯吡格雷，现在两种药都停了", expected: [] },
  { id: "both_must_continue", text: "阿司匹林和氯吡格雷两种都不能停，继续按原剂量服", expected: [/阿司匹林/, /氯吡格雷/] },
  { id: "mixed_time", text: "去年短期吃过布洛芬，现用氯吡格雷75mg每日一次", expected: [/氯吡格雷/] },
  { id: "resume_referent", text: "氨氯地平5mg每天一次，前阵子停过，后来又用回来了", expected: [/氨氯地平/] },
  { id: "continue_aspect", text: "美托洛尔47.5mg每早一次，继续吃着", expected: [/美托洛尔/] },
  { id: "slash_list", text: "用药清单：阿托伐他汀20mg每晚／氨氯地平5mg每天", expected: [/阿托伐他汀/, /氨氯地平/] },
  { id: "replacement_with_old_history", text: "年轻时吃过心得安；现在因房颤服美托洛尔，华法林已改成利伐沙班", expected: [/美托洛尔/, /利伐沙班/] },
  { id: "family_and_negation", text: "哥哥在吃阿司匹林；患者否认当前用药", expected: [] },
];

const concurrency = Math.max(1, Math.min(6, Number(process.env.MEDICATION_EVENT_CONCURRENCY || 3)));
let cursor = 0;
const results = [];

async function worker() {
  while (cursor < cases.length) {
    const item = cases[cursor++];
    const startedAt = Date.now();
    const extraction = await extractMedicationEventsWithModel(item.text);
    const current = currentMedicationsFromSemanticExtraction(extraction);
    const names = current.map((entry) => entry.drug_name);
    const joined = names.join("；");
    const expectedMatch = names.length === item.expected.length && item.expected.every((pattern) => pattern.test(joined));
    const doseText = current.map((entry) => entry.dose_daily || "").join("；");
    const doseMatch = !item.dose || item.dose.test(doseText);
    const ok = extraction.source === "model" && expectedMatch && doseMatch;
    results.push({ id: item.id, ok, source: extraction.source, names, doseText, manual: extraction.needsManualReview, elapsedMs: Date.now() - startedAt });
    console.log(`${ok ? "PASS" : "FAIL"} ${item.id} | ${names.join(",") || "none"} | ${Date.now() - startedAt}ms${extraction.needsManualReview ? " | manual-review" : ""}`);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const failures = results.filter((item) => !item.ok);
console.log(JSON.stringify({ suite: "live-medication-events", cases: results.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
