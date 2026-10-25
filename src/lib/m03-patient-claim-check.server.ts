import "server-only";
import { negativeFormClaim } from "./tcm-therapy-phrasing";

import {
  CHINESE_NUMERAL_BEFORE_UNIT,
  CLAUSE_LINKER_TAIL,
  EXISTENCE_LEAD_IN,
  ORPHAN_ANAPHORIC_TAIL,
  PATIENT_SELF_REFERENCE,
  RECORD_CONSIDERATION_MARKER,
  RECORD_GAP_MARKER,
  affirmedClinicalSourceClauses,
  carriesListPredicate,
} from "./clinical-polarity";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { recordedFindingReading } from "./diagnosis-safety";

/**
 * 辨病辨证里关于本例患者的说法要有病历依据（2026-10-19，独立评审通则 1）。
 *
 * 甲方标准病历与留出集的独立评审里，最大的一类剩余不合格是「写了病历没有的本例情况」：风温鉴别写「本例恶寒重、发热轻、口不渴」
 *（病历从未记录口渴）、紧张型头痛鉴别写「本例为双侧隐痛」（未记录部位）、胃食管反流病鉴别写「胸痛与情绪相关」（只有胸闷、善叹息）、
 * 辨证依据写「痛剧、疱壁紧张属热毒」（疱壁紧张是教材特征）、「皮损为肥厚脱屑性斑块」（未记录脱屑）、
 * 先天性巨结肠鉴别写「本例3月龄后起病」（病历是 9 岁儿童「3个月来大便干结」）。
 *
 * 做法与追问重复核对、兼证一致核对相同：小模型只判这一件事，交出字段号与该字段里逐字的片段；服务端只做四道核对——片段逐字在该字段里、
 * 片段本身不是病历原文的一部分（是就不删）、片段及其所在分句开头不是「未诉/未记录/需核实」这类缺项说法（RECORD_GAP_MARKER）、
 * 删后字段不空——然后只删最小单位：片段是顿号并列里的一项就删这一项，否则删它所在的逗号分句。
 * 病历正文（trustedInputText）不含性别年龄，交给小模型前在首行补上（patientClaimRecordText），否则「本例36岁」「老年男性」都会被当成无据。
 * 超时、未配置、输出非法都原样返回。开关：CDSS_M03_PATIENT_CLAIM_CHECK=false 关闭。
 *
 * 离线测量（~/runlogs/r1018/work/r1019/agentB/r4，每条删除逐条对病历读过）：开发集（甲方 10 例×3 + 留出 32 例 + M 集 40 例）
 * 删 23 处全对，评审指出的 6 例 8 处全删到；考题式病历留出集（X 集 200 例）删 31 处对 23 处，错的 8 处是术语化（「拘痉」写成
 *「肌张力增高」、「肌紧张」写成「腹皮挛急」）与由病历推得的说法（体重 2kg 写成「形体极瘦」、「心痛」推出「痛位不在胃脘」）。
 * 每例多 2 次小模型调用（两次核对并行，约 0.4–1.0 秒），标到时再加 1 次复核（约 0.8 秒）；西医半与病名核对并行，基本不增加耗时。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.M03_PATIENT_CLAIM_CHECK_TIMEOUT_MS || 4_000);
  return Number.isFinite(value) && value >= 1_500 && value <= 10_000 ? Math.round(value) : 4_000;
})();
const MAX_RECORD_CHARS = 2_400;
const MAX_FIELD_CHARS = 400;
const MAX_CLAIMS = 8;
const MAX_SPAN_CHARS = 20;

export function patientClaimCheckEnabled(): boolean {
  return process.env.CDSS_M03_PATIENT_CLAIM_CHECK !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const CN_NUMERAL: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 「五天」「十二个月」→「5天」「12个月」（只换紧跟时间、次数、年龄单位的中文数字），病历与结论写法不同时仍能对上。 */
