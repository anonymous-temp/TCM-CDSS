// Medical Records 18,114 条现代医案 → T16 结构化评测语料（v4 flash，构建期专用）。
// 用法: DEEPSEEK_API_KEY=sk-... node scripts/ingest/medical-records-extract.mjs [并发] [起始行] [结束行]
//
// 源格式实测：一行一案（18,114 行 = 18,114 案），叙事体但高度稳定：
//   「X医生于<日期>初诊…<姓某>的<性别>患者…主诉是…舌质…脉象…分析认为…诊断为…采用<治则>…
//    开出了一剂由A、B、C组成的药方…共N剂…」
// 每 5 案打包一次调用（单案 ~560 字），输出 JSON 数组；解析失败的组自动拆成单案重试一次，
// 仍失败进复核队列，绝不静默吞掉。
//
// 对拍纪律（与方书批同构）：抽取出的每味药必须能在**原文行**内命中（带 T9 归一与尾字容差），
// 中医诊断名必须是原文子串；不过的案标 extractionVerified=false 进复核队列，不进语料。
// 脱敏：患者本已是「姓+某」；出生日期一律不抽取、不落地；就诊日期只保留到日（节气/季节
// 有临床意义）。医生姓名保留——那是经验来源署名，不是患者 PHI。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "中医补充数据/灵丹GitHub/Medical Records.txt");
const OUTDIR = resolve(ROOT, "artifacts/medical-records-extract");
mkdirSync(OUTDIR, { recursive: true });
const KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
if (!KEY) throw new Error("DEEPSEEK_API_KEY or OPENAI_API_KEY required");
const CONC = Number(process.argv[2] || 8);
const LINE_START = Number(process.argv[3] || 0);
const LINE_END = Number(process.argv[4] || 99999);
const PACK = 5;

const lines = readFileSync(SRC, "utf-8").split("\n");
const cases = [];
for (let i = 0; i < lines.length; i += 1) {
  const t = lines[i].trim();
  if (t.length < 50) continue; // 空行/残行不计入,但要在 summary 里报出来
  cases.push({ line: i + 1, text: t });
}
const target = cases.filter((c) => c.line > LINE_START && c.line <= LINE_END);
console.log(JSON.stringify({ totalLines: lines.length, usableCases: cases.length, skippedShort: lines.length - cases.length - 1, target: target.length }));

const SYSTEM = `你是中医医案结构化抽取器。输入若干条现代中医医案（每条以【案N】开头），对每条输出一个 JSON 对象，整体组成 JSON 数组，不要输出任何其他文字。
每条字段:
- caseNo: 案号（【案N】的 N，整数）
- physician: 医生姓名（无则 null）
- visitDate: 就诊日期 YYYY-MM-DD（推不出准确日则 null；绝不输出出生日期）
- patientSex: "男"/"女"/null
- patientAge: 就诊时年龄描述（如 "56岁"、"3个月"，推不出则 null）
- chiefComplaint: 主诉（≤60字，原文语义）
- fourExams: 刻下症+舌脉（≤120字）
- patternAnalysis: 辨证/病机分析（≤100字，无则 null）
- diagnosisTcm: 中医诊断病名（必须是原文出现的词）
- diagnosisWestern: 西医诊断（原文有才有，否则 null）
- treatmentPrinciple: 治则治法（无则 null）
- formulaName: 方剂名（经典方名或医家命名方；自拟无名单味组方则 null）
- herbs: [{"herb":"药名","dose":"原文剂量或null"}]，只含原文实际出现的药味
- course: 剂数/疗程/煎服法（≤60字，无则 null）
- outcome: 疗效/转归（原文有才有，≤60字，否则 null）
要求：只输出 JSON 数组；宁可字段为 null 也绝不凭记忆补充；数组长度必须等于输入案数。`;

async function callApi(user, attempt = 0) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0, max_tokens: 4000, thinking: { type: "disabled" }, stream: false,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    return callApi(user, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const lb = text.indexOf("["), rb = text.lastIndexOf("]");
  if (lb < 0 || rb < 0) throw new Error(`no json array: ${text.slice(0, 100)}`);
  return JSON.parse(text.slice(lb, rb + 1));
}

