/**
 * 本机 artifacts/ 归档的**统一访问口**。
 *
 * 【为什么需要它】artifacts/ 按设计不入 Git（评测产出，不是源码）。多条闸门套件会
 * 「本机若存在归档则一并扫描」——意图是好的：真实归档比构造夹具更能暴露问题。
 * 但它带来一个隐蔽后果：**同一个提交，在 fresh clone 上绿、在留有归档的机器上红**，
 * 两边都"跑过测试"，结论相反。
 *
 * 2026-08-15 实测踩到过一次：test-clinical-four-binding 把上下文换成新提交的夹具后，
 * 循环仍拿它去判 artifacts/ 里五份旧病例的产出，本机红、干净克隆绿，
 * 并且是带着这个红上线的（robustness-r11）。
 *
 * 所以归档访问必须能被**显式关掉**，让任何一台机器都能复现另一种状态：
 *   CDSS_IGNORE_LOCAL_ARTIFACTS=1 npm run test:deterministic
 * 等价于在干净克隆上跑。发布闸门 verify:release 会两种状态各跑一次。
 */
import { existsSync } from "node:fs";

/** 是否允许读取本机 artifacts/ 归档。设 CDSS_IGNORE_LOCAL_ARTIFACTS=1 即模拟干净克隆。 */
export function localArtifactsEnabled() {
  const raw = (process.env.CDSS_IGNORE_LOCAL_ARTIFACTS || "").trim().toLowerCase();
  return !(raw === "1" || raw === "true" || raw === "yes");
}

/**
 * 归档路径存在性判定。**所有对 artifacts/ 的可选读取都应走这里**，
 * 而不是各自裸调 existsSync——否则加了开关也只关掉一部分，等于没关。
 */
export function hasLocalArtifact(pathLike) {
  if (!localArtifactsEnabled()) return false;
  return existsSync(pathLike);
}