function arabicNumerals(value: string): string {
  return value.replace(CHINESE_NUMERAL_BEFORE_UNIT, (raw) => {
    const match = /^([一二两三四五六七八九])?(十)?([一二两三四五六七八九])?$/u.exec(raw);
    if (!match || (!match[1] && !match[2] && !match[3])) return raw;
    if (!match[2]) return String(CN_NUMERAL[match[1] || match[3]]);
    return String((match[1] ? CN_NUMERAL[match[1]] : 1) * 10 + (match[3] ? CN_NUMERAL[match[3]] : 0));
  });
}
/** 比较用：中文数字换成阿拉伯数字，去掉空白与标点（片段是不是病历原文的一部分）。 */
const compact = (value: string) => arabicNumerals(value.normalize("NFKC")).replace(/[\s，,。．.；;：:、（）()“”"'‘’！!？?【】\[\]]/gu, "");

export type PatientClaimHalf = "tcm" | "western";
export type PatientClaimField = { id: string; text: string };
export type PatientClaimRemoval = { field: string; span: string };

const CLAUSE_DELIMITERS = "，,。；;：:（）()";

type FieldSlot = PatientClaimField & { read: () => string; write: (value: string) => void };

/**
 * 两半里要核对的文字字段（逐个给编号）。中医半：辨病依据、辨证依据、病名级与证候级鉴别的区分要点；
 * 西医半：主诊断的临床依据、鉴别诊断的理由与区分要点。
 * 候选诊断的支持/不支持证据（candidates[].keyEvidence/againstEvidence）不核：离线 102 例里这类短条目被标的 6 处有 4 处是误判
 *（把「双肩、双肘、双膝」读成「对称」算无据、把「五天」与「5天」、既往的胸痛当成没写）。
 */
function fieldSlots(root: Json, half: PatientClaimHalf): FieldSlot[] {
  const slots: FieldSlot[] = [];
  const stringSlot = (id: string, owner: Json | undefined, key: string) => {
    if (!owner || !text(owner[key])) return;
    slots.push({
      id,
      text: text(owner[key]),
      read: () => text(owner[key]),
      write: (value) => { owner[key] = value; },
    });
  };
  const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(record).filter((item): item is Json => Boolean(item)) : [];
  if (half === "tcm") {
    const overview = record(root.overview);
    stringSlot("tcmDiseaseRationale", overview, "tcmDiseaseRationale");
    stringSlot("tcmDiagnosticRationale", overview, "tcmDiagnosticRationale");
    list(overview?.tcmDiseaseDifferentials).forEach((item, index) => stringSlot(`tcmDiseaseDifferentials[${index}].distinguishingPoints`, item, "distinguishingPoints"));
    list(overview?.tcmDifferentials).forEach((item, index) => stringSlot(`tcmDifferentials[${index}].distinguishingPoints`, item, "distinguishingPoints"));
    return slots;
  }
  const western = record(root.westernDiagnosis);
  stringSlot("primary.clinicalRationale", record(western?.primary), "clinicalRationale");
  list(western?.differentials).forEach((item, index) => {
    stringSlot(`differentials[${index}].reason`, item, "reason");
    stringSlot(`differentials[${index}].distinguishingPoints`, item, "distinguishingPoints");
  });
  return slots;
}

/** 给小模型看的字段清单（编号 + 原文）。 */
export function patientClaimFields(root: Json, half: PatientClaimHalf): PatientClaimField[] {
  return fieldSlots(root, half).map(({ id, text: value }) => ({ id, text: value.slice(0, MAX_FIELD_CHARS) }));
}

/**
 * 交给核对的病历：首行补性别、年龄、带名称的生命体征（病历正文里没有前两项，生命体征只有裸数字「生命体征：46」——
 * 结论里的「本例36岁」「老年男性」「心动过缓」要有据可查）。只给这一个核对用，不进任何安全判断。
 */
export function patientClaimRecordText(
  recordText: string,
  patient?: { sex?: unknown; age?: unknown },
  vitals?: { T?: unknown; P?: unknown; R?: unknown; BP?: unknown } | null,
): string {
  const sex = text(patient?.sex);
  const rawAge = typeof patient?.age === "number" && Number.isFinite(patient.age) ? String(patient.age) : text(patient?.age);
  const age = /^\d+(?:\.\d+)?$/u.test(rawAge) ? `${rawAge}岁` : rawAge;
  const vital = (label: string, value: unknown) => {
    const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
    return raw ? `${label}${raw}` : "";
  };
  const vitalLine = [vital("体温", vitals?.T), vital("脉搏/心率", vitals?.P), vital("呼吸", vitals?.R), vital("血压", vitals?.BP)].filter(Boolean).join("，");
  const header = [sex && `性别：${sex}`, age && `年龄：${age}`, vitalLine && `生命体征：${vitalLine}`].filter(Boolean).join("；");
  return header ? `${header}\n${recordText}` : recordText;
}

export function buildPatientClaimMessages(recordText: string, fields: readonly PatientClaimField[]) {
  return [
    {
      role: "system" as const,
      content: [
        "你是病历事实核对器。给你一份门诊病历（record，首行是性别、年龄）和一份辨病辨证结论里的若干段文字（fields，每段有 id）。",
        "只找一种错误：文字把某个具体表现当成本例患者自己有的（或没有的）来写——症状、体征、症状的性质、部位、侧别、起病时间或起病年龄、检查结果、既往史、诱因——而病历里用任何说法都没有写到，或与病历写的相反。",
        "典型的错误：病历只写“咳嗽”，文字写“本例干咳无痰”；病历只写“起水疱”，文字写“水疱破溃渗液”“疱液浑浊”；病历写“皮肤瘙痒”，文字写“瘙痒夜间加重”；病历没写部位，文字写“本例右侧疼痛”；病历只有胸闷，文字写“胸痛”；病历写“2个月来出现”，文字写“2月龄起病”；病历没写口渴与否，文字写“口不渴”。",
        "同一类错误还有三种写法：写某项“正常、如常、清楚”（如“神志清楚”“四肢活动自如”“饮食如常”）而病历没写这一项；写症状“不在某处”“与某事无关”（如“痛不在胁下”“与进食无关”）而病历没写部位或这层关系；把病历里笼统的“不适”写成具体性质（病历只写“腹部不适”，文字写“腹部痞满”“腹部胀痛”）。",
        "还有一种容易漏的：病历写了这个症状或体征，文字在它前后加上病历没有的限定——程度（病历“发热”，文字“壮热”）、颜色或性状（病历“身黄”，文字“黄色鲜明”）、固定与否或范围（病历“刺痛”，文字“痛有定处”“肿势散漫”）。这类限定词要逐个对照病历，病历没写的那个限定词就是错误，span 取该限定词连同它修饰的症状（如“壮热”“黄色鲜明”）；病历用另一种说法写了同样的意思（“针刺样痛”与“刺痛如针扎”）不算。",
        "辨证依据常把体征和病机写在同一句里（如“痛剧、XX属热毒”“皮损为XX，与之不同”）：病机部分不用管，但句中每个体征、性状词都要逐个对照病历——病历没写的那个词就是错误。",
        "以下不算错误，不要列出：",
        "- 鉴别诊断里写别的病、别的证的典型表现或一般规律：没有“本例/患者/患儿/该患者”这类主语、只是罗列特征的话（如“搏动性、单侧、伴畏光”“起病即发热重”“多见于中老年”“需排除占位”），默认是在写那个病；",
        "- 病机、推理、归纳、风险判断、诊断结论（如“属风寒束表”“为热毒壅于肝经”“提示免疫功能偏低”“存在心血管危险因素”）；",
        "- 写明病历没记录、没提到、需要核实、待查的话（如“未诉口渴”“舌脉未记录”“需核实有无发热”“尚缺胃镜”）；",
        "- 由首行性别、年龄、生命体征得出的说法（如“58岁男性”“老年患者”“中青年”“高龄”“育龄期女性”“起病年龄偏大”“心动过速”）；",
        "- 对病历原话的临床解读或术语化，换成中医或西医术语（如病历“按压时疼痛加重”写成“拒按”，“饭后胃胀”写成“食后脘胀”，“不想吃饭”写成“纳呆”，“小便量多”写成“多尿”，“腹部肌紧张”写成“腹肌紧张”，心率 50 次/分写成“心动过缓”）；",
        "- 辨病依据里拿别的病作对照时写的那个病的表现（如“痫病以突然仆倒为主”“消渴以多饮多食为主”）；",
        "- 病历原话的换说法、概括或合理归纳，包括把病历里分开写的几处合起来的说法（如“恶寒重、发热轻”与“寒重热轻”，“食欲下降”与“食少”，“大便两日未行”与“便秘”，“加重1月余”与“近1月加重”，“咳嗽……无痰”与“干咳”，“1月前出现胸痛”与“胸痛1月”）；",
        "- 病历里写了的正常值、阴性结果与否认。",
        "每条给出 field（字段 id）和 span：从该段文字里逐字复制、不超过20字、恰好是那个没有依据的说法（如“干咳无痰”“右侧疼痛”“2月龄起病”“口不渴”），不要复制整句，也不要改字。",
        "拿不准时不要列。没有就返回空数组。",
        "只输出 JSON：{\"claims\":[{\"field\":\"…\",\"span\":\"…\"}]}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({ record: recordText.slice(0, MAX_RECORD_CHARS), fields }),
    },
  ];
}

/**
 * 小模型输出 → 可以删的片段。只收：字段号在清单里、片段 2–20 字且逐字在该字段里、片段（去标点后）不是病历原文的一部分。
 * 其余一律丢弃；整体不合法时返回 undefined。
 */
export function parsePatientClaimRemovals(
  content: unknown,
  fields: readonly PatientClaimField[],
  recordText: string,
): PatientClaimRemoval[] | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Json | undefined;
  try { parsed = record(JSON.parse(content)); } catch { return undefined; }
  if (!parsed || !Array.isArray(parsed.claims)) return undefined;
  const byId = new Map(fields.map((field) => [field.id, field.text]));
  const source = compact(recordText);
  const affirmed = compact(affirmedClinicalSourceClauses(recordText).join("，"));
  const removals: PatientClaimRemoval[] = [];
  for (const item of parsed.claims.slice(0, MAX_CLAIMS)) {
    const claim = record(item);
    const field = text(claim?.field);
    const span = text(claim?.span);
    const fieldText = byId.get(field);
    if (!fieldText || span.length < 2 || span.length > MAX_SPAN_CHARS || !fieldText.includes(span)) continue;
    const key = compact(span);
    // 片段是病历原文的一部分就不删——除非病历里它只以否认的形式出现（「无腹痛，发热，呕吐」里的「发热、呕吐」，2026-10-25 A056：
    //「发热、呕吐为湿浊内扰之象」因为四个字在病历里逐字出现而被放过）。读法用病历读法（recordedFindingReading），
    // 只解除保护，删不删仍由两次核对与复核决定。
    if (key.length < 2 || (source.includes(key) && !onlyDeniedInRecord(span, recordText))) continue;
    // 「有胸痛」「伴口苦」：去掉开头的「有/伴/见」后是病历里肯定写着的表现（「偶有心慌、胸痛」），不删。否认句里的不算（「无恶心呕吐」对「有呕吐」照删）。
    const core = key.replace(EXISTENCE_LEAD_IN, "");
    if (core.length >= 2 && core !== key && affirmed.includes(core)) continue;
    // 「以灼痛为主而非瘙痒」「本例为持续性胀痛而非阵发性电击样痛」：片段本身或分句里片段之前带「非」的，是与别的病、别的证作对照，不按本例说法删。
    const clauseStart = clauseStartOf(fieldText, fieldText.indexOf(span));
    if (/非/u.test(fieldText.slice(clauseStart, fieldText.indexOf(span) + span.length))) continue;
    // 缺项与鉴别意图说法（「未诉口渴」「未诉急躁易怒、口苦」「需与撕裂样痛鉴别」「单侧耳鸣需排除占位」）不是本例说法：从分句开头到片段所在
    // 顿号项结尾带这类标记的，不删。顿号后面别的项里的标记不算（「神志清、未诉肢冷」里的「神志清」照常核）。
    if (RECORD_GAP_MARKER.test(clauseThroughItem(fieldText, fieldText.indexOf(span), span.length))) continue;
    // 句末的「需排除X」「需与X鉴别」管整个分句（「乏力、抽筋、月经紊乱需排除甲减」里的「乏力」）。
    if (RECORD_CONSIDERATION_MARKER.test(clauseThroughItem(fieldText, fieldText.indexOf(span), span.length, true))) continue;
    // 「脱肛为直肠黏膜全层脱出、色淡红，本例为肛内肿物脱出」「心悸突发突止、发作时心率增快，本例监测未捕捉发作」：同一句里
    // 指本例的主语在片段之后、片段之前没有——片段写的是对照的那个病，不删。
    const sentenceStart = Math.max(...["。", "；", ";", "\n"].map((mark) => fieldText.lastIndexOf(mark, fieldText.indexOf(span) - 1))) + 1;
    const sentenceEnds = ["。", "；", ";", "\n"].map((mark) => fieldText.indexOf(mark, fieldText.indexOf(span) + span.length)).filter((index) => index >= 0);
    const sentenceStop = sentenceEnds.length > 0 ? Math.min(...sentenceEnds) : fieldText.length;
    if (!PATIENT_SELF_REFERENCE.test(fieldText.slice(sentenceStart, fieldText.indexOf(span) + span.length)) &&
        PATIENT_SELF_REFERENCE.test(fieldText.slice(fieldText.indexOf(span) + span.length, sentenceStop))) continue;
    // 西医鉴别的理由与区分要点多半在写那个病的特征（「心悸突发突止、发作时心率明显增快」「症状与进食体位相关」「化疗后进食差可致低钠」）：
    // 只核同一句里片段之前有「本例/患者」、或句子以「有/伴」起头（「有胸闷但未记录反酸烧心，胸痛与情绪相关」）的说法。
    if (/^differentials\[/u.test(field) && !PATIENT_SELF_REFERENCE.test(fieldText.slice(sentenceStart, fieldText.indexOf(span))) &&
        !/^\s*(?:有|伴)/u.test(fieldText.slice(sentenceStart))) continue;
    // 片段大半是病历原话（「心前区压迫不适非典型更年期表现」里的「心前区压迫不适」）：错的只是后面的推断，不按本例说法删。
    const shared = longestSharedRun(key, source);
    if (shared >= 4 && shared * 2 >= key.length && !onlyDeniedInRecord(span, recordText)) continue;
    if (!removals.some((removal) => removal.field === field && removal.span === span)) removals.push({ field, span });
  }
  return removals;
}

/** 片段里的表现在病历里只有否认的读法（每一项都读成 denied，至少一项）。 */
function onlyDeniedInRecord(span: string, recordText: string): boolean {
  const items = span.replace(EXISTENCE_LEAD_IN, "").split(/[、，,和及与]/u).map((item) => item.trim()).filter((item) => item.length >= 2);
  return items.length > 0 && items.every((item) => recordedFindingReading(recordText, item) === "denied");
}

const COMMA = /[，,]/u;

function clauseStartOf(value: string, at: number): number {
  let start = Math.max(0, at);
  while (start > 0 && !CLAUSE_DELIMITERS.includes(value[start - 1])) start -= 1;
  return start;
}

/** 从片段所在分句的开头，到片段所在顿号项的结尾（分句界：逗号、句号、分号、冒号、括号；项界：顿号）；wholeClause 时到分句结尾。 */
function clauseThroughItem(value: string, at: number, length: number, wholeClause = false): string {
  if (at < 0) return "";
  const start = clauseStartOf(value, at);
  let stop = at + length;
  while (stop < value.length && !CLAUSE_DELIMITERS.includes(value[stop]) && (wholeClause || value[stop] !== "、")) stop += 1;
  return value.slice(start, stop);
}

/** a 与 b 最长的公共连续片段长度。 */
function longestSharedRun(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + best + 1; j <= a.length; j += 1) {
      if (!b.includes(a.slice(i, j))) break;
      best = j - i;
    }
  }
  return best;
}

/**
 * 从一段文字里删掉一个片段的最小单位：片段紧挨着顿号（并列里的一项）时只删这一项和一个顿号；片段在顿号并列的某一项里面时
 * 删这一项（「长期典型劳力相关胸闷胸痛史、明确冠心病诊断」只删前一项）；否则删它所在的逗号分句，
 * 连带一个相邻逗号（分句是括号里唯一的内容时连括号一起删）。删后没有汉字了就原样返回（不把字段删空）。片段不在文中时原样返回。
 */
export function withoutClaimSpan(value: string, span: string): string {
  const at = span ? value.indexOf(span) : -1;
  if (at < 0) return value;
  const end = at + span.length;
  let next: string;
  // 片段所在的顿号并列项（项界：顿号或分句界）。
  let itemStart = at;
  while (itemStart > 0 && !CLAUSE_DELIMITERS.includes(value[itemStart - 1]) && value[itemStart - 1] !== "、") itemStart -= 1;
  let itemStop = end;
  while (itemStop < value.length && !CLAUSE_DELIMITERS.includes(value[itemStop]) && value[itemStop] !== "、") itemStop += 1;
  const inList = value[itemStart - 1] === "、" || value[itemStop] === "、";
  // 片段是并列的第一项、并列的谓语（否定、「在/为/属」）只写在这一项里、后面各项共用它（「疼痛不在背膂以上、尻骶或胯部，与背痛、尻痛相区分」）：
  // 删这一项会留下没有谓语的「尻骶或胯部」，删整句又丢了区分依据（2026-10-19 甲方标准病历 6 第三轮复测）。这种写法不删。
  if (inList && value[itemStart - 1] !== "、" && itemStart === at && itemStop === end) {
    let nextStop = itemStop + 1;
    while (nextStop < value.length && !CLAUSE_DELIMITERS.includes(value[nextStop]) && value[nextStop] !== "、") nextStop += 1;
    const nextItem = value.slice(itemStop + 1, nextStop);
    if (carriesListPredicate(span) && !carriesListPredicate(nextItem)) return value;
  }
  // 片段是这一项末尾、由「并/且/伴/而…」接上的那半句（「慢性胸闷乏力加重并放射至肩背」「肿物脱出不能还纳伴明显坠胀疼痛」）：
  // 只删连接词（连同紧跟的程度词）和片段。
  const linked = end === itemStop ? CLAUSE_LINKER_TAIL.exec(value.slice(itemStart, at)) : null;
  if (linked && linked.index > 0) {
    next = `${value.slice(0, itemStart + linked.index)}${value.slice(end)}`;
  } else if (inList && itemStart === at && itemStop > end && value[at - 1] === "、" && !/^[无不未没非]/u.test(span)) {
    // 片段是这一项的开头、后面接着判断（「痛剧、疱壁紧张属热毒」）：只删片段和它前面的顿号，判断接回前一项。
    // 片段以否定字开头时不用这条（「隐痛酸软、无定处刺痛及外伤史」只删「无定处刺痛」会剩下「及外伤史」，把否认变成肯定），删整项。
    next = `${value.slice(0, at - 1)}${value.slice(end)}`;
  } else if (inList) {
    // 删整项和一个相邻顿号（「恶寒重、发热轻、口不渴、涕清」→ 去掉「口不渴」；「长期典型劳力相关胸闷胸痛史、明确冠心病诊断」→ 去掉前一项）。
    next = value[itemStop] === "、"
      ? `${value.slice(0, itemStart)}${value.slice(itemStop + 1)}`
      : `${value.slice(0, itemStart - 1)}${value.slice(itemStop)}`;
  } else {
    let start = at;
    while (start > 0 && !CLAUSE_DELIMITERS.includes(value[start - 1])) start -= 1;
    let stop = end;
    while (stop < value.length && !CLAUSE_DELIMITERS.includes(value[stop])) stop += 1;
    const opener = value[start - 1];
    const closer = value[stop];
    if ((opener === "（" && closer === "）") || (opener === "(" && closer === ")")) {
      next = `${value.slice(0, start - 1)}${value.slice(stop + 1)}`;
    } else if (closer && COMMA.test(closer)) {
      next = `${value.slice(0, start)}${value.slice(stop + 1)}`;
    } else if (start > 0 && COMMA.test(value[start - 1])) {
      next = `${value.slice(0, start - 1)}${value.slice(stop)}`;
    } else {
      // 句首或句末分句：连同它后面的句号/分号一起删（句中则由前一个分句的标点收尾）。
      next = `${value.slice(0, start)}${value.slice(closer && /[。；;]/u.test(closer) && start === 0 ? stop + 1 : stop)}`;
    }
  }
  next = next
    .replace(/([（(])[，,、]+/gu, "$1")
    .replace(/[，,、]+([）)])/gu, "$1")
    .replace(/[，,]{2,}/gu, "，")
    .replace(/([；;])[；;]+/gu, "$1")
    .replace(/、{2,}/gu, "、")
    .replace(/([。；;：:])[，,、]+/gu, "$1")
    .replace(/[，,、]+([。；;])/gu, "$1")
    .replace(/[；;]+([。])/gu, "$1")
    .replace(/^[，,、。；;：:]+/u, "")
    .trim();
  next = withoutOrphanedAnaphoricTail(value, next);
  return /[㐀-鿿]/u.test(next) ? next : value;
}

/**
 * 删掉一个分句后，紧挨着它的尾句只剩「故与二者相区分」这类回指被删内容的话时，连这条尾句一起删（2026-10-19 X-C-0159：
 * 「…属产后小便淋痛；故与二者相区分。」——「二者」指的是被删掉的那两条鉴别，留下的尾句没有所指）。
 * 两个条件同时成立才删：尾句整条只有「（故/因此/所以）（与/同/和）二者/两者/上述各病 …区分/鉴别」这一个回指；
 * 且尾句前面紧挨着的那个分句，删之前和删之后不是同一个（被删的正是它的所指）。删的是别处、或删之前就这样写的，不动。
 */
function clauseBefore(text: string, at: number): string {
  const head = text.slice(0, at).replace(/[，,、；;。\s]+$/u, "");
  const cut = Math.max(...["，", ",", "、", "；", ";", "。"].map((mark) => head.lastIndexOf(mark)));
  return head.slice(cut + 1);
}
export function withoutOrphanedAnaphoricTail(before: string, after: string): string {
  if (before === after) return after;
  for (const match of after.matchAll(/[^。；;，,]+[。；;，,]?/gu)) {
    const unit = match[0];
    const core = unit.replace(/[。；;，,\s]+$/u, "").trim();
    if (!ORPHAN_ANAPHORIC_TAIL.test(core)) continue;
    const at = match.index ?? 0;
    const beforeAt = before.indexOf(unit);
    if (beforeAt < 0 || clauseBefore(before, beforeAt) === clauseBefore(after, at)) continue;
    const head = after.slice(0, at).replace(/[；;，,]+$/u, "");
    const tail = after.slice(at + unit.length);
    const terminal = /[。；;，,]$/u.test(unit) ? unit.slice(-1) : "";
    return `${head}${terminal}${tail}`.trim();
  }
  return after;
}

/** 把片段删除落到一半的 JSON 上（纯函数，原地改 root）。片段已不在字段里的跳过；返回实际删了几处。 */
export function applyPatientClaimRemovals(root: Json, half: PatientClaimHalf, removals: readonly PatientClaimRemoval[]): number {
  if (removals.length === 0) return 0;
  const slots = new Map(fieldSlots(root, half).map((slot) => [slot.id, slot]));
  let applied = 0;
  for (const { field, span } of removals) {
    const slot = slots.get(field);
    if (!slot) continue;
    const current = slot.read();
    if (!current.includes(span)) continue;
    const next = withoutClaimSpan(current, span);
    if (next !== current) {
      slot.write(next);
      applied += 1;
    }
  }
  return applied;
}

/** 内容（一半的 JSON 串）上落实删除；解析失败或没删任何东西时原样返回。 */
export function applyPatientClaimRemovalsToContent(content: string, half: PatientClaimHalf, removals: readonly PatientClaimRemoval[]): string {
  if (removals.length === 0) return content;
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return content; }
  if (!root) return content;
  return applyPatientClaimRemovals(root, half, removals) > 0 ? JSON.stringify(root) : content;
}

