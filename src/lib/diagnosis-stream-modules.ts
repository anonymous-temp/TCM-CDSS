/**
 * 按模块顺序流式反馈（需求2：「推理的时候按模块来顺序执行，一个模块一个模块来，而不是最后统一出」）。
 *
 * ★ 这里有一条必须尊重的既有决策 ★
 * diagnosis-api.ts 把全部结构化阶段设成 bufferedClinicalStage，注释写明理由：
 *   "Streaming a second, provisional representation before the authoritative JSON is validated
 *    caused visible/structured drift and could expose raw internal fields."
 * 也就是说，这个项目试过在验证前流式输出第二份临床正文，出过事才改成缓冲。
 *
 * 因此本模块**不**产出第二份临床正文。它只做两件事：
 *   1. 增量识别权威 JSON 里哪些顶层模块已经写完；
 *   2. 为每个写完的模块产出一行**结论标题**（白名单字段、长度封顶）。
 * 医生因此能一个模块一个模块地看到结论落地，而不是盯着「请稍候」等 88 秒；
 * 完整正文仍然只在末尾由 STREAM_REPLACE_MARKER 一次性确定性渲染，且该标记会把之前推送的
 * 全部内容整段丢弃（diagnosis-engine.ts 的实现是 `combined.slice(markerIdx + marker.length)`），
 * 所以中途被修复轮改掉的结论不会与最终结果并存。
 *
 * 白名单是硬约束：只允许下面 MODULE_HEADLINES 列出的字段进入可见流。任何新增模块若想上流，
 * 必须显式登记它要暴露哪一个字段——默认不暴露，这样「泄漏原始内部字段」不可能再发生。
 */

/** 权威 JSON 里按提示词模板顺序出现的顶层模块，及其医生可见名称。 */
const MODULE_LABELS: ReadonlyMap<string, string> = new Map([
  ["westernDiagnosis", "西医诊断"],
  ["overview", "中医辨病辨证"],
  ["pathogenesis", "病机分析"],
  ["therapy", "治则治法"],
  ["formula", "候选方药"],
  ["nonPharma", "健康调护"],
  ["management", "管理与随访"],
]);

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * 每个模块允许进入可见流的结论标题。只读白名单字段，不读整段对象——
 * 这是「不泄漏原始内部字段」这条约束的落点。
 */
const MODULE_HEADLINES: ReadonlyMap<string, (value: Record<string, unknown>) => string> = new Map([
  ["westernDiagnosis", (value) => {
    const primary = value.primary as Record<string, unknown> | undefined;
    return text(primary?.name, 40);
  }],
  ["overview", (value) => {
    const disease = text(value.tcmDiseaseName, 20);
    const syndrome = text(value.primarySyndrome, 30);
    return [disease && `辨病 ${disease}`, syndrome && `辨证 ${syndrome}`].filter(Boolean).join("／");
  }],
  ["pathogenesis", (value) => {
    const chain = Array.isArray(value.chain) ? value.chain.length : 0;
    return chain > 0 ? `已形成 ${chain} 个病机节点` : "";
  }],
  ["therapy", (value) => text(value.overallMethod, 40) || text(value.overallPrinciple, 40)],
  ["formula", (value) => {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (!first) return "";
    const name = text(first.name, 30);
    const herbs = Array.isArray(first.herbs) ? first.herbs.length : 0;
    // 只报味数，不报药名与剂量：剂量要等审方，药名要等组成核验。
    return [name, herbs > 0 && `共 ${herbs} 味`].filter(Boolean).join("，");
  }],
  ["nonPharma", () => "饮食起居、情志与注意事项已生成"],
  ["management", () => "随访安全网已生成"],
]);

/**
 * 从一段**可能不完整**的 JSON 文本里，找出已经写完的顶层键。
 *
 * 只扫最外层对象的第一层：逐字符走，跳过字符串（含转义），用括号深度判断某个值是否闭合。
 * 不用 JSON.parse——被截断的文本永远解析不了，而我们要的正是「已经写完的那部分」。
 */
export function completedTopLevelKeys(partial: string): string[] {
  const start = partial.indexOf("{");
  if (start < 0) return [];
  const keys: string[] = [];
  let index = start + 1;
  let inString = false;
  let escaped = false;
  let pendingKey: string | undefined;
  let keyBuffer = "";
  let readingKey = false;
  let depth = 0;
  let awaitingValue = false;

  for (; index < partial.length; index += 1) {
    const char = partial[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (readingKey) {
          pendingKey = keyBuffer;
          readingKey = false;
        }
      } else if (readingKey) keyBuffer += char;
      else if (depth === 0 && awaitingValue) {
        // 顶层的字符串值：闭合即算写完。
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 0 && !awaitingValue) {
        readingKey = true;
        keyBuffer = "";
      }
      continue;
    }
    if (char === ":" && depth === 0) {
      awaitingValue = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) break; // 最外层对象收尾
      if (depth === 0 && pendingKey && awaitingValue) {
        keys.push(pendingKey);
        pendingKey = undefined;
        awaitingValue = false;
      }
      continue;
    }
    if (char === "," && depth === 0) {
      // 顶层标量值（"stage": "diagnose" / null / 数字）在逗号处收尾。
      if (pendingKey && awaitingValue) {
        keys.push(pendingKey);
        pendingKey = undefined;
      }
      awaitingValue = false;
    }
  }
  return keys;
}

/** 取某个顶层键的值文本（已闭合时），用于抽取结论标题。 */
function topLevelValueJson(partial: string, key: string): string | undefined {
  const marker = `"${key}"`;
  const keyIndex = partial.indexOf(marker);
  if (keyIndex < 0) return undefined;
  let index = partial.indexOf(":", keyIndex + marker.length);
  if (index < 0) return undefined;
  index += 1;
  while (index < partial.length && /\s/.test(partial[index])) index += 1;
  const opener = partial[index];
  if (opener !== "{" && opener !== "[") return undefined;
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < partial.length; cursor += 1) {
    const char = partial[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return partial.slice(index, cursor + 1);
    }
  }
  return undefined;
}

/**
 * 为一个刚写完的模块产出可见的一行进度。返回 undefined 表示该模块不上流
 * （未登记、值未闭合、或没有可展示的结论标题——例如 M03 阶段 formula 恒为 null）。
 */
export function moduleProgressNotice(partial: string, key: string): string | undefined {
  const label = MODULE_LABELS.get(key);
  const headline = MODULE_HEADLINES.get(key);
  if (!label || !headline) return undefined;
  const valueJson = topLevelValueJson(partial, key);
  if (!valueJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const summary = headline(parsed as Record<string, unknown>);
  return summary ? `▸ ${label}：${summary}` : undefined;
}

/** 供流式循环使用：返回本次新写完、且可展示的模块进度行。 */
export function newModuleNotices(partial: string, emitted: Set<string>): string[] {
  const notices: string[] = [];
  for (const key of completedTopLevelKeys(partial)) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    const notice = moduleProgressNotice(partial, key);
    if (notice) notices.push(notice);
  }
  return notices;
}
