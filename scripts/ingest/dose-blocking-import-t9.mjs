// 剂量阻断药名裁定 → T9 身份补充表导入。
// 通道:tcm-herb-identity-supplements.json(生地黄先例:{inputName,canonicalName,doseCanonicalName,autoResolvable})。
// 纪律:blank 不进;excipient(白蜜→蜂蜜)身份归一但 autoResolvable=false(赋形语义不属饮片煎服);
// adjust 项按 T9/knowledge 实际正形落(延胡索→延胡索（元胡）;皂矾→皂矾（绿矾）;熟大黄/鲜地黄/酒萸肉/姜炭
// 自为正名、doseCanonicalName 指到药典有量的基名)。药典剂量背书缺失的一律不进(保持阻断)。
// 用法: node scripts/ingest/dose-blocking-import-t9.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTDIR = resolve(ROOT, "artifacts/dose-blocking-adjudication");
const SUPP = resolve(ROOT, "src/data/tcm-herb-identity-supplements.json");

const adjudicated = JSON.parse(readFileSync(resolve(OUTDIR, "adjudicated.json"), "utf-8"));
const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
const compact = (v) => String(v || "").replace(/\s+/g, "");

// knowledge 药典剂量名集合(与构建同口径)
const know = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-knowledge.json"), "utf-8"));
const PHARM = /药典|中华人民共和国药典|中国药典/;
const dosed = new Set();
for (const herb of know.herbs || []) {
  for (const entry of herb.entries || []) {
    const mn = Number(entry.minG), mx = Number(entry.maxG);
    if (!(mn > 0) || !(mx >= mn)) continue;
    if (!PHARM.test(compact(entry.basis))) continue;
    if (["dose", "curatedDose"].includes(entry.type)) dosed.add(compact(herb.name));
  }
}

// adjust 项的落地映射(T9/knowledge 实测):鲜地黄剂量=药典地黄 12-30g,熟大黄=大黄 3-15g,
// 酒萸肉=山茱萸 6-12g,姜炭=炮姜 3-9g,延胡索系=延胡索（元胡） 3-10g。
const CANON_FIX = {
  延胡索: { canonicalName: "延胡索（元胡）", doseCanonicalName: "延胡索（元胡）" },
  玄胡: { canonicalName: "延胡索（元胡）", doseCanonicalName: "延胡索（元胡）" },
  醋延胡索: { canonicalName: "延胡索（元胡）", doseCanonicalName: "延胡索（元胡）", preparation: "醋制" },
  熟大黄: { canonicalName: "熟大黄", doseCanonicalName: "大黄" },
  鲜生地: { canonicalName: "鲜地黄", doseCanonicalName: "地黄" },
  酒萸肉: { canonicalName: "酒萸肉", doseCanonicalName: "山茱萸" },
  炮姜炭: { canonicalName: "姜炭", doseCanonicalName: "炮姜" },
};

const supp = JSON.parse(readFileSync(SUPP, "utf-8"));
const entries = supp.entries || (supp.entries = []);
const existing = new Set(entries.map((e) => e.inputName));
const report = { adopted: 0, excipientHeld: 0, blankSkipped: 0, doseBlocked: 0, dup: 0, rows: [] };
for (const o of adjudicated) {
  if (!o.ok || o.decision === "blank") { report.blankSkipped++; continue; }
  if (existing.has(o.name)) { report.dup++; continue; }
  const fix = CANON_FIX[o.name] || {};
  let canonical = fix.canonicalName || o.standardName;
  // 若标准名在 T9 里可解(如 皂矾→皂矾（绿矾）),用 T9 canonical
  const v = ri[o.standardName] || ri[canonical];
  if (!fix.canonicalName && v?.canonicalName && v.autoResolvable) canonical = v.canonicalName;
  const doseName = fix.doseCanonicalName || canonical;
  if (!dosed.has(compact(doseName))) {
    report.doseBlocked++;
    report.rows.push({ name: o.name, hold: `无药典剂量背书:${doseName}` });
    continue;
  }
  const isExcipient = o.riskClass === "excipient";
  entries.push({
    inputName: o.name,
    canonicalName: canonical,
    doseCanonicalName: doseName,
    ...(fix.preparation ? { preparation: fix.preparation } : {}),
    autoResolvable: !isExcipient,
    note: `中医师裁定(2026-07-26):${o.evidence}${isExcipient ? "【赋形/外用载体为主,身份归一但保持剂量阻断】" : ""}`,
    batch: "ADJ-20260726-DOSE-BLOCKING",
  });
  if (isExcipient) report.excipientHeld++; else report.adopted++;
}
writeFileSync(SUPP, JSON.stringify(supp, null, 2) + "\n");
console.log(JSON.stringify({ ...report, totalEntries: entries.length }));
