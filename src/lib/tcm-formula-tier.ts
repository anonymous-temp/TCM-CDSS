import modernCaseFormulaIndexJson from "../data/tcm-modern-case-formula-index.json" with { type: "json" };

/**
 * 方剂「常用度」分层（2026-09-27）。
 *
 * 受控目录 2,969 首里 2,910 首可锁定身份，其中大量是古籍单方、章节标题式条目
 * （防饥救生四果丹、治漆疮方、吐血除根方……）。9/27 本机 65 例实测：模型没给方名时服务端按证候
 * 检索自动锁定首位，锁到过上述条目；M04 引用后又判「组成不足」进 qwen3.8-max 修复轮（约 25s）；
 * 按证候检索出的前 8 名里只有 27% 在现代医案里用过 3 次以上。
 *
 * 分层口径：官方标准方（SZJG/T 38.2-2011 地方方剂标准）与古代经典名方目录一律入层；其余只有在
 * 现代医案语料（1.7 万例，构建期统计）里至少 3 例用过才入层。共 732 首。不入层的方仍可检索、
 * 仍可作为鉴别与参考出现在提示词里，只是不能被锁定为本例主方身份（M03）、不作为 M04 编译基准与
 * 按组成反查的命名对象。
 *
 * `CDSS_FORMULA_LOCK_TIER=false` 回退到不分层（回滚开关，也是本机 A/B 的基线臂）。
 */
export const FORMULA_COMMON_TIER_MIN_MODERN_CASES = 3;

const formulaCaseCounts = (modernCaseFormulaIndexJson as unknown as { formulaCaseCounts?: Record<string, unknown> })
  .formulaCaseCounts || {};

export function formulaLockTierEnabled(): boolean {
  return process.env.CDSS_FORMULA_LOCK_TIER !== "false";
}

export function formulaModernCaseCount(id: string): number {
  const raw = formulaCaseCounts[id];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** 该受控条目是否属于常用层（与开关无关的纯判据）。 */
export function formulaInCommonTier(entry: { id: string; sourceClass?: string }): boolean {
  if (entry.sourceClass === "official_local_formula_standard" || entry.sourceClass === "official_classic_catalog") return true;
  return formulaModernCaseCount(entry.id) >= FORMULA_COMMON_TIER_MIN_MODERN_CASES;
}

/** 身份锁定资格 = 目录治理层允许锁定 ∧（分层关闭 ∨ 属于常用层）。M03 锁定与 M04 编译同用这一个谓词。 */
export function formulaIdentityLockAllowed(entry: { id: string; sourceClass?: string; identityLockEligible: boolean }): boolean {
  return entry.identityLockEligible && (!formulaLockTierEnabled() || formulaInCommonTier(entry));
}
