import "server-only";

import { diagnosticsCriteriaFor } from "./m03-secondary-syndrome-consistency.server";
import { textbookProvenanceVerified } from "./tcm-textbook-syndromes";

/**
 * 服务端按本地受治理资料写的证据出处，逐条核验属实才放行（2026-10-22 第十五轮）。
 *  · 教材证型行与教材加减：《中医内科学》心悸·心虚胆怯证[加减：原文]（tcm-textbook-syndrome-formula-table.json）；
 *  · 《中医诊断学》辨证要点：《中医诊断学》血虚证辨证要点（tcm-diagnostics-syndrome-criteria.json）。
 * 证据清洗只对 kb_entry（标准资料）用它；模型写的同样字样也要逐字对得上表才过，不能凭书名号放行。
 * 放在服务端：教材表约 5MB，证据清洗模块也被页面引用，由路由把这个函数传进去。
 */
export function governedEvidenceSourceVerified(source: string): boolean {
  const clean = source.trim();
  if (!clean) return false;
  if (textbookProvenanceVerified(clean)) return true;
  const criteria = clean.match(/^《中医诊断学》(.+证)辨证要点$/u);
  return Boolean(criteria && diagnosticsCriteriaFor(criteria[1])?.name === criteria[1]);
}
