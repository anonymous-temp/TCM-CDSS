// 同源饮片候选对（第五十七轮，2026-11-23）。
//
// tcm-same-source-herbs.source.json 只有逐个客户病例补进去的四组（姜、参、瓜蒌、合欢），玄明粉与芒硝同时出现在一张处方里
// （方中玄明粉、加减「加芒硝」，药典「本品为芒硝经风化干燥制得」）没有拦住。这里把「可能出自同一药材」的饮片对整类列出来，
// 每一对都必须在表里归入三类之一（同源同用 groups / 同源异用 sameOriginDistinctUse / 并不相关 notRelated），闸门核对没有漏判。
//
// 候选来源三种，都只取系统能开的饮片身份（canonicalTcmHerbIdentity 的不动点，且知识库认得）：
//   species   《中药学》十三五教材各药及附药的来源句里写的拉丁学名（属＋种，不分变种）相同；
//   attached  教材「附药：X」挂在正药 Y 之下；
//   derived   来源句里写明由另一味制得（「本品为鹿角经水煎煮、浓缩制成的固体胶」「芒硝经风化…称玄明粉」），本药与同一句里点到的
//             那味成对（一句点到三味及以上的是多味原料的发酵曲剂配料表，如半夏曲、建神曲，不算；「大戟科」一类科属名不算点到）；
//   statement 教材【鉴别用药】明说同出一物（「生姜、干姜与炮姜同出一物」「郁金、姜黄为同一植物的不同药用部位」），句中点到的饮片两两成对；
//   name      药名构词：两名共享一段 ≥2 字的词干，词干在两名里都在词首或词尾，各自另加 0–2 字（茯苓/茯苓皮、金银花/山银花、北沙参/南沙参）。
// 同一味药的不同炮制品（炙甘草/甘草、生地黄/熟地黄，compositionIdentityName 相同）不在这里，按 sameDrugDifferentProcessing 另行处理；
// 身份分叉的统称（贝母、沙参、大戟、芍药、乌头）不是一味饮片，也不进名单。这里只列两个不同饮片身份。
//
// 本模块是纯函数，不读文件、不引 TS：教材行与身份判定函数由调用方传入（构建脚本与闸门测试各自用 jiti 载入真实的
// canonicalTcmHerbIdentity / isKnownTcmHerbName）。

export const MATERIA_MEDICA_LINES = Object.freeze([151400, 161000]);
export const TEXTBOOK_CORPUS_REF = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt";

const PINYIN_LINE = /^[A-ZÀ-ǜ][^一-鿿]*（/u;
const SOURCE_SENTENCE = /^(?:本品|为[^。]{0,8}(?:科|类))/u;
const NUMBERED_ATTACHED = /^\d[.．]\s*([一-鿿]{2,7})[　 ]+(.*)$/u;
// 来源句里表示「由另一味制得」的写法。只认这些，避免「以色红者为佳」一类品质描述里的字面碰撞。
const DERIVATION_VERB = /(?:炮制加工品|加工品|制成|制得|而成|风化|煎煮|去胶质|炒炭|捣汁|经[^。，；]{0,12}(?:加工|发芽|发酵|蒸|煅|炒|精制))/u;
const NAME_AFFIX_MAX = 2;
const NAME_STEM_MIN = 2;

export function compactName(value) {
  return String(value || "").replace(/[\s　]/gu, "");
}

/**
 * 《中药学》各论（固定行段）里每一味正药与附药的来源句：
 *   正药：药名行（「芒　硝」）＋拼音行＋「本品为…」来源行；
 *   附药：「附药：X」下一行「本品为…」，或多味附药各起一段「1.生姜皮　本品为…」。
 * 返回 { name, line（来源句所在行号，1 起）, source, parent? }，parent 是附药所挂的正药。
 */
export function extractTextbookMaterialRecords(lines, range = MATERIA_MEDICA_LINES) {
  const [start, end] = range;
  const records = [];
  let parent = "";
  for (let index = start; index < Math.min(end, lines.length - 1); index += 1) {
    const line = lines[index];
    if (PINYIN_LINE.test(line) && /^本品(?:为|系|始载|由|以)/u.test(lines[index + 1] || "")) {
      const name = compactName(lines[index - 1]);
      if (!name) continue;
      parent = name;
      records.push({ name, line: index + 2, source: lines[index + 1].trim() });
      continue;
    }
    if (!line.startsWith("附药：")) continue;
    const names = line.slice(3).split(/[、，,]/u).map(compactName).filter(Boolean);
    const following = lines[index + 1] || "";
    if (names.length === 1 && (/^本品/u.test(following) || SOURCE_SENTENCE.test(following))) {
      records.push({ name: names[0], line: index + 2, source: following.trim(), parent });
      continue;
    }
    for (let offset = 1; offset < 12 && index + offset < lines.length; offset += 1) {
      const matched = lines[index + offset].match(NUMBERED_ATTACHED);
      if (!matched) {
        if (lines[index + offset].trim()) break;
        continue;
      }
      records.push({ name: matched[1], line: index + offset + 1, source: matched[2].trim(), parent });
    }
  }
  return records;
}

