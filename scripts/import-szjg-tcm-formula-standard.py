#!/usr/bin/env python3
"""Import the complete SZJG/T 38.2-2011 formula appendix into structured JSON.

The importer reads the official, text-layer PDF table rather than inferring formula
identities from the project's historical same-name corpus.  It is intentionally a
separate source-import step: normal application builds consume the checked-in JSON
and do not require network access.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
import urllib.request
from pathlib import Path

import pdfplumber


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT_ROOT / "src/data/szjg-tcm-formula-standard.json"
SOURCE_URL = "https://amr.sz.gov.cn/attachment/1/1620/1620360/9772233.pdf"
CODE_RE = re.compile(r"06\d{8}")


def compact(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip()


def normalized_ingredients(value: object) -> list[str]:
    text = str(value or "").replace("\n", " ")
    tokens = [item.strip() for item in re.split(r"\s+", text) if item.strip()]
    result: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index] == "火单" and index + 1 < len(tokens):
            result.append(f"燀{tokens[index + 1]}")
            index += 2
            continue
        result.append(tokens[index].replace("枳売", "枳壳"))
        index += 1
    return result


def download_pdf() -> Path:
    temporary = tempfile.NamedTemporaryFile(prefix="szjg-tcm-formula-", suffix=".pdf", delete=False)
    temporary.close()
    target = Path(temporary.name)
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "tcm-cdss-governance-import/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
        output.write(response.read())
    return target


def parse_pdf(path: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    with pdfplumber.open(path) as pdf:
        # The appendix occupies PDF pages 10-88 (one-based).  Header/footer tables
        # are ignored by requiring the ten-digit formula code in column two.
        for page_number, page in enumerate(pdf.pages[9:88], start=10):
            for table in page.extract_tables():
                for row in table:
                    if len(row) < 7:
                        continue
                    code = compact(row[1])
                    if not CODE_RE.fullmatch(code):
                        continue
                    name = compact(row[2])
                    source = compact(row[3])
                    functions = [item for item in re.split(r"[，、；;]", compact(row[5])) if item]
                    indications = compact(row[6])
                    if not name or not source or not indications:
                        continue
                    entries.append({
                        "code": code,
                        "name": name,
                        "source": source,
                        "ingredients": normalized_ingredients(row[4]),
                        "functions": functions,
                        "indications": [indications],
                        "sourcePage": page_number,
                    })
    entries.sort(key=lambda item: str(item["code"]))
    names = [str(item["name"]) for item in entries]
    codes = [str(item["code"]) for item in entries]
    if len(entries) < 650 or len(set(names)) != len(entries) or len(set(codes)) != len(entries):
        raise SystemExit(f"Unexpected appendix parse: rows={len(entries)}, uniqueNames={len(set(names))}, uniqueCodes={len(set(codes))}")
    return entries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, help="Use a local official PDF instead of downloading it")
    args = parser.parse_args()
    downloaded = args.pdf is None
    source_path = args.pdf or download_pdf()
    try:
        entries = parse_pdf(source_path)
        payload = {
            "schemaVersion": "szjg-tcm-formula-standard-v1",
            "source": {
                "title": "中药饮片与中药方剂编码规则 第2部分：中药方剂（SZJG/T 38.2-2011）",
                "url": SOURCE_URL,
                "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                "appendix": "附录A 中药方剂代码一览表",
                "extractionMethod": "pdfplumber_table_text_layer",
            },
            "governance": {
                "scope": "方剂身份、来源、组成、功效和主治；不提供患者级剂量",
                "selectionPolicy": "T8可从本全量标准表选取门诊检索基线；患者采用仍经M03方证核对、M04剂量生成和处方后审方。",
            },
            "summary": {"formulaCount": len(entries)},
            "entries": entries,
        }
        OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(payload["summary"], ensure_ascii=False))
    finally:
        if downloaded:
            source_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
