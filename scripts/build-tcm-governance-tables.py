#!/usr/bin/env python3
"""Build the governed formula catalog (T8), herb identity catalog (T9), and table manifest.

The builder deliberately separates source-backed runtime-eligible records from unresolved
high-frequency candidates. It never promotes a same-name workbook row into a governed formula.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = PROJECT_ROOT / "src/data"
HERB_MAPPING_SOURCE = PROJECT_ROOT / "药学基础数据/重点整理数据表/中药饮片标准名别名炮制品映射表.csv"
FORMULA_SOURCE = DATA_ROOT / "tcm-formula-sources.json"
FORMULA_INDICATIONS = DATA_ROOT / "tcm-formula-indications.json"
VERIFIED_FORMULAS = DATA_ROOT / "tcm-verified-formula-supplements.json"
FORMULA_STANDARD_SOURCE = DATA_ROOT / "szjg-tcm-formula-standard.json"
HERB_IDENTITY_SUPPLEMENTS = DATA_ROOT / "tcm-herb-identity-supplements.json"
FORMULA_OUTPUT = DATA_ROOT / "tcm-formula-governed-catalog.json"
FORMULA_RETRIEVAL_CONCEPTS = DATA_ROOT / "tcm-formula-retrieval-concepts.json"
HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS = DATA_ROOT / "tcm-high-frequency-syndrome-formula-relations.source.json"
# Regression floor for the curated T8 syndrome->formula relation table. Raising it is a deliberate
# coverage commitment; the build fails if the source drops below it or if any row stops being
# reachable through the same syndrome resolution the runtime retrieval uses.
HIGH_FREQUENCY_RELATION_FLOOR = 77
# Human-adjudicated formula->syndrome tags. Kept separate from the verified-formula supplement
# because that file only feeds verified_reference_catalog entries: routing adjudications through it
# would silently drop every classic-catalog and local-standard formula (101 of the first 241).
SYNDROME_TAG_ADJUDICATIONS = DATA_ROOT / "tcm-formula-syndrome-tag-adjudications.source.json"
# Same ratchet as the relation table: a tag decides whether a formula can be identity-locked and
# prescribed, so losing rows silently would remove formulas from the doctor's reach.
# 241 → 233：首批裁定里有 8 条打给了**根本不是方剂**的条目（喘促=症状、痿症/子痫=病名、
# 中湿论/岭南诸病/形证并治法=篇名），它们是 tcmoc 自动抽取把篇名当方名入库、进而混进待裁定清单的。
# 清除假方名后这 8 条成了孤儿，触发本校验——这正是它该拦下的东西。下调闸门是对**已核实的
# 数据缺陷**做的一次性修正，不是放松标准：真方剂的裁定一条没少。
SYNDROME_TAG_ADJUDICATION_FLOOR = 233
FORMULA_RETRIEVAL_INDEX_OUTPUT = DATA_ROOT / "tcm-formula-retrieval-index.json"
HERB_OUTPUT = DATA_ROOT / "tcm-herb-identity-catalog.json"
MANIFEST_OUTPUT = DATA_ROOT / "clinical-governance-table-manifest.json"
SOURCE_REGISTRY = DATA_ROOT / "clinical-governance-source-registry.json"
TCM_KNOWLEDGE = DATA_ROOT / "tcm-knowledge.json"

FORMULA_STANDARD_URL = "https://amr.sz.gov.cn/attachment/1/1620/1620360/9772233.pdf"
FORMULA_STANDARD_OVERRIDES: dict[str, dict[str, Any]] = {
    "桂枝汤": {
        "code": "0600110024", "source": "《伤寒论》",
        "ingredients": ["桂枝", "白芍", "炙甘草", "生姜", "大枣"],
        "functions": ["解肌发表", "调和营卫"],
        "indications": ["外感风寒表虚，见头痛发热、汗出恶风、鼻鸣干呕、苔白不渴、脉浮缓或浮弱"],
    },
    "银翘散": {
        "code": "0600120016", "source": "《温病条辨》",
        "ingredients": ["金银花", "连翘", "荆芥", "薄荷", "桔梗", "淡豆豉", "炒牛蒡子", "甘草", "淡竹叶"],
        "functions": ["辛凉解表", "清热解毒"],
        "indications": ["温病初起，见发热、微恶寒、头痛口渴、咳嗽咽痛、舌尖红、苔薄白或薄黄、脉浮数"],
    },
    "加味逍遥散": {
        "code": "0600320065", "source": "《审视瑶函》",
        "ingredients": ["柴胡", "当归", "白芍", "白术", "茯苓", "生姜", "薄荷", "炙甘草", "防风", "龙胆"],
        "functions": ["疏利玄府", "清肝解郁"],
        "indications": ["该标准条目主治暴盲；不得与丹栀逍遥散或其他同名加味方自动合并"],
    },
    "丹栀逍遥散": {
        "code": "0600320096", "source": "《内科摘要》",
        "ingredients": ["当归", "白芍", "茯苓", "白术", "柴胡", "牡丹皮", "栀子", "甘草"],
        "functions": ["养血健脾", "疏肝清热"],
        "indications": ["肝脾血虚兼热相关表现；具体患者适用性须按病历事实和医生辨证复核"],
    },
    "龙胆泻肝汤": {
        "code": "0600440022", "source": "《小儿药证直诀》",
        "ingredients": ["龙胆", "酒黄芩", "栀子", "泽泻", "川木通", "酒当归", "地黄", "柴胡", "盐车前子", "甘草"],
        "functions": ["清肝胆实火", "泻下焦湿热"],
        "indications": ["肝胆实火上炎证或肝胆湿热下注证"],
    },
    "补中益气汤": {
        "code": "0600710033", "source": "《内外伤辨惑论》",
        "ingredients": ["黄芪", "炙甘草", "人参", "当归", "陈皮", "升麻", "柴胡", "白术"],
        "functions": ["补中益气", "升阳举陷"],
        "indications": ["脾胃气虚或气虚下陷相关表现；须结合患者事实确认"],
    },
    "六味地黄丸": {
        "code": "0600740016", "source": "《小儿药证直诀》",
        "ingredients": ["熟地黄", "山萸肉", "山药", "牡丹皮", "茯苓", "泽泻"],
        "functions": ["滋阴补肾"],
        "indications": ["肝肾阴虚相关表现；丸剂身份不得自动等同于同名汤剂或加味变方"],
    },
    "天麻钩藤饮": {
        "code": "0601320033", "source": "《杂病证治新义》",
        "ingredients": ["姜天麻", "钩藤", "煅石决明", "栀子", "黄芩片", "牛膝", "盐杜仲", "益母草", "桑寄生", "首乌藤", "朱茯神"],
        "functions": ["平肝熄风", "清热活血", "补益肝肾"],
        "indications": ["肝经有热、肝阳偏亢相关头痛头胀、耳鸣目眩等表现"],
    },
}

HIGH_FREQUENCY_REVIEW_QUEUE = (
    "龙胆泻肝汤",
    "丹栀逍遥散",
    "加味逍遥散",
    "天麻钩藤饮",
    "六味地黄丸",
    "桂枝汤",
    "银翘散",
    "补中益气汤",
)

HIGH_FREQUENCY_FORMULA_PRIORITY = (
    "二陈汤", "四君子汤", "四物汤", "小柴胡汤", "血府逐瘀汤", "柴胡疏肝散",
    "参苓白术散", "藿香正气散", "天王补心丹", "左金丸", "越鞠丸", "八正散",
    "导赤散", "白头翁汤", "甘麦大枣汤", "麻黄杏仁甘草石膏汤", "白虎汤",
    "乌梅丸", "黄连阿胶汤", "五苓散", "金匮肾气丸", "黄土汤", "桂枝茯苓丸",
    "安宫牛黄丸", "至宝丹", *HIGH_FREQUENCY_REVIEW_QUEUE,
)
# 受控源域（经典名方 + 项目补充 + SZJG 标准，去重后）实测 2103 首。上限低于源域时，
# 排在后面的标准方会被静默截断——温病批入库（+174 首）后正好把真武汤等挤出目录。
# 上限的作用是给构建规模一个显式天花板，不是替代治理；正确性由 fail-closed 校验守住。
FORMULA_CATALOG_TARGET = 2300

TABLE_FILES = {
    "T1": "tcm-syndrome-lexicon.json",
    "T2": "tcm-nature-lexicon.json",
    "T3": "tcm-location-lexicon.json",
    "T4": "tcm-treatment-principle-lexicon.json",
    "T5": "diagnostics-context-lexicon.json",
    "T6": "redflag-triage-lexicon.json",
    "T7": "engineering-jargon-lexicon.json",
    "T8": "tcm-formula-governed-catalog.json",
    "T9": "tcm-herb-identity-catalog.json",
    "T10": "clinical-required-field-matrix.json",
    "T11": "clinical-output-contract-registry.json",
    "T12": "tcm-nondrug-treatment-evidence-catalog.json",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_id(prefix: str, *parts: str) -> str:
    suffix = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:12].upper()
    return f"{prefix}-{suffix}"


def compact(value: object) -> str:
    return "".join(str(value or "").split()).strip()


def syndrome_token(value: object) -> str:
    """Mirror the runtime T1 resolver: canonical term wins, aliases must be unique."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"[\s，,。；;：:、（）()【】\[\]“”'\"]+", "", text).strip()
    return re.sub(r"(?:证候|证|型)$", "", text)


def syndrome_resolution_maps() -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    payload = read_json(DATA_ROOT / "tcm-syndrome-lexicon.json")
    entries = [*payload.get("entries", []), *payload.get("clinicalExtensions", [])]
    canonical_by_token: dict[str, dict[str, Any]] = {}
    alias_candidates_by_token: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        token = syndrome_token(entry.get("canonical"))
        if token and token not in canonical_by_token:
            canonical_by_token[token] = entry
        for alias in entry.get("aliases") or []:
            token = syndrome_token(alias)
            if token and all(candidate["id"] != entry["id"] for candidate in alias_candidates_by_token[token]):
                alias_candidates_by_token[token].append(entry)
    return canonical_by_token, dict(alias_candidates_by_token)


def resolve_syndrome_id(
    value: object,
    canonical_by_token: dict[str, dict[str, Any]],
    alias_candidates_by_token: dict[str, list[dict[str, Any]]],
) -> str | None:
    token = syndrome_token(value)
    canonical = canonical_by_token.get(token)
    if canonical:
        return canonical["id"]
    candidates = alias_candidates_by_token.get(token, [])
    return candidates[0]["id"] if len(candidates) == 1 else None


def formula_identity_key(value: object) -> str:
    """Canonical formula identity used to prevent silent same-name/variant overwrites."""
    text = compact(value)
    text = re.sub(r"[（(]?《[^》]{2,80}》[）)]?", "", text)
    text = re.sub(r"[·•，,。；;：:（）()【】\[\]“”\"']", "", text)
    return re.sub(r"(?:加减方?|化裁方?|加味方?)$", "", text).strip()


def official_source_indication(value: object) -> str:
    """Return the clinical clause carried by an official classic source record.

    The former builder joined the composition source and the separate indication index only by
    formula name, then discarded a sourceOriginal clinical quote when the second file had no row.
    That made a verified formula identity appear indication-less. Keep the quoted official clause
    as an indication fallback; historical workbook variants are deliberately excluded.
    """
    text = compact(value)
    if not text:
        return ""
    quoted = re.findall(r"[“\"]([^”\"]{2,1000})[”\"]", text)
    return "；".join(quoted) if quoted else text


def build_herb_catalog() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if not HERB_MAPPING_SOURCE.is_file():
        raise SystemExit(f"Herb mapping source not found: {HERB_MAPPING_SOURCE}")
    with HERB_MAPPING_SOURCE.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    supplement_payload = read_json(HERB_IDENTITY_SUPPLEMENTS)
    supplements = supplement_payload.get("entries", [])

    by_standard: dict[str, list[dict[str, str]]] = defaultdict(list)
    candidates_by_input: dict[str, list[dict[str, str]]] = defaultdict(list)
    ambiguous_groups: list[dict[str, str]] = []
    for row in rows:
        normalized = {key: compact(value) for key, value in row.items()}
        input_name = normalized.get("input_name", "")
        standard_name = normalized.get("standard_name", "")
        mapping_type = normalized.get("mapping_type", "")
        if mapping_type == "AMBIGUOUS_GROUP" or not standard_name:
            ambiguous_groups.append(normalized)
            continue
        by_standard[standard_name].append(normalized)
        if input_name:
            candidates_by_input[input_name].append(normalized)

    standard_names = set(by_standard)
    resolution_index: dict[str, dict[str, Any]] = {}
    ambiguities: list[dict[str, Any]] = []
    for input_name, candidates in sorted(candidates_by_input.items()):
        all_targets = sorted({item["standard_name"] for item in candidates})
        high_targets = sorted({
            item["standard_name"] for item in candidates
            if item.get("confidence") == "high"
        })
        if input_name in standard_names:
            resolution = {"canonicalName": input_name, "status": "exact_standard_name", "autoResolvable": True}
        elif len(high_targets) == 1:
            resolution = {"canonicalName": high_targets[0], "status": "unique_high_confidence", "autoResolvable": True}
        elif len(all_targets) == 1:
            source_backed = all(item.get("source_basis") and item.get("source_url") for item in candidates)
            resolution = {
                "canonicalName": all_targets[0],
                "status": "unique_source_backed" if source_backed else "unique_mapping_requires_review",
                "autoResolvable": source_backed,
            }
        else:
            resolution = {"canonicalName": None, "status": "ambiguous", "candidates": all_targets, "autoResolvable": False}
            ambiguities.append({"inputName": input_name, "candidates": all_targets})
        resolution_index[input_name] = resolution

    for item in supplements:
        input_name = compact(item.get("inputName"))
        canonical_name = compact(item.get("canonicalName")) or None
        candidates = [compact(value) for value in item.get("candidates", []) if compact(value)]
        auto_resolvable = bool(item.get("autoResolvable")) and bool(canonical_name)
        resolution_index[input_name] = {
            "canonicalName": canonical_name,
            "status": "source_backed_clinical_extension" if auto_resolvable else "ambiguous",
            "autoResolvable": auto_resolvable,
            "sourceRefs": supplement_payload["governance"]["sourceRefs"],
            **({"preparation": item["preparation"]} if item.get("preparation") else {}),
            **({"medicinalPart": item["medicinalPart"]} if item.get("medicinalPart") else {}),
            **({"doseCatalogStatus": item["doseCatalogStatus"]} if item.get("doseCatalogStatus") else {}),
            **({"doseCanonicalName": item["doseCanonicalName"]} if item.get("doseCanonicalName") else {}),
            **({"candidates": candidates} if candidates else {}),
            **({"ambiguityGroup": item["ambiguityGroup"]} if item.get("ambiguityGroup") else {}),
        }

    # The official formula appendix carries ordinary preparation spellings such as
    # 黄连片、麸炒枳壳、盐菟丝子.  Resolve only transparent preparation morphology
    # whose stripped base is already source-backed in T9; never use fuzzy matching.
    preparation_prefixes = ("麸炒", "酒炙", "蜜炙", "盐炙", "姜炙", "醋炙", "燀", "炒", "酒", "盐", "姜", "醋", "蜜", "炙", "煅", "制", "炮", "烫")
    standard_formula_payload = read_json(FORMULA_STANDARD_SOURCE)
    official_ingredient_names = {
        compact(value)
        for formula in standard_formula_payload.get("entries", [])
        for value in formula.get("ingredients", [])
        if compact(value)
    }
    for raw_name in sorted(official_ingredient_names):
        if raw_name in resolution_index:
            continue
        candidate = raw_name
        preparation = None
        for prefix in preparation_prefixes:
            if candidate.startswith(prefix) and len(candidate) > len(prefix):
                preparation = prefix
                candidate = candidate[len(prefix):]
                break
        if candidate.endswith("片") and len(candidate) > 2 and candidate not in resolution_index:
            candidate = candidate[:-1]
        base = resolution_index.get(candidate)
        if not base or not base.get("autoResolvable") or not base.get("canonicalName"):
            continue
        resolution_index[raw_name] = {
            "canonicalName": base["canonicalName"],
            "status": "source_backed_preparation_form",
            "autoResolvable": True,
            "sourceRefs": ["SRC-SZJG-TCM-FORMULA-2011"],
            **({"preparation": preparation} if preparation else {"preparation": "切片"}),
        }

    entries = []
    for standard_name, mappings in sorted(by_standard.items()):
        first = mappings[0]
        variants = []
        seen = set()
        for item in mappings:
            name = item.get("input_name", "")
            if not name or name in seen:
                continue
            seen.add(name)
            variants.append({
                "name": name,
                "mappingType": item.get("mapping_type", ""),
                "confidence": item.get("confidence", ""),
                "sourceBasis": item.get("source_basis", ""),
                "sourceUrl": item.get("source_url", ""),
                "mappingAction": item.get("mapping_action", ""),
                "note": item.get("note", ""),
            })
        entries.append({
            "standardName": standard_name,
            "inChp2020": first.get("in_chp2020") == "Y",
            "chpEntryId": first.get("chp_entry_id") or None,
            "riskTags": sorted({tag for item in mappings for tag in item.get("risk_tags", "").split("|") if tag}),
            "variants": variants,
        })

    supplemental_canonical_names = sorted({
        compact(item.get("canonicalName"))
        for item in supplements
        if compact(item.get("canonicalName")) and compact(item.get("canonicalName")) not in by_standard
    })
    for standard_name in supplemental_canonical_names:
        entries.append({
            "standardName": standard_name,
            "inChp2020": False,
            "chpEntryId": None,
            "riskTags": [],
            "variants": [],
            "catalogStatus": "project_clinical_extension_not_pharmacopoeia_entry",
            "sourceRefs": supplement_payload["governance"]["sourceRefs"],
        })
    entries.sort(key=lambda item: item["standardName"])

    status_counts: dict[str, int] = defaultdict(int)
    for value in resolution_index.values():
        status_counts[value["status"]] += 1
    review_queue = []
    for input_name, resolution in sorted(resolution_index.items()):
        if resolution.get("autoResolvable"):
            continue
        review_queue.append({
            "id": stable_id("TCM-HERB-IDENTITY-REVIEW", input_name),
            "inputName": input_name,
            "status": "awaiting_evidence_adjudication",
            "candidates": resolution.get("candidates", []),
            "serviceLevel": {"triageBusinessDays": 1, "adjudicationBusinessDays": 5},
            "requiredEvidence": ["authoritative_source_locator", "HIS_local_code_or_dispensing_identity_when_available"],
            "reviewPolicy": "两名获机构授权的临床知识治理人员独立一致；涉及真实处方调剂时仍按机构处方审核职责执行。",
        })

    payload = {
        "schemaVersion": "tcm-herb-identity-catalog-v2",
        "source": {
            "file": str(HERB_MAPPING_SOURCE.relative_to(PROJECT_ROOT)),
            "sha256": sha256(HERB_MAPPING_SOURCE),
            "rowCount": len(rows),
        },
        "supplementSource": {
            "file": HERB_IDENTITY_SUPPLEMENTS.name,
            "sha256": sha256(HERB_IDENTITY_SUPPLEMENTS),
            "rowCount": len(supplements),
        },
        "governance": {
            "status": "generated_mapping_plus_source_backed_clinical_extensions",
            "resolutionPolicy": "exact standard name > unique high-confidence target > source-backed unique target/extension > unresolved review queue > ambiguous/fail-closed",
            "runtimePolicy": "仅 autoResolvable=true 且 canonicalName 非空的输入可自动归一；待复核和歧义输入一律不得自动落药。",
            "scopeNote": "联网检索可用于收集权威来源和完成知识治理，但不能替代真实处方依法依规的审核职责；多目标别名保持 fail-closed。",
        },
        "summary": {
            "standardNameCount": len(entries),
            "ambiguousInputCount": sum(value["status"] == "ambiguous" for value in resolution_index.values()),
            "resolutionStatusCounts": dict(sorted(status_counts.items())),
        },
        "entries": entries,
        "resolutionIndex": resolution_index,
        "ambiguities": ambiguities,
        "ambiguousGroups": ambiguous_groups,
        "reviewQueue": review_queue,
    }
    write_json(HERB_OUTPUT, payload)
    return payload, resolution_index


def lexicon_terms(file_name: str, list_key: str = "entries") -> list[tuple[str, list[str]]]:
    payload = read_json(DATA_ROOT / file_name)
    terms = []
    entries = [*payload.get(list_key, [])]
    if file_name in {"tcm-syndrome-lexicon.json", "tcm-treatment-principle-lexicon.json"}:
        entries.extend(payload.get("clinicalExtensions", []))
    for item in entries:
        names = [compact(item.get("canonical")), *[compact(value) for value in item.get("aliases", [])]]
        terms.append((item["id"], [name for name in names if len(name) >= 2]))
    return terms


def derived_tag_ids(text: str, lexicon: list[tuple[str, list[str]]]) -> list[str]:
    return sorted({item_id for item_id, terms in lexicon if any(term in text for term in terms)})


def linked_ingredients(ingredients: list[object], resolution_index: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for value in ingredients:
        raw_name = compact(value)
        resolution = resolution_index.get(raw_name)
        if not resolution:
            result.append({"rawName": raw_name, "canonicalName": None, "linkageStatus": "unmapped"})
        else:
            result.append({
                "rawName": raw_name,
                "canonicalName": resolution.get("canonicalName"),
                **({"doseCanonicalName": resolution["doseCanonicalName"]} if resolution.get("doseCanonicalName") else {}),
                "linkageStatus": resolution["status"],
                "autoResolvable": bool(resolution.get("autoResolvable")),
                **({"preparation": resolution["preparation"]} if resolution.get("preparation") else {}),
                **({"medicinalPart": resolution["medicinalPart"]} if resolution.get("medicinalPart") else {}),
                **({"candidates": resolution["candidates"]} if resolution.get("candidates") else {}),
            })
    return result


def numeric_decoction_dose_names() -> set[str]:
    """Return herbs with an actual numeric internal-decoction boundary in the runtime KB.

    T9 identity resolution alone does not authorize a dose. Keeping this derivation in the T8
    builder makes the catalog flag and the M04 runtime gate share the same concrete requirement.
    """
    knowledge = read_json(TCM_KNOWLEDGE)
    names: set[str] = set()
    for herb in knowledge.get("herbs", []):
        for entry in herb.get("entries", []):
            try:
                minimum = float(entry.get("minG"))
                maximum = float(entry.get("maxG"))
            except (TypeError, ValueError):
                continue
            if minimum <= 0 or maximum < minimum:
                continue
            entry_type = entry.get("type")
            if entry_type in {"dose", "curatedDose"}:
                names.add(compact(herb.get("name")))
            elif entry_type == "routeDose" and re.search(
                r"煎服|汤剂|另煎|另炖",
                f"{entry.get('routeForm') or ''}{entry.get('method') or ''}",
            ):
                names.add(compact(herb.get("name")))
    for herb in knowledge.get("commonHerbs", []):
        try:
            minimum = float(herb.get("minG"))
            maximum = float(herb.get("maxG"))
        except (TypeError, ValueError):
            continue
        if minimum > 0 and maximum >= minimum:
            names.add(compact(herb.get("name")))
    return {name for name in names if name}


def load_syndrome_tag_adjudications(governed_formula_names: set[str]) -> dict[str, list[str]]:
    """Load human-adjudicated formula->syndrome tags, rejecting anything that cannot be proven.

    Every check below is fail-closed on purpose. A wrong tag does not degrade retrieval, it makes a
    formula lockable for the wrong syndrome — the model can then hand the doctor a named prescription
    justified by a syndrome the source text never supported. Cheap to reject at build time,
    expensive to find in the clinic.
    """
    payload = read_json(SYNDROME_TAG_ADJUDICATIONS)
    entries = payload.get("entries", [])
    if len(entries) < SYNDROME_TAG_ADJUDICATION_FLOOR:
        raise SystemExit(
            "T8 syndrome tag adjudication table must contain at least "
            f"{SYNDROME_TAG_ADJUDICATION_FLOOR} rows; found {len(entries)}"
        )

    lexicon = read_json(DATA_ROOT / "tcm-syndrome-lexicon.json")
    canonical_by_id = {
        entry["id"]: compact(entry.get("canonical"))
        for entry in [*lexicon.get("entries", []), *lexicon.get("clinicalExtensions", [])]
        if entry.get("id")
    }
    canonical_by_token, alias_candidates_by_token = syndrome_resolution_maps()

    tags_by_formula: dict[str, list[str]] = {}
    for entry in entries:
        name = compact(entry.get("name"))
        if name in tags_by_formula:
            raise SystemExit(f"T8 syndrome tag adjudication has duplicate formula row: {name}")
        if name not in governed_formula_names:
            raise SystemExit(
                f"T8 syndrome tag adjudication references formula outside governed source universe: {name}"
            )
        tag_ids = [compact(value) for value in entry.get("syndromeTagIds") or []]
        tag_names = [compact(value) for value in entry.get("syndromeNames") or []]
        if not tag_ids:
            raise SystemExit(f"T8 syndrome tag adjudication row has no syndrome tag: {name}")
        if len(tag_ids) != len(tag_names):
            raise SystemExit(
                f"T8 syndrome tag adjudication row must carry one syndrome name per id: {name}"
            )
        for tag_id, tag_name in zip(tag_ids, tag_names):
            if tag_id not in canonical_by_id:
                raise SystemExit(f"T8 syndrome tag adjudication has unknown governed syndrome id: {name}->{tag_id}")
            # The human-readable name must resolve back to the same id through the runtime resolver.
            # This is what catches a transposed or copy-pasted row, where the id is individually
            # valid but belongs to a different syndrome than the adjudicator actually decided.
            resolved = resolve_syndrome_id(tag_name, canonical_by_token, alias_candidates_by_token)
            if resolved != tag_id:
                raise SystemExit(
                    "T8 syndrome tag adjudication name/id disagree: "
                    f"{name}->{tag_name} resolves to {resolved or 'nothing'}, row claims {tag_id} "
                    f"({canonical_by_id[tag_id]})"
                )
        if not compact(entry.get("basis")):
            raise SystemExit(f"T8 syndrome tag adjudication row lacks an adjudication basis: {name}")
        tags_by_formula[name] = list(dict.fromkeys(tag_ids))
    return tags_by_formula


def build_formula_catalog(
    resolution_index: dict[str, dict[str, Any]],
    numeric_dose_names: set[str],
) -> dict[str, Any]:
    source = read_json(FORMULA_SOURCE)
    indication_source = read_json(FORMULA_INDICATIONS)
    verified = read_json(VERIFIED_FORMULAS).get("entries", {})
    standard_payload = read_json(FORMULA_STANDARD_SOURCE)
    standard_rows = standard_payload.get("entries", [])
    indications_by_name = {entry["name"]: entry for entry in indication_source.get("entries", [])}
    syndrome_terms = lexicon_terms("tcm-syndrome-lexicon.json")
    nature_terms = lexicon_terms("tcm-nature-lexicon.json")
    location_terms = lexicon_terms("tcm-location-lexicon.json")
    retrieval_concepts = read_json(FORMULA_RETRIEVAL_CONCEPTS).get("entries", [])
    high_frequency_relation_source = read_json(HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS)
    high_frequency_relations = high_frequency_relation_source.get("entries", [])
    syndrome_canonical_by_token, syndrome_alias_candidates_by_token = syndrome_resolution_maps()

    # The curated relation table is allowed to grow, never to silently shrink: a dropped row would
    # quietly remove a governed syndrome from formula recall. Keep the floor at the 41-row baseline
    # and let every downstream count derive from the actual source length.
    if len(high_frequency_relations) < HIGH_FREQUENCY_RELATION_FLOOR:
        raise SystemExit(
            "T8 high-frequency relation source must contain at least "
            f"{HIGH_FREQUENCY_RELATION_FLOOR} syndrome rows; found {len(high_frequency_relations)}"
        )
    curated_relations_by_formula: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    governed_formula_names = {
        compact(name)
        for name in [
            *source.get("officialClassicFormulas", {}).keys(),
            *verified.keys(),
            *(item.get("name") for item in standard_rows),
        ]
        if compact(name)
    }
    adjudicated_tags_by_formula = load_syndrome_tag_adjudications(governed_formula_names)

    resolved_high_frequency_syndrome_ids: set[str] = set()
    resolved_high_frequency_relations: list[dict[str, Any]] = []
    for relation in high_frequency_relations:
        syndrome_name = compact(relation.get("syndrome"))
        syndrome_id = resolve_syndrome_id(
            syndrome_name,
            syndrome_canonical_by_token,
            syndrome_alias_candidates_by_token,
        )
        if not syndrome_id:
            raise SystemExit(f"T8 high-frequency relation has unknown governed syndrome: {syndrome_name}")
        resolved_high_frequency_syndrome_ids.add(syndrome_id)
        formulas = relation.get("formulas") or []
        if not formulas:
            raise SystemExit(f"T8 high-frequency relation has no formula candidates: {syndrome_name}")
        for formula_relation in formulas:
            formula_name = compact(formula_relation.get("name"))
            if formula_name not in governed_formula_names:
                raise SystemExit(
                    f"T8 high-frequency relation references formula outside governed source universe: "
                    f"{syndrome_name}->{formula_name}"
                )
            therapy_terms = list(dict.fromkeys(
                compact(value) for value in formula_relation.get("therapyTerms", []) if compact(value)
            ))
            if not therapy_terms:
                raise SystemExit(f"T8 high-frequency relation lacks therapy terms: {syndrome_name}->{formula_name}")
            curated_relations_by_formula[formula_name].append({
                "syndromeId": syndrome_id,
                "syndrome": syndrome_name,
                "fit": formula_relation.get("fit") or "primary",
                "therapyTerms": therapy_terms,
                **(
                    {"discriminator": compact(formula_relation.get("discriminator"))}
                    if compact(formula_relation.get("discriminator"))
                    else {}
                ),
                "sourceRefs": list(dict.fromkeys([
                    *high_frequency_relation_source.get("sourceRefs", []),
                    "SRC-PROJECT-CLINICAL-ADJUDICATION-20260722",
                ])),
            })
        resolved_high_frequency_relations.append({
            "syndrome": syndrome_name,
            "syndromeId": syndrome_id,
            "formulaNames": [compact(item.get("name")) for item in formulas],
        })
    if len(resolved_high_frequency_syndrome_ids) != len(high_frequency_relations):
        raise SystemExit(
            "T8 high-frequency relation source must resolve to one distinct governed syndrome ID per "
            f"row; rows={len(high_frequency_relations)}, "
            f"resolved={len(resolved_high_frequency_syndrome_ids)}"
        )

    governed: dict[str, dict[str, Any]] = {}
    for name, item in source.get("officialClassicFormulas", {}).items():
        governed[name] = {
            "name": name,
            "aliases": [],
            "source": compact(item.get("source")),
            "sourceOriginal": compact(item.get("sourceOriginal")),
            "prescriptionOriginal": compact(item.get("prescription")),
            "ingredients": item.get("ingredients") or [],
            "dosageForm": compact(item.get("dosageForm")) or None,
            "sourceClass": "official_classic_catalog",
            "sourceCatalog": compact(item.get("catalogBatch")),
            "verification": [{
                "title": "国家古代经典名方目录本地构建记录",
                "url": f"urn:tcm-cdss:official-classic-formula:{name}",
            }],
        }
    for name, item in verified.items():
        governed[name] = {
            "name": name,
            "aliases": item.get("aliases") or [],
            "source": compact(item.get("source")),
            "sourceOriginal": None,
            "prescriptionOriginal": None,
            "ingredients": item.get("ingredients") or [],
            "dosageForm": None,
            "sourceClass": "verified_reference_catalog",
            "sourceCatalog": "project_verified_supplement",
            "verification": item.get("verification") or [],
            "curatedSyndromeTags": item.get("curatedSyndromeTags") or [],
        }

    governed_identity_keys = {formula_identity_key(name) for name in governed}

    standard_by_name = {compact(item["name"]): item for item in standard_rows}
    # 优先级必须**从高频证候关系表自己派生**，不能只靠一份手写名单。
    # 手写名单会漂移：目录到达 FORMULA_CATALOG_TARGET 上限后，未列名的标准方会被截断挤出，
    # 而关系表里恰好依赖它们时构建才 fail-closed 报错——实测温病批入库时就撞上了
    # 心肾阳虚->真武汤/济生肾气丸、脾肾阳虚->真武汤/四神丸，这三首都不在手写名单里。
    # 关系表已经声明了「哪些方必须可达」，目录构建照它执行即可，不需要第二份平行清单去同步。
    relation_required_names = [
        compact(formula_relation.get("name"))
        for relation in high_frequency_relations
        for formula_relation in (relation.get("formulas") or [])
        if compact(formula_relation.get("name"))
    ]
    prioritized_names = list(dict.fromkeys([*relation_required_names, *HIGH_FREQUENCY_FORMULA_PRIORITY]))
    prioritized_standard_rows = [
        standard_by_name[name]
        for name in prioritized_names
        if name in standard_by_name
    ]
    prioritized_codes = {item["code"] for item in prioritized_standard_rows}
    for standard_item in [*prioritized_standard_rows, *[item for item in standard_rows if item["code"] not in prioritized_codes]]:
        if len(governed) >= FORMULA_CATALOG_TARGET:
            break
        source_name = compact(standard_item["name"])
        name = "加味逍遥散（《审视瑶函》暴盲方）" if source_name == "加味逍遥散" else source_name
        identity_key = formula_identity_key(name)
        if name in governed or identity_key in governed_identity_keys:
            continue
        item = {**standard_item, **FORMULA_STANDARD_OVERRIDES.get(source_name, {})}
        aliases = []
        alias_resolution = None
        if source_name == "麻黄杏仁甘草石膏汤":
            aliases.append("麻杏石甘汤")
        if source_name == "丹栀逍遥散":
            aliases.append("加味逍遥散")
            alias_resolution = "门诊未注明眼科暴盲语境时，加味逍遥散归入丹栀逍遥散；明确《审视瑶函》或暴盲方时转入具名变体。"
        if source_name == "加味逍遥散":
            aliases.extend(["审视瑶函加味逍遥散", "暴盲加味逍遥散"])
        governed[name] = {
            "name": name,
            "aliases": aliases,
            **({"aliasResolutionRule": alias_resolution} if alias_resolution else {}),
            "sourceName": source_name,
            "source": item["source"],
            "sourceOriginal": item["source"],
            "prescriptionOriginal": None,
            "ingredients": item["ingredients"],
            "dosageForm": "丸剂" if name.endswith("丸") else "散剂" if name.endswith("散") else "汤剂" if name.endswith("汤") else None,
            "sourceClass": "official_local_formula_standard",
            "sourceCatalog": "SZJG/T 38.2-2011",
            "standardCode": item["code"],
            "functions": item["functions"],
            "standardIndications": item["indications"],
            "verification": [{
                "title": "深圳市中药方剂编码规则配套内容表",
                "url": FORMULA_STANDARD_URL,
                "sourceRef": "SRC-SZJG-TCM-FORMULA-2011",
                "sourcePage": standard_item.get("sourcePage"),
            }],
        }
        governed_identity_keys.add(identity_key)

    entries = []
    for name, item in sorted(governed.items()):
        indication_entry = indications_by_name.get(name, {})
        indications = indication_entry.get("indications") or verified.get(name, {}).get("indications") or item.get("standardIndications") or []
        if not indications and item["sourceClass"] == "official_classic_catalog":
            source_indication = official_source_indication(item.get("sourceOriginal"))
            if source_indication:
                indications = [source_indication]
        searchable_text = "；".join([name, *item.get("aliases", []), *indications])
        ingredient_links = linked_ingredients(item["ingredients"], resolution_index)
        identity_blocking_reasons = []
        if not item["source"]:
            identity_blocking_reasons.append("missing_standard_source")
        if not item["ingredients"]:
            identity_blocking_reasons.append("missing_standard_ingredients")
        if not indications:
            identity_blocking_reasons.append("missing_governed_indication")
        dose_blocking_reasons = []
        unresolved_ingredients = [link["rawName"] for link in ingredient_links if not link.get("autoResolvable")]
        # 单字药名不是「解析不出剂量」，是**数据缺陷**：源书为 GB18030，古籍生僻字（如黄芪的「耆」）
        # 丢字后只剩单字残留（实测 13 处「黄」、若干「芍」）。把它按普通剂量缺口埋进
        # unresolvedDoseIngredientNames，会让一个抽取 bug 长期伪装成治理进度问题。
        # 这里单列出来，使其以数据缺陷的身份可见；不做任何猜测性补全——
        # 单字药名无法安全推断（黄=黄芪/黄芩/黄连/大黄…），必须回源修抽取或人工裁定。
        corrupt_ingredient_names = sorted({
            link["rawName"] for link in ingredient_links
            if isinstance(link.get("rawName"), str) and len(link["rawName"].strip()) == 1
        })
        if unresolved_ingredients:
            dose_blocking_reasons.append("ingredient_identity_requires_resolution")
        missing_dose_boundaries = [
            link["rawName"]
            for link in ingredient_links
            if link.get("autoResolvable") and compact(link.get("doseCanonicalName") or link.get("canonicalName")) not in numeric_dose_names
        ]
        if missing_dose_boundaries:
            dose_blocking_reasons.append("ingredient_numeric_dose_boundary_missing")
        if item["sourceClass"] == "verified_reference_catalog":
            governance_status = "project_reference_verified"
        elif item["sourceClass"] == "official_local_formula_standard":
            governance_status = "official_local_standard_identity_verified"
        else:
            governance_status = "regulatory_source_verified"
        machine_syndrome_tags = derived_tag_ids(searchable_text, syndrome_terms)
        curated_syndrome_relations = curated_relations_by_formula.get(name, [])
        curated_syndrome_tags = list(dict.fromkeys([
            *(item.get("curatedSyndromeTags") or []),
            *adjudicated_tags_by_formula.get(name, []),
            *(relation["syndromeId"] for relation in curated_syndrome_relations),
        ]))
        symptom_tags = sorted({
            concept["id"] for concept in retrieval_concepts
            if concept.get("domain", "symptom") == "symptom" and re.search(concept["indicationPattern"], searchable_text)
        })
        disease_tags = sorted({
            concept["id"] for concept in retrieval_concepts
            if concept.get("domain") == "disease" and re.search(concept["indicationPattern"], searchable_text)
        })
        identity_lock_eligible = not identity_blocking_reasons
        entries.append({
            "id": indication_entry.get("id") or stable_id("TCM-FORMULA", name, item["source"]),
            **item,
            "ingredientLinks": ingredient_links,
            "indications": indications,
            "syndromeTags": list(dict.fromkeys([*curated_syndrome_tags, *machine_syndrome_tags])),
            "curatedSyndromeTags": curated_syndrome_tags,
            "curatedSyndromeRelations": curated_syndrome_relations,
            "natureTags": derived_tag_ids(searchable_text, nature_terms),
            "locationTags": derived_tag_ids(searchable_text, location_terms),
            "symptomTags": symptom_tags,
            "diseaseTags": disease_tags,
            "tagGovernanceStatus": "governed_source_text_derived_plus_curated_relations" if curated_syndrome_tags else "governed_source_text_derived_index",
            "governanceStatus": governance_status,
            "retrievalEligible": identity_lock_eligible,
            "identityLockEligible": identity_lock_eligible,
            "prescriptionLockEligible": identity_lock_eligible,
            "doseCompilationEligible": identity_lock_eligible and not dose_blocking_reasons,
            "requiresPatientSpecificDoseCompilation": True,
            "requiresPostPrescriptionAudit": True,
            "identityBlockingReasons": identity_blocking_reasons,
            "doseBlockingReasons": dose_blocking_reasons,
            "unresolvedDoseIngredientNames": unresolved_ingredients,
            "corruptIngredientNames": corrupt_ingredient_names,
            "missingDoseBoundaryIngredientNames": missing_dose_boundaries,
            "blockingReasons": identity_blocking_reasons,
        })

    evidence_adjudications = []
    all_formulas = source.get("formulas", {})
    for name in HIGH_FREQUENCY_REVIEW_QUEUE:
        variants = all_formulas.get(name, [])
        baseline = {**standard_by_name[name], **FORMULA_STANDARD_OVERRIDES.get(name, {})}
        baseline_source = compact(baseline["source"]).strip("《》。")
        disposed_variants = []
        for item in variants:
            variant_source = compact(item.get("source")).strip("《》。")
            source_aligned = bool(baseline_source and baseline_source in variant_source)
            disposed_variants.append({
                "source": compact(item.get("source")),
                "ingredients": item.get("ingredients") or [],
                "ingredientLinks": linked_ingredients(item.get("ingredients") or [], resolution_index),
                "disposition": "source_aligned_supporting_variant" if source_aligned else "historical_same_name_variant_not_baseline",
                "runtimeEligible": False,
                "reason": "与治理基线来源相符但仍以标准组成优先" if source_aligned else "同名不等于同方；保留供考证但不参与运行时锁方",
            })
        evidence_adjudications.append({
            "id": stable_id("TCM-FORMULA-ADJUDICATION", name),
            "name": name,
            "governanceStatus": "evidence_identity_adjudicated",
            "adjudicationMethod": "official_local_standard_baseline_plus_full_same_name_variant_disposition",
            "standardBaseline": {
                "standardCode": baseline["code"],
                "source": baseline["source"],
                "ingredients": baseline["ingredients"],
                "functions": baseline["functions"],
                "indications": baseline["indications"],
                "sourceRef": "SRC-SZJG-TCM-FORMULA-2011",
            },
            "retrievalEligible": False,
            "identityLockEligible": True,
            "prescriptionLockEligible": True,
            "requiresPatientSpecificDoseCompilation": True,
            "requiresPostPrescriptionAudit": True,
            "blockingReasons": [],
            "variants": disposed_variants,
        })

    review_queue: list[dict[str, Any]] = []
    runtime_entry_by_name = {
        item["name"]: item for item in entries if item.get("retrievalEligible")
    }
    runtime_reachable_relations = [
        relation for relation in resolved_high_frequency_relations
        if all(
            formula_name in runtime_entry_by_name
            and relation["syndromeId"] in runtime_entry_by_name[formula_name].get("syndromeTags", [])
            and any(
                item.get("syndromeId") == relation["syndromeId"]
                for item in runtime_entry_by_name[formula_name].get("curatedSyndromeRelations", [])
            )
            for formula_name in relation["formulaNames"]
        )
    ]
    if len(runtime_reachable_relations) != len(high_frequency_relations):
        unreachable = sorted(
            f'{item["syndrome"]}->{",".join(item["formulaNames"])}'
            for item in resolved_high_frequency_relations
            if item not in runtime_reachable_relations
        )
        raise SystemExit(
            "T8 high-frequency relations are not runtime reachable: "
            + "; ".join(unreachable)
        )

    payload = {
        "schemaVersion": "tcm-formula-governed-catalog-v2",
        "sources": [
            {"file": FORMULA_SOURCE.name, "sha256": sha256(FORMULA_SOURCE)},
            {"file": FORMULA_INDICATIONS.name, "sha256": sha256(FORMULA_INDICATIONS)},
            {"file": VERIFIED_FORMULAS.name, "sha256": sha256(VERIFIED_FORMULAS)},
            {
                "file": HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS.name,
                "sha256": sha256(HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS),
            },
            {"file": FORMULA_STANDARD_SOURCE.name, "sha256": sha256(FORMULA_STANDARD_SOURCE)},
            {"file": HERB_OUTPUT.name, "sha256": sha256(HERB_OUTPUT)},
            {"sourceRef": "SRC-SZJG-TCM-FORMULA-2011", "url": FORMULA_STANDARD_URL},
        ],
        "governance": {
            "status": "governed_identity_catalog_with_separate_dose_and_audit_gates",
            "runtimePolicy": "identityLockEligible 只治理方名身份和方证检索；患者级剂量由 M04 独立编译，真实处方采用前必须经过处方后审方。三者不得相互替代或反向锁死。",
            "scopeNote": "目录目标固定为500首；深圳标准提供方名、来源、组成、功效和主治，不冒充患者级剂量依据。八个高频方的同名异方另存裁定记录，但不重复进入检索集合。",
            "sameNamePolicy": "门诊裸词“加味逍遥散”按别名归入丹栀逍遥散；只有明确《审视瑶函》或暴盲语境才进入具名眼科变体。",
        },
        "summary": {
            "governedFormulaCount": len(entries),
            "prescriptionLockEligibleCount": sum(bool(item["prescriptionLockEligible"]) for item in entries),
            "identityLockEligibleCount": sum(bool(item["identityLockEligible"]) for item in entries),
            "doseCompilationEligibleCount": sum(bool(item["doseCompilationEligible"]) for item in entries),
            "symptomTaggedFormulaCount": sum(bool(item["symptomTags"]) for item in entries),
            "diseaseTaggedFormulaCount": sum(bool(item["diseaseTags"]) for item in entries),
            "syndromeTaggedFormulaCount": sum(bool(item["syndromeTags"]) for item in entries),
            "locationTaggedFormulaCount": sum(bool(item["locationTags"]) for item in entries),
            "natureTaggedFormulaCount": sum(bool(item["natureTags"]) for item in entries),
            "candidateFormulaCount": len(review_queue),
            "candidateVariantCount": sum(len(item["variants"]) for item in review_queue),
            "evidenceAdjudicatedFormulaCount": len(evidence_adjudications),
            "disposedSameNameVariantCount": sum(len(item["variants"]) for item in evidence_adjudications),
            "sourceUniverseFormulaNameCount": source.get("formulaNameCount"),
            "sourceUniverseRowCount": source.get("sourceRowCount"),
            "highFrequencySyndromeTargetCount": len(high_frequency_relations),
            "highFrequencySyndromeSourceResolvedCount": len(resolved_high_frequency_syndrome_ids),
            "highFrequencySyndromeRuntimeReachableCount": len(runtime_reachable_relations),
            "highFrequencySyndromeCoveredCount": len(runtime_reachable_relations),
            "curatedSyndromeFormulaRelationCount": sum(
                len(item["curatedSyndromeRelations"]) for item in entries
            ),
        },
        "entries": entries,
        "reviewQueue": review_queue,
        "evidenceAdjudications": evidence_adjudications,
    }
    write_json(FORMULA_OUTPUT, payload)
    return payload


def table_record(table_id: str, file_name: str) -> dict[str, Any]:
    path = DATA_ROOT / file_name
    payload = read_json(path)
    if table_id in {"T1", "T4"}:
        record_count = len(payload.get("entries", [])) + len(payload.get("clinicalExtensions", []))
    elif table_id in {"T2", "T3"}:
        record_count = len(payload.get("entries", []))
    elif table_id == "T5":
        record_count = len(payload.get("groups", []))
    elif table_id == "T6":
        record_count = len(payload.get("categoryRules", []))
    elif table_id == "T7":
        record_count = len(payload.get("entries", []))
    elif table_id == "T8":
        record_count = len(payload.get("entries", []))
    else:
        record_count = len(payload.get("entries", []))
    return {
        "id": table_id,
        "file": file_name,
        "schemaVersion": payload.get("schemaVersion"),
        "sha256": sha256(path),
        "recordCount": record_count,
    }


def build_formula_retrieval_index(formula_catalog: dict[str, Any]) -> dict[str, Any]:
    """Compile T8 relations once so runtime retrieval never re-derives formula associations."""
    concepts = read_json(FORMULA_RETRIEVAL_CONCEPTS).get("entries", [])
    syndrome_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)
    nature_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)
    location_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)
    symptom_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)
    disease_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)
    concept_to_formula_ids: defaultdict[str, list[str]] = defaultdict(list)

    runtime_entries = [item for item in formula_catalog.get("entries", []) if item.get("retrievalEligible")]
    runtime_entries.extend({
        "id": item["id"],
        "name": item["name"],
        "aliases": [],
        "indications": item["standardBaseline"].get("indications") or [],
        "syndromeTags": [],
        "natureTags": [],
        "locationTags": [],
    } for item in formula_catalog.get("evidenceAdjudications", []) if item.get("retrievalEligible"))
    for item in runtime_entries:
        formula_id = item["id"]
        for tag in item.get("syndromeTags", []):
            syndrome_to_formula_ids[tag].append(formula_id)
        for tag in item.get("natureTags", []):
            nature_to_formula_ids[tag].append(formula_id)
        for tag in item.get("locationTags", []):
            location_to_formula_ids[tag].append(formula_id)
        for tag in item.get("symptomTags", []):
            symptom_to_formula_ids[tag].append(formula_id)
        for tag in item.get("diseaseTags", []):
            disease_to_formula_ids[tag].append(formula_id)
        indication_text = "；".join(item.get("indications") or [])
        for concept in concepts:
            if re.search(concept["indicationPattern"], indication_text):
                concept_to_formula_ids[concept["id"]].append(formula_id)

    def ordered(index: defaultdict[str, list[str]]) -> dict[str, list[str]]:
        return {key: list(dict.fromkeys(values)) for key, values in sorted(index.items())}

    ordered_syndrome_index = ordered(syndrome_to_formula_ids)
    relation_source = read_json(HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS)
    canonical_by_token, alias_candidates_by_token = syndrome_resolution_maps()
    runtime_formula_id_by_name = {item["name"]: item["id"] for item in runtime_entries}
    runtime_reachable_syndrome_ids: set[str] = set()
    unreachable_relations: list[str] = []
    for relation in relation_source.get("entries", []):
        syndrome_name = compact(relation.get("syndrome"))
        syndrome_id = resolve_syndrome_id(
            syndrome_name,
            canonical_by_token,
            alias_candidates_by_token,
        )
        expected_formula_ids = [
            runtime_formula_id_by_name.get(compact(item.get("name")))
            for item in relation.get("formulas") or []
        ]
        if (
            syndrome_id
            and expected_formula_ids
            and all(formula_id and formula_id in ordered_syndrome_index.get(syndrome_id, []) for formula_id in expected_formula_ids)
        ):
            runtime_reachable_syndrome_ids.add(syndrome_id)
        else:
            unreachable_relations.append(
                f'{syndrome_name}->{",".join(compact(item.get("name")) for item in relation.get("formulas") or [])}'
            )
    target_count = len(relation_source.get("entries", []))
    if target_count < HIGH_FREQUENCY_RELATION_FLOOR or len(runtime_reachable_syndrome_ids) != target_count:
        raise SystemExit(
            "T8 retrieval index high-frequency runtime reachability failed: "
            f"target={target_count}, reachable={len(runtime_reachable_syndrome_ids)}, "
            f"unreachable={'; '.join(unreachable_relations)}"
        )

    payload = {
        "schemaVersion": "tcm-formula-retrieval-index-v2",
        "governanceTable": "T8",
        "sourceCatalog": {"file": FORMULA_OUTPUT.name, "sha256": sha256(FORMULA_OUTPUT)},
        "conceptSource": {"file": FORMULA_RETRIEVAL_CONCEPTS.name, "sha256": sha256(FORMULA_RETRIEVAL_CONCEPTS)},
        "curatedRelationSource": {
            "file": HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS.name,
            "sha256": sha256(HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS),
        },
        "policy": "Build-time inverted relations are retrieval evidence only. Formula identity locking requires case facts and M03 validation; M04 dose compilation and post-prescription audit remain separate gates.",
        "indexes": {
            "conceptToFormulaIds": ordered(concept_to_formula_ids),
            "syndromeToFormulaIds": ordered_syndrome_index,
            "natureToFormulaIds": ordered(nature_to_formula_ids),
            "locationToFormulaIds": ordered(location_to_formula_ids),
            "symptomToFormulaIds": ordered(symptom_to_formula_ids),
            "diseaseToFormulaIds": ordered(disease_to_formula_ids),
        },
        "summary": {
            "formulaCount": len(runtime_entries),
            "conceptCount": len(concepts),
            "conceptRelationCount": sum(len(values) for values in concept_to_formula_ids.values()),
            "syndromeRelationCount": sum(len(values) for values in syndrome_to_formula_ids.values()),
            "natureRelationCount": sum(len(values) for values in nature_to_formula_ids.values()),
            "locationRelationCount": sum(len(values) for values in location_to_formula_ids.values()),
            "symptomRelationCount": sum(len(values) for values in symptom_to_formula_ids.values()),
            "diseaseRelationCount": sum(len(values) for values in disease_to_formula_ids.values()),
            "highFrequencySyndromeTargetCount": formula_catalog["summary"]["highFrequencySyndromeTargetCount"],
            "highFrequencySyndromeSourceResolvedCount": formula_catalog["summary"]["highFrequencySyndromeSourceResolvedCount"],
            "highFrequencySyndromeRuntimeReachableCount": len(runtime_reachable_syndrome_ids),
            "highFrequencySyndromeCoveredCount": len(runtime_reachable_syndrome_ids),
            "curatedSyndromeFormulaRelationCount": formula_catalog["summary"]["curatedSyndromeFormulaRelationCount"],
        },
    }
    write_json(FORMULA_RETRIEVAL_INDEX_OUTPUT, payload)
    return payload