/**
 * 两次独立核对都标到的片段才删（同一字段，一个片段包含另一个，取较短的）。
 * 离线 102 例：单次核对的误判多是把病历原话的换说法当成无据（「左侧胁肋部」与「沿一侧分布」、「1月前…胸痛」与「胸痛1月内加重」），
 * 这类判断在两次核对之间不稳定；真正无据的说法（「口不渴」「胸痛与情绪相关」「3月龄后起病」）两次都标。
 */
export function agreedPatientClaimRemovals(first: readonly PatientClaimRemoval[], second: readonly PatientClaimRemoval[]): PatientClaimRemoval[] {
  const agreed: PatientClaimRemoval[] = [];
  for (const a of first) {
    const match = second.find((b) => b.field === a.field && (a.span.includes(b.span) || b.span.includes(a.span)));
    if (!match) continue;
    const span = a.span.length <= match.span.length ? a.span : match.span;
    if (!agreed.some((item) => item.field === a.field && item.span === span)) agreed.push({ field: a.field, span });
  }
  return agreed;
}

/**
 * 交给复核的片段：两次都标到的，加上只有一次标到、但写成否定或无关的说法（「腹不胀大」「非时聚时散」「与咳唾呼吸无关」
 *「大便不酸臭」「未见膨隆」）。2026-10-19 Claude 评审 M 集：鉴别区分点里这类病历没写的阴性 16 处判不合格，两次核对各标到一半，
 * 交集把它们全丢了。复核一步只问「病历写没写到」，否定说法病历没写就是没写，误判面窄；肯定说法仍要两次一致。
 *
 * eitherPass（CDSS_M03_PATIENT_CLAIM_EITHER_PASS=true，缺省关）：肯定说法也只要有一次标到就交给复核（2026-10-19 晚第八轮，待主控实测）。
 * 动机：「病历已有的主词 + 病历没有的限定」（身黄→黄色鲜明、发热→壮热）两次核对常常一次标到一次漏掉（遥测里有「first: 3, second: 0」），
 * 交集把它们丢了；复核是最后一道关，同义写法在复核里会判「写到了」。代价是复核条数变多。
 */
