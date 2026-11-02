/**
 * 改了病名后，推理说明里仍把原病名当结论的说法一并改（2026-10-22 第十五轮）。
 * 病名核对只改 primary.name，推理说明照旧写「符合缺铁性贫血」「支持绝经后骨质疏松症」，页面「西医诊断：贫血 / 推理说明：…符合缺铁性贫血」
 * 自相矛盾（已存输出里被改名的 74 例中 28 例）。D 类（缺确诊所需的检查或病程）改成「考虑X可能」，与「X待查」和鉴别里的「尚未取得确诊所需的检查」一致；
 * 其余几类（病历与原病名相反、说重了）改成「需与X鉴别」。只改「符合/支持/指向/诊断为/考虑为/明确为/确诊为X」与「暂按X考虑」这几种断言式，有限闭集。
 */
export function rationaleAlignedWithRenamedPrimary(rationale: string, previous: string, type: "A" | "B" | "C" | "D"): string {
  if (!rationale || !previous || !rationale.includes(previous)) return rationale;
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replacement = type === "D" ? `考虑${previous}可能` : `需与${previous}鉴别`;
  return rationale
    .replace(new RegExp(`(?:符合|支持|指向|诊断为|考虑为|可诊断为|明确为|确诊为)\\s*${escaped}(?:的?(?:表现|诊断|特点|模式)|临床诊断)?(?!可能)`, "gu"), replacement)
    .replace(new RegExp(`暂按\\s*${escaped}\\s*考虑`, "gu"), type === "D" ? `${previous}可能` : replacement)
    // 后面跟的是原病名自己的描述（「符合膝骨关节炎退行性负重痛特点」「符合心律失常类发作特点」「符合股骨头缺血性坏死早期表现」）：描述随断言一起去掉，
    // 断开留着是残句（第三十六轮甲方 11/2：「考虑心律失常可能，类发作特点」）。不是这种描述的才断开，否则读成「考虑X可能退行性…」。
    .replace(new RegExp(`(考虑${escaped}可能|需与${escaped}鉴别)的?[^，,。；;]{0,14}?(?:特点|特征|表现|模式|征象|改变)(?=[，,。；;]|$)`, "gu"), "$1")
    .replace(new RegExp(`(考虑${escaped}可能|需与${escaped}鉴别)的?(?=[\\u4e00-\\u9fff])`, "gu"), "$1，");
}
