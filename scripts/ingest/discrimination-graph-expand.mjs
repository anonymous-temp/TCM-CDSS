// C1：方剂鉴别图谱（T14）扩展——节点（方证要点）+ 边（相邻方鉴别）。
// 通道：按方族聚类 → v4-pro 依据目录主治起草节点与鉴别边 → 确定性校验
// （方名⊆T8、supportTerms 患者可观察、边两端成对、与既有 77 边去重）
// → artifacts/discrimination-graph-expansion/{new-nodes.json,new-edges.json}
// 合并时由构建脚本续编 T14-NODE-### / T14-### 序号。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdjudicator, runPool, readCheckpoint } from "./deepseek-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");
const OUT = resolve(ROOT, "artifacts/discrimination-graph-expansion");
mkdirSync(OUT, { recursive: true });
const MAX_CLUSTERS = Number(process.env.MAX_CLUSTERS || 9999);

const graph = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-discrimination-graph.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-governed-catalog.json"), "utf-8"));
const byName = new Map(catalog.entries.map((e) => [e.name, e]));
const existingNodeNames = new Set(graph.nodes.map((n) => n.formulaName));
const existingPairs = new Set(graph.edges.map((e) => [e.from, e.to].sort().join("↔")));

const CLUSTERS = [
  { id: "buqi", title: "补气方族", formulas: ["四君子汤", "异功散", "六君子汤", "香砂六君子汤", "参苓白术散", "补中益气汤", "归脾汤", "生脉散", "玉屏风散"] },
  { id: "buxue", title: "补血方族", formulas: ["四物汤", "桃红四物汤", "八珍汤", "十全大补汤", "归脾汤", "炙甘草汤", "当归补血汤"] },
  { id: "xinliang", title: "辛凉解表方族", formulas: ["银翘散", "桑菊饮", "麻杏石甘汤", "升麻葛根汤", "柴葛解肌汤", "葱豉桔梗汤"] },
  { id: "hejie", title: "和解方族", formulas: ["小柴胡汤", "大柴胡汤", "逍遥散", "丹栀逍遥散", "半夏泻心汤", "甘草泻心汤", "生姜泻心汤", "痛泻要方"] },
  { id: "qingre", title: "清热泻火方族", formulas: ["白虎汤", "竹叶石膏汤", "黄连解毒汤", "凉膈散", "清胃散", "泻白散", "导赤散", "龙胆泻肝汤", "左金丸", "玉女煎"] },
  { id: "wenli", title: "温里方族", formulas: ["理中丸", "附子理中丸", "小建中汤", "黄芪建中汤", "吴茱萸汤", "大建中汤", "四逆汤", "当归四逆汤"] },
  { id: "qushi", title: "祛湿方族", formulas: ["平胃散", "藿香正气散", "三仁汤", "甘露消毒丹", "藿朴夏苓汤", "茵陈蒿汤", "八正散", "五苓散", "猪苓汤", "防己黄芪汤", "羌活胜湿汤"] },
  { id: "huatan", title: "化痰止咳方族", formulas: ["二陈汤", "温胆汤", "清气化痰丸", "半夏白术天麻汤", "止嗽散", "三子养亲汤", "小青龙汤", "射干麻黄汤"] },
  { id: "liqi", title: "理气方族", formulas: ["柴胡疏肝散", "四逆散", "越鞠丸", "金铃子散", "厚朴温中汤", "天台乌药散", "苏子降气汤", "定喘汤", "旋覆代赭汤"] },
  { id: "lixue", title: "理血方族", formulas: ["桃核承气汤", "血府逐瘀汤", "补阳还五汤", "复元活血汤", "温经汤", "生化汤", "失笑散", "桂枝茯苓丸", "黄土汤", "槐花散"] },
  { id: "anshen", title: "安神方族", formulas: ["酸枣仁汤", "天王补心丹", "朱砂安神丸", "甘麦大枣汤", "交泰丸"] },
  { id: "kaiqiao-xifeng", title: "开窍与息风方族", formulas: ["安宫牛黄丸", "紫雪丹", "至宝丹", "苏合香丸", "羚角钩藤汤", "镇肝熄风汤", "天麻钩藤饮", "大定风珠"] },
  { id: "xiaoshi-guse", title: "消食与固涩方族", formulas: ["保和丸", "枳实导滞丸", "健脾丸", "木香槟榔丸", "四神丸", "真人养脏汤", "金锁固精丸", "桑螵蛸散", "完带汤", "易黄汤"] },
  { id: "wenbing", title: "温病方族", formulas: ["清营汤", "犀角地黄汤", "清瘟败毒饮", "普济消毒饮", "达原饮", "升降散", "新加香薷饮", "清暑益气汤", "青蒿鳖甲汤", "黄连阿胶汤"] },
  { id: "fuke-erke", title: "妇科儿科常用方族", formulas: ["温经汤", "胶艾汤", "固冲汤", "完带汤", "寿胎丸", "七味白术散", "泻黄散", "导赤散", "异功散"] },
];

