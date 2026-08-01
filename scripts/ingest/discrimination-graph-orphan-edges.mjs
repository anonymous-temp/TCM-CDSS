// C1 补边：为鉴别图谱中尚无连接的 6 个节点补鉴别边（治理要求：每个节点至少一条边）。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdjudicator } from "./deepseek-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");

const graph = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-discrimination-graph.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-governed-catalog.json"), "utf-8"));
const byName = new Map(catalog.entries.map((e) => [e.name, e]));

const ORPHANS = ["甘草泻心汤", "三子养亲汤", "失笑散", "桂枝茯苓丸", "普济消毒饮", "升降散"];
const NEIGHBORS = {
  甘草泻心汤: ["半夏泻心汤", "生姜泻心汤", "黄连汤"],
  三子养亲汤: ["二陈汤", "止嗽散", "苏子降气汤"],
  失笑散: ["桂枝茯苓丸", "桃红四物汤", "生化汤"],
  桂枝茯苓丸: ["失笑散", "温经汤", "生化汤", "桃红四物汤"],
  普济消毒饮: ["清瘟败毒饮", "升降散", "银翘散"],
  升降散: ["达原饮", "普济消毒饮", "清瘟败毒饮"],
};

const SYS = `你是中医方证鉴别图谱编纂专家。为指定的「孤儿方」与相邻方编写鉴别边。
输出 JSON 数组，每条：{"from":"方A","to":"方B","discriminator":"一句话鉴别点","discriminatingSymptom":"关键鉴别症状对","questionText":"当前阳性事实更支持「A的方证」，还是「B的方证」？","sides":{"from":{"supportTerms":["3-6词"],"againstTerms":["3-6词"]},"to":{"supportTerms":["3-6词"],"againstTerms":["3-6词"]}}}
铁律：只用所附清单内方名；supportTerm 必须是患者可观察表现（症状/舌/脉），不得用治法词、药名；鉴别点必须来自所附主治摘要的临床含义；每条边两端成对互补。只输出 JSON 数组。`;

const rows = [];
for (const name of [...ORPHANS, ...new Set(Object.values(NEIGHBORS).flat())]) {
  const f = byName.get(name);
  if (f) rows.push({ name, indications: (f.indications || "").slice(0, 150), ingredients: (f.ingredients || []).slice(0, 10) });
}
const tasks = ORPHANS.map((name) => ({ orphan: name, neighbors: NEIGHBORS[name] }));
const user = `请为以下 ${tasks.length} 首孤儿方各写 1–2 条鉴别边（与所给相邻方配对）：\n${JSON.stringify(tasks, null, 1)}\n\n【方与主治摘要】\n${JSON.stringify(rows, null, 1)}`;
const draft = await callAdjudicator({ system: SYS, user, maxTokens: 12000 });

const existingPairs = new Set(graph.edges.map((e) => [e.from, e.to].sort().join("↔")));
const termOk = (t) => typeof t === "string" && t.trim().length >= 2 && t.trim().length <= 10;
const accepted = [];
for (const edge of draft) {
  const pair = [edge.from, edge.to].sort().join("↔");
  if (!byName.has(edge.from) || !byName.has(edge.to) || edge.from === edge.to) continue;
  if (existingPairs.has(pair)) continue;
  const sf = [...new Set((edge.sides?.from?.supportTerms || []).filter(termOk))];
  const st = [...new Set((edge.sides?.to?.supportTerms || []).filter(termOk))];
  if (sf.length < 3 || st.length < 3) continue;
  if (!edge.questionText || String(edge.questionText).length < 12) continue;
  accepted.push({
    from: edge.from,
    to: edge.to,
    discriminator: String(edge.discriminator || "").slice(0, 60),
    discriminatingSymptom: String(edge.discriminatingSymptom || edge.discriminator || "").slice(0, 60),
    questionText: String(edge.questionText),
    sides: {
      from: { supportTerms: sf.slice(0, 6), againstTerms: [...new Set((edge.sides?.from?.againstTerms || []).filter(termOk))].slice(0, 6) },
      to: { supportTerms: st.slice(0, 6), againstTerms: [...new Set((edge.sides?.to?.againstTerms || []).filter(termOk))].slice(0, 6) },
    },
    sourceRefs: ["ADJ-20260727-T14-GRAPH-EXPANSION"],
  });
  existingPairs.add(pair);
}
// 每个孤儿必须至少一条
const covered = new Set(accepted.flatMap((e) => [e.from, e.to]));
const missing = ORPHANS.filter((n) => !covered.has(n));
if (missing.length) throw new Error(`仍有孤儿未补边：${missing.join("、")}`);

const ext = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-discrimination-extensions.source.json"), "utf-8"));
ext.edges.push(...accepted);
writeFileSync(resolve(DATA, "tcm-formula-discrimination-extensions.source.json"), JSON.stringify(ext, null, 2) + "\n");
console.log(JSON.stringify({ added: accepted.length, perOrphan: ORPHANS.map((n) => `${n}:${accepted.filter((e) => e.from === n || e.to === n).length}`) }));