def main() -> None:
    herb_catalog, resolution_index = build_herb_catalog()
    formula_catalog = build_formula_catalog(resolution_index, numeric_decoction_dose_names())
    formula_retrieval_index = build_formula_retrieval_index(formula_catalog)
    manifest = {
        "schemaVersion": "clinical-governance-table-manifest-v1",
        "tables": [table_record(table_id, file_name) for table_id, file_name in TABLE_FILES.items()],
        "sourceRegistry": {
            "file": SOURCE_REGISTRY.name,
            "sha256": sha256(SOURCE_REGISTRY),
            "recordCount": len(read_json(SOURCE_REGISTRY).get("entries", [])),
        },
        "auxiliaryIndexes": [{
            "governanceTable": "T8",
            "file": FORMULA_RETRIEVAL_INDEX_OUTPUT.name,
            "schemaVersion": formula_retrieval_index["schemaVersion"],
            "sha256": sha256(FORMULA_RETRIEVAL_INDEX_OUTPUT),
            "recordCount": formula_retrieval_index["summary"]["formulaCount"],
        }],
        "buildSummary": {
            "formulaGoverned": formula_catalog["summary"]["governedFormulaCount"],
            "formulaEligible": formula_catalog["summary"]["prescriptionLockEligibleCount"],
            "formulaDoseCompilationEligible": formula_catalog["summary"]["doseCompilationEligibleCount"],
            "formulaCandidatesAwaitingReview": formula_catalog["summary"]["candidateFormulaCount"],
            "formulaEvidenceAdjudicated": formula_catalog["summary"]["evidenceAdjudicatedFormulaCount"],
            "herbStandardNames": herb_catalog["summary"]["standardNameCount"],
            "herbAmbiguousInputs": herb_catalog["summary"]["ambiguousInputCount"],
        },
    }
    write_json(MANIFEST_OUTPUT, manifest)
    print(json.dumps(manifest["buildSummary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
