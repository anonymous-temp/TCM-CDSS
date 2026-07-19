#!/usr/bin/env python3
"""Build a provenance-bearing herb function category index from the curated workbook."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(
    "/Users/wangzeyuan/Desktop/合理用药/中医药数据/中药数据规范（药典、中华本草、中药学）+-+副本.xlsx"
)
SOURCE = Path(os.environ.get("TCM_HERB_FUNCTION_SOURCE", DEFAULT_SOURCE))
OUTPUT = ROOT / "src/data/tcm-herb-function-categories.json"


def clean(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip().replace(" ", "")


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing herb function source workbook: {SOURCE}")

    frame = pd.read_excel(SOURCE, sheet_name="中药规范")
    pairs = [
        ("中药学（十版）", "功效归类1"),
        ("中药学（十版）.1", "功效归类2"),
    ]
    categories: dict[str, set[str]] = {}
    for herb_column, category_column in pairs:
        if herb_column not in frame.columns or category_column not in frame.columns:
            raise SystemExit(f"Missing expected columns: {herb_column}, {category_column}")
        for herb_value, category_value in zip(frame[herb_column], frame[category_column], strict=True):
            herb = clean(herb_value)
            category = clean(category_value)
            if herb and category:
                categories.setdefault(herb, set()).add(category)

    payload = {
        "schemaVersion": "tcm-herb-function-categories-v1",
        "sourceFile": SOURCE.name,
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "sourceSheet": "中药规范",
        "sourceColumns": [column for pair in pairs for column in pair],
        "basis": "中药学（第十版）功效归类；仅用于功效语义校验，不替代药典剂量与院内审方",
        "herbCount": len(categories),
        "categories": {name: sorted(values) for name, values in sorted(categories.items())},
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "herbCount": len(categories)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
