#!/usr/bin/env python3
"""Import governed terminology indexes from official TCM standard attachments.

The generated tables intentionally omit the standards' full definitions.  They retain
the standard number, canonical term, aliases, English label, classification and a
definition digest so that local copies can be verified without republishing the text.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from zipfile import ZipFile
from xml.etree import ElementTree


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = PROJECT_ROOT / "src/data"
CACHE_ROOT = PROJECT_ROOT / "artifacts/governance-source-cache"
SYNDROME_PDF = Path(os.environ.get(
    "TCM_SYNDROME_STANDARD_PDF",
    CACHE_ROOT / "GBT16751.2-2021.pdf",
))
TREATMENT_DOCX = Path(os.environ.get(
    "TCM_TREATMENT_STANDARD_DOCX",
    CACHE_ROOT / "e67eb60c0e954a318f06242a1f92cf2c.docx",
))
TREATMENT_PDF = Path(os.environ.get(
    "TCM_TREATMENT_STANDARD_PDF",
    CACHE_ROOT / "GBT16751.3-2023.pdf",
))
TREATMENT_OCR_TEXT = Path(os.environ.get(
    "TCM_TREATMENT_STANDARD_OCR_TEXT",
    CACHE_ROOT / "GBT16751.3-2023.ocr.txt",
))
SYNDROME_OUTPUT = DATA_ROOT / "tcm-syndrome-lexicon.json"
TREATMENT_OUTPUT = DATA_ROOT / "tcm-treatment-principle-lexicon.json"
CLINICAL_EXTENSIONS = DATA_ROOT / "tcm-clinical-terminology-extensions.json"

SYNDROME_SOURCE_URL = "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=C71A9DAD24CB1252F12439D1F045DA6A"
TREATMENT_SOURCE_URL = "https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=E8BBBAB76E1AF1498C5DA5DFBB2194EC"

SYNDROME_SECTIONS = {
    "3": "八纲证候类术语",
    "4": "病因证候类术语",
    "5": "气血阴阳精髓津液证候类术语",
    "6": "脏腑官窍证候类术语",
    "7": "经络证候类术语",
    "8": "六经证候类术语",
    "9": "三焦证候类术语",
    "10": "卫气营血证候类术语",
    "11": "其他证候类术语",
    "12": "期度类术语",
}
TREATMENT_SECTIONS = {
    "3": "治则类术语",
    "4": "治法类术语",
    "5": "疗法类术语",
}
TREATMENT_OCR_HEADING_REPAIRS = {
    "清热祛邪": "4.6.3",
    "固护阴液": "4.20.3",
    "湿热敷疗法": "5.3.1.2.1",
    "浸洗疗法": "5.3.5.1",
    "耳部疗法": "5.3.24",
}
SPECIAL_TREATMENT_ALIASES = {
    "标本兼治": ["标本兼顾"],
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def stable_id(prefix: str, value: str) -> str:
    suffix = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12].upper()
    return f"{prefix}-{suffix}"


def compact(value: object) -> str:
    return "".join(str(value or "").split()).strip()


def strip_syndrome_suffix(value: str) -> str:
    return re.sub(r"(?:证候|证)$", "", compact(value))


def strip_treatment_suffix(value: str) -> str:
    return re.sub(r"法$", "", compact(value))


def unique(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = value.strip()
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def cleaned_block(lines: list[str]) -> list[str]:
    result = []
    for raw in lines:
        line = raw.strip()
        if not line or re.fullmatch(r"\d+", line):
            continue
        if "GB/T 16751" in line or line.startswith("中医临床诊疗术语") or line.startswith("=== PAGE"):
            continue
        result.append(line)
    return result


def split_term_block(lines: list[str]) -> tuple[str, str, list[str], str]:
    block = cleaned_block(lines)
    if not block:
        raise ValueError("empty standard term block")
    match = re.match(r"^(.*?[\u3400-\u9fff])\s+[•·]?\s*([A-Za-z].*)$", block[0])
    if match:
        term = match.group(1).strip()
        english_parts = [match.group(2).strip()]
        cursor = 1
    else:
        term = block[0].strip()
        english_parts = []
        cursor = 1
    while cursor < len(block) and not re.search(r"[\u3400-\u9fff]", block[cursor]):
        english_line = re.sub(r"^[•·]\s*", "", block[cursor]).strip()
        if re.search(r"[A-Za-z]", english_line):
            english_parts.append(english_line)
        cursor += 1
    aliases: list[str] = []
    while cursor < len(block):
        line = compact(block[cursor])
        if len(line) <= 40 and re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9（）()\[\]·/\-]+", line):
            aliases.append(line)
            cursor += 1
            continue
        break
    definition = "".join(compact(item) for item in block[cursor:])
    return term, " ".join(english_parts), unique(aliases), definition


def syndrome_lines() -> list[str]:
    if not SYNDROME_PDF.is_file():
        raise SystemExit(
            f"Missing official syndrome PDF: {SYNDROME_PDF}. "
            "Set TCM_SYNDROME_STANDARD_PDF to the downloaded GB/T 16751.2-2021 file."
        )
    with tempfile.NamedTemporaryFile(suffix=".txt") as handle:
        subprocess.run(
            ["pdftotext", "-layout", str(SYNDROME_PDF), handle.name],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return Path(handle.name).read_text(encoding="utf-8", errors="ignore").splitlines()


def docx_paragraphs(path: Path) -> list[str]:
    if not path.is_file():
        raise SystemExit(
            f"Missing official treatment DOCX: {path}. "
            "Set TCM_TREATMENT_STANDARD_DOCX to the downloaded official revision attachment."
        )
    with ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    result = []
    for paragraph in root.iter(f"{namespace}p"):
        value = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t")).strip()
        if value:
            result.append(value)
    return result


def treatment_lines() -> list[str]:
    if not TREATMENT_PDF.is_file() or not TREATMENT_OCR_TEXT.is_file():
        raise SystemExit(
            "Missing GB/T 16751.3-2023 PDF or OCR text. Download the official PDF and run "
            "`swift scripts/ocr-pdf-vision.swift <pdf> <ocr.txt>`, or set "
            "TCM_TREATMENT_STANDARD_PDF and TCM_TREATMENT_STANDARD_OCR_TEXT."
        )
    lines = TREATMENT_OCR_TEXT.read_text(encoding="utf-8", errors="ignore").splitlines()
    repaired: list[str] = []
    for line in lines:
        normalized = line.strip()
        repaired_heading = next((
            number
            for title, number in TREATMENT_OCR_HEADING_REPAIRS.items()
            if normalized == title or normalized.startswith(f"{title} ")
        ), None)
        if repaired_heading:
            repaired.append(repaired_heading)
        repaired.append(line)
    return repaired


def term_blocks(lines: list[str], number_pattern: re.Pattern[str]) -> list[tuple[str, list[str]]]:
    all_numbered = [(index, line.strip()) for index, line in enumerate(lines) if number_pattern.fullmatch(line.strip())]
    if not all_numbered:
        raise ValueError("no numbered standard entries found")
    first_numbered_index = all_numbered[0][0]
    end = next(
        (index for index, line in enumerate(lines[first_numbered_index + 1:], first_numbered_index + 1)
         if line.strip().startswith("参考文献")),
        len(lines),
    )
    numbered = [(index, number) for index, number in all_numbered if index < end]
    result = []
    for position, (index, number) in enumerate(numbered):
        next_index = numbered[position + 1][0] if position + 1 < len(numbered) else end
        result.append((number, lines[index + 1:next_index]))
    return result


def legacy_match_index(entries: list[dict[str, Any]], normalizer) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for entry in entries:
        key = normalizer(entry.get("canonical", ""))
        if key and key not in result:
            result[key] = entry
    return result


def derived_ids(text: str, entries: list[dict[str, Any]]) -> list[str]:
    return sorted({
        entry["id"]
        for entry in entries
        if any(compact(term) and compact(term) in text for term in [entry["canonical"], *entry.get("aliases", [])])
    })


def build_syndrome_table() -> dict[str, Any]:
    clinical_extensions = read_json(CLINICAL_EXTENSIONS)
    # Clinicians write governed syndromes under several equally standard surface forms
    # (痰热扰心 / 痰火扰神, 风寒袭肺 / 风寒犯肺). Without an alias the term fails to normalize and the
    # whole T8 formula recall for that syndrome silently returns nothing, so alias augmentation is a
    # coverage mechanism, not cosmetics. Mirrors treatmentAliasAugmentations.
    syndrome_alias_augmentations = {
        item["targetCanonical"]: item.get("aliases", [])
        for item in clinical_extensions.get("syndromeAliasAugmentations", [])
    }
    legacy = read_json(SYNDROME_OUTPUT)
    legacy_index = legacy_match_index(legacy.get("entries", []), strip_syndrome_suffix)
    natures = read_json(DATA_ROOT / "tcm-nature-lexicon.json").get("entries", [])
    locations = read_json(DATA_ROOT / "tcm-location-lexicon.json").get("entries", [])
    entries: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for number, section_name in SYNDROME_SECTIONS.items():
        entry_id = stable_id("TCM-SYNDROME-CLASS", number)
        used_ids.add(entry_id)
        entries.append({
            "id": entry_id,
            "canonical": section_name,
            "standardTerm": section_name,
            "aliases": [],
            "standardNumber": number,
            "english": None,
            "category": section_name,
            "termClass": "category_heading",
            "locations": [],
            "natures": [],
            "definitionSha256": None,
            "sourceRefs": ["SRC-GBT-16751-2-2021"],
        })
    for number, block in term_blocks(
        syndrome_lines(),
        re.compile(r"(?:[3-9]|1[0-2])(?:\.\d+)+"),
    ):
        standard_term, english, standard_aliases, definition = split_term_block(block)
        canonical = strip_syndrome_suffix(standard_term)
        legacy_entry = legacy_index.get(canonical, {})
        candidate_id = legacy_entry.get("id") or stable_id("TCM-SYNDROME", number)
        entry_id = candidate_id if candidate_id not in used_ids else stable_id("TCM-SYNDROME", number)
        used_ids.add(entry_id)
        aliases = [value for value in unique([
            *[strip_syndrome_suffix(value) for value in standard_aliases],
            *legacy_entry.get("aliases", []),
            *syndrome_alias_augmentations.get(canonical, []),
        ]) if value != canonical]
        searchable = compact("；".join([canonical, standard_term, *aliases, definition]))
        entries.append({
            "id": entry_id,
            "canonical": canonical,
            "standardTerm": standard_term,
            "aliases": aliases,
            "standardAliases": standard_aliases,
            "standardNumber": number,
            "english": english,
            "category": SYNDROME_SECTIONS[number.split(".", 1)[0]],
            "termClass": "category_term" if "一类证候" in definition else "clinical_term",
            "locations": legacy_entry.get("locations") or derived_ids(searchable, locations),
            "natures": legacy_entry.get("natures") or derived_ids(searchable, natures),
            "definitionSha256": sha256_bytes(definition.encode("utf-8")),
            "sourceRefs": ["SRC-GBT-16751-2-2021"],
        })
    if len(entries) != 2060:
        raise ValueError(f"expected 2060 syndrome terms, got {len(entries)}")
    if len({entry["canonical"] for entry in entries}) != len(entries):
        raise ValueError("duplicate canonical syndrome terms after suffix normalization")
    return {
        "schemaVersion": "tcm-syndrome-lexicon-v2",
        "governance": {
            "status": "official_standard_complete_index",
            "standardReference": "GB/T 16751.2-2021",
            "standardUrl": SYNDROME_SOURCE_URL,
            "scopeNote": "完整索引覆盖标准收录的2060个术语；定义仅保存SHA-256指纹。病位病性标签为项目规则派生候选，不等同于标准定义或临床裁定。",
            "definitionReproductionPolicy": "digest_only",
        },
        "source": {
            "cachedFile": str(SYNDROME_PDF.relative_to(PROJECT_ROOT)),
            "sha256": sha256_file(SYNDROME_PDF),
            "accessedAt": "2026-07-22",
        },
        "summary": {
            "standardTermCount": len(entries),
            "categoryHeadingCount": len(SYNDROME_SECTIONS),
            "numberedTermCount": len(entries) - len(SYNDROME_SECTIONS),
            "clinicalExtensionCount": len(clinical_extensions.get("syndromeEntries", [])),
        },
        "normalization": {
            "removableSuffixes": ["证", "证候", "型"],
            "allowCompositionalTerms": True,
        },
        "clinicalExtensions": clinical_extensions.get("syndromeEntries", []),
        "entries": entries,
    }


def treatment_relation_policy(section: str) -> str:
    return {
        "3": "principle_only",
        "4": "method_requires_case_binding",
        "5": "therapy_requires_capability_and_safety_review",
    }[section]


def build_treatment_table() -> dict[str, Any]:
    clinical_extensions = read_json(CLINICAL_EXTENSIONS)
    alias_augmentations = {
        item["targetCanonical"]: item.get("aliases", [])
        for item in clinical_extensions.get("treatmentAliasAugmentations", [])
    }
    legacy = read_json(TREATMENT_OUTPUT)
    legacy_index = legacy_match_index(legacy.get("entries", []), strip_treatment_suffix)
    paragraphs = treatment_lines()
    entries: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for number, section_name in TREATMENT_SECTIONS.items():
        entry_id = stable_id("TCM-THERAPY-CLASS", number)
        used_ids.add(entry_id)
        entries.append({
            "id": entry_id,
            "canonical": section_name,
            "standardTerm": section_name,
            "aliases": [],
            "standardNumber": number,
            "english": None,
            "category": section_name,
            "termClass": "category_heading",
            "examples": [],
            "relationPolicy": treatment_relation_policy(number),
            "definitionSha256": None,
            "sourceRefs": ["SRC-GBT-16751-3-2023"],
        })
    for number, block in term_blocks(paragraphs, re.compile(r"[345](?:\.\d+)+")):
        standard_term, english, standard_aliases, definition = split_term_block(block)
        section = number.split(".", 1)[0]
        lookup_keys = unique([strip_treatment_suffix(standard_term), *SPECIAL_TREATMENT_ALIASES.get(standard_term, [])])
        legacy_entry = next((legacy_index[key] for key in lookup_keys if key in legacy_index), {})
        candidate_id = legacy_entry.get("id") or stable_id("TCM-THERAPY", number)
        entry_id = candidate_id if candidate_id not in used_ids else stable_id("TCM-THERAPY", number)
        used_ids.add(entry_id)
        aliases = [value for value in unique([
            *standard_aliases,
            *SPECIAL_TREATMENT_ALIASES.get(standard_term, []),
            *alias_augmentations.get(standard_term, []),
            *legacy_entry.get("aliases", []),
        ]) if value != standard_term]
        entries.append({
            "id": entry_id,
            "canonical": standard_term,
            "standardTerm": standard_term,
            "aliases": aliases,
            "standardAliases": standard_aliases,
            "standardNumber": number,
            "english": english,
            "category": TREATMENT_SECTIONS[section],
            "termClass": "category_term" if "类治法" in definition or "类疗法" in definition else "clinical_term",
            "examples": legacy_entry.get("examples", []),
            "relationPolicy": legacy_entry.get("relationPolicy") or treatment_relation_policy(section),
            **({"permitsPrioritization": legacy_entry["permitsPrioritization"]} if "permitsPrioritization" in legacy_entry else {}),
            "definitionSha256": sha256_bytes(definition.encode("utf-8")),
            "sourceRefs": ["SRC-GBT-16751-3-2023"],
        })
    if len(entries) != 1276:
        raise ValueError(f"expected 1276 treatment terms, got {len(entries)}")
    if len({entry["canonical"] for entry in entries}) != len(entries):
        raise ValueError("duplicate canonical treatment terms")
    return {
        "schemaVersion": "tcm-treatment-principle-lexicon-v3",
        "governance": {
            "status": "official_current_standard_complete_index",
            "standardReference": "GB/T 16751.3-2023",
            "sourceEdition": "现行国家推荐性标准",
            "sourceUrl": TREATMENT_SOURCE_URL,
            "scopeNote": "完整索引覆盖现行标准收录的1276个治则、治法和疗法术语；定义仅保存SHA-256指纹。OCR漏识别的5个层级编号按同一标准正文与索引交叉复原。",
            "definitionReproductionPolicy": "digest_only",
        },
        "source": {
            "cachedFile": str(TREATMENT_PDF.relative_to(PROJECT_ROOT)),
            "sha256": sha256_file(TREATMENT_PDF),
            "extraction": "macOS Vision OCR with five heading repairs cross-checked against the standard index",
            "accessedAt": "2026-07-22",
        },
        "summary": {
            "standardTermCount": len(entries),
            "categoryHeadingCount": len(TREATMENT_SECTIONS),
            "numberedTermCount": len(entries) - len(TREATMENT_SECTIONS),
            "clinicalExtensionCount": len(clinical_extensions.get("treatmentEntries", [])),
        },
        "clinicalExtensions": clinical_extensions.get("treatmentEntries", []),
        "entries": entries,
    }


def main() -> None:
    syndrome = build_syndrome_table()
    treatment = build_treatment_table()
    write_json(SYNDROME_OUTPUT, syndrome)
    write_json(TREATMENT_OUTPUT, treatment)
    print(json.dumps({
        "syndromeTerms": syndrome["summary"]["standardTermCount"],
        "treatmentTerms": treatment["summary"]["standardTermCount"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
