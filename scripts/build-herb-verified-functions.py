#!/usr/bin/env python3
"""联网/教材核对过的药味功用词典（2026-09-29，甲方 9.24/9.27 测评：方义栏「需医生结合方义复核」占位、炙甘草混入生甘草功效）。

输入：研究员逐味产出的 parts/H-*.jsonl（每行一味药：verifiedFunctions / primaryFunctionsForFormulaUse / formulaRolePhrases /
kbClauseVerdicts / restriction / quotes）。原始材料与来源在 ~/runlogs/eval924/research2/（引文逐条 checkquote 校验，教材引文带行号）。
输出：src/data/tcm-herb-verified-functions.json，运行时由 src/lib/tcm-knowledge.ts 读取：
  · functions   —— 追加到该药的功用文本（只追加，原有条目不动；这是把「库里只有分类标签」补成有正文的来源）；
  · unsupported —— 核对为「药典/中药学都不给该药」的原有条目，从功用文本剔除（例：炙甘草名下的「清热解毒」属生甘草）。
                   分类标签与给药途径类文字（先煎/包煎/冲服…）绝不在此列——它们承载安全语义；
  · primary     —— 该药作为方剂组成时通常承担的 1–3 项作用，方义栏对不上本方治法时用它代替占位句；
  · roles       —— 方剂学明确写出的该药佐/使角色（甘草使：调和诸药；桔梗使：载药上行…）。
只收「有已核对引文」的条目；kind 为 parse_artifact / unidentifiable 的不收。本脚本只整形，不改写临床文字。
用法：python3 scripts/build-herb-verified-functions.py [parts 目录] [输出路径]
"""
import glob
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARTS = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "runlogs/eval924/research2/parts"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "src/data/tcm-herb-verified-functions.json"
SKIP_KINDS = {"parse_artifact", "unidentifiable"}
ROLES = ("君", "臣", "佐", "使")


def clean_phrase(value):
    text = str(value or "").strip().strip("，,；;。 ")
    return text


def phrases(values, limit):
    out = []
    for value in values or []:
        text = clean_phrase(value)
        # 一条功用短语只有一个含义；含逗号的按逗号拆开，超长句子（>12 字）不进词典（那是说明文字不是功效词）
        for piece in text.replace("；", "，").replace(";", "，").replace(",", "，").split("，"):
            piece = clean_phrase(piece)
            if 2 <= len(piece) <= 12 and piece not in out:
                out.append(piece)
    return out[:limit]


def applies_to_this_form(name, note):
    """processing_specific 的说明写明了该条属于哪种炮制品：
    「仅麸炒品…」且本条目名含「麸炒」→ 属于本条目，保留；「仅萸黄连」而本条目是「黄连片」→ 属于别的炮制品，剔除；
    「属生甘草」「宜生用」→ 不属于炙品，剔除。说明里认不出指向时按「不属于」处理（宁可少写一条功用，不写错）。"""
    text = str(note or "")
    if text.startswith("属生") or "宜生用" in text or "炙品不取" in text:
        return False
    marker = text.find("仅")
    if marker < 0:
        return False
    tail = text[marker + 1:]
    for stop in ("：", ":", "；", ";", "，", ",", "(", "（", " "):
        cut = tail.find(stop)
        if cut >= 0:
            tail = tail[:cut]
    for token in tail.split("/"):
        token = token.strip().rstrip("品")
        if token and (token in name or name in token):
            return True
    return False


def main():
    herbs = {}
    skipped = {"no_verified_quote": [], "skip_kind": [], "empty": []}
    for path in sorted(glob.glob(str(PARTS / "H-*.jsonl"))):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            name = clean_phrase(row.get("name"))
            if not name:
                continue
            if row.get("kind") in SKIP_KINDS:
                skipped["skip_kind"].append(name)
                continue
            quotes = [q for q in row.get("quotes", []) if q.get("verified")]
            if not quotes:
                skipped["no_verified_quote"].append(name)
                continue
            functions = phrases(row.get("verifiedFunctions"), 8)
            primary = phrases(row.get("primaryFunctionsForFormulaUse"), 3) or functions[:2]
            roles = {}
            for key, value in (row.get("formulaRolePhrases") or {}).items():
                picked = phrases([value], 2)
                if not picked:
                    continue
                # 「佐使」这类合写的键，两个角色都登记。使药的说法（调和诸药、载药上行、引血下行）是跨方通用的，
                # 留两条短语；其余角色的说法是某一首方剂里的具体配伍，只留一条（运行时也不用它们，只用「使」）。
                for role in ROLES:
                    if role in key and role not in roles:
                        roles[role] = "，".join(picked[:2] if role == "使" else picked[:1])
            unsupported = []
            for verdict in row.get("kbClauseVerdicts", []):
                clause = clean_phrase(verdict.get("clause"))
                if not clause or clause in unsupported:
                    continue
                if verdict.get("verdict") == "unsupported":
                    unsupported.append(clause)
                elif (verdict.get("verdict") == "processing_specific" and row.get("kind") == "processed_form"
                      and not applies_to_this_form(name, verdict.get("note"))):
                    # 该条属于**另一种**炮制品（炙甘草名下的「清热解毒」属生甘草；黄连片名下的「止呕」属姜/萸黄连）
                    unsupported.append(clause)
            if not functions and not primary and not roles:
                skipped["empty"].append(name)
                continue
            entry = {
                "kind": row.get("kind"),
                "canonicalName": clean_phrase(row.get("canonicalName")),
                "functions": functions,
                "primary": primary,
                "roles": roles,
                "unsupported": unsupported,
                "confidence": row.get("confidence") or "",
                "evidence": [{"source": q.get("sourceId"), "text": q.get("text"), "line": q.get("line")} for q in quotes[:3]],
            }
            if row.get("restriction"):
                entry["restriction"] = clean_phrase(row["restriction"])
            # 同名多行时后写入者覆盖（研究员重跑同一味药时取最新一行）
            herbs[name] = entry
    output = {
        "schemaVersion": "tcm-herb-verified-functions-v1",
        "generatedBy": "scripts/build-herb-verified-functions.py",
        "note": "药味功用核对词典：来源为《中国药典》2020年版一部功能项、十三五《中药学》《方剂学》原句，逐条带引文；运行时只追加功用、剔除已核对为无依据的条目，不改写任何临床文字。",
        "herbs": dict(sorted(herbs.items())),
    }
    OUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} herbs={len(herbs)} skipped={{{', '.join(f'{k}:{len(v)}' for k, v in skipped.items())}}}")


if __name__ == "__main__":
    main()