export function patientClaimCandidatesForVerification(
  first: readonly PatientClaimRemoval[],
  second: readonly PatientClaimRemoval[],
  options: { eitherPass?: boolean } = {},
): PatientClaimRemoval[] {
  const candidates = agreedPatientClaimRemovals(first, second);
  for (const item of [...first, ...second]) {
    if (!options.eitherPass && !negativeFormClaim(item.span)) continue;
    if (candidates.some((existing) => existing.field === item.field && (existing.span.includes(item.span) || item.span.includes(existing.span)))) continue;
    candidates.push({ field: item.field, span: item.span });
  }
  return candidates;
}

/**
 * 第二道：逐条复核「病历里有没有写到这句话的全部内容」（2026-10-19）。两次核对都标到、病历里却有同义写法或术语化写法的（「红斑风团」与
 *「风团色红」、「心痛如绞」与「压榨样胸痛」、「小便频数清」与「小便清长」）在留出集里占误删的大半；这一步只问一件事，复核说「写到了」就不删。
 * 只写到一部分（病历「隐痛」、说法「双侧隐痛」）照删。
 */
export function buildPatientClaimVerificationMessages(recordText: string, claims: readonly { span: string; context: string }[]) {
  return [
    {
      role: "system" as const,
      content: [
        "你是病历核对员。给你一份门诊病历（record，首行是性别、年龄、生命体征）和几条从辨病辨证结论里摘出的、关于本例患者的说法（claims，每条附它所在的那句话 context）。",
        "逐条判断：病历里有没有写到这条说法的全部内容——同义的说法、术语化的说法（病历描述换成中医或西医术语，如“心痛如绞”与“绞痛”、“红斑风团”与“风团色红”、“不想吃饭”与“纳呆”、“手脚发麻”与“四肢麻木”）、几处合起来能得出的，都算写到了。",
        "只有说法里多出了病历根本没有的内容——新的症状、部位、侧别、性质、程度（病历“发热”，说法“壮热”）、颜色或性状（病历“身黄”，说法“黄色鲜明”）、固定与否、诱因、起病时间、与某事的关系、“正常/如常/清楚”这类判断——才算 partial 或 absent。",
        "- supported：写到了全部内容，quote 给出病历里的原文（逐字复制，不超过40字）；",
        "- partial：只写到一部分（如病历只写“隐痛”，说法是“双侧隐痛”；病历只写“胃脘不适”，说法是“胃脘痞闷”）；",
        "- absent：没写到，或与病历写的相反。",
        "只输出 JSON：{\"items\":[{\"id\":0,\"verdict\":\"supported|partial|absent\",\"quote\":\"…\"}]}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        record: recordText.slice(0, MAX_RECORD_CHARS),
        claims: claims.map((claim, id) => ({ id, claim: claim.span, context: claim.context.slice(0, 120) })),
      }),
    },
  ];
}

