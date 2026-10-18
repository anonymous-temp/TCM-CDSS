import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { westernLabelContainsTcmSyndrome } from "./clinical-governance-tables";
import { westernCriteriaEntry, westernCriteriaPromptValue, westernCriteriaReference, westernNameWithoutCourseOrSideQualifier } from "./western-diagnostic-criteria.server";

/**
 * 参考西医诊断名与病历已记录内容的一致性核对（2026-10-14）。
 *
 * 要解决的是这一类：病名与病历已经写明的内容直接矛盾，或说得过头——家属明确说夜间无打鼾憋气，诊断写睡眠呼吸暂停低通气综合征；
 * 月经周期规律、只有一次 AMH 偏低，写早发性卵巢功能不全；能进食、尿量正常、酮体阴性，写妊娠剧吐；肛门镜见痔核脱出，写直肠脱垂。
 * 独立评审里西医诊断不通过的病例属于这一类。
 *
 * 为什么不改生成侧：上一轮在西医半提示词里加过「下病名前先对照检查结果」，三例复跑不变；本轮试过让模型在病名之前先写一栏
 *「检查结果→意义」，模型对检查的解读是对的，病名照旧，而且首轮结构违规从 0/190 升到 30/40（漏写鉴别、依据写成对象）。
 * 相关研究的结论是一致的：模型「知道标准」不等于「用上标准」，要它定位自己的错很难，把具体位置指给它之后改起来却很准；
 * 泛化的复核模型会过度挑错（本项目 9/16 删掉的复核环节 84% 打回）。所以这里只问一件窄事、只在三种情形下成立，
 * 并且要交出病历原文片段，服务端逐字核对后才采信。
 *
 * 离线实测（已落盘的 252 例辨证结果）：合成 190 例标出 9–10 例（两次运行一致 9 例），其中 7 例确属矛盾或说过头、1 例为误报
 *（静息心电图 T 波低平被当成不支持冠心病）；甲方既往 52 例与标准 10 例标出 0 例。单次约 0.8 秒，与中医半并行。
 *
 * 第四种情形 D（2026-10-17，owner 定的口径「没有关键检查时写上一级病名」）：名称比病历能支撑的更具体——按公认标准须靠某项
 * 检查（缺铁性贫血要铁代谢、甲减要甲功、慢性胃炎要胃镜、PCOS 要鹿特丹两项）或病程门槛（功能性消化不良/肠易激/功能性便秘起病满
 * 6 个月）才成立，而病历两样都没有。上一版明文规定「没做检查不算矛盾」，留出集评审西医诊断 72% 不通过的主体正是这一类（缺铁性贫血
 * 只有血红蛋白、病程两周写功能性消化不良、超声激素都正常写 PCOS）。离线实测（已落盘 272 份辨证结果，两次运行）：合成 190 例标出
 * 29–30 例、既往 52 例 16–17 例、甲方标准 10 例 × 3 次 5–6 次，两次运行各集合只差 1 例；逐条读过，多数属实，存疑的都是降一级的
 * 温和改名（失血性贫血→贫血）。第一版提示词把病程两年的功能性消化不良也判不够、把有反酸的胃食管反流病和产后贫血判过度具体、并把
 * 雷击样头痛的蛛网膜下腔出血改成「待查」，所以提示词写明了时间门槛与临床可诊断的病，红旗病例另由服务端整条不用 D（见 redFlag）。
 *
 * 边界：
 *  · 只改病名这一项：采信后 primary.name 换成核对给出的名称（更宽一层、更轻一层，或「症状＋待查」），原病名留在候选与鉴别里；
 *  · 不产生新的患者事实，不参与任何安全判断；病名之后的编码、术语归一、签名照常走既有链路；
 *  · 超时、未配置、输出非法、引文不在病历里、给出的名称不合规，一律不采信（保持模型原样）；
 *  · temperature 0，按请求内容缓存，同一份病历得到同一结论。
 * 开关：CDSS_WESTERN_NAME_EVIDENCE_CHECK=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.WESTERN_NAME_EVIDENCE_CHECK_TIMEOUT_MS || 5_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 5_000;
})();
const MAX_RECORD_CHARS = 2_400;

function enabled(): boolean {
  return process.env.CDSS_WESTERN_NAME_EVIDENCE_CHECK !== "false";
}

const compact = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

export type WesternNameCorrection = {
  supportedName: string;
  quote: string;
  reason: string;
  type: "A" | "B" | "C" | "D";
  /** 核对模型判断原诊断名属急危重症（只在为真时出现）。红旗病例上据此不把急危重病名改成别的写法（见 alignWesternNameWithRecord）。 */
  currentIsEmergency?: true;
  /** 改成的名称是西医半自己列在候选或鉴别里的病（只在为真时出现）。 */
  adoptedFromList?: true;
};

