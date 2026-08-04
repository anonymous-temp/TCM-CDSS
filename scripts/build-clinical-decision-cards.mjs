// 甲方「中医相关卡片」临床决策卡片结构化构建脚本。
//
// 输入:artifacts/drive-clinical-cards/*.md(Google Drive 共享文件夹「中医相关卡片」原样下载)
// 输出:src/data/tcm-clinical-decision-cards.source.json
//
// 定性(决定接入方式,不得拔高):
//   这批卡片是**厂商编写的二次综述型决策参考**,不是受治理规则。每份都带「参考文献」段
//   (作者;题名[J]. 期刊,年份),但**全库 0 条 DOI、0 条 PMID**,绝大多数无 URL —— 引文
//   人工可查、机器不可核验。卡片自述的底层证据强度也普遍偏低(「单中心、小样本 RCT」
//   「方法学质量普遍偏低,存在发表偏倚」「证据等级为中等」)。因此 evidenceTier 统一记为
//   expert_decision_reference,并附**可计算的**取证标记(referenceCount /
//   hasPersistentIdentifier / containsDoseLevelContent …),让等级判断本身可被测试复核,
//   而不是靠一句散文断言。
//
// 关联字段的纪律:relatedFormulas / relatedSyndromes 只允许写**受治理目录里真实存在**的名字。
//   - 方名:走项目自有权威识别器 identifyKnownFormulaNames(tcm-formula-provenance.ts),
//     再与受治理方剂目录 tcm-formula-governed-catalog.json 求交,并用 GB/T 治法术语做重叠否决
//     (「清热解毒散结」里的“解毒散”、「活血散瘀」里的“活血散”属于治法吸收,不是方名)。
//   - 证候:按 GB/T 16751.2-2021 证候类术语做最长匹配,再经 canonicalTcmSyndromeTerm 归一;
//     归一不掉的一律丢弃。
//   - 「参考文献」段不参与关联抽取 —— 期刊题名里的方名是别人的研究对象,不是本卡片的临床主张。
//   匹配不到就留空。宁可漏,不可臆造。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../src", import.meta.url).pathname } });

const CARD_DIR = new URL("../artifacts/drive-clinical-cards/", import.meta.url);
const OUTPUT = new URL("../src/data/tcm-clinical-decision-cards.source.json", import.meta.url);

const DRIVE_FOLDER = "Google Drive 共享文件夹「中医相关卡片」(甲方提供)";
const EVIDENCE_TIER = "expert_decision_reference";

const { identifyKnownFormulaNames } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { treatmentPrinciplesInText, canonicalTcmSyndromeTerm } = await jiti.import("../src/lib/clinical-governance-tables.ts");
const { canonicalTcmDiseaseName } = await jiti.import("../src/lib/clinical-terminology.ts");

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

// ---------- 受治理目录:方名 / 证候 / 病名 ----------
const governedCatalog = readJson("../src/data/tcm-formula-governed-catalog.json");
// 只认治理层判定「可被检索召回」的方剂条目。retrievalEligible=false 的条目(如《惠直堂经验方》
// 健脾方)本就不允许被检索层surfaced,卡片里的“健脾方”那类通用说法更不该绑到它头上。
const governedFormulaNames = new Set();
for (const entry of governedCatalog.entries) {
  if (entry.retrievalEligible !== true) continue;
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    if (typeof name === "string" && name.trim()) governedFormulaNames.add(name.trim());
  }
}

const syndromeLexicon = readJson("../src/data/tcm-syndrome-lexicon.json");
// 只取证候类术语里的**临床术语**。GB/T 16751.2 里还混着「期度类术语」(如“发作期”)这类非证候
// 条目,以及 category_term 层的分类伞名(“气滞”“血瘀”“实”“络脉”)—— 后者是分类节点而非可用于
// 辨证结论的证名,作为卡片索引提示价值低且噪声大,一并排除。
const syndromeSurfaceForms = [];
for (const entry of syndromeLexicon.entries) {
  if (entry.termClass !== "clinical_term") continue;
  if (!String(entry.category || "").includes("证候")) continue;
  for (const form of [entry.canonical, entry.standardTerm, ...(entry.aliases || []), ...(entry.standardAliases || [])]) {
    if (typeof form === "string" && form.length >= 2) syndromeSurfaceForms.push(form);
  }
}
const syndromeFormSet = new Set(syndromeSurfaceForms);
const syndromeFormsByLength = [...syndromeFormSet].sort((a, b) => b.length - a.length);
const maxSyndromeFormLength = syndromeFormsByLength[0]?.length || 0;