const ORIGIN_STATEMENT = /同出一物|同出一源|同一植物/u;

/** 《中药学》【鉴别用药】里明说同出一物的句子：{ line, text }（只留含该说法的那一句）。 */
export function extractTextbookOriginStatements(lines, range = MATERIA_MEDICA_LINES) {
  const [start, end] = range;
  const out = [];
  for (let index = start; index < Math.min(end, lines.length); index += 1) {
    const line = lines[index];
    if (!line.startsWith("【鉴别用药】") || !ORIGIN_STATEMENT.test(line)) continue;
    const sentence = line.replace(/^【鉴别用药】\s*/u, "").split(/(?<=。)/u).find((part) => ORIGIN_STATEMENT.test(part));
    if (sentence) out.push({ line: index + 1, text: sentence.trim() });
  }
  return out;
}

/** 来源句里的拉丁学名（属＋种，小写；不分变种、栽培品）。OCR 把属名首字母打成小写的（knoxia）也认。 */
export function speciesInSource(source) {
  const out = new Set();
  const text = String(source || "");
  for (const matched of text.matchAll(/(?:^|[^A-Za-z.])([A-Z][a-z]+|[a-z]{5,})\s+(?:×\s*)?([a-z][a-z-]{2,})(?![a-z])/gu)) {
    const genus = matched[1].toLowerCase();
    const species = matched[2].toLowerCase();
    if (["var", "subsp", "et", "ex", "and"].includes(species) || ["var", "subsp"].includes(genus)) continue;
    out.add(`${genus} ${species}`);
  }
  return [...out].sort();
}

/** 来源句里写明「由另一味制得」的那些句子（以句号切）。 */
function derivationSentences(source) {
  return String(source || "").split(/[。；]/u).filter((sentence) => DERIVATION_VERB.test(sentence));
}

/**
 * 只留候选判据要读的句子：第一句（「本品为…科植物…的…」）、带拉丁学名的句子、写明由另一味制得的句子。
 * 附药段落后半是性味功能主治，不进候选判据，也不存进生成物（有语料与无语料两条路径读同一份摘录）。
 */
export function sourceExcerpt(source) {
  const sentences = String(source || "").split(/(?<=[。])/u).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.filter((sentence, index) => index === 0 || /[A-Za-z]{3}/u.test(sentence) || DERIVATION_VERB.test(sentence)).join("");
}

function pairKey(left, right) {
  return [left, right].sort().join("|");
}

/**
 * 两个药名是否构词同源：共享一段 ≥2 字的词干，词干在两名里都在词首或词尾，各自另加 0–2 字。
 * 返回词干，不是则返回空串。
 */
export function sharedNameStem(left, right) {
  const a = compactName(left).replace(/[（(][^）)]*[）)]/gu, "");
  const b = compactName(right).replace(/[（(][^）)]*[）)]/gu, "");
  if (!a || !b || a === b) return "";
  const edges = (name) => {
    const stems = new Set();
    for (let length = NAME_STEM_MIN; length <= name.length; length += 1) {
      if (name.length - length > NAME_AFFIX_MAX) continue;
      stems.add(name.slice(0, length));
      stems.add(name.slice(name.length - length));
    }
    return stems;
  };
  const left_ = edges(a);
  let best = "";
  for (const stem of edges(b)) if (left_.has(stem) && stem.length > best.length) best = stem;
  return best;
}

/**
 * 候选对。参数：
 *   records    extractTextbookMaterialRecords 的结果（可为空：没有语料时只算构词候选）
 *   names      系统可开饮片的原始名单（知识库、身份目录、教材…），逐一映射到身份
 *   canonical  canonicalTcmHerbIdentity
 *   known      isKnownTcmHerbName
 *   prescribable（可选）身份是否可开（有剂量依据等），缺省都算
 * 返回 { universe: string[], records: [...带 identity/species], candidates: [{ herbs:[a,b], bases:[...] }] }，按字典序稳定排序。
 */
