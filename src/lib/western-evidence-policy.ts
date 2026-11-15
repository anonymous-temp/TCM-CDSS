import policy from "../data/western-evidence-policy.source.json";

/** URL 主机边界校验；专业版路径不允许被家用版或伪造 siteName 绕过。 */
export function isAllowedWesternEvidenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return false;
    return policy.sites.some((site) => {
      const rule = site as { host: string; pathPrefix?: string; excludedPaths?: string[] };
      return (url.hostname === rule.host || url.hostname.endsWith(`.${rule.host}`)) &&
        (!rule.pathPrefix || url.pathname.startsWith(rule.pathPrefix)) &&
        !(rule.excludedPaths || []).some((path) => url.pathname.startsWith(path));
    });
  } catch { return false; }
}

export function westernDiseaseCore(name: string): string {
  let value = name.normalize("NFKC").replace(/\s+/gu, "").replace(/待[查排]$/u, "");
  for (const qualifier of policy.nameQualifiers) if (value.startsWith(qualifier)) value = value.slice(qualifier.length);
  return value;
}

/** 标题必须命中完整病名或受治理同义名的核心；不以相邻病名的共有二字当概念。 */
export function westernEvidenceTitleMatches(title: string, names: readonly string[], requestedName = names[0] || ""): boolean {
  const compact = title.normalize("NFKC").replace(/\s*(?:URL:)?https?:\/\/\S+.*$/iu, "").replace(/\s+/gu, "").toLocaleLowerCase();
  if (policy.nonGuidelineTitleGenres.some((genre) => compact.includes(genre))) return false;
  if (policy.titleSubjectExclusions.some((row) => requestedName.replace(/待[查排]$/u, "") === row.name && compact.includes(row.titleSubject))) return false;
  if (policy.titleScopeQualifiers.some((scope) => compact.includes(scope) && ![...names, requestedName].some((name) => name.includes(scope)))) return false;
  if (policy.courseQualifiers.some((course) => requestedName.includes(course) && policy.courseQualifiers.some((other) => other !== course && compact.includes(other)))) return false;
  return names.some((name) => {
    // 急、慢性不能互借证据；人群、病因限定也不能因共有症状而消失。
    const core = westernDiseaseCore(name).toLocaleLowerCase();
    return core.length >= 2 && compact.includes(core);
  });
}

export function westernEvidenceIsChinese(url: string, title: string): boolean {
  return /[\u4e00-\u9fff]{2}/u.test(title) || /\/zh(?:-|\/)|msdmanuals\.cn/iu.test(url);
}