// 核对给出的名称只能是一个干净的病名：不带括号、并列与推测语气（标点与语气词是写法检查）；中医证候字样由合同的同一判据
// westernLabelContainsTcmSyndrome（西医主诊断不得带证候）判定，不在这里另写一张词表。
// 「主要症状＋待查」是提示词旧版里的格式说明，模型曾逐字照抄成病名（验收集 X-D-4595、X-D-4660）：带格式词的名称不采信。
const INVALID_SUPPORTED_NAME_FORM = /[（）()\/、，,；;：:？?＋+]|或|可能|疑似|待排|主要症状/;

/** 名称是不是一个干净的病名（不带括号、并列、推测语气、证候字样）。西医主诊断的闭集重选（western-primary-reselect）用同一判据。 */
export function isCleanWesternDiagnosisName(name: string): boolean {
  const value = name.trim();
  return value.replace(/待查$/u, "").length >= 2 && value.length <= 30 && !INVALID_SUPPORTED_NAME_FORM.test(value) &&
    !westernLabelContainsTcmSyndrome(value) && !/证$/.test(value) && /[一-龥]/.test(value);
}

/** 西医半自己列出的候选与鉴别病名（不含主诊断本身），给核对与闭集重选当名单。 */
export function listedWesternDiagnosisNames(western: unknown): string[] {
  const root = record(western);
  const primaryName = typeof record(root?.primary)?.name === "string" ? String(record(root?.primary)?.name).trim() : "";
  const names = [...(Array.isArray(root?.candidates) ? root.candidates : []), ...(Array.isArray(root?.differentials) ? root.differentials : [])]
    .map((item) => (typeof record(item)?.name === "string" ? String(record(item)?.name).trim() : ""))
    .filter((item) => item && compact(item) !== compact(primaryName));
  return [...new Set(names)].slice(0, 12);
}

/** 原名去掉核对给出的上一级之后仍包含它（「神经源性休克」⊃「休克」、「大量心包积液」⊃「心包积液」）：说的还是同一类病。 */
function namesSameDiseaseFamily(broader: string, current: string): boolean {
  const core = compact(broader.replace(/待查$/u, ""));
  return core.length >= 2 && core !== compact(current) && compact(current).includes(core);
}

