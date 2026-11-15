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
export function westernEvidenceTitleMatches(title: string, names: readonly string[]): boolean {
  const compact = title.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
  return names.some((name) => {
    const core = westernDiseaseCore(name).toLocaleLowerCase();
    return core.length >= 2 && compact.includes(core);
  });
}

export function westernEvidenceIsChinese(url: string, title: string): boolean {
  return /[\u4e00-\u9fff]{2}/u.test(title) || /\/zh(?:-|\/)|msdmanuals\.cn/iu.test(url);
}