const SYS = `你是中医方证鉴别图谱编纂专家。为一个方族编写「鉴别图谱」：节点=每首方的方证要点；边=两首易混方之间的鉴别。
输出 JSON：{"nodes":[...],"edges":[...]}。
节点格式：{"formulaName":"方名","pattern":"核心方证（主症+舌脉+治法，≤40字）","supportTerms":["3-8个患者可观察的支持词（症状/舌/脉）"],"discriminator":"与本族他方的分水岭（≤40字）","safetyClass":"standard|restricted"}
边格式：{"from":"方A","to":"方B","discriminator":"一句话鉴别点","discriminatingSymptom":"关键鉴别症状对（如 有汗/无汗）","questionText":"当前阳性事实更支持「A的方证」，还是「B的方证」？","sides":{"from":{"supportTerms":["3-6词"],"againstTerms":["3-6词"]},"to":{"supportTerms":["3-6词"],"againstTerms":["3-6词"]}}}
铁律：
1. 只使用所附清单内的方名；每个 supportTerm 必须是患者层面可观察表现（症状、舌、脉），不得用治法词、药名、篇名。
2. 边的两端必须成对互补：from 的 supportTerms 指向 A 方证，againstTerms 指向 B 方证的反向表现。
3. 鉴别点必须来自所附主治摘要的临床含义，不得凭方名想象；摘要读不出鉴别点的配对不写。
4. 已有的节点/边不要重复（清单已标注）。只输出 JSON。`;

async function handleCluster(cluster) {
  const rows = cluster.formulas
    .map((name) => {
      const f = byName.get(name);
      if (!f) return null;
      return {
        name,
        indications: (f.indications || "").slice(0, 150),
        ingredients: (f.ingredients || []).slice(0, 10),
        alreadyNode: existingNodeNames.has(name),
      };
    })
    .filter(Boolean);
  if (rows.length < 3) return { nodes: [], edges: [] };
  const user = [
    `方族：${cluster.title}`,
    `请为其中尚无节点的方编写节点（alreadyNode=false 的），并为族内易混方对编写 3-6 条鉴别边。`,
    `已有鉴别边（不得重复）：${graph.edges.filter((e) => cluster.formulas.includes(e.from) || cluster.formulas.includes(e.to)).map((e) => `${e.from}↔${e.to}`).join("、") || "无"}`,
    `\n【方与主治摘要】\n${JSON.stringify(rows, null, 1)}`,
  ].join("\n");
  return callAdjudicator({ system: SYS, user, maxTokens: 12000, format: "object" });
}

await runPool({
  items: CLUSTERS.slice(0, MAX_CLUSTERS),
  keyOf: (c) => c.id,
  workers: 3,
  checkpointPath: resolve(OUT, "checkpoint.jsonl"),
  handle: handleCluster,
});

// 汇总校验
const cp = readCheckpoint(resolve(OUT, "checkpoint.jsonl"));
const nodeNames = new Set(existingNodeNames);
const pairSet = new Set(existingPairs);
const newNodes = [];
const newEdges = [];
const rejects = [];
const termOk = (t) => typeof t === "string" && t.trim().length >= 2 && t.trim().length <= 10;
for (const [clusterId, record] of cp) {
  if (!record.ok) { rejects.push({ clusterId, error: record.error }); continue; }
  const draft = record.result || {};
  for (const node of draft.nodes || []) {
    const name = node.formulaName;
    if (!byName.has(name)) { rejects.push({ clusterId, node: name, reason: "目录外方名" }); continue; }
    if (nodeNames.has(name)) continue;
    const terms = [...new Set((node.supportTerms || []).filter(termOk))];
    if (terms.length < 3) { rejects.push({ clusterId, node: name, reason: "supportTerms 不足" }); continue; }
    if (!node.pattern || String(node.pattern).length < 8) { rejects.push({ clusterId, node: name, reason: "pattern 过短" }); continue; }
    newNodes.push({
      formulaName: name,
      formulaAliases: [],
      pattern: String(node.pattern).slice(0, 60),
      supportTerms: terms.slice(0, 8),
      discriminator: String(node.discriminator || "").slice(0, 60),
      safetyClass: node.safetyClass === "restricted" ? "restricted" : "standard",
      sourceRefs: ["ADJ-20260727-T14-GRAPH-EXPANSION"],
    });
    nodeNames.add(name);
  }
  for (const edge of draft.edges || []) {
    const pair = [edge.from, edge.to].sort().join("↔");
    if (!byName.has(edge.from) || !byName.has(edge.to)) { rejects.push({ clusterId, edge: pair, reason: "目录外方名" }); continue; }
    if (edge.from === edge.to) continue;
    if (pairSet.has(pair)) continue;
    const sf = [...new Set((edge.sides?.from?.supportTerms || []).filter(termOk))];
    const st = [...new Set((edge.sides?.to?.supportTerms || []).filter(termOk))];
    if (sf.length < 3 || st.length < 3) { rejects.push({ clusterId, edge: pair, reason: "两端 supportTerms 不足" }); continue; }
    if (!edge.questionText || String(edge.questionText).length < 12) { rejects.push({ clusterId, edge: pair, reason: "questionText 过短" }); continue; }
    newEdges.push({
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
    pairSet.add(pair);
  }
}
writeFileSync(resolve(OUT, "new-nodes.json"), JSON.stringify(newNodes, null, 2) + "\n");
writeFileSync(resolve(OUT, "new-edges.json"), JSON.stringify(newEdges, null, 2) + "\n");
writeFileSync(resolve(OUT, "rejected.json"), JSON.stringify(rejects, null, 2) + "\n");
console.log(JSON.stringify({ newNodes: newNodes.length, newEdges: newEdges.length, rejects: rejects.length }));