/** 模型输出 → 可采信的改名（否则 undefined）。引文必须逐字在病历里；名称必须合规且与原名不同。 */
export function parseWesternNameCorrection(
  content: unknown,
  recordText: string,
  currentName: string,
  options: { listedNames?: readonly string[] } = {},
): WesternNameCorrection | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { verdict, type, quote, reason, supportedName, emergencyName } = parsed as Record<string, unknown>;
  if (verdict !== "inconsistent" || (type !== "A" && type !== "B" && type !== "C" && type !== "D")) return undefined;
  const name = typeof supportedName === "string" ? supportedName.trim() : "";
  const quoted = typeof quote === "string" ? quote.trim() : "";
  const why = typeof reason === "string" ? reason.trim().replace(/[。；;]+$/u, "") : "";
  if (name.replace(/待查$/u, "").length < 2 || name.length > 30 || INVALID_SUPPORTED_NAME_FORM.test(name) || westernLabelContainsTcmSyndrome(name) || /证$/.test(name) || !/[一-龥]/.test(name)) return undefined;
  if (compact(name) === compact(currentName)) return undefined;
  // D 类（缺确诊检查或病程）指不出更宽一层的病名、只能写「症状待查」时，留住原来的首要考虑、写成「原病名待查」（2026-10-18）。
  // 改成症状会把首要考虑挤进鉴别：验收集 X-D-4595 多发性骨髓瘤→「腰痛待查」、X-D-4660 先天性甲减→「便秘待查」、
  // X-D-2054 慢性胰腺炎→「腹胀」。病历里「肺癌待查」「结核待查」本来就是这么写的：点出首要考虑，同时说明未确诊。
  const current = currentName.trim();
  // 靠病程门槛定义的病（功能性消化不良要 6 个月）没到病程时，「原病名待查」仍是越级：甲方病历 4 半个月写成「功能性消化不良待查」，
  // 复核判越过罗马 IV（2026-10-18）。这类沿用核对给的上一级或症状名，只给「缺确诊检查」的病留住首要考虑。
  const courseDefined = Boolean(westernCriteriaEntry(current)?.durationThreshold) || /病程|个月|周|时长|持续时间/u.test(why);
  // A、B 类：病历记录的检查所见本身指向西医半自己列出的另一个病（活检见钉突→膜性肾病、超声「落雪状」→葡萄胎、扩容后中心静脉压高→
  // 心源性休克）时，直接改成那个病（2026-10-19）。此前只许写「症状待查」，验收集 11 次 A–C 改名 11 次评审不通过，多数是核对
  // 指出了原名不对、却交出「肾病综合征待查」「妊娠待查」这种更差的名称。只认名单里逐字有的病名：不产生西医半没有提出过的诊断。
  const adoptedFromList = (type === "A" || type === "B") && !/待查$/u.test(name) &&
    (options.listedNames || []).some((item) => compact(item) === compact(name));
  // D 类核对给的是原名的上一级（「大量心包积液」→「心包积液待查」、「低钾性周期性麻痹」→「周期性麻痹待查」）时用它，不再换回
  //「原病名待查」——那会把说过头的那部分又带回来（验收集 X-D-1053、X-D-4969，2026-10-19）。
  const keepHypothesis = type === "D" && /待查$/u.test(name) && !/待查$/u.test(current) && !courseDefined &&
    !namesSameDiseaseFamily(name, current) &&
    current.length >= 2 && current.length <= 24 && !INVALID_SUPPORTED_NAME_FORM.test(current);
  // A、B 类给的上一级只是去掉了病程限定或侧别（「急性尿潴留」→「尿潴留待查」）时，上一级本身有依据，不再挂「待查」（验收集 X-D-0204）。
  const qualifierOnly = (type === "A" || type === "B") && /待查$/u.test(name) &&
    westernNameWithoutCourseOrSideQualifier(current) === name.replace(/待查$/u, "");
  const supported = keepHypothesis ? `${current}待查` : qualifierOnly ? name.replace(/待查$/u, "") : name;
  if (compact(quoted).length < 4 || compact(quoted).length > 60 || !compact(recordText).includes(compact(quoted))) return undefined;
  if (why.length < 4 || why.length > 60) return undefined;
  return {
    supportedName: supported, quote: quoted, reason: why, type,
    ...(emergencyName === true ? { currentIsEmergency: true as const } : {}),
    ...(adoptedFromList ? { adoptedFromList: true as const } : {}),
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/**
 * 把采信的改名写进西医半的输出：主诊断换名，原病名留在候选（A–C 标明不支持它的那句病历原文）与鉴别（核对给出的理由）里。
 * 只动这三处；解析不了或没有主诊断时原样返回。
 */
export function applyWesternNameCorrection(westernContent: string, correction: WesternNameCorrection): string {
  let parsed: unknown;
  try { parsed = JSON.parse(westernContent); } catch { return westernContent; }
  const root = record(parsed);
  const western = record(root?.westernDiagnosis);
  const primary = record(western?.primary);
  const previous = typeof primary?.name === "string" ? primary.name.trim() : "";
  if (!root || !western || !primary || !previous) return westernContent;
  primary.name = correction.supportedName;
  // 「原病名待查」：首要考虑没有换，只是标明未确诊。候选首位改名即可，不再另列原病名，鉴别里也不重复它。
  const hypothesisKept = correction.supportedName === `${previous}待查`;
  const candidates = Array.isArray(western.candidates) ? western.candidates.filter((item): item is Json => Boolean(record(item))) : [];
  if (candidates.length > 0) {
    const others = candidates.filter((item) => item.name !== previous && item.name !== correction.supportedName);
    const lead = candidates.find((item) => item.name === previous) || candidates[0];
    // 改成西医半自己列过的病时，首位用它自己那一条（带它自己的支持与反对依据），不把原病名的依据挪给它。
    const adopted = correction.adoptedFromList ? candidates.find((item) => item.name === correction.supportedName) : undefined;
    western.candidates = hypothesisKept ? [{ ...lead, name: correction.supportedName }, ...others].slice(0, 3) : [
      adopted ? { ...adopted } : { ...lead, name: correction.supportedName },
      // D 类没有与原病名相反的记录，只是还没有确诊它的检查或病程：不把引文（支撑上一级病名的那句）写成反对依据。
      correction.type === "D"
        ? { name: previous, likelihood: "中", keyEvidence: [], againstEvidence: [] }
        : { name: previous, likelihood: "低", keyEvidence: [], againstEvidence: [correction.quote] },
      ...others,
    ].slice(0, 3);
  }
  const differentials = Array.isArray(western.differentials) ? western.differentials.filter((item): item is Json => Boolean(record(item))) : [];
  if (!hypothesisKept && !differentials.some((item) => item.name === previous)) {
    western.differentials = [
      correction.type === "D"
        // 模型写的理由常以「无/未记录…检查」开头，放进鉴别要点后会被当成对患者的否认、再被改写成「病历未记录…（需问诊核实…）」
        //（2026-10-17 本地复测病历 7）。这里说的是缺哪项检查，开头换成「尚缺」。
        ? { name: previous, reason: "尚未取得确诊所需的检查或病程依据", distinguishingPoints: correction.reason.replace(/^(?:病历)?(?:未记录|未见|无|缺少|缺乏|没有)/u, "尚缺"), nextCheck: "完善确诊所需检查" }
        : { name: previous, reason: "与病历记录不符", distinguishingPoints: correction.reason, nextCheck: "必要时完善相关检查" },
      ...differentials.filter((item) => item.name !== correction.supportedName),
    ].slice(0, 8);
  } else if (correction.adoptedFromList) {
    // 原病名已在鉴别里：只把升为主诊断的那个病从鉴别里拿掉。
    western.differentials = differentials.filter((item) => item.name !== correction.supportedName);
  }
  return JSON.stringify(root);
}

export async function westernNameCorrectionForRecord(
  input: { recordText: string; diagnosisName: string; patient?: { sex?: unknown; age?: unknown }; listedNames?: readonly string[] },
  signal?: AbortSignal,
): Promise<WesternNameCorrection | undefined> {
  if (!enabled() || signal?.aborted) return undefined;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return undefined;
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  const diagnosisName = input.diagnosisName.trim();
  // 已经停在症状层面的名称（「头痛待查」）没有可核对的病种。
  if (!recordText.trim() || diagnosisName.length < 2 || /待查$/.test(diagnosisName)) return undefined;
  const criteria = westernCriteriaPromptValue(await westernCriteriaReference(diagnosisName, signal).catch(() => undefined));
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是病历与诊断名的一致性核对器，不负责重新诊断，也不评价诊断是否最优。",
        "任务：给你一份门诊病历和系统拟定的“参考西医诊断”名称。只判断一件事：病历里**已经记录**的内容，是否与这个诊断名直接矛盾，或不足以支撑这个名称说到的具体程度。",
        "判 inconsistent 仅限以下四种情况：",
        "A. 该病成立时本应阳性的检验/检查，病历已经做了并记录为阴性、正常或未见（如诊断为某种感染，病历记录的病原学检查未见病原体）；或病历记录的检查所见明确指向另一个病。",
        "B. 该诊断名有定义性的必备条件，而病历已记录的事实与之相反（如诊断要求闭经或月经稀发，病历写月经周期规律；诊断的核心表现病历明确写了没有）；或该病的诊断标准要求同时满足几项中的若干项，而病历已把其余各项记录为阴性或正常，满足的项数不够。",
        "C. 诊断名说的是较重的一层（“功能不全”“衰竭”“剧吐”“重度”等需要特定指标或程度才成立的名称），而病历记录的指标、程度只够得上较轻的一层。",
        "D. 诊断名比病历能支撑的更具体：按公认诊断标准，这个名称必须依赖某项检查结果才能成立，或必须满足病程门槛，而病历里既没有记录这项检查的结果，已记录的病程也够不上门槛。典型的如：缺铁性贫血、巨幼细胞贫血等指明贫血类型的名称需要相应检查（只有血红蛋白只能说贫血）；多囊卵巢综合征需要鹿特丹标准三项中至少两项；甲状腺功能减退症、糖尿病等以化验定义的病需要相应化验结果；慢性胃炎、消化性溃疡需要胃镜；骨质疏松症需要骨密度或影像；某种特定病原体感染需要病原学结果；功能性消化不良、肠易激综合征、功能性便秘的时间门槛是起病至今满6个月——病程写满6个月（半年、1年、2年都算）就满足，不要求病历另写“持续3个月”，也不要求做过胃镜；没满6个月时 supportedName 写“消化不良待查”“便秘待查”这类上一级名称（不写成单个症状）；肠易激综合征还必须有腹痛；牙病的分型名称（急性牙髓炎、慢性牙髓炎、急性根尖周炎、牙周脓肿、智齿冠周炎等）需要口腔专科检查（牙髓活力或冷热测试、叩诊、牙周探诊、X线）才能分型，病历没有口腔检查记录时只能写“牙痛”。",
        "以下情况一律判 consistent：门诊常见病按典型临床表现即可诊断、诊断标准本来不要求某项检查（如上呼吸道感染、急性支气管炎、急性胃肠炎、带状疱疹、荨麻疹、湿疹、偏头痛、紧张型头痛、失眠障碍、腰肌劳损、原发性痛经；有烧心或反酸、反流症状的胃食管反流病；有典型发作性胸痛的心绞痛或冠心病；有长期饮酒史并有肝脏影像或肝功能异常的酒精性肝病），这时没做检查不算问题；贫血按病历已记录的原因命名（产后贫血、失血性贫血、月经过多所致贫血）不算过度具体；名称是急危重症（如蛛网膜下腔出血、急性心肌梗死、主动脉夹层、异位妊娠、脑卒中、休克）时不适用 D；检查只有非特异性改变、不能确诊也不能排除；结果正常但该病在此阶段结果本来就可以正常（如痛风急性发作期血尿酸可以正常、冠心病静息心电图可以正常）；病历里写明的既往确诊（如“高血压病史10年”“胃镜示慢性胃炎”）；你只是觉得另一个诊断更可能。拿不准时判 consistent。",
        "判 inconsistent 时给出：quote（A、B、C 写病历里与之矛盾的那句原文；D 写病历里支撑上一级病名的那句原文；逐字复制，不超过40字）、reason（一句话说明为什么不符或缺什么，≤30字）和 supportedName。supportedName 只能是下面两种之一：① 比原诊断更宽一层或更轻一层、现有记录已经够得上的规范病名（如“贫血”“月经稀发”“消化不良”“妊娠呕吐”“关节炎”“牙痛”）；② 指不出这样的病名时：D 类写原诊断名加“待查”（如“多发性骨髓瘤待查”，表示首要考虑不变、尚未确诊）；A、B、C 类写病历里最主要的症状加“待查”（如“关节痛待查”“血尿待查”）。不得换成病历同样没有证实的另一个具体病种，不得写比原诊断更重的名称，不带括号和解释。",
        // 2026-10-19：A、B 类允许改成西医半自己列出的、病历检查所见已经指向的那个病（服务端只认名单里逐字有的名称）；
        // 「上一级」本身有依据时不挂「待查」；另报原名是否急危重症，红旗病例据此不把急危重病名改掉。
        "例外：A、B 类里，病历记录的检查所见本身就是另一个病的确诊依据或特征性表现（如活检、典型影像征象、确诊性化验），而这个病就在输入的 listedDiagnoses 里时，supportedName 直接写这个病（逐字照抄名单里的写法），quote 写那句检查所见。上一级病名本身已有记录支持时（如“急性尿潴留”的上一级“尿潴留”）不要再加“待查”。",
        "另给出 emergencyName：原诊断名属于需要立即处理的急危重症（如急性心肌梗死、急性胰腺炎、消化道穿孔、休克、异位妊娠、脑卒中、主动脉夹层、颅内血肿）时为 true，否则为 false。",
        // 2026-10-18：诊断标准要点来自受治理要点表或权威页面的检索摘要（western-diagnostic-criteria.server.ts），让情形 D 不再只靠上面手写的十几个病。
        "如果输入里给了 criteria（该诊断名的诊断标准要点，摘自诊疗手册、指南等权威来源）：clinicallyDiagnosable 为 true 的病按典型临床表现即可诊断，不适用 D；requiredTests 不为空时，病历里没有其中任何一项检查的结果、也不是病历写明的既往确诊，才符合 D；durationThreshold 写了病程门槛时按它判断病程够不够；definingFeatures 是定义性表现，病历已记录与之相反时属 B。criteria 里是检索摘录（searchExcerpts）时，只把摘录里明确写出的必需检查或病程门槛当依据。criteria 与上面的通则冲突时以上面的通则为准（急危重症不用 D、病历写明的既往确诊不算）。没有 criteria 时按上面的通则判断。",
        "只输出 JSON：{\"verdict\":\"consistent|inconsistent\",\"type\":\"A|B|C|D|\",\"quote\":\"…\",\"reason\":\"…\",\"supportedName\":\"…\",\"emergencyName\":true|false}",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        patient: { sex: input.patient?.sex ?? null, age: input.patient?.age ?? null },
        record: recordText,
        diagnosisName,
        ...(criteria ? { criteria } : {}),
        ...(input.listedNames && input.listedNames.length > 0 ? { listedDiagnoses: [...input.listedNames] } : {}),
      }),
    },
  ];
  return memoizedSmallTask<WesternNameCorrection | undefined>("western_name_evidence_check", smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task: "western_name_evidence_check", stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: 220,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const content = response.choices[0]?.message?.content;
      return { value: parseWesternNameCorrection(content, recordText, diagnosisName, { listedNames: input.listedNames }), cacheable: typeof content === "string" && content.trim().length > 0 };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, undefined, signal);
}

