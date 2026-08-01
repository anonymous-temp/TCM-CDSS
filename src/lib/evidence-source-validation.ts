import { medicineClinicalConceptsMatch } from "./medicine-clinical-concepts.ts";

export type EvidenceRecord = {
  ids: Set<string>;
  urls: Set<string>;
  titles: Set<string>;
  years: Set<string>;
  text: string;
};

export type EvidenceScope = {
  ids: Set<string>;
  urls: Set<string>;
  records: EvidenceRecord[];
};

const CUSTOMER_EVIDENCE_PLACEHOLDER = /(?:证据不足|待检索|待核验|检索失败|未配置|内部证据缺口|来源机构未明|年份未明|摘要未提供|题名未知|年份未知|来源未知|机构未知)/;
const KNOWN_TITLE_ALIASES = ["医疗机构处方审核规范", "中成药临床应用指导原则", "中华人民共和国药典", "中国药典"];

function lineRecord(line: string): EvidenceRecord | undefined {
  const ids = new Set([...line.matchAll(/\[([A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+)\]/g)].map((match) => match[1]));
  const urls = new Set([...line.matchAll(/https?:\/\/[^\s)）\]，。；;]+/g)].map((match) => match[0].replace(/[.,，。；;]+$/, "")));
  const titles = new Set([...line.matchAll(/《([^》]{2,160})》/g)].map((match) => match[1]));
  const years = new Set([...line.matchAll(/(?:19|20)\d{2}/g)].map((match) => match[0]));
  KNOWN_TITLE_ALIASES.forEach((title) => {
    if (line.includes(title)) titles.add(title);
  });

  const idPrefix = line.match(/^\s*[-*]?\s*\[[A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+\]\s*(.+)$/)?.[1] || "";
  const plainTitle = idPrefix.split(/(?:[（(:：]|\s+URL:|\s+https?:\/\/)/i, 1)[0]?.trim();
  if (plainTitle && plainTitle.length >= 2 && plainTitle.length <= 160 && !plainTitle.includes("用途")) titles.add(plainTitle);
  if (ids.size === 0 && urls.size === 0 && titles.size === 0) return undefined;
  return { ids, urls, titles, years, text: line };
}

export function buildEvidenceScope(evidenceContext: string): EvidenceScope {
  const records: EvidenceRecord[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const line of evidenceContext.split("\n")) {
    // 2020版规则只作历史安全基线，不能进入可展示的现行证据白名单。
    if (/(?:中国药典|药典).{0,12}2020|2020.{0,12}(?:中国药典|药典)|2020版历史/.test(line)) continue;
    // 药典首页只能证明版本状态，不能替代逐药味、逐剂量、逐炮制条目的现行核验。
    if (line.includes("[OFFICIAL-CHP-2025]")) continue;
    const record = lineRecord(line);
    if (!record) continue;
    records.push(record);
    record.ids.forEach((id) => ids.add(id));
    record.urls.forEach((url) => urls.add(url));
  }
  return { ids, urls, records };
}

function atomAllowed(atom: string, scope: EvidenceScope): boolean {
  if (CUSTOMER_EVIDENCE_PLACEHOLDER.test(atom)) return false;
  const citedIds = [...atom.matchAll(/\[([A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+)\]/g)].map((match) => match[1]);
  const citedUrls = [...atom.matchAll(/https?:\/\/[^\s)）\]，。；;]+/g)].map((match) => match[0].replace(/[.,，。；;]+$/, ""));
  const citedTitles = [...atom.matchAll(/《([^》]{2,160})》/g)].map((match) => match[1]);
  const citedYears = [...atom.matchAll(/(?:19|20)\d{2}/g)].map((match) => match[0]);

  const matchingRecords = scope.records.filter((record) => {
    if (citedIds.some((id) => !record.ids.has(id))) return false;
    if (citedUrls.some((url) => !record.urls.has(url))) return false;
    if (citedTitles.some((title) => !record.titles.has(title))) return false;
    if (citedYears.some((year) => !record.years.has(year))) return false;
    if (citedIds.length + citedUrls.length + citedTitles.length > 0) return true;
    return [...record.titles].some((title) => atom.includes(title));
  });
  if (matchingRecords.length === 0) return false;

  return matchingRecords.some((record) => {
    const fingerprint = (value: string) => value
      .normalize("NFKC")
      .replace(/\[[A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+\]/g, "")
      .replace(/https?:\/\/[^\s)）\]，。；;]+/g, "")
      .replace(/^(?:证据依据|引用来源|参考依据|参考文献|来源|依据)\s*[：:]?/g, "")
      .replace(/[\s，,。.：:；;（）()《》【】\[\]"'“”‘’·—-]/g, "")
      .toLowerCase();
    const atomFingerprint = fingerprint(atom);
    const recordFingerprint = fingerprint(record.text);
    // The source field is a citation, not a place for a new clinical assertion. It may contain a
    // bare ID/URL or an exact contiguous slice of the retrieved metadata, but it cannot append a
    // claim that was absent from the evidence record while borrowing a legitimate ID.
    return atomFingerprint.length === 0 || recordFingerprint.includes(atomFingerprint);
  });
}

export function sourceAllowed(source: string, evidenceLevel: string | undefined, scope: EvidenceScope): boolean {
  const clean = source.trim();
  if (!clean || CUSTOMER_EVIDENCE_PLACEHOLDER.test(clean)) return false;
  if (evidenceLevel === "insufficient") return false;
  if (/(?:中国药典|药典).{0,12}2020|2020.{0,12}(?:中国药典|药典)/.test(clean)) return false;
  if (evidenceLevel === "model_inference" || evidenceLevel === "deterministic_rule") {
    // model_inference/deterministic_rule 不得挟带外部权威引用。除 URL/ID/《》/DOI/PMID/指南/说明书/药典/文献/共识 外，
    // 补齐常见文献造假信号(研究/论文/循证/临床试验/RCT/荟萃/系统评价/meta/期刊/杂志)；命中即须通过 guideline 白名单校验，
    // 否则结构化降级为 insufficient，防止伪证据借这两个等级直通。
    return !/https?:\/\/|\[[A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+\]|《[^》]+》|DOI|doi|PMID|指南|说明书|药典|文献|共识|研究|论文|循证|临床试验|RCT|荟萃|系统评价|[Mm]eta|META|期刊|杂志/.test(clean) ||
      sourceAllowed(clean, "guideline", scope);
  }
  const atoms = clean.split(/[；;\n]+/).map((atom) => atom.trim()).filter(Boolean);
  return atoms.length > 0 && atoms.every((atom) => atomAllowed(atom, scope));
}

function normalizedMedicineNames(value: string): string[] {
  const compact = value.normalize("NFKC").replace(/[\s（）()【】\[\]·]/g, "");
  const withoutForm = compact.replace(/(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|注射液|喷雾剂|滴丸|糖浆|散|膏)$/g, "");
  return [...new Set([compact, withoutForm].filter((item) => item.length >= 2))];
}

/** A policy document can authorize review practice, but cannot prove a concrete medicine choice. */
export function sourceSupportsMedicine(
  source: string,
  medicineName: string,
  scope: EvidenceScope,
): boolean {
  if (!sourceAllowed(source, undefined, scope)) return false;
  const citedIds = [...source.matchAll(/\[([A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+)\]/g)].map((match) => match[1]);
  const citedUrls = [...source.matchAll(/https?:\/\/[^\s)）\]，。；;]+/g)].map((match) => match[0].replace(/[.,，。；;]+$/, ""));
  const citedTitles = [...source.matchAll(/《([^》]{2,160})》/g)].map((match) => match[1]);
  const referenced = scope.records.filter((record) =>
    citedIds.some((id) => record.ids.has(id)) ||
    citedUrls.some((url) => record.urls.has(url)) ||
    citedTitles.some((title) => record.titles.has(title)) ||
    [...record.titles].some((title) => source.includes(title))
  );
  if (referenced.length === 0) return false;
  const names = normalizedMedicineNames(medicineName);
  return referenced.some((record) => {
    const recordText = record.text.normalize("NFKC").replace(/[\s（）()【】\[\]·]/g, "");
    return names.some((name) => recordText.includes(name));
  });
}

function normalizedMedicineBindingText(value: string): string {
  return value.normalize("NFKC").replace(/[\s（）()【】\[\]·，,。；;：:|｜]/g, "").toLowerCase();
}

/** Bind a medicine row to one exact retrieved instruction record and its case-relevant indication. */
export function medicineEvidenceBindingValid(
  evidenceId: string,
  evidenceFingerprint: string,
  medicineName: string,
  correspondingProblem: string,
  specification: string | null | undefined,
  scope: EvidenceScope,
): boolean {
  if (!/^(?:EVID|LOCAL)-INST-\d{3}$/.test(evidenceId) || !/^sha256:[a-f0-9]{64}$/.test(evidenceFingerprint)) return false;
  const record = scope.records.find((candidate) => candidate.ids.has(evidenceId));
  if (!record || !record.text.includes(`条目指纹：${evidenceFingerprint}`)) return false;
  const recordText = normalizedMedicineBindingText(record.text);
  if (!normalizedMedicineNames(medicineName).some((name) => recordText.includes(normalizedMedicineBindingText(name)))) return false;
  if (specification && !recordText.includes(normalizedMedicineBindingText(specification))) return false;
  // correspondingProblem 只能在**适应证段**核验，不能在整行上跑。
  //
  // 记录行是 `标签：值｜标签：值` 结构，除适应证外还含「禁忌/注意」「特殊人群」「相互作用」。
  // 原实现的概念匹配与裸子串兜底都跑在 record.text 整行上，于是反指征条文可以证明适应证。
  // 实测（丁桂温胃散，适应证=温胃散寒，行气止痛；禁忌栏写「不适用于肝肾阴虚，主要表现为口干、
  // 手足心热、心烦易怒」）：correspondingProblem 取「肝肾阴虚」「肾阴虚」「手足心热」三者
  // 全部通过绑定校验——一个温里药可以被绑成「对应肝肾阴虚」，正好用反了。
  //
  // 没有适应证段的条目一律判不通过：一条不载明适应证的说明书记录，本就无法证明某药对某问题适用。
  // 药名、规格与指纹仍按整行核对——它们是条目身份，不是临床适应关系。
  const indication = record.text.match(/适应证[：:]([^｜|]*)/)?.[1]?.trim();
  if (!indication) return false;
  if (medicineClinicalConceptsMatch(correspondingProblem, indication)) return true;
  const problem = normalizedMedicineBindingText(correspondingProblem);
  return problem.length >= 2 && normalizedMedicineBindingText(indication).includes(problem);
}

export function medicineProblemMatchesCase(problem: string, caseText: string): boolean {
  if (medicineClinicalConceptsMatch(problem, caseText)) return true;
  const normalizedProblem = normalizedMedicineBindingText(problem);
  const normalizedCase = normalizedMedicineBindingText(caseText);
  return normalizedProblem.length >= 2 && normalizedCase.includes(normalizedProblem);
}

const INSUFFICIENT_EVIDENCE = {
  evidenceLevel: "insufficient",
  source: "内部证据缺口",
  confidence: "低",
};

export function sanitizeEvidenceObject(
  value: unknown,
  scope: EvidenceScope,
  evidenceLevels: readonly string[],
): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidenceObject(item, scope, evidenceLevels));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) next[key] = sanitizeEvidenceObject(raw, scope, evidenceLevels);
  const evidenceLevel = typeof record.evidenceLevel === "string" ? record.evidenceLevel : undefined;
  const source = typeof record.source === "string" ? record.source : undefined;
  if (evidenceLevel === "insufficient" || (source != null && CUSTOMER_EVIDENCE_PLACEHOLDER.test(source))) {
    return { ...next, ...INSUFFICIENT_EVIDENCE };
  }
  // 任何"证据类"对象声称的 source 都必须校验。此前只在 evidenceLevel 命中已知枚举时才校验，
  // 于是"省略/拼错 evidenceLevel"即可绕过来源白名单伪造引用（fail-open）。改为：只要对象是证据类
  // （带 evidenceLevel 键，或 source 形似引用：URL/括号ID/《》/DOI/PMID），evidenceLevel 缺失或不在
  // 枚举内即无法校验 → fail-closed 到 insufficient。非证据对象（仅有普通 source 字段，如方剂出处）不受影响。
  if (source != null) {
    const evidenceLike =
      "evidenceLevel" in record ||
      /https?:\/\/|\[[A-Z][A-Z0-9_-]*(?:-[A-Z0-9_-]+)+\]|《[^》]+》|DOI|doi|PMID/.test(source);
    if (evidenceLike) {
      const levelKnown = evidenceLevel != null && evidenceLevels.includes(evidenceLevel);
      if (!levelKnown || !sourceAllowed(source, evidenceLevel, scope)) {
        return { ...next, ...INSUFFICIENT_EVIDENCE };
      }
    }
  }
  return next;
}
