import { safeHttpUrl } from "./safe-url";

export type EvidenceDisplayReference = {
  raw: string;
  title: string;
  url?: string;
  sourceType: "指南/共识" | "药品说明书/监管资料" | "研究文献" | "中医药知识" | "病例内证据" | "其他资料";
  publicationDate?: string;
  retrievedAt?: string;
  relevance: string;
};

const EXTERNAL_URL = /https?:\/\/[^\s，。；、）》】]+/i;
const PUBLICATION_DATE = /(?:19|20)\d{2}(?:[-/.年](?:0?[1-9]|1[0-2])(?:[-/.月](?:0?[1-9]|[12]\d|3[01])日?)?)?/;

function inferSourceType(value: string): EvidenceDisplayReference["sourceType"] {
  if (/(?:EVID[-_](?:GUIDE|CONSENSUS)|指南|共识|临床路径)/i.test(value)) return "指南/共识";
  if (/(?:EVID[-_](?:INST|LABEL)|说明书|药品标签|NMPA|FDA|EMA|PMDA|监管)/i.test(value)) return "药品说明书/监管资料";
  if (/(?:EVID[-_](?:LIT|PAPER)|PMID|DOI|期刊|文献|研究|试验)/i.test(value)) return "研究文献";
  if (/(?:方剂|本草|药典|知识库|《[^》]+》|EVID[-_](?:TCM|KB))/i.test(value)) return "中医药知识";
  if (/(?:本例|病历|病例|患者已提供|模型推断)/.test(value)) return "病例内证据";
  return "其他资料";
}

export function splitEvidenceReferenceItems(source: string | undefined): string[] {
  if (!source?.trim()) return [];
  return [...new Set(source
    .split(/\n+|；(?=\s*(?:\[[A-Z]|《|https?:\/\/))/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function parseEvidenceDisplayReferences(
  source: string | undefined,
  relevance: string,
  retrievedAt?: string,
): EvidenceDisplayReference[] {
  return splitEvidenceReferenceItems(source).map((raw) => {
    const rawUrl = raw.match(EXTERNAL_URL)?.[0];
    const url = rawUrl ? safeHttpUrl(rawUrl, "") : "";
    const publicationDate = raw.match(PUBLICATION_DATE)?.[0];
    const title = rawUrl
      ? raw.replace(rawUrl, "").replace(/\s*[；;,，]?\s*$/, "").trim()
      : raw;
    return {
      raw,
      title: title || url || "未命名资料",
      ...(url ? { url } : {}),
      sourceType: inferSourceType(raw),
      ...(publicationDate ? { publicationDate } : {}),
      ...(retrievedAt ? { retrievedAt } : {}),
      relevance,
    };
  });
}
