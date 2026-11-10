#!/usr/bin/env python3
"""按用途选饮片规格的表（2026-11-11 第四十二轮）：从《中药学》（十三五）各药【用法用量】【使用注意】【功效】原文切出
「哪种用途用生品、哪种用途用哪种炮制品」，以及「内服须经炮制」的药。

输入是已生成的 src/data/tcm-herb-textbook-references.json（各药的 usage/caution/function 原文与行号，见 build-herb-textbook-references.py），
输出 src/data/tcm-herb-purpose-processing.json，运行时由 src/lib/herb-processing-forms.ts 读取。

为什么要它：线上盲评 new40 两例内服写了裸「半夏」（教材「内服一般炮制后用」），天麻钩藤饮里平肝潜阳用了「煅石决明」
（教材「平肝、清肝宜生用」；煅品来自调剂编码标准的组成）。第三十七轮的炮制规则是手挑的九条，只会加炮制、不会改用错的炮制，
有毒药一律不碰。这里把教材写明生/制用途的条目全部切出来，规则只写一次。

切法（只认这几种句式，其余不切；每条都带原句与行号）：
  ① 「A、B宜生用，C宜煅用」「…生用，…煅用」：句末是「(宜|须)?<炮制词>用」的分句，前面的顿号短语就是用途；
     带「多」「可」「其余」「其他」的是倾向性说法（「止血多炒炭用」），记为 weak，运行时不据此改名；
  ② 「法半夏长于燥湿化痰…；姜半夏长于温中化痰，降逆止呕…」「生用偏于…，姜汁炙用偏于…」；
  ③ 【功效】写成「制何首乌：…。生何首乌：…」的分规格功效；【使用注意】「制用偏于补益…；生用滑肠通便」；
  ④ 内服须炮制：【用法用量】「内服一般炮制后用」「内服制用」「一般宜炮制后用」「内服醋炙用」「制X煎服…生品宜外用」，
     或【使用注意】「内服须经炮制」。
炮制词只换成规格前缀（煅、炒、焦、炭、蜜、酒、醋、盐、煨、姜、制）；饮片名由运行时按知识库认得的写法拼（煅石决明、蜜百部、侧柏炭…）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "src/data/tcm-herb-textbook-references.json"
OUTPUT = ROOT / "src/data/tcm-herb-purpose-processing.json"

# 炮制词 → 规格前缀（"" 是生品）。长的在前。
PROCESS_WORDS = [
    ("砂烫醋淬", "醋"), ("盐水炙", "盐"), ("姜汁炙", "姜"), ("醋淬", "煅"), ("炒焦", "焦"), ("炒炭", "炭"),
    ("蜜炙", "蜜"), ("蜜制", "蜜"), ("酒炙", "酒"), ("酒制", "酒"), ("酒炒", "酒"), ("醋炙", "醋"), ("醋炒", "醋"),
    ("盐炙", "盐"), ("煅", "煅"), ("煨", "煨"), ("炒", "炒"), ("制", "制"), ("生", ""),
]
PROCESS_ALT = "|".join(re.escape(word) for word, _ in PROCESS_WORDS)
PREFIX_OF = dict(PROCESS_WORDS)
WEAK = re.compile(r"(?:多|可|其余|其他)")
CLAUSE = re.compile(rf"^(?P<purposes>.+?)(?P<modal>宜|须|多|可)?(?:(?P<word>{PROCESS_ALT})(?:后)?用|(?P<word2>{PROCESS_ALT})(?:品)?(?:为佳))$")
MUST_PROCESS = re.compile(r"内服一般炮制后用|内服制用|一般宜炮制后用|内服醋炙用|内服须经炮制|内服宜制用")
NAMED_FORM = re.compile(r"^(?P<name>[\u4e00-\u9fff]{2,5}?)(?:长于|偏于|善)(?P<purposes>.+?)(?:[，,](?:主治|用于|多用)|$)")
# 规格名的前缀只认饮片规格（法半夏、姜半夏、清半夏、酒黄连、炒稻芽…）；「黄菊花」「青翘」是品种不是炮制，不收。
NAMED_PREFIXES = {"法", "姜", "清", "制", "炙", "蜜", "酒", "醋", "盐", "煅", "炒", "焦", "煨", "熟"}


def purposes_of(text: str) -> list[str]:
    text = re.sub(r"[（(][^）)]*[）)]", "", text)
    parts = [part.strip() for part in re.split(r"[、，,]", text) if part.strip()]
    out = []
    for part in parts:
        part = re.sub(r"^(?:本品|欲|以|用于|治|故)", "", part)
        part = re.sub(r"(?:者|以)$", "", part)
        if 2 <= len(part) <= 8 and not re.search(r"[\d～~g]|效果|作用|其余|其他|内服|炮制|一般", part):
            out.append(part)
    return out


def form_rows(herb: str, entry: dict) -> list[dict]:
    rows: list[dict] = []
    usage = entry.get("usage") or ""
    line = entry.get("usageLine")
    for sentence in re.split(r"[。；;]", usage):
        for clause in re.split(r"[，,]", sentence):
            clause = clause.strip()
            if not clause or re.search(r"煎服|外用|适量|\d", clause) or MUST_PROCESS.search(clause) or "炮制" in clause:
                continue
            match = CLAUSE.match(clause)
            if not match:
                continue
            word = match.group("word") or match.group("word2")
            raw_purposes = match.group("purposes")
            if re.search(r"或", raw_purposes) or re.search(r"或$", clause):
                continue
            purposes = purposes_of(raw_purposes)
            if not purposes:
                continue
            weak = bool(match.group("modal") in ("多", "可")) or bool(WEAK.search(raw_purposes))
            rows.append({"prefix": PREFIX_OF[word], "purposes": purposes, "weak": weak, "quote": clause, "field": "usage", "line": line})
        # ② 「法半夏长于…」「生用偏于…，姜汁炙用偏于…」
        for clause in re.split(r"[；;]", sentence):
            clause = clause.strip()
            named = NAMED_FORM.match(clause)
            if named and named.group("name").endswith(herb) and named.group("name")[: -len(herb)] in NAMED_PREFIXES:
                prefix = named.group("name")[: -len(herb)]
                rows.append({"prefix": prefix, "purposes": purposes_of(named.group("purposes")), "weak": False, "quote": clause, "field": "usage", "line": line})
            for part in re.split(r"[，,]", clause):
                biased = re.match(rf"^(?P<word>{PROCESS_ALT})用偏于(?P<purposes>.+)$", part.strip())
                if biased:
                    rows.append({"prefix": PREFIX_OF[biased.group("word")], "purposes": purposes_of(biased.group("purposes")), "weak": False, "quote": part.strip(), "field": "usage", "line": line})
    # ③ 【功效】分规格（「制何首乌：…。生何首乌：…」）与【使用注意】「制用偏于补益…；生用滑肠通便」
    for match in re.finditer(rf"(?P<prefix>{PROCESS_ALT}){re.escape(herb)}[：:](?P<purposes>[^。]+)", entry.get("function") or ""):
        rows.append({"prefix": PREFIX_OF[match.group("prefix")], "purposes": purposes_of(match.group("purposes")), "weak": False, "quote": match.group(0), "field": "function", "line": entry.get("line")})
    for match in re.finditer(rf"(?P<word>制|生)用(?:偏于)?(?P<purposes>[^，；。]+)", entry.get("caution") or ""):
        rows.append({"prefix": PREFIX_OF[match.group("word")], "purposes": purposes_of(match.group("purposes")), "weak": False, "quote": match.group(0), "field": "caution", "line": entry.get("cautionLine")})
    return [row for row in rows if row["purposes"]]


def main() -> None:
    source = json.loads(INPUT.read_text(encoding="utf-8"))
    herbs = source["herbs"]
    table = []
    for herb, entry in sorted(herbs.items()):
        rows = form_rows(herb, entry)
        usage = entry.get("usage") or ""
        caution = entry.get("caution") or ""
        must = MUST_PROCESS.search(usage) or MUST_PROCESS.search(caution) or re.search(rf"^制{re.escape(herb)}煎服", usage)
        if not rows and not must:
            continue
        item = {"herb": herb, "forms": rows}
        if must:
            quote_field = "usage" if (MUST_PROCESS.search(usage) or re.search(rf"^制{re.escape(herb)}煎服", usage)) else "caution"
            text = usage if quote_field == "usage" else caution
            item["internalMustProcess"] = {
                "quote": next(part for part in re.split(r"[。；]", text) if MUST_PROCESS.search(part) or part.startswith(f"制{herb}")),
                "field": quote_field,
                "line": entry.get("usageLine") if quote_field == "usage" else entry.get("cautionLine"),
            }
        table.append(item)
    payload = {
        "schemaVersion": "herb-purpose-processing-v1",
        "generatedBy": "scripts/build-herb-purpose-processing.py",
        "source": {"file": "src/data/tcm-herb-textbook-references.json", "book": source.get("source", {}).get("books", {}).get("herbs")},
        "note": "prefix 是饮片规格前缀（\"\" 为生品）；purposes 是原句里该规格对应的用途；weak=true 的是「多…用」「可…用」一类倾向性说法，运行时不据此改名。internalMustProcess 是教材写明内服须炮制的药。",
        "herbs": table,
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(table)} herbs, {sum(len(item['forms']) for item in table)} form rows, {sum(1 for item in table if 'internalMustProcess' in item)} must-process")


if __name__ == "__main__":
    main()
