#!/usr/bin/env python3
"""Build the 成份 (composition) table for the local Chinese patent-medicine label indexes.

2026-10-19：推荐的中成药与汤剂重复（甲方标准病历 2：汤剂人参 6g 旁推荐人参口服液；病历 7：汤剂黄连、大黄旁推荐
三黄片、栀子金花丸、一清片）。判重复要知道中成药由哪些药组成。两份说明书索引（非处方、处方）只收了功能主治、
用法、禁忌这些字段，没有「成份」；同一个工作簿里有这一列。

只为两份索引里已有的药名取成份，并且取**与索引条目同一批准文号**的那一行——页面上显示的说明书就是那一条。
成份原文按顿号/逗号切成药名片段，去掉辅料、括注、含量与制法词（浸膏、提取物、细粉…），药名的身份归一留给运行时
（canonicalTcmHerbIdentity），不在这里猜。说明书索引的指纹不动：这是另一份文件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from openpyxl import load_workbook


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "药学基础数据/药品说明书数据库_医药数据查询/药品详细信息_总.xlsx"
INDEXES = [
    PROJECT_ROOT / "src/data/local-patent-medicine-index.json",
    PROJECT_ROOT / "src/data/local-patent-medicine-rx-index.json",
]
DEFAULT_OUTPUT = PROJECT_ROOT / "src/data/local-patent-medicine-composition.json"

# 辅料及其后的内容不是药味。
EXCIPIENT_CUT = re.compile(r"(?:辅料|輔料|辅\s*料)[为是：:]?.*$")
# 「本品每片含…」「每1000片含…」「本品系由…制成」这类引导语。
LEAD_PHRASES = re.compile(r"^(?:本品)?(?:主要)?(?:成份|成分|组成|处方)?(?:为|是|：|:)?|本品(?:系|是)?由|每\s*[\d.]*\s*(?:片|粒|袋|丸|支|ml|毫升|克|g)?\s*含")
# 括注（含量、炮制说明）。
PARENTHESES = re.compile(r"[（(【\[][^）)】\]]*[）)】\]]")
# 制剂词尾：提取物、浸膏、挥发油、细粉……这些仍代表那味药。
# 只去明确的制剂词；单个「粉」「油」「汁」不去（天花粉、薄荷油、生姜汁本身就是药名或另一味药）。
PREPARATION_SUFFIX = re.compile(r"(?:总?(?:提取物|浸膏粉?|流浸膏|干浸膏|稠膏|挥发油|细粉|粗粉|极细粉|水提物|醇提物|总苷|总黄酮|总皂苷))$")
TRAILING_ETC = re.compile(r"(?:等(?:味|药)?)$")
QUANTITY = re.compile(r"[\d.]+\s*(?:mg|g|kg|ml|μg|ug|毫克|克|千克|毫升|万单位|单位|IU|%)", re.I)
CJK_TOKEN = re.compile(r"^[一-鿿]{1,10}$")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generic_name(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()[:160]
    return re.sub(r"[（(][^）)]*[）)]", "", text).strip()


def composition_tokens(raw: object) -> list[str]:
    text = re.sub(r"\s+", "", str(raw or "")).strip()
    if not text:
        return []
    text = EXCIPIENT_CUT.sub("", text)
    text = PARENTHESES.sub("", text)
    text = QUANTITY.sub("", text)
    tokens: list[str] = []
    for piece in re.split(r"[、，,；;。.\s/]+", text):
        piece = LEAD_PHRASES.sub("", piece).strip()
        piece = TRAILING_ETC.sub("", piece).strip()
        piece = PREPARATION_SUFFIX.sub("", piece).strip()
        if CJK_TOKEN.match(piece) and piece not in tokens:
            tokens.append(piece)
    return tokens[:40]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"Local medicine workbook not found: {source}")

    wanted: dict[str, str] = {}
    for index in INDEXES:
        payload = json.loads(index.read_text(encoding="utf-8"))
        for entry in payload["entries"]:
            wanted.setdefault(entry["name"], entry["approvalNumber"])

    worksheet = load_workbook(source, read_only=True, data_only=True).active
    rows = worksheet.iter_rows(values_only=True)
    headers = [str(value or "").strip() for value in next(rows)]
    for column in ("产品名称", "批准文号", "主分类", "成份"):
        if column not in headers:
            raise SystemExit(f"Local medicine workbook missing column: {column}")
    name_at, approval_at, category_at, composition_at = (
        headers.index("产品名称"), headers.index("批准文号"), headers.index("主分类"), headers.index("成份"))

    same_approval: dict[str, list[str]] = {}
    by_name: dict[str, list[list[str]]] = {}
    for row in rows:
        if str(row[category_at] or "").strip() != "中成药":
            continue
        name = generic_name(row[name_at])
        if name not in wanted:
            continue
        tokens = composition_tokens(row[composition_at])
        if not tokens:
            continue
        approval = re.sub(r"\s+", " ", str(row[approval_at] or "")).strip()[:100]
        if approval == wanted[name] and name not in same_approval:
            same_approval[name] = tokens
        by_name.setdefault(name, []).append(tokens)

    # 索引挑的是字段最全的那一行，成份栏却可能恰好空着（人参口服液、人参健脾丸）。同名中成药按同一标准生产，
    # 这时取同名其他批准文号各行都有的药名片段（共有部分），并注明来源。
    entries: dict[str, dict[str, object]] = {}
    for name, approval in wanted.items():
        if name in same_approval:
            entries[name] = {"approvalNumber": approval, "basis": "same_approval", "ingredients": same_approval[name]}
            continue
        variants = by_name.get(name) or []
        if not variants:
            continue
        shared = [token for token in variants[0] if all(token in other for other in variants[1:])]
        if shared:
            entries[name] = {"approvalNumber": approval, "basis": f"same_name_consensus:{len(variants)}", "ingredients": shared}

    if len(entries) < 0.8 * len(wanted):
        raise SystemExit(f"Composition found for only {len(entries)} of {len(wanted)} indexed medicines")
    payload = {
        "schemaVersion": "local-patent-medicine-composition-v1",
        "sourceFile": source.name,
        "sourceSha256": file_sha256(source),
        "selectionBoundary": "两份说明书索引（非处方、处方）里的药名；取与索引条目同一批准文号那一行的「成份」，切成药名片段（不含辅料、括注、含量）",
        "entryCount": len(entries),
        "entries": {name: entries[name] for name in sorted(entries)},
    }
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Built {args.output}: composition for {len(entries)} of {len(wanted)} indexed medicines")


if __name__ == "__main__":
    main()