export function buildSameSourceHerbCandidates({
  records = [], statements = [], names = [], canonical, known, prescribable = () => true, ambiguous = () => false, sameDrug = () => false,
}) {
  const identityOf = (name) => {
    const raw = compactName(name);
    if (!raw) return "";
    for (const variant of [raw, raw.replace(/[（(][^）)]*[）)]/gu, "")]) {
      // 身份分叉的统称（贝母→川贝母/平贝母…、沙参、大戟、芍药、乌头）不是一味饮片，不进名单。
      if (ambiguous(variant)) return "";
      const id = canonical(variant);
      if (id && !ambiguous(id) && known(id) && canonical(id) === id && prescribable(id)) return id;
    }
    return "";
  };
  const universe = new Set();
  for (const name of [...names, ...records.map((record) => record.name)]) {
    const id = identityOf(name);
    if (id) universe.add(id);
  }
  const sortedUniverse = [...universe].sort();
  const candidates = new Map();
  const add = (left, right, basis) => {
    if (!left || !right || left === right || !universe.has(left) || !universe.has(right)) return;
    // 同一味药的不同炮制品（炙甘草/甘草、生地黄/熟地黄、姜半夏/半夏）由 sameDrugDifferentProcessing 另行判定，不在本表。
    if (sameDrug(left, right)) return;
    const key = pairKey(left, right);
    const entry = candidates.get(key) || { herbs: [left, right].sort(), bases: [] };
    if (!entry.bases.some((item) => JSON.stringify(item) === JSON.stringify(basis))) entry.bases.push(basis);
    candidates.set(key, entry);
  };

  // 教材来源句
  const enriched = records.map((record) => ({
    ...record,
    source: sourceExcerpt(record.source),
    identity: identityOf(record.name),
    parentIdentity: record.parent ? identityOf(record.parent) : "",
    species: speciesInSource(sourceExcerpt(record.source)),
  }));
  const bySpecies = new Map();
  for (const record of enriched) {
    if (!record.identity) continue;
    for (const species of record.species) {
      const list = bySpecies.get(species) || [];
      list.push(record);
      bySpecies.set(species, list);
    }
  }
  for (const [species, list] of bySpecies) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        add(list[i].identity, list[j].identity, { kind: "species", species, lines: [list[i].line, list[j].line].sort((x, y) => x - y) });
      }
    }
  }
  for (const record of enriched) {
    if (record.identity && record.parentIdentity) {
      add(record.parentIdentity, record.identity, { kind: "attached", parent: record.parentIdentity, line: record.line });
    }
  }
  // 名单里的身份按长度倒序找最长匹配，避免「生地黄」里再认出「地黄」。
  const lexicon = sortedUniverse.filter((name) => name.length >= 2).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const mentionsIn = (sentence) => {
    const found = new Set();
    let rest = sentence;
    for (const name of lexicon) {
      if (!rest.includes(name)) continue;
      // 「大戟科植物巴豆」「棕榈科植物麒麟竭」：科、属、族名里的字面不是那味药。
      const pattern = new RegExp(`${name}(?![科属族])`, "gu");
      if (pattern.test(rest)) found.add(name);
      rest = rest.split(name).join("　");
    }
    return [...found];
  };
  for (const record of enriched) {
    if (!record.identity) continue;
    for (const sentence of derivationSentences(record.source)) {
      const mentioned = mentionsIn(sentence).filter((name) => name !== record.identity);
      if (mentioned.length === 0 || mentioned.length >= 3) continue;
      // 只配本药与点到的那味（「红粉由水银、白矾…制成」配红粉/水银、红粉/白矾，不配水银/白矾）。
      for (const name of mentioned) add(record.identity, name, { kind: "derived", herb: record.identity, line: record.line });
    }
  }
  for (const statement of statements) {
    if (!ORIGIN_STATEMENT.test(statement.text || "")) continue;
    const mentioned = mentionsIn(statement.text);
    for (let i = 0; i < mentioned.length; i += 1) {
      for (let j = i + 1; j < mentioned.length; j += 1) add(mentioned[i], mentioned[j], { kind: "statement", line: statement.line });
    }
  }
  // 构词
  for (let i = 0; i < sortedUniverse.length; i += 1) {
    for (let j = i + 1; j < sortedUniverse.length; j += 1) {
      const stem = sharedNameStem(sortedUniverse[i], sortedUniverse[j]);
      if (stem) add(sortedUniverse[i], sortedUniverse[j], { kind: "name", stem });
    }
  }
  const list = [...candidates.values()]
    .map((entry) => ({ herbs: entry.herbs, bases: entry.bases.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) }))
    .sort((x, y) => pairKey(...x.herbs).localeCompare(pairKey(...y.herbs)));
  return {
    universe: sortedUniverse,
    records: enriched.filter((record) => record.identity).map((record) => ({
      name: record.name, identity: record.identity, line: record.line, source: record.source,
      ...(record.parentIdentity ? { parent: record.parentIdentity } : {}),
      ...(record.species.length ? { species: record.species } : {}),
    })),
    candidates: list,
  };
}

/** 一项的成对：herbs 两两成对；between: [[…],[…]] 只配两组之间（同组之内另有归类时用）。 */
export function entryPairs(entry) {
  const out = [];
  const herbs = entry.herbs || [];
  for (let i = 0; i < herbs.length; i += 1) for (let j = i + 1; j < herbs.length; j += 1) out.push([herbs[i], herbs[j]]);
  const [left = [], right = []] = entry.between || [];
  for (const a of left) for (const b of right) out.push([a, b]);
  return out;
}

/** 三类数组里每一项的成对，返回 { key → [{ kind, id }] }，用于核对覆盖与重复。 */
export function decidedPairs(table) {
  const out = new Map();
  const visit = (kind, entries) => {
    for (const entry of entries || []) {
      for (const [left, right] of entryPairs(entry)) {
        const key = pairKey(left, right);
        const list = out.get(key) || [];
        list.push({ kind, id: entry.id || [...(entry.herbs || []), ...(entry.between || []).flat()].join("、") });
        out.set(key, list);
      }
    }
  };
  visit("groups", table.groups);
  visit("sameOriginDistinctUse", table.sameOriginDistinctUse);
  visit("notRelated", table.notRelated);
  return out;
}

export { pairKey };