/**
 * 西医半返回后的收口：核对病名，采信则改写西医半的输出；任何失败都原样返回。
 * redFlag：确定性闸门判了红旗时不用情形 D——急危重的病名（蛛网膜下腔出血、异位妊娠）在检查出来之前本来就该先按它处置，
 * 改成「待查」会把医生的注意力从必须排除的病上移开。A–C（病历已记录的内容与病名相反）照常，但原名属急危重症时见 heldOnRedFlag。过滤放在缓存之外，
 * 同一份病历的核对结果在红旗与非红旗请求之间共用缓存也不会串。
 */
export async function alignWesternNameWithRecord(
  westernContent: string,
  context: { recordText: string; patient?: { sex?: unknown; age?: unknown }; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return westernContent;
  let name = "";
  let listedNames: string[] = [];
  try {
    const western = record(JSON.parse(westernContent))?.westernDiagnosis;
    name = String(record(record(western)?.primary)?.name || "").trim();
    listedNames = listedWesternDiagnosisNames(western);
  } catch {
    return westernContent;
  }
  if (!name) return westernContent;
  const found = await westernNameCorrectionForRecord({ recordText: context.recordText, diagnosisName: name, patient: context.patient, listedNames }, signal);
  const correction = found && !(context.redFlag && heldOnRedFlag(found, name)) ? found : undefined;
  console.info("[tcm-cdss:telemetry] western_name_evidence_check", {
    applied: Boolean(correction),
    type: found?.type,
    heldForRedFlag: Boolean(found && !correction),
    adoptedFromList: Boolean(found?.adoptedFromList),
    currentIsEmergency: Boolean(found?.currentIsEmergency),
    // 病名不是患者信息；记下来是为了能把改名归到病例上（10/19 分析验收集时只有类型码，归不了因）。
    currentName: name.slice(0, 30),
    supportedName: found ? found.supportedName.slice(0, 30) : undefined,
  });
  return correction ? applyWesternNameCorrection(westernContent, correction) : westernContent;
}

/**
 * 红旗病例上不采信的改名：D 类一律不采信（见上）；A–C 类在原名属急危重症时，只允许改成西医半自己列过的病，或同一类病的上一级
 *（「神经源性休克」→「休克待查」）——不把急危重病名换成症状（2026-10-19，验收集 X-D-0529 急性胰腺炎凭「血淀粉酶<500」被改成「腹痛」，
 * 淀粉酶不高本来就排除不了胰腺炎）。
 */
function heldOnRedFlag(found: WesternNameCorrection, currentName: string): boolean {
  if (found.type === "D") return true;
  return Boolean(found.currentIsEmergency) && !found.adoptedFromList && !namesSameDiseaseFamily(found.supportedName, currentName);
}
