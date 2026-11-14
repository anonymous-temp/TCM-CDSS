import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 西药药理学分类表（src/data/western-drug-pharmacology-class.json，医脉通用药参考 APP 的四级分类，由 scripts/build-western-drug-class.py
 * 自药学基础数据生成）。按 process.cwd()/src/data 懒加载，不打进代码包。成药重复判同类（patent-medicine-duplication）与
 * 「用药史」一栏认药名（required-precautions）共用这一份。
 */
export type WesternClassTable = { classes: string[]; byProduct: Record<string, number[]>; byGeneric: Record<string, number[]> };
let westernClassTableCache: WesternClassTable | undefined;
export function westernClassTable(): WesternClassTable {
  if (westernClassTableCache) return westernClassTableCache;
  try {
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "src", "data", "western-drug-pharmacology-class.json"), "utf8")) as Partial<WesternClassTable>;
    westernClassTableCache = {
      classes: Array.isArray(parsed.classes) ? parsed.classes : [],
      byProduct: parsed.byProduct && typeof parsed.byProduct === "object" ? parsed.byProduct : {},
      byGeneric: parsed.byGeneric && typeof parsed.byGeneric === "object" ? parsed.byGeneric : {},
    };
  } catch (error) {
    console.warn("[tcm-cdss:knowledge] western drug class table unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    westernClassTableCache = { classes: [], byProduct: {}, byGeneric: {} };
  }
  return westernClassTableCache;
}

let genericKeysLongestFirst: string[] | undefined;
/**
 * 一段写法里能认出的西药通用名（2026-11-14 第四十五轮复核：「用药史」一栏逐段切开后，「偶有漏用」「近期」「喝热水」也被当药名写进注意事项）。
 * 整段就是表里的全名/通用名时原样认；否则取其中最长的通用名（至少 3 个字）；病历常写到通用名的词干（华法林←华法林钠），整段是某个通用名的
 * 开头（至少 3 个字、全是汉字）也认。认不出返回 undefined。
 */
export function westernDrugNameIn(text: string): string | undefined {
  const clean = String(text || "").normalize("NFKC").replace(/\s+/gu, "");
  if (clean.length < 2) return undefined;
  const table = westernClassTable();
  if (table.byProduct[clean]?.length || table.byGeneric[clean]?.length) return clean;
  genericKeysLongestFirst ??= Object.keys(table.byGeneric).filter((key) => key.length >= 3 && /^[一-鿿]+$/u.test(key)).sort((a, b) => b.length - a.length);
  const contained = genericKeysLongestFirst.find((key) => clean.includes(key));
  if (contained) return contained;
  if (clean.length >= 3 && /^[一-鿿]+$/u.test(clean) && genericKeysLongestFirst.some((key) => key.startsWith(clean))) return clean;
  return undefined;
}