const t9 = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-herb-identity-catalog.json"), "utf-8"));
const ri = t9.resolutionIndex;
function herbInText(herb, text) {
  if (!herb) return false;
  if (text.includes(herb)) return true;
  for (const suf of ["子", "仁", "皮", "肉", "片", "炭", "末", "萸", "黄", "苓", "芍", "草", "参", "归", "芎", "朴", "芪", "桂", "母", "星", "夏", "枳", "姜", "枣"]) {
    if (herb.endsWith(suf) && text.includes(herb.slice(0, -1))) return true;
  }
  const v = ri[herb];
  if (v?.canonicalName && text.includes(v.canonicalName)) return true;
  if (herb.startsWith("熟地") && text.includes("熟地")) return true;
  return false;
}

const catalog = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8"));
const catalogNames = new Set((catalog.entries || []).map((e) => e.name));
for (const e of catalog.entries || []) for (const a of e.aliases || []) catalogNames.add(a);

function verifyOne(extracted, srcText) {
  const unmatchedHerbs = (extracted.herbs || [])
    .map((h) => String(h?.herb || "").trim())
    .filter((h) => h && !herbInText(h, srcText));
  const diag = String(extracted.diagnosisTcm || "").trim();
  const diagOk = !diag || srcText.includes(diag);
  return { unmatchedHerbs, diagOk, pass: unmatchedHerbs.length === 0 && diagOk };
}

const out = [];
const queue = [];
for (let i = 0; i < target.length; i += PACK) queue.push(target.slice(i, i + PACK));
let donePacks = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const pack = queue.shift();
    const user = pack.map((c, k) => `【案${k + 1}】(行${c.line})\n${c.text}`).join("\n\n");
    let arr = null;
    try {
      arr = await callApi(user);
      if (!Array.isArray(arr) || arr.length !== pack.length) throw new Error(`array length ${arr?.length} != ${pack.length}`);
    } catch {
      // 拆单案重试一次：打包解析失败不丢案
      arr = [];
      for (let k = 0; k < pack.length; k += 1) {
        try {
          const single = await callApi(`【案1】(行${pack[k].line})\n${pack[k].text}`);
          if (!Array.isArray(single) || single.length !== 1) throw new Error("single length");
          arr.push(single[0]);
        } catch {
          arr.push(null);
        }
      }
    }
    for (let k = 0; k < pack.length; k += 1) {
      const j = arr[k];
      if (!j || typeof j !== "object") {
        out.push({ line: pack[k].line, ok: false, error: "extract failed after single retry" });
        continue;
      }
      const v = verifyOne(j, pack[k].text);
      out.push({ line: pack[k].line, ok: true, verified: v.pass, unmatchedHerbs: v.unmatchedHerbs, diagOk: v.diagOk, extracted: j, sourceText: pack[k].text.slice(0, 200) });
    }
    donePacks += 1;
    if (donePacks % 50 === 0) console.log(JSON.stringify({ donePacks, of: Math.ceil(target.length / PACK), elapsedSec: Math.round((Date.now() - t0) / 1000) }));
  }
}));
out.sort((a, b) => a.line - b.line);
writeFileSync(resolve(OUTDIR, "cases-extracted.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
const stats = {
  total: out.length,
  ok: out.filter((r) => r.ok).length,
  verified: out.filter((r) => r.ok && r.verified).length,
  reviewUnmatched: out.filter((r) => r.ok && !r.verified).length,
  failed: out.filter((r) => !r.ok).length,
  withFormulaInCatalog: out.filter((r) => r.ok && r.verified && r.extracted.formulaName && catalogNames.has(String(r.extracted.formulaName).trim())).length,
};
writeFileSync(resolve(OUTDIR, "_summary.json"), JSON.stringify(stats, null, 2) + "\n");
console.log(JSON.stringify(stats));