/** 复核输出 → 判「写到了」的条目编号。整体不合法时返回 undefined（不删任何一条）。 */
export function parsePatientClaimVerification(content: unknown, count: number): Set<number> | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: Json | undefined;
  try { parsed = record(JSON.parse(content)); } catch { return undefined; }
  if (!parsed || !Array.isArray(parsed.items)) return undefined;
  const supported = new Set<number>();
  const answered = new Set<number>();
  for (const item of parsed.items) {
    const entry = record(item);
    const id = typeof entry?.id === "number" ? entry.id : Number.NaN;
    if (!Number.isInteger(id) || id < 0 || id >= count) continue;
    const verdict = text(entry?.verdict);
    if (!["supported", "partial", "absent"].includes(verdict)) continue;
    answered.add(id);
    if (verdict === "supported") supported.add(id);
  }
  // 漏答的条目按「写到了」处理（不删）：复核没给结论的不能当成无据。
  for (let id = 0; id < count; id += 1) if (!answered.has(id)) supported.add(id);
  return supported;
}

async function patientClaimPass(
  task: string,
  messages: ReturnType<typeof buildPatientClaimMessages>,
  fields: readonly PatientClaimField[],
  recordText: string,
  signal?: AbortSignal,
): Promise<PatientClaimRemoval[] | undefined> {
  const config = getControlledTerminologyModelConfig();
  return memoizedSmallTask<PatientClaimRemoval[] | undefined>(task, smallTaskMemoKey([config.model, messages]), async () => {
    // 计算不绑在某一个调用方的中止信号上（同一份输入的其他调用方可能并入这次计算）；调用方中止由 memoizedSmallTask 处理。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task, stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 400,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parsePatientClaimRemovals(response.choices[0]?.message?.content, fields, recordText);
      return { value, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

/**
 * 对一半的内容做核对，返回可删的片段（不改内容，便于与同一半的其他收口并行、再按顺序落实）。
 * 两次核对并行（字段顺序一正一反），只取两次都标到的，外加只标到一次的否定说法（patientClaimCandidatesForVerification）；有标到的再逐条复核一次，复核说病历写到了的不删。
 * 关闭、没有字段、未配置、任一次超时或输出非法都返回空数组。
 */
export async function decidePatientClaimRemovals(
  content: string,
  context: { recordText: string },
  half: PatientClaimHalf,
  signal?: AbortSignal,
): Promise<PatientClaimRemoval[]> {
  if (!patientClaimCheckEnabled() || signal?.aborted) return [];
  let root: Json | undefined;
  try { root = record(JSON.parse(content)); } catch { return []; }
  if (!root) return [];
  const fields = patientClaimFields(root, half);
  const recordText = context.recordText.trim();
  if (fields.length === 0 || !recordText) return [];
  if (!getControlledTerminologyModelConfig().configured) return [];
  const task = `m03_patient_claim_${half}`;
  const [first, second] = await Promise.all([
    patientClaimPass(task, buildPatientClaimMessages(recordText, fields), fields, recordText, signal),
    patientClaimPass(task, buildPatientClaimMessages(recordText, [...fields].reverse()), fields, recordText, signal),
  ]);
  const agreed = first && second
    ? patientClaimCandidatesForVerification(first, second, { eitherPass: process.env.CDSS_M03_PATIENT_CLAIM_EITHER_PASS === "true" })
    : undefined;
  let removals = agreed;
  if (agreed && agreed.length > 0) {
    const byId = new Map(fields.map((field) => [field.id, field.text]));
    const claims = agreed.map(({ field, span }) => {
      const fieldText = byId.get(field) || "";
      const at = fieldText.indexOf(span);
      const sentenceStart = Math.max(...["。", "；", ";"].map((mark) => fieldText.lastIndexOf(mark, at - 1))) + 1;
      const ends = ["。", "；", ";"].map((mark) => fieldText.indexOf(mark, at + span.length)).filter((index) => index >= 0);
      return { span, context: fieldText.slice(sentenceStart, ends.length > 0 ? Math.min(...ends) : fieldText.length) };
    });
    const supported = await patientClaimVerification(`${task}_verify`, buildPatientClaimVerificationMessages(recordText, claims), claims.length, signal);
    removals = supported ? agreed.filter((_, index) => !supported.has(index)) : undefined;
  }
  console.info("[tcm-cdss:telemetry] m03_patient_claim_check", {
    half,
    fields: fields.length,
    first: first?.length ?? "unavailable",
    second: second?.length ?? "unavailable",
    agreed: agreed?.length ?? "unavailable",
    removals: removals?.length ?? "unavailable",
  });
  return removals ?? [];
}

async function patientClaimVerification(
  task: string,
  messages: ReturnType<typeof buildPatientClaimVerificationMessages>,
  count: number,
  signal?: AbortSignal,
): Promise<Set<number> | undefined> {
  const config = getControlledTerminologyModelConfig();
  const ids = await memoizedSmallTask<number[] | undefined>(task, smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task, stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 400,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parsePatientClaimVerification(response.choices[0]?.message?.content, count);
      return { value: value ? [...value] : undefined, cacheable: Boolean(value) };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
  return ids ? new Set(ids) : undefined;
}
