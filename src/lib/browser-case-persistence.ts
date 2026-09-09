import type { CaseState } from "./diagnosis-types";
import { dateOnly, generalizeOccupation, scrubQuasiIdentifierText, scrubRecordHeaderName, scrubRelationPrefixedName, scrubSubjectPrefixedName } from "./phi-sanitizer";

export function scrubPersistentPhiText(text: string, explicitNames: string[] = []): string {
  // 病历抬头姓名走**共享**判据（phi-sanitizer.scrubRecordHeaderName）。
  // 此前本函数走百家姓枚举、服务端 scrubPhi 走上下文模式，两套各写各的，实测浏览器侧漏：
  //   「张伟，男，45岁」「欧阳明月，女，32岁」「本例赵敏既往有高血压」服务端脱敏、本侧留存。
  // 本侧保护的是 localStorage 里的静态 PHI，而「姓名，男，NN岁」正是标准 HIS 抬头格式。
  // 本侧原本**完全没有**主语前缀姓名这条规则：「本例赵敏既往有高血压」在 localStorage 里原样留存。
  let next = scrubRelationPrefixedName(scrubSubjectPrefixedName(scrubRecordHeaderName(text)));
  for (const name of explicitNames) {
    const cleaned = name.trim();
    if (cleaned) next = next.replaceAll(cleaned, "[姓名已脱敏]");
  }

  // Redaction markers are terminal values. Protect them from the broad name/address recognizers so
  // saving, normalizing and saving the same case cannot consume a marker or change a signed hash.
  const protectedMarkers: string[] = [];
  next = next.replace(/\[(?:姓名|手机号|电话|邮箱|证件号|地址|出生日期|日期|精确时间|职业)[^\]]*(?:脱敏|泛化)[^\]]*\]/g, (marker) => {
    const token = `__CDSS_REDACTION_${protectedMarkers.length}__`;
    protectedMarkers.push(marker);
    return token;
  });

  const scrubbed = scrubQuasiIdentifierText(next
    .replace(/(?:出生日期|出生年月日|出生年月|出生时间)\s*[:：]?\s*(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2}日?)?/gi, "出生日期：[已脱敏]")
    .replace(/(?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3}/g, (match) => {
      const label = match.match(/^(姓名|患者|家属|联系人|陪同者|监护人)/)?.[1] || "人员";
      return `${label}：[姓名已脱敏]`;
    })
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*(?:昨夜|今日|今晨|近日|近\d|来诊|就诊|入院|出院|自述|反映|称|表示|出现|发生|患|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸))/g, "$1[姓名已脱敏]")
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*[\u4e00-\u9fa5])/g, "$1[姓名已脱敏]")
    .replace(/((?:患者|家属|联系人|陪同者|监护人|医生|医师)?\s*)(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|顾|孟|黄|和|穆|萧|尹|姚|邵|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|管|卢|莫|房|裘|缪|干|解|应|宗|丁|宣|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|龚|程|嵇|邢|裴|陆|荣|翁|荀|羊|甄|曲|封|储|靳|段|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|黎|乔|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|却|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|浦|尚|农|温|别|庄|晏|柴|瞿|阎|连|习|艾|鱼|容|向|古|易|廖|终|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|毋|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公)[\u4e00-\u9fa5]{1,2}(?=(?:昨夜|今日|今晨|近日|来诊|就诊|入院|出院|自述|反映|称|表示|告知))/g, "$1[姓名已脱敏]")
    .replace(/(?:患者|家属|联系人|陪同者|监护人|医生|医师)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|反映|诉|称|表示|告知|建议|记录)/g, (match) => {
      const label = match.match(/^(患者|家属|联系人|陪同者|监护人|医生|医师)/)?.[1] || "人员";
      return `${label}[姓名已脱敏]`;
    })
    .replace(/(^|[\s，,；。:：])[\u4e00-\u9fa5]{2,4}(?=\s*(?:\[手机号已脱敏\]|1[3-9]\d{9}|电话|手机))/g, "$1[姓名已脱敏]")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已脱敏]")
    .replace(/\b0\d{2,3}-?\d{7,8}\b/g, "[电话已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[证件号已脱敏]")
    .replace(/(身份证号?|证件号?|医保号|社保号|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|MRN)\s*[:：]?\s*[A-Za-z0-9-]{4,}/gi, (_match, label: string) => {
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:住址|地址|家庭住址|工作单位)\s*[:：]?\s*[^，；。\n]+/g, (match) => {
      const label = match.split(/[:：]/)[0] || "地址";
      return `${label}：[已脱敏]`;
    }));

  return protectedMarkers.reduce(
    (restored, marker, index) => restored.replaceAll(`__CDSS_REDACTION_${index}__`, marker),
    scrubbed,
  );
}

