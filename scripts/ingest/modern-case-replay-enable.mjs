// 现代医案回放池治理启用(保守子集)。
// 背景:tcm-modern-case-eval-corpus.json 17,270 案全部 replayEligible=false(安全默认,§9)。
// 本脚本对通过全部治理闸门的子集启用 replayEligible=true——仅回放评测可用,
// evaluationOnly 与 runtimeRetrievalAllowed=false 不变(现代案不进运行时检索)。
// 闸门(fail-closed,缺一即排除):
//   ① expectedFormulaNames 非空(回放断言锚到 T8 受控方);
//   ② 主诉/四诊/辨证/中医诊断/治则/方药(≥2)/疗程 七项齐全;
//   ③ 药味不得含毒剧禁品(名单与剂量阻断评审的毒性类一致);
//   ④ replayInput 不得命中剂量/操作语料(复用 nihaixia 构建器同口径正则);
//   ⑤ 主诉/四诊合计 ≥24 字(回放输入信息量下限);
//   ⑥ 诊断不得为空、herbs 不得含未归一单字(防 44 首缺字类的数据缺陷进入黄金池)。
// 用法: node scripts/ingest/modern-case-replay-enable.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CORPUS = resolve(ROOT, "src/data/tcm-modern-case-eval-corpus.json");

const corpus = JSON.parse(readFileSync(CORPUS, "utf-8"));
const caseDoseOrInstructionPattern = /(?:(?:\d+(?:\.\d+)?|[〇零一二三四五六七八九十百半]+)\s*(?:克|g|钱|两|升|合|铢)|每日.{0,8}(?:服|次)|(?:先煎|后下|久煎|水煎服)|(?:针|刺|灸).{0,16}(?:穴|分钟|寸))/i;
const TOXIC_HERBS = new Set([
  "马钱子", "巴豆", "巴豆霜", "罂粟壳", "御米壳", "雄黄", "商陆", "红大戟", "京大戟", "甘遂",
  "蓖麻子", "蓖麻仁", "苦楝皮", "仙茅", "砒霜", "轻粉", "红粉", "水银", "铅", "铅丹", "铅粉",
  "斑蝥", "蟾酥", "生川乌", "生草乌", "生附子", "生半夏", "生天南星", "生白附子", "硫黄", "硫磺",
]);

const catalog = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8"));
const catalogNames = new Set((catalog.entries || []).map((e) => e.name));
for (const e of catalog.entries || []) for (const a of e.aliases || []) catalogNames.add(a);

const rejectReasons = {};
let enabled = 0;
for (const c of corpus.cases) {
  const fail = (reason) => { rejectReasons[reason] = (rejectReasons[reason] || 0) + 1; };
  // Recompute eligibility from scratch on every run. A case that no longer passes
  // a gate must never retain a stale approval from an earlier generated corpus.
  c.replayEligible = false;
  delete c.replayGovernance;
  const complete = [c.chiefComplaint, c.fourExams, c.patternAnalysis, c.diagnosisTcm, c.treatmentPrinciple, c.course]
    .every((v) => typeof v === "string" && v.trim().length > 0);
  const anchorOk = (c.expectedFormulaNames || []).length > 0 && c.expectedFormulaNames.every((n) => catalogNames.has(n));
  const herbs = (c.herbs || []).map((h) => h.herb);
  const toxic = herbs.filter((h) => TOXIC_HERBS.has(h));
  const singleChar = herbs.filter((h) => typeof h === "string" && h.trim().length === 1);
  if (!anchorOk) { fail("no-catalog-formula-anchor"); continue; }
  if (!complete) { fail("incomplete-fields"); continue; }
  if (herbs.length < 2) { fail("herbs<2"); continue; }
  if (toxic.length) { fail(`toxic-herb:${toxic.join("/")}`); continue; }
  if (singleChar.length) { fail(`single-char-herb:${singleChar.join("/")}`); continue; }
  if (!c.replayInput || c.replayInput.length < 24) { fail("replay-input-too-short"); continue; }
  if (caseDoseOrInstructionPattern.test(c.replayInput)) { fail("dose-in-replay-input"); continue; }
  if (c.containsQuarantinedContent) { fail("quarantined"); continue; }
  c.replayEligible = true;
  c.replayGovernance = "ADJ-20260726-MODERN-CASE-REPLAY-POOL:七项字段齐全+受控方锚+无毒剧+输入无剂量操作语料,经治理闸门启用回放";
  enabled++;
}
corpus.replayPoolGovernance = {
  batch: "ADJ-20260726-MODERN-CASE-REPLAY-POOL",
  enabled,
  gates: ["catalogFormulaAnchor", "completeFields", "herbs>=2", "noToxicHerbs", "noSingleCharHerbs", "replayInput>=24", "noDoseOrInstructionInReplayInput", "notQuarantined"],
  note: "回放资格只用于评测回放;evaluationOnly 与 runtimeRetrievalAllowed=false 不变,现代案不作运行时证据。",
};
writeFileSync(CORPUS, JSON.stringify(corpus, null, 2) + "\n");
console.log(JSON.stringify({ total: corpus.cases.length, replayEligible: enabled, rejectReasons: Object.fromEntries(Object.entries(rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, 10)) }));
