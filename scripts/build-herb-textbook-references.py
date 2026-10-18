#!/usr/bin/env python3
"""从本地教材语料生成「方义药物功效核对」用的参考文本（2026-10-19）。

产物 src/data/tcm-herb-textbook-references.json 只给运行时一件事用：M04 方义里某味药被说成有某种功效时，
判断这种功效有没有教材依据（m04-formula-analysis-claim-check.server.ts 的第二道确定性核对）。
它只用来**挡住删除**：参考文本越全，删得越少。

两部分：
  herbs               《中药学》（钟赣生主编，全国中医药行业高等教育“十三五”规划教材）各药【功效】一行，以及附药（椒目、鹿角胶…）
                      「功能…」一句；
  formulaCommentaries 《方剂学》（同一套十三五教材）各方【方解】与【配伍特点】。

语料（中医补充数据/灵丹GitHub/TCM Educational Materials.txt）不进镜像，所以要在这里生成一份小的受治理产物。
语料是多本教材拼接的文本，两本书在文中的行段固定：《中药学》各论约在 151400–161000 行，《方剂学》各论约在 46000–51200 行；
解析后按条数自检（药 ≥ 450、方 ≥ 200），语料换了版本条数对不上就失败，不静默产出半份。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CORPUS_REF = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt"
CORPUS = PROJECT_ROOT / CORPUS_REF
OUTPUT = PROJECT_ROOT / "src/data/tcm-herb-textbook-references.json"
MATERIA_MEDICA_LINES = (151400, 161000)
FORMULA_LINES = (46000, 51200)


def compact(value: str) -> str:
    return re.sub(r"[\s　]", "", value or "")


def parse_herbs(lines: list[str]) -> dict[str, dict]:
    start, end = MATERIA_MEDICA_LINES
    herbs: dict[str, dict] = {}
    # 附药挂在哪一味正药下面（龟甲胶 → 龟甲、椒目 → 花椒）：运行时把正药的功效也算作附药的参考（只用来挡住删除）。
    parent = ""
    for index in range(start, min(end, len(lines))):
        line = lines[index]
        if line.startswith("【药性】"):
            # 药名在拼音行（「Máhuáng（《神农本草经》）」）的上一行，写作「麻　黄」。
            pinyin = index - 1
            while pinyin > index - 6 and not re.match(r"^[A-ZÀ-ǜ][^一-鿿]*（", lines[pinyin]):
                pinyin -= 1
            if pinyin <= index - 6:
                continue
            name = compact(lines[pinyin - 1])
            parent = name
            for offset in range(1, 4):
                candidate = lines[index + offset]
                if candidate.startswith("【功效】"):
                    text = candidate.replace("【功效】", "").strip(" 　")
                    if name and text:
                        herbs.setdefault(name, {"function": text, "line": index + offset + 1})
                    break
            # 【用法用量】与【使用注意】在同一味正文里、下一味【药性】之前（2026-10-19：饮片使用注意与病历对照 herb-record-caution.ts；
            # 特殊煎法标注的依据 herb-decoction-rules.ts）。
            if name in herbs:
                for offset in range(1, 80):
                    if index + offset >= len(lines):
                        break
                    candidate = lines[index + offset]
                    if candidate.startswith("【药性】"):
                        break
                    if candidate.startswith("【用法用量】") and "usage" not in herbs[name]:
                        text = candidate.replace("【用法用量】", "").strip(" 　")
                        if text:
                            herbs[name]["usage"] = text
                            herbs[name]["usageLine"] = index + offset + 1
                    if candidate.startswith("【使用注意】") and "caution" not in herbs[name]:
                        text = candidate.replace("【使用注意】", "").strip(" 　")
                        if text:
                            herbs[name]["caution"] = text
                            herbs[name]["cautionLine"] = index + offset + 1
                        break
            continue
        # 附药：「附药：椒目」下一行「本品为…功能利水消肿，降气平喘。」；多味附药各起一段「2.鹿角胶　本品为…功能…」。
        # 附药段落里功能之后的用法（「…煎服，15～30g，先煎。」）记作 usage，供特殊煎法标注核对。
        usage_of = lambda paragraph: (re.search(r"(?:煎服|入煎|用量)[^。]*。?", paragraph.split("功能", 1)[-1]) or [None])[0]
        numbered = re.match(r"^(?:\d\.)?([一-鿿]{2,5})[　 ]+本品为.*?功能(.*?)。", line)
        if numbered:
            usage = usage_of(line)
            herbs.setdefault(numbered.group(1), {"function": numbered.group(2), "line": index + 1, **({"parent": parent} if parent else {}),
                                                 **({"usage": usage, "usageLine": index + 1} if usage else {})})
            continue
        if line.startswith("附药：") and "、" not in line:
            name = compact(line.replace("附药：", ""))
            following = lines[index + 1] if index + 1 < len(lines) else ""
            matched = re.search(r"功能(.*?)。", following)
            if name and matched:
                usage = usage_of(following)
                herbs.setdefault(name, {"function": matched.group(1), "line": index + 2, **({"parent": parent} if parent else {}),
                                        **({"usage": usage, "usageLine": index + 2} if usage else {})})
    return herbs


def parse_formulas(lines: list[str]) -> dict[str, dict]:
    start, end = FORMULA_LINES
    heads = [
        (index - 2, compact(lines[index - 2]))
        for index in range(start, min(end, len(lines)))
        if lines[index].startswith("【组成】") and lines[index - 1].startswith("《")
    ]
    formulas: dict[str, dict] = {}
    for position, (head, name) in enumerate(heads):
        stop = heads[position + 1][0] if position + 1 < len(heads) else head + 60
        entry: dict[str, object] = {"line": head + 1}
        current = None
        for index in range(head + 2, stop):
            line = lines[index]
            matched = re.match(r"^【(.*?)】", line)
            if matched:
                current = matched.group(1)
                if current in ("方解", "配伍特点"):
                    entry["commentary" if current == "方解" else "features"] = line[matched.end():].strip(" 　")
                    entry[f"{'commentary' if current == '方解' else 'features'}Line"] = index + 1
            elif current == "方解":
                entry["commentary"] = f"{entry.get('commentary', '')}{line.strip()}"
        if name and entry.get("commentary"):
            formulas[name] = entry
    return formulas


def main() -> int:
    if not CORPUS.is_file():
        print(f"textbook corpus not found: {CORPUS_REF}", file=sys.stderr)
        return 1
    raw = CORPUS.read_bytes()
    lines = raw.decode("utf-8").split("\n")
    herbs = parse_herbs(lines)
    formulas = parse_formulas(lines)
    if len(herbs) < 450 or len(formulas) < 200:
        print(f"unexpected corpus layout: herbs={len(herbs)} formulas={len(formulas)}", file=sys.stderr)
        return 1
    payload = {
        "schemaVersion": "tcm-herb-textbook-references-v1",
        "source": {
            "file": CORPUS_REF,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "books": {
                "herbs": "《中药学》钟赣生主编，全国中医药行业高等教育“十三五”规划教材，各药【功效】与附药「功能」句；正药另取【用法用量】【使用注意】，附药取功能之后的用法句",
                "formulaCommentaries": "《方剂学》全国中医药行业高等教育“十三五”规划教材，各方【方解】与【配伍特点】",
            },
            "generator": "scripts/build-herb-textbook-references.py",
        },
        "note": "function 与 formulaCommentaries 只供 M04 方义药物功效核对的第二道确定性判据挡住删除：某味药被说成有某种功效时，药的功效行或任何一首方的方解里这味药紧跟着就有这种功效，就不删。caution（【使用注意】）供饮片使用注意与病历对照（herb-record-caution.ts）；usage（【用法用量】）供特殊煎法标注核对（herb-decoction-rules.ts）。都不参与准入、剂量门禁。",
        "herbs": dict(sorted(herbs.items())),
        "formulaCommentaries": dict(sorted(formulas.items())),
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({"herbs": len(herbs), "formulaCommentaries": len(formulas)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
