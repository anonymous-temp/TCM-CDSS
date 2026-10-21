#!/usr/bin/env python3
"""从本地《中医诊断学》（十三五规划教材，中医补充数据/灵丹GitHub/TCM Educational Materials.txt）逐字切出各证的
【证候表现】与【辨证要点】，生成 src/data/tcm-diagnostics-syndrome-criteria.json（2026-10-21 第十二轮）。

用途：立兼证的判据（m03-secondary-syndrome-consistency.server.ts）。教材对每个证写明「辨证要点」，多为
「几项特异表现与某类症状共见」（脾气虚证：「纳少、腹胀、便溏与气虚症状共见」），或「以……为主要表现」。
运行时按它数病历里该证的特异表现与共见类症状，扣除主证自己的表现，够数才立兼证。

每条带书名与行号；切分只在标点处断开，文字逐字来自原文。原文缺失时脚本报错退出，不生成残缺表。
用法：python3 scripts/build-tcm-diagnostics-syndrome-criteria.py [原文路径]
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "中医补充数据" / "灵丹GitHub" / "TCM Educational Materials.txt"
OUT = ROOT / "src" / "data" / "tcm-diagnostics-syndrome-criteria.json"
BOOK = "中医诊断学"

HEADING = re.compile(r"^(?:（[一二三四五六七八九十]+）|[一二三四五六七八九十]+、)([^，。（）]{1,12}证)$")
# 「与X症状共见」里的 X → 该类症状取哪一（几）个证的【证候表现】。闭集，按教材本身的证名对应；对应不上的类别不要求共见类症状。
CATEGORY_ENTRIES = {
    "气虚": ["气虚证"], "气虚证的": ["气虚证"], "阴虚": ["阴虚证"], "阳虚": ["阳虚证"], "血虚": ["血虚证"], "血虚证的": ["血虚证"],
    "气滞": ["气滞证"], "血瘀": ["血瘀证"], "血瘀证的": ["血瘀证"], "实热": ["热证"], "里热炽盛": ["热证"], "里实热": ["热证"],
    "实寒": ["寒证"], "虚热": ["阴虚证"], "虚寒": ["阳虚证"], "湿热": ["湿淫证", "热证"], "痰热": ["痰证", "热证"],
    "痰浊": ["痰证"], "寒痰": ["痰证", "寒证"], "寒湿": ["湿淫证", "寒证"], "饮停": ["饮证"], "津亏": ["津液亏虚证"],
    "肾气虚": ["肾气不固证"], "肾阳虚": ["肾阳虚证"], "脾气虚": ["脾气虚证"], "气血两虚": ["气血两虚证"],
    "风热表": ["表证"], "风寒表": ["表证"], "卫表": ["表证"], "太阳经证": ["表证"], "燥淫": ["燥淫证"], "亡阳": ["亡阳证"],
}
# 模型常写的同义证名 → 本书证名（闭集）。另按 NAME_SUFFIX_VARIANTS 把「X不足证/X亏虚证/X亏损证」归到「X虚证」。
ALIASES = {
    "脾气虚证": ["脾虚证", "脾气亏虚证", "脾气不足证", "脾胃气虚证"],
    "津液亏虚证": ["津亏证", "伤津证", "津伤证", "津液不足证"],
    "风淫证": ["风邪证", "风证"], "湿淫证": ["湿邪证", "湿证", "湿阻证"], "寒淫证": ["寒邪证"], "暑淫证": ["暑邪证", "暑湿证"],
    "燥淫证": ["燥邪证", "燥证"], "火淫证": ["火热证", "火邪证"],
    "气血两虚证": ["气血亏虚证", "气血不足证"], "血瘀证": ["瘀血证", "瘀血内阻证", "瘀血阻滞证"], "气滞证": ["气机郁滞证"],
    "痰证": ["痰浊证", "痰阻证", "痰浊内阻证"], "饮证": ["饮停证", "痰饮证"],
}
NAME_SUFFIX_VARIANTS = ["不足证", "亏虚证", "亏损证"]
CO_OCCUR = re.compile(r"(?:，|、)?(?:常)?与([^，。、]{1,10}?)(?:症状|证的症状|证症状)?共见")


def split_items(text: str) -> list[str]:
    parts = re.split(r"[，、；。,;]|或者|或|及|和", text)
    items = []
    for part in parts:
        item = re.sub(r"^(?:以|伴有?|兼见|并见|可见|见|甚则|甚至|常|多|有|等)", "", part.strip())
        item = re.sub(r"(?:等(?:为主要表现|为证候特点|表现)?|为主要表现|为证候特点|为主|表现共见|共见)$", "", item).strip()
        if 2 <= len(item) <= 14 and re.search(r"[一-鿿]", item):
            items.append(item)
    return list(dict.fromkeys(items))


def main() -> None:
    if not SOURCE.exists():
        sys.exit(f"原文不存在：{SOURCE}")
    lines = SOURCE.read_text(encoding="utf-8").split("\n")
    # 正文起点：标题「表证」之后紧跟「表证是指」的那一处（前面同名的是目录）。
    start = next(i for i, line in enumerate(lines) if line.strip() in ("（一）表证", "一、表证") and any(
        lines[j].startswith("表证是指") for j in range(i + 1, min(i + 4, len(lines)))))
    entries = []
    i = start
    while i < len(lines):
        match = HEADING.match(lines[i].strip())
        if not match:
            # 正文到「辨证」各论结束（十二经脉、奇经八脉之后不再有证名标题）即停。
            if i > start + 3000:
                break
            i += 1
            continue
        name = match.group(1)
        block_end = i + 1
        while block_end < len(lines) and not HEADING.match(lines[block_end].strip()) and block_end - i < 40:
            block_end += 1
        block = lines[i:block_end]
        definition = next((line.strip() for line in block[1:] if line.startswith(f"{name}是指")), "")
        manifest_at = next((k for k, line in enumerate(block) if line.startswith("【证候表现】")), None)
        key_at = next((k for k, line in enumerate(block) if line.startswith("【辨证要点】")), None)
        # 只有【证候表现】、没有【辨证要点】的（八纲的寒证、热证）也收：它们只作「与实寒/实热症状共见」的类症状来源。
        if manifest_at is not None:
            manifest_text = block[manifest_at][len("【证候表现】"):].strip()
            key_text = block[key_at][len("【辨证要点】"):].strip() if key_at is not None else ""
            co = CO_OCCUR.search(key_text)
            category = co.group(1).strip() if co else None
            specific_text = key_text[:co.start()] if co else key_text
            entries.append({
                "name": name,
                "line": i + 1,
                "definition": definition,
                "manifestationsText": manifest_text,
                "manifestations": split_items(manifest_text),
                "keyPointsText": key_text,
                "keyPointsLine": i + 1 + key_at if key_at is not None else None,
                "specific": split_items(specific_text),
                "category": category,
                "categoryEntries": CATEGORY_ENTRIES.get(category, []) if category else [],
            })
        i = block_end
    if len(entries) < 100:
        sys.exit(f"只切出 {len(entries)} 个证，原文结构可能变了，不生成")
    names = {entry["name"] for entry in entries}
    unresolved = sorted({entry["category"] for entry in entries if entry["category"] and not entry["categoryEntries"]})
    for entry in entries:
        entry["categoryEntries"] = [name for name in entry["categoryEntries"] if name in names]
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    OUT.write_text(json.dumps({
        "schemaVersion": "tcm-diagnostics-syndrome-criteria-v1",
        "source": {"book": BOOK, "edition": "全国中医药行业高等教育“十三五”规划教材", "file": "中医补充数据/灵丹GitHub/TCM Educational Materials.txt", "sha256": digest},
        "generatedBy": "scripts/build-tcm-diagnostics-syndrome-criteria.py",
        "unresolvedCategories": unresolved,
        "aliases": {alias: name for name, aliases in ALIASES.items() if name in names for alias in aliases},
        "nameSuffixVariants": NAME_SUFFIX_VARIANTS,
        "entries": entries,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(entries)} entries → {OUT.relative_to(ROOT)}; categories without entries: {unresolved}")


if __name__ == "__main__":
    main()
