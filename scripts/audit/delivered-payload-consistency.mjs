// 交付载荷自洽审计（第五十三轮）。甲方读的是原始 JSON；我们的评审面板与 1.1 打分只看渲染后的文字，于是「同一件事两个模块各算一份」
// 「推出来的字段不随交付内容更新」「病历写了却报缺」这三类长期没人看见。本脚本只读已保存的链路输出（regress-customer-shape 的
// <outDir>/*.json），逐条核：
//   P1 处方药味写「身份待核/剂量来源无」而剂量层查得到该药的用量（两个解析器不一致）
//   P2 药名写着炮制（土炒白术）而炮制栏空着
//   P3 加减核对统计与交付的加减条数、删除原因合计对不上
//   P4 加减的 triggerSource 引用在交付内容里落空
//   P5 「本例已见」后带病程
//   P6 闸门报缺舌象/脉象/儿童体重而病历（含追问作答）写着
//   P7 无剂量页
// 用法：node scripts/audit/delivered-payload-consistency.mjs <outDir> [<outDir>…]   （REPO= 指定被审代码树，默认当前目录）
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const repo = process.env.REPO || process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${repo}/src`, "server-only": `${repo}/node_modules/next/dist/compiled/server-only/empty.js` } });
const kb = await jiti.import(`${repo}/src/lib/tcm-knowledge.ts`);
const identity = await jiti.import(`${repo}/src/lib/tcm-herb-identity.ts`);

const PREFIXES = [...identity.governedHerbPreparationPrefixes()];
const COURSE_TAIL = /(?:反复|持续|间断)?(?:\d+(?:\.\d+)?|[一二三四五六七八九十两半]+|X{2,})\s*(?:余|多)?\s*(?:个)?(?:天|日|周|月|年)(?:余|多)?$/u;
const pointer = (root, ref) => {
  const [p] = String(ref || "").split(":");
  return p.replace(/\[(\d+)\]/gu, ".$1").split(".").filter(Boolean).reduce((cursor, key) => (cursor == null ? undefined : Array.isArray(cursor) ? cursor[Number(key)] : cursor[key]), root);
};
const recordText = (input = {}) => JSON.stringify({ cc: input.chiefComplaint, s: input.symptoms, t: input.tongue, p: input.pulse, h: input.hisRecord, u: (input.conversation || []).filter((m) => (m.role || m.Role) === "user").map((m) => m.content || m.Content) });

function auditOne(output) {
  const hits = [];
  const rx = output?.prescribe?.structured;
  const formula = rx?.formula;
  if (output?.prescribe && !(formula?.candidates?.[0]?.herbs || []).some((herb) => /\d/u.test(String(herb.dose || "")))) hits.push({ code: "P7", detail: "无剂量页" });
  for (const herb of formula?.candidates?.[0]?.herbs || []) {
    const name = String(herb.name || "");
    if ((herb.verificationTier === "identity_pending" || herb.doseSource === "none") && kb.getTcmHerbDoseLimit(name)) hits.push({ code: "P1", detail: name });
    if (!String(herb.processing || "").trim()) {
      const id = identity.resolveGovernedTcmHerbIdentity(name);
      const base = id.canonicalName;
      if (base && base !== name && name.endsWith(base) && PREFIXES.includes(name.slice(0, name.length - base.length))) hits.push({ code: "P2", detail: name });
    }
  }
  const rows = formula?.modifications || [];
  const review = formula?.modificationReview;
  if (review) {
    const reasons = (review.droppedReasons || []).reduce((sum, item) => sum + Number(item.count || 0), 0);
    if (review.retainedCount !== rows.length || review.droppedCount !== reasons || review.submittedCount !== review.retainedCount + review.droppedCount) {
      hits.push({ code: "P3", detail: `交付${rows.length}条 统计${review.submittedCount}/${review.retainedCount}/${review.droppedCount} 原因合计${reasons}` });
    }
  }
  for (const row of rows) {
    const source = row.triggerSource;
    if (source) {
      const target = pointer(rx, source.sourceRef);
      if (typeof target !== "string" || !target.includes(String(source.sourceQuote || ""))) hits.push({ code: "P4", detail: `${row.trigger} → ${source.sourceRef}` });
    }
    if (/^本例已见/u.test(String(row.trigger || "")) && COURSE_TAIL.test(String(row.trigger))) hits.push({ code: "P5", detail: row.trigger });
  }
  const codes = output?.redFlags?.missingItemCodes || output?.redFlags?.safetyGate?.missingItemCodes || [];
  const text = recordText(output?.input);
  if (codes.includes("tongue_unknown") && /舌[质体象苔]?\s*[:：]?\s*(?:淡|红|暗|紫|胖|瘦|薄|厚|白|黄|腻)/u.test(text)) hits.push({ code: "P6", detail: "舌象" });
  if (codes.includes("pulse_unknown") && /脉[象]?\s*[:：]?\s*(?:浮|沉|迟|数|弦|滑|细|弱|缓|涩|紧|濡|洪)/u.test(text)) hits.push({ code: "P6", detail: "脉象" });
  if (codes.includes("pediatric_weight_unknown") && /(?:体重|(?<![A-Za-z])(?:W|Wt|BW))\s*[:：]?\s*\d{1,3}(?:\.\d+)?\s*(?:kg|公斤|千克)/iu.test(text)) hits.push({ code: "P6", detail: "体重" });
  return hits;
}

const summary = {};
for (const dir of process.argv.slice(2)) {
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  const counts = { outputs: 0 };
  const examples = {};
  for (const file of files) {
    let output;
    try { output = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { continue; }
    if (!output?.prescribe && !output?.redFlags) continue;
    counts.outputs += 1;
    const seen = new Set();
    for (const hit of auditOne(output)) {
      if (!seen.has(hit.code)) counts[hit.code] = (counts[hit.code] || 0) + 1;
      seen.add(hit.code);
      (examples[hit.code] ||= []).length < 5 && examples[hit.code].push(`${file}: ${hit.detail}`);
    }
  }
  summary[path.basename(dir)] = { counts, examples };
}
console.log(JSON.stringify(summary, null, 1));
