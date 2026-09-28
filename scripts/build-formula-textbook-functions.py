#!/usr/bin/env python3
"""
《方剂学》教材功用/主治抽取（2026-09-28）→ src/data/tcm-formula-textbook-functions.json。

来源：中医补充数据/灵丹GitHub/TCM Educational Materials.txt（本机外部数据，不入库；owner 持有全部版权）。
其中《方剂学》规划教材正文每首正方按固定栏目排版：
    方名\n《出处》\n【组成】…【用法】…\n【功用】 …\n【主治】 …
【附方】各条为单行：「N.方名 （《出处》） 组成与用法… 功用：…。主治：…」。

输出只收「方名 + 出处 + 功用短语 + 主治原文 + 组成原文」，供 build-tcm-governance-tables.py 给目录里
功效为空的条目补 functions（按出处书名或组成重合度确认同一张方，同名异方不补）。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "中医补充数据" / "灵丹GitHub" / "TCM Educational Materials.txt"
OUT = ROOT / "src" / "data" / "tcm-formula-textbook-functions.json"

NAME = r"[一-龥]{2,16}"


def split_functions(text: str) -> list[str]:
    text = re.sub(r"\s+", "", text).strip("。；;，,")
    parts = [part.strip("。；;，,、") for part in re.split(r"[，,；;、]", text)]
    return [part for part in parts if 2 <= len(part) <= 16]


def main() -> int:
    if not SOURCE.exists():
        print(json.dumps({"error": "source_missing", "path": str(SOURCE)}, ensure_ascii=False))
        return 1
    raw = SOURCE.read_bytes()
    text = raw.decode("utf-8", errors="replace").replace("　", " ")
    entries: list[dict] = []

    # 正方：方名行（可带「（原名…/又名…）」）+ 出处行（「《书》」或「某某方，录自《书》」）+ 【组成】…【功用】…【主治】…
    main_pattern = re.compile(
        rf"\n({NAME})(?:（([^）\n]{{1,40}})）)?\n([^\n]{{0,40}}?《([^》\n]{{1,40}})》[^\n]{{0,40}})\n【组成】(.{{0,1600}}?)\n【功用】\s*([^\n]{{2,80}})\n【主治】\s*([^\n]{{2,400}})",
        re.S,
    )
    for match in main_pattern.finditer(text):
        name, alias_note, _source_line, source, composition, functions, indications = match.groups()
        aliases = [alias for alias in re.findall(rf"(?:原名|又名|亦名|一名)([^，、；）]{{2,20}})", alias_note or "")]
        aliases = [re.sub(r"《[^》]*》", "", alias).strip() for alias in aliases]
        entries.append({
            "name": name.strip(),
            "aliases": [alias for alias in aliases if alias and alias != name],
            "source": f"《{source.strip()}》",
            "kind": "main",
            "functions": split_functions(functions),
            "indications": indications.strip(),
            "composition": re.sub(r"\s+", " ", composition).strip()[:600],
        })

    # 附方：单行，「N.方名 （《出处》…） …功用：…。主治：…」
    appended_pattern = re.compile(
        rf"(?m)^(?:【附方】\s*)?(?:\d{{1,2}}\s*[.．]\s*)?({NAME})\s*[（(]《([^》\n]{{1,40}})》[^）)\n]{{0,30}}[）)](.{{0,900}}?)功用[：:]\s*([^。\n]{{2,80}})。\s*主治[：:]\s*([^\n]{{2,400}})$",
    )
    for match in appended_pattern.finditer(text):
        name, source, composition, functions, indications = match.groups()
        entries.append({
            "name": name.strip(),
            "source": f"《{source.strip()}》",
            "aliases": [],
            "kind": "appended",
            "functions": split_functions(functions),
            "indications": indications.strip(),
            "composition": re.sub(r"\s+", " ", composition).strip()[:600],
        })

    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for entry in entries:
        key = (entry["name"], entry["source"])
        if key in seen or not entry["functions"]:
            continue
        seen.add(key)
        unique.append(entry)
    unique.sort(key=lambda item: (item["name"], item["source"]))
    payload = {
        "schemaVersion": "tcm-formula-textbook-functions-v1",
        "source": {
            "file": "中医补充数据/灵丹GitHub/TCM Educational Materials.txt",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "work": "《方剂学》规划教材（正方【功用】【主治】与【附方】功用/主治）",
        },
        "counts": {
            "main": sum(1 for item in unique if item["kind"] == "main"),
            "appended": sum(1 for item in unique if item["kind"] == "appended"),
        },
        "entries": unique,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(OUT.relative_to(ROOT)), **payload["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
