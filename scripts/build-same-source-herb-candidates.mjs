// 生成同源饮片候选对（第五十七轮，2026-11-23）：scripts/fixtures/same-source-herb-candidates.json。
//
// 用法：
//   npx jiti scripts/build-same-source-herb-candidates.mjs          重新生成并写盘
//   npx jiti scripts/build-same-source-herb-candidates.mjs --check  只比较，不一致时非零退出（闸门测试同一判据）
//
// 规则见 scripts/lib/same-source-herb-candidates.mjs。候选对必须在 src/data/tcm-same-source-herbs.source.json 的
// groups / sameOriginDistinctUse / notRelated 三类里各归一处（test:r1075-same-source-herbs）。
// 语料（中医补充数据/…/TCM Educational Materials.txt）不进镜像；没有语料的机器上只能 --check 构词部分，教材部分沿用已提交的结果。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { buildSameSourceHerbCandidates, extractTextbookMaterialRecords, extractTextbookOriginStatements, TEXTBOOK_CORPUS_REF } from "./lib/same-source-herb-candidates.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
export const CANDIDATES_PATH = path.join(root, "scripts/fixtures/same-source-herb-candidates.json");

/** 系统可开饮片的原始名单：知识库各药、常用药、身份目录标准名、药典外参考用量表。 */
export function prescribableNameSources() {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const knowledge = read("src/data/tcm-knowledge.json");
  const catalog = read("src/data/tcm-herb-identity-catalog.json");
  const reference = read("src/data/tcm-herb-nonpharmacopoeia-dose.source.json");
  return [
    ...knowledge.herbs.map((item) => item.name),
    ...(knowledge.commonHerbs || []).map((item) => item.name),
    ...catalog.entries.map((item) => item.standardName),
    ...(reference.entries || []).map((item) => item.name || item.herb),
  ].filter(Boolean);
}

export async function loadIdentityFunctions() {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    alias: { "@": path.join(root, "src"), "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") },
  });
  const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
  const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");
  const identity = await jiti.import("../src/lib/tcm-herb-identity.ts");
  const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
  return {
    canonical: contract.canonicalTcmHerbIdentity,
    known: knowledge.isKnownTcmHerbName,
    ambiguous: (name) => identity.resolveGovernedTcmHerbIdentity(name).status === "ambiguous",
    // 同一味药的不同炮制品（compositionIdentityName 相同）归 sameDrugDifferentProcessing 判定。
    sameDrug: (left, right) => {
      const a = provenance.compositionIdentityName(left);
      return Boolean(a) && a === provenance.compositionIdentityName(right);
    },
    // 系统能开出剂量或交医生定量的饮片：有剂量依据（药典或参考用量）、或在医生定量政策表里。
    prescribable: (name) => Boolean(knowledge.getTcmHerbDoseLimit(name) || knowledge.clinicianDoseHerbClass(name)),
  };
}

export function readCorpusLines() {
  // SAME_SOURCE_HERB_CORPUS=none 模拟没有语料的机器（核对无语料路径用）。
  if (process.env.SAME_SOURCE_HERB_CORPUS === "none") return undefined;
  const corpusPath = process.env.SAME_SOURCE_HERB_CORPUS || path.join(root, TEXTBOOK_CORPUS_REF);
  if (!fs.existsSync(corpusPath)) return undefined;
  const buffer = fs.readFileSync(corpusPath);
  return { lines: buffer.toString("utf8").split("\n"), sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

export async function computeSameSourceHerbCandidates() {
  const identity = await loadIdentityFunctions();
  const corpus = readCorpusLines();
  const committed = fs.existsSync(CANDIDATES_PATH) ? JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf8")) : undefined;
  // 没有语料时沿用已提交的教材记录（名称、行号、学名、所挂正药），只重算身份映射与构词候选。
  const records = corpus
    ? extractTextbookMaterialRecords(corpus.lines).map((record) => ({ ...record }))
    : (committed?.textbookRecords || []).map((record) => ({ name: record.name, line: record.line, parent: record.parentName, source: record.source }));
  const statements = corpus ? extractTextbookOriginStatements(corpus.lines) : (committed?.textbookStatements || []);
  const built = buildSameSourceHerbCandidates({ records, statements, names: prescribableNameSources(), ...identity });
  return {
    corpusAvailable: Boolean(corpus),
    output: {
      schemaVersion: "tcm-same-source-herb-candidates-v1",
      generatedBy: "scripts/build-same-source-herb-candidates.mjs",
      note: "生成物，勿手改。每一对都须在 tcm-same-source-herbs.source.json 的 groups / sameOriginDistinctUse / notRelated 里各归一处。bases: species=教材来源句拉丁学名相同；attached=教材附药；derived=来源句写明由另一味制得；statement=教材【鉴别用药】明说同出一物；name=药名构词同干。",
      source: { file: TEXTBOOK_CORPUS_REF, sha256: corpus ? corpus.sha256 : committed?.source?.sha256 || null, lines: "151400-161000" },
      universeCount: built.universe.length,
      textbookRecords: records
        .map((record) => {
          const resolved = built.records.find((item) => item.line === record.line && item.name === record.name);
          return resolved ? { name: record.name, identity: resolved.identity, line: record.line, ...(record.parent ? { parentName: record.parent } : {}), source: resolved.source } : undefined;
        })
        .filter(Boolean),
      textbookStatements: statements,
      candidates: built.candidates,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { output, corpusAvailable } = await computeSameSourceHerbCandidates();
  const text = `${JSON.stringify(output, null, 1)}\n`;
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(CANDIDATES_PATH) ? fs.readFileSync(CANDIDATES_PATH, "utf8") : "";
    if (current !== text) {
      console.error(`候选对与已提交的 ${path.relative(root, CANDIDATES_PATH)} 不一致${corpusAvailable ? "" : "（本机无教材语料，只重算了构词部分）"}：请重跑本脚本并逐对归类。`);
      process.exit(1);
    }
    console.log(`候选对一致：${output.candidates.length} 对（身份 ${output.universeCount} 个${corpusAvailable ? "" : "；无语料"}）`);
  } else {
    fs.writeFileSync(CANDIDATES_PATH, text);
    console.log(`写入 ${path.relative(root, CANDIDATES_PATH)}：${output.candidates.length} 对，身份 ${output.universeCount} 个，教材记录 ${output.textbookRecords.length} 条`);
  }
}
