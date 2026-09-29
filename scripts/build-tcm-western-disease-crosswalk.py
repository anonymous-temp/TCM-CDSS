#!/usr/bin/env python3
"""西医病名 → 中医病名对照（2026-09-29，甲方 9.24/9.27 测评 1.1「中医鉴别诊断写成『流感』」）。

来源：本地「十三五」规划教材合集（中医补充数据/灵丹GitHub/TCM Educational Materials.txt）里
《中医内科学》（张伯礼、吴勉华主编，2017）与《针灸治疗学》（高树中、杨骏主编，2016）各病证节的
「西医学的……属于本病范畴 / 可参照本病辨证论治 / 本病相当于西医学的…… / X 属于 Y 范畴」原句。
只抽教材原话里明确写出的对应关系，逐条记下书名与行号；运行时用它把误写进中医病名鉴别栏的
西医病名归一到中医病名（流行性感冒 → 时行感冒），归一不了的条目丢弃。

用法：python3 scripts/build-tcm-western-disease-crosswalk.py [教材合集路径] [输出路径]
"""
import json
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "中医补充数据/灵丹GitHub/TCM Educational Materials.txt"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / "src/data/tcm-western-disease-crosswalk.json"

BOOKS = [
    # (起始行, 书名) —— 行号为 1 起；每本书止于下一本书的起始行。
    (7932, "针灸治疗学（高树中，杨骏主编，4版，中国中医药出版社，2016）"),
    (13099, None),
    (232345, "中医内科学（张伯礼，吴勉华主编，4版，中国中医药出版社，2017）"),
    (238394, None),
]

HEADING = re.compile(r"^第[一二三四五六七八九十百]+节\s*(\S{1,12})\s*$")
SECTION_SCOPE = [
    re.compile(r"西医学(?:中)?的?([^。；]{2,160}?)(?:等)?(?:疾病)?(?:均)?(?:属|属于)本病(?:范畴|范围)"),
    re.compile(r"本病相当于西医学(?:中)?的?([^。；]{2,80}?)(?:[。；]|$)"),
    re.compile(r"西医学(?:中)?的?([^。；]{2,160}?)(?:等)?(?:疾病)?[，,]?(?:以[^。；]{0,30})?可参(?:照|考)本(?:节|病|篇)"),
]
EXPLICIT = re.compile(r"([^，。；、]{2,20}?)属于([^，。；、]{2,10}?)范畴")


def split_names(text: str) -> list[str]:
    text = text.replace("→", "、")
    text = re.sub(r"[（(][^）)]*[）)]", "", text)
    parts = re.split(r"[、，,及和与或]|以及", text)
    out = []
    for part in parts:
        part = re.sub(r"^(?:如|中的|的|部分|某些|一些|各种|多种)", "", part.strip())
        part = re.sub(r"(?:等|等病|等疾病|引起的?|所致的?)$", "", part).strip()
        if 2 <= len(part) <= 20 and not re.search(r"本病|本节|中医|辨证|论治|参照|参考|表现|临床|特点|相似|关系|原来|原因|包括|范畴|[“”‘’：:]", part):
            out.append(part)
    return out


def main() -> None:
    lines = SRC.read_text(encoding="utf-8").split("\n")
    entries: dict[tuple[str, str], dict] = {}
    for index, (start, book) in enumerate(BOOKS):
        if book is None:
            continue
        end = BOOKS[index + 1][0] - 1
        section = None
        for number in range(start, min(end, len(lines)) + 1):
            line = lines[number - 1].strip()
            heading = HEADING.match(line)
            if heading:
                section = heading.group(1)
                continue
            if not section or "西医学" not in line and "范畴" not in line:
                continue
            found = []
            for pattern in SECTION_SCOPE:
                for match in pattern.finditer(line):
                    found.extend((name, section) for name in split_names(match.group(1)))
            for match in EXPLICIT.finditer(line):
                western, tcm = match.group(1), match.group(2)
                if "本病" in tcm or "西医" in western:
                    continue
                western = re.sub(r"^.*?(?:西医学的?|；|，)", "", western)
                found.extend((name, tcm) for name in split_names(western))
            for western, tcm in found:
                tcm = re.sub(r"^中医学", "", tcm).strip("“”\"' ")
                if not (1 < len(tcm) <= 8) or re.search(r"[“”‘’]|中医|范畴", tcm):
                    continue
                key = (western, tcm)
                if key not in entries:
                    entries[key] = {"westernName": western, "tcmDisease": tcm, "book": book, "line": number}
    rows = sorted(entries.values(), key=lambda row: (row["westernName"], row["tcmDisease"]))
    OUT.write_text(json.dumps({
        "schemaVersion": "tcm-western-disease-crosswalk-v1",
        "generatedBy": "scripts/build-tcm-western-disease-crosswalk.py",
        "note": "西医病名→中医病名对照，只收教材原句明确写出的关系（带书名与行号）。运行时仅用于把误写进中医病名鉴别栏的西医病名归一；不参与诊断。",
        "entryCount": len(rows),
        "entries": rows,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} entries to {OUT}")


if __name__ == "__main__":
    main()
