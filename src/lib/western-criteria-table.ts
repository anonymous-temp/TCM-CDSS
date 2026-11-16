import criteriaSource from "../data/western-diagnostic-criteria.source.json";

export type WesternCriteriaEntry = {
  name: string;
  aliases?: string[];
  reviewedAt?: string;
  clinicallyDiagnosable: boolean;
  requiredTests: string[];
  durationThreshold: string;
  definingFeatures: string[];
  quote: string;
  url: string;
  siteName: string;
  title: string;
  retrievedAt: string;
  /**
   * 起病至今的病程门槛（天；adult 成人，under18 未满18岁）。只收「起病至今满多久」这一类门槛；按年发作次数、单次发作时长定义的不收
   *（数据文件 courseFields.basis）。病名一致性核对据此判断核对给的「病程不够」是不是与病历记录的病程相反（2026-10-19）。
   */
  courseThresholdDays?: { adult?: number; under18?: number };
  /** 病程未满门槛时，原病名那条鉴别的「建议核实」：可以开出的检查、量表或记录（不是「随访至病程满N个月」）。 */
  courseNextCheck?: string;
  /** 未满18岁用的那一项（儿童功能性消化不良无报警征象时不需要胃镜）；没有时用 courseNextCheck。 */
  courseNextCheckUnder18?: string;
  /** 需要数够若干项特征才成立的病（ICHD-3 紧张型头痛、偏头痛）：给核对模型的计数口径。 */
  featureRule?: string;
  /** 诊断必需的前驱病史（反应性关节炎的前驱肠道或泌尿生殖道感染）：病历没有记录时名称说得比记录具体。 */
  requiredHistory?: string;
  /** featureRule / requiredHistory 不满足时原病名那条鉴别的「建议核实」（头痛日记、追问前驱感染），不是检查时也是可执行的临床动作。 */
  clinicalNextCheck?: string;
};

type CriteriaTable = { entries: Map<string, WesternCriteriaEntry>; qualifiers: { course: string[]; side: string[]; population: string[] } };
let table: CriteriaTable | undefined;
function criteriaTable(): CriteriaTable {
  if (table) return table;
  table = { entries: new Map(), qualifiers: { course: [], side: [], population: [] } };
  try {
    const parsed = criteriaSource as unknown as {
      entries?: WesternCriteriaEntry[];
      nameLookupQualifiers?: { course?: unknown; side?: unknown; population?: unknown };
    };
    // 正名优先；别名只填空位，不能遮住已有独立条目。
    for (const entry of parsed.entries || []) if (entry?.name) table.entries.set(entry.name, entry);
    for (const entry of parsed.entries || []) for (const alias of entry.aliases || []) if (!table.entries.has(alias)) table.entries.set(alias, entry);
    const words = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.length > 0)
      .sort((a, b) => b.length - a.length);
    table.qualifiers = {
      course: words(parsed.nameLookupQualifiers?.course),
      side: words(parsed.nameLookupQualifiers?.side),
      population: words(parsed.nameLookupQualifiers?.population),
    };
  } catch {
    // 数据结构不完整时只走现场检索。
  }
  return table;
}

function withoutLeadingQualifier(name: string, qualifiers: string[]): string {
  const hit = qualifiers.find((word) => name.startsWith(word) && name.length > word.length + 1);
  return hit ? name.slice(hit.length) : name;
}

/**
 * 表里的条目：先按原名，再按去掉病程限定、侧别、人群（儿童/小儿）前缀后的名称（前缀词表在数据文件 nameLookupQualifiers 里）。
 * 人群前缀与病程限定可以叠着写（「儿童慢性功能性便秘」），两层都去掉再查一次。
 */
export function westernCriteriaEntry(name: string): WesternCriteriaEntry | undefined {
  const { entries, qualifiers } = criteriaTable();
  const trimmed = name.trim().replace(/待[查排]$/u, "");
  const withoutPopulation = withoutLeadingQualifier(trimmed, qualifiers.population);
  return entries.get(trimmed) || entries.get(withoutLeadingQualifier(trimmed, qualifiers.course)) ||
    entries.get(withoutLeadingQualifier(trimmed, qualifiers.side)) || entries.get(withoutPopulation) ||
    entries.get(withoutLeadingQualifier(withoutPopulation, qualifiers.course)) ||
    // 交付写「慢性失眠」（ICSD-3），表里按「慢性失眠障碍」收载。
    entries.get(`${trimmed}障碍`);
}

/**
 * 去掉一个病程限定或侧别前缀后的病名（「急性尿潴留」→「尿潴留」）；没有这类前缀时返回 undefined。
 * 前缀词表与查表同一份（数据文件 nameLookupQualifiers）。病名一致性核对用它判断「核对给出的名称只是去掉了病程限定」。
 */
export function westernNameWithoutCourseOrSideQualifier(name: string): string | undefined {
  const { qualifiers } = criteriaTable();
  const trimmed = name.trim();
  for (const words of [qualifiers.course, qualifiers.side]) {
    const stripped = withoutLeadingQualifier(trimmed, words);
    if (stripped !== trimmed) return stripped;
  }
  return undefined;
}