const diseaseLexicon = readJson("../src/data/tcm-disease-lexicon.json");
const diseaseForms = new Set();
for (const entry of diseaseLexicon.entries) {
  for (const form of [entry.canonical, ...(entry.aliases || [])]) {
    if (typeof form === "string" && form.length >= 2) diseaseForms.add(form);
  }
}
const diseaseFormsByLength = [...diseaseForms].sort((a, b) => b.length - a.length);

// ---------- Markdown 解析 ----------
const HEADING = /^(#{1,4})\s*(.+?)\s*$/;
const BOLD_LABEL = /^\*\*([^*]{2,24})\*\*\s*$/;
const BOLD_LABEL_LEVEL = 5;

function parseSections(text) {
  const sections = [];
  let heading = "";
  let level = 0;
  let buffer = [];
  const flush = () => {
    const body = buffer.join("\n").trim();
    if (heading || body) sections.push({ heading, level, body });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const hash = line.match(HEADING);
    const bold = hash ? null : line.match(BOLD_LABEL);
    if (hash || bold) {
      flush();
      heading = (hash ? hash[2] : bold[1]).trim();
      level = hash ? hash[1].length : BOLD_LABEL_LEVEL;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

// 取整节内容:命中的标题 + 其下所有更深层级的小节。卡片普遍在「### 决策依据」下直接排
// 「**1. 病机演变逻辑**」这类粗体小标题,只取命中标题自身的 body 会得到空串。
function sectionBody(sections, keyword) {
  const parts = [];
  for (let index = 0; index < sections.length; index += 1) {
    if (!sections[index].heading.includes(keyword)) continue;
    parts.push(sections[index].body);
    for (let next = index + 1; next < sections.length && sections[next].level > sections[index].level; next += 1) {
      parts.push(sections[next].heading, sections[next].body);
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

function cardTitle(sections, text, fileStem) {
  const explicit = sectionBody(sections, "标题");
  if (explicit) return explicit.split("\n").map((line) => line.trim()).filter(Boolean)[0] || fileStem;
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fileStem;
}

const collapse = (value) => value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// ---------- 关联抽取 ----------
function treatmentPrincipleSpans(text) {
  const spans = [];
  for (const principle of treatmentPrinciplesInText(text) || []) {
    for (const form of [principle.canonical, principle.standardTerm, ...(principle.aliases || []), ...(principle.standardAliases || [])]) {
      if (typeof form !== "string" || form.length < 2) continue;
      let index = text.indexOf(form);
      while (index >= 0) {
        spans.push([index, index + form.length]);
        index = text.indexOf(form, index + 1);
      }
    }
  }
  return spans;
}

// 方名歧义否决(全部由受治理词表派生,不含手写词表):
//   ① 长度 <3 的方名一律不采信 ——「药方」「治方」这类通用词会在“论治方案”“标本兼治方面”里
//      命中同名目录条目。
//   ② 方名去掉末尾剂型字后若**正好**是一条 GB/T 治法术语(如“健脾”方 → 健脾),按治法处理。
//   ③ 出现位置被治法术语跨度覆盖(如“活血散”瘀 ⊂ 活血散瘀)。
//   ④ 方名末字与其后 1–2 字连读构成某条治法术语的结尾(如“解毒散”+结 → 散结 ⊂ 清热散结),
//      说明这里是治法动宾结构而非方名。
const FORM_SUFFIX = /[汤散丸饮丹膏煎方片]$/;
const principleSurfaceForms = [];
for (const entry of readJson("../src/data/tcm-treatment-principle-lexicon.json").entries) {
  if (entry.termClass === "category_heading") continue;
  for (const form of [entry.canonical, entry.standardTerm, ...(entry.aliases || []), ...(entry.standardAliases || [])]) {
    if (typeof form === "string" && form.length >= 2) principleSurfaceForms.push(form);
  }
}
const principleFormSet = new Set(principleSurfaceForms);

const stemIsPrinciple = (name) => {
  const stem = name.replace(FORM_SUFFIX, "");
  return stem.length >= 2 && principleFormSet.has(stem);
};

const readsAsPrincipleTail = (paragraph, index, name) => {
  const tail = name.slice(-1);
  for (let extra = 1; extra <= 2; extra += 1) {
    const probe = tail + paragraph.slice(index + name.length, index + name.length + extra);
    if (probe.length < 2) continue;
    if (principleSurfaceForms.some((form) => form.length > probe.length && form.endsWith(probe))) return true;
  }
  return false;
};

function relatedFormulasFrom(text) {
  const found = new Set();
  // 识别器内部对单段落有产出上限,逐段调用后取并集,避免长卡片被截断。
  // 治法跨度按**同一段落**计算,免去段内偏移换算回全文的错位风险。
  for (const paragraph of text.split(/\n{2,}|\n(?=[-*\d]\s)/)) {
    const spans = treatmentPrincipleSpans(paragraph);
    const overlapsPrinciple = (start, end) => spans.some(([from, to]) => start < to && from < end);
    for (const name of identifyKnownFormulaNames(paragraph) || []) {
      if (name.length < 3) continue;
      if (!governedFormulaNames.has(name)) continue; // 必须在受治理目录内
      if (stemIsPrinciple(name)) continue;
      let index = paragraph.indexOf(name);
      while (index >= 0) {
        // 只要存在一次未被治法吸收的出现,即视为本卡片真实提及该方。
        if (!overlapsPrinciple(index, index + name.length) && !readsAsPrincipleTail(paragraph, index, name)) {
          found.add(name);
          break;
        }
        index = paragraph.indexOf(name, index + 1);
      }
    }
  }
  return [...found].sort();
}

function relatedSyndromesFrom(text) {
  const canonical = new Set();
  for (let index = 0; index < text.length; index += 1) {
    for (let length = Math.min(maxSyndromeFormLength, text.length - index); length >= 2; length -= 1) {
      const slice = text.slice(index, index + length);
      if (!syndromeFormSet.has(slice)) continue;
      // canonicalTcmSyndromeTerm 返回受治理条目对象;歧义/未收录时为空,直接丢弃。
      const resolved = canonicalTcmSyndromeTerm(slice);
      const name = typeof resolved === "string" ? resolved : resolved?.canonical;
      if (name) canonical.add(name);
      index += length - 1; // 最长匹配:消费掉整个术语,避免“心血瘀阻”里再切出“血瘀”
      break;
    }
  }
  return [...canonical].sort();
}

function topicsFrom(text, syndromes, formulas) {
  const topics = new Map();
  const add = (value) => {
    if (typeof value === "string" && value.length >= 2) topics.set(value, (topics.get(value) || 0) + 1);
  };
  for (const form of diseaseFormsByLength) {
    if (form.length < 3 || !text.includes(form)) continue;
    const resolved = canonicalTcmDiseaseName(form);
    add(typeof resolved === "string" ? resolved : resolved?.canonical);
  }
  for (const principle of treatmentPrinciplesInText(text) || []) add(principle.canonical);
  syndromes.forEach(add);
  formulas.forEach(add);
  return [...topics.keys()].sort().slice(0, 16);
}

// ---------- 取证标记(evidenceTier 的可计算依据) ----------
const REFERENCE_ITEM = /^\s*\[\d+\]/gm;
const PERSISTENT_ID = /\b(?:DOI|doi)\s*[:：]|\b10\.\d{4,9}\/|\bPMID\b/;
const DOSE_LEVEL = /\d+\s*(?:g|mg|ml|IU|μg|ug)(?![a-zA-Z])/;

function provenanceOf(text, sections) {
  const references = sectionBody(sections, "参考文献");
  return {
    referenceCount: (references.match(REFERENCE_ITEM) || []).length,
    hasPersistentIdentifier: PERSISTENT_ID.test(references),
    hasReferenceUrl: /https?:\/\//.test(references),
    hasEvidenceBoundarySection: sections.some((section) => section.heading.includes("证据边界")),
    containsDoseLevelContent: DOSE_LEVEL.test(text),
  };
}

// ---------- 主流程 ----------
const files = readdirSync(CARD_DIR).filter((name) => name.endsWith(".md")).sort();
const cards = [];
for (const file of files) {
  const text = readFileSync(new URL(file, CARD_DIR), "utf8").replace(/\r\n/g, "\n");
  const sections = parseSections(text);
  const fileStem = file.replace(/\.md$/, "");
  // 关联抽取排除「参考文献」段:期刊题名里的方名属于被研究对象,不是本卡片的临床主张。
  const clinicalText = sections
    .filter((section) => !section.heading.includes("参考文献"))
    .map((section) => `${section.heading}\n${section.body}`)
    .join("\n\n");

  const conclusion = collapse(sectionBody(sections, "核心结论"));
  const rationale = collapse(
    [...new Set(["决策依据", "病机逻辑", "决策树"].map((keyword) => sectionBody(sections, keyword)).filter(Boolean))].join("\n\n"),
  );
  const relatedFormulas = relatedFormulasFrom(clinicalText);
  const relatedSyndromes = relatedSyndromesFrom(clinicalText);

  cards.push({
    cardId: `TCM-CARD-${createHash("sha256").update(fileStem).digest("hex").slice(0, 12).toUpperCase()}`,
    title: cardTitle(sections, text, fileStem),
    conclusion,
    rationale,
    topics: topicsFrom(clinicalText, relatedSyndromes, relatedFormulas),
    relatedFormulas,
    relatedSyndromes,
    evidenceTier: EVIDENCE_TIER,
    provenance: provenanceOf(text, sections),
    sourceRef: {
      driveFileName: file,
      driveFolder: DRIVE_FOLDER,
      documentSha256: createHash("sha256").update(text).digest("hex"),
    },
  });
}

cards.sort((a, b) => a.cardId.localeCompare(b.cardId));

const output = {
  schemaVersion: "tcm-clinical-decision-cards-v1",
  governance: {
    status: "expert_reference_only_not_governed_rule",
    // 这段话就是接入边界的规范文本,改动接入点前先读它。
    runtimePolicy:
      "厂商决策卡片仅作为医生侧参考与模型推理提示,不得驱动任何确定性判定:不得进入方证召回打分、" +
      "不得作为剂量或配伍依据、不得作为客户可见引用来源。卡片行不进入证据白名单(见 evidence-source-validation.ts " +
      "的 buildEvidenceScope 跳过规则),因此模型即使复述卡片 ID 也会被证据清洗层剥离。",
    evidenceTierRationale:
      "每份卡片都带参考文献,但全库无 DOI/PMID,机器不可核验;卡片自述底层多为单中心小样本 RCT 且方法学质量偏低。" +
      "按项目「一切结论可追溯」原则,只能定级为专家决策参考(expert_decision_reference),不得升格为指南/共识/受治理规则。",
    citableAsCustomerEvidence: false,
    drivesDeterministicDecisions: false,
  },
  source: {
    folder: DRIVE_FOLDER,
    localMirror: "artifacts/drive-clinical-cards/",
    generator: "scripts/build-clinical-decision-cards.mjs",
  },
  summary: {
    cardCount: cards.length,
    cardsWithGovernedFormula: cards.filter((card) => card.relatedFormulas.length > 0).length,
    cardsWithGovernedSyndrome: cards.filter((card) => card.relatedSyndromes.length > 0).length,
    cardsWithAnyGovernedLink: cards.filter((card) => card.relatedFormulas.length + card.relatedSyndromes.length > 0).length,
    cardsWithPersistentIdentifier: cards.filter((card) => card.provenance.hasPersistentIdentifier).length,
    cardsWithDoseLevelContent: cards.filter((card) => card.provenance.containsDoseLevelContent).length,
  },
  cards,
};

writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.summary));