function scrubFreeClinicalInputForPersistence(value: unknown, explicitNames: string[]): unknown {
  if (typeof value === "string") return scrubPersistentPhiText(value, explicitNames);
  if (Array.isArray(value)) return value.map((item) => scrubFreeClinicalInputForPersistence(item, explicitNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) =>
    /(name|姓名|患者名|联系人|身份证|证件|电话|手机|地址|住址|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|mrn|medical.?record|record.?number|patient.?id)/i.test(key)
      ? []
      : [[key, scrubFreeClinicalInputForPersistence(raw, explicitNames)]],
  ));
}

function scrubExplicitNamesForPersistence(text: string, explicitNames: string[]): string {
  return explicitNames.reduce((next, name) => {
    const cleaned = name.trim();
    return cleaned ? next.replaceAll(cleaned, "[姓名已脱敏]") : next;
  }, text);
}

export function sanitizeCaseStateForBrowserPersistence(state: CaseState): CaseState {
  const explicitNames = [state.patient.name, state.hisRecord?.fields.patientName].filter((item): item is string => Boolean(item?.trim()));
  return {
    // M03/M04/M05、处方与审方对象是受治理的结构化临床输出，必须原样持久化；
    // 仅对明确身份字段、M01/M02 自由病历输入和用户回答执行脱敏。
    ...state,
    // “跳过追问”是本次医生操作意图，不是病例事实；刷新后必须重新确认，不能被快照自动沿用。
    skipDifferentiationGate: undefined,
    patient: {
      ...state.patient,
      name: undefined,
      occupation: generalizeOccupation(state.patient.occupation),
    },
    chiefComplaint: scrubPersistentPhiText(state.chiefComplaint, explicitNames),
    symptoms: scrubFreeClinicalInputForPersistence(state.symptoms, explicitNames) as CaseState["symptoms"],
    tongue: state.tongue ? scrubPersistentPhiText(state.tongue, explicitNames) : undefined,
    pulse: state.pulse ? scrubPersistentPhiText(state.pulse, explicitNames) : undefined,
    faceNote: state.faceNote ? scrubPersistentPhiText(state.faceNote, explicitNames) : undefined,
    vitals: state.vitals
      ? scrubFreeClinicalInputForPersistence(state.vitals, explicitNames) as CaseState["vitals"]
      : undefined,
    pastHistory: state.pastHistory ? scrubPersistentPhiText(state.pastHistory, explicitNames) : undefined,
    medicationHistory: state.medicationHistory ? scrubPersistentPhiText(state.medicationHistory, explicitNames) : undefined,
    allergyHistory: state.allergyHistory ? scrubPersistentPhiText(state.allergyHistory, explicitNames) : undefined,
    conversation: state.conversation.map((message) => ({
      ...message,
      content: message.role === "user"
        ? scrubPersistentPhiText(message.content, explicitNames)
        : scrubExplicitNamesForPersistence(message.content, explicitNames),
    })),
    previousResult: state.previousResult ? {
      capturedAt: dateOnly(state.previousResult.capturedAt),
      diagnosis: state.previousResult.diagnosis
        ? scrubExplicitNamesForPersistence(state.previousResult.diagnosis, explicitNames)
        : undefined,
      prescription: state.previousResult.prescription
        ? scrubExplicitNamesForPersistence(state.previousResult.prescription, explicitNames)
        : undefined,
      riskAssessment: state.previousResult.riskAssessment
        ? scrubExplicitNamesForPersistence(state.previousResult.riskAssessment, explicitNames)
        : undefined,
    } : undefined,
    lastError: state.lastError ? {
      ...state.lastError,
      message: scrubExplicitNamesForPersistence(state.lastError.message, explicitNames),
    } : undefined,
    faceCapture: state.faceCapture ? { ...state.faceCapture, updatedAt: dateOnly(state.faceCapture.updatedAt) } : undefined,
    prescriptionRevision: state.prescriptionRevision ? {
      ...state.prescriptionRevision,
      auditedAt: dateOnly(state.prescriptionRevision.auditedAt),
      auditId: undefined,
      traceId: undefined,
    } : undefined,
    warningAcknowledgement: state.warningAcknowledgement ? {
      ...state.warningAcknowledgement,
      acknowledgedAt: dateOnly(state.warningAcknowledgement.acknowledgedAt),
      reason: state.warningAcknowledgement.reason
        ? scrubPersistentPhiText(state.warningAcknowledgement.reason, explicitNames)
        : undefined,
    } : undefined,
    emergencyClearance: state.emergencyClearance ? {
      ...state.emergencyClearance,
      assessmentSummary: scrubPersistentPhiText(state.emergencyClearance.assessmentSummary, explicitNames),
    } : undefined,
    hisRecord: state.hisRecord ? {
      ...state.hisRecord,
      updatedAt: dateOnly(state.hisRecord.updatedAt),
      fields: {
        ...scrubFreeClinicalInputForPersistence(
          state.hisRecord.fields,
          explicitNames,
        ) as NonNullable<CaseState["hisRecord"]>["fields"],
        patientName: undefined,
      },
      rawText: scrubPersistentPhiText(state.hisRecord.rawText || "", explicitNames),
    } : undefined,
  };
}
