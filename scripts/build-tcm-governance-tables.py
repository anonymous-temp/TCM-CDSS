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
FORMULA_RETRIEVAL_CONCEPTS_SOURCE = DATA_ROOT / "tcm-formula-retrieval-concepts.source.json"
# 受治理症状词族表（症状→病位/病性轴），已被 tcm-syndrome-hypothesis / tcm-chief-complaint-anchor
# 消费；这里把它的 terms 复用为检索概念的同义词来源，见 build_retrieval_concepts。
SYMPTOM_AXIS_MAP = DATA_ROOT / "tcm-symptom-axis-map.source.json"
HIGH_FREQUENCY_SYNDROME_FORMULA_RELATIONS = DATA_ROOT / "tcm-high-frequency-syndrome-formula-relations.source.json"
# Regression floor for the curated T8 syndrome->formula relation table. Raising it is a deliberate
# coverage commitment; the build fails if the source drops below it or if any row stops being
# reachable through the same syndrome resolution the runtime retrieval uses.
HIGH_FREQUENCY_RELATION_FLOOR = 77
# Human-adjudicated formula->syndrome tags. Kept separate from the verified-formula supplement
# because that file only feeds verified_reference_catalog entries: routing adjudications through it
# would silently drop every classic-catalog and local-standard formula (101 of the first 241).
SYNDROME_TAG_ADJUDICATIONS = DATA_ROOT / "tcm-formula-syndrome-tag-adjudications.source.json"
CONTROLLED_TOXIC_POLICY = DATA_ROOT / "tcm-controlled-toxic-herb-policy.source.json"
# Same ratchet as the relation table: a tag decides whether a formula can be identity-locked and
# prescribed, so losing rows silently would remove formulas from the doctor's reach.
# 241 → 233：首批裁定里有 8 条打给了**根本不是方剂**的条目（喘促=症状、痿症/子痫=病名、
# 中湿论/岭南诸病/形证并治法=篇名），它们是 tcmoc 自动抽取把篇名当方名入库、进而混进待裁定清单的。
# 清除假方名后这 8 条成了孤儿，触发本校验——这正是它该拦下的东西。下调闸门是对**已核实的
# 数据缺陷**做的一次性修正，不是放松标准：真方剂的裁定一条没少。
SYNDROME_TAG_ADJUDICATION_FLOOR = 488  # 233(B1) + 255(B2)
# 按方裁定的药味身份。古方只写「芍药/贝母/紫苏/菖蒲」时，品种由**这一首方**的原书或标准注疏决定，
# 不能全局归一：同一个「芍药」在桂枝汤里是白芍、在排脓散里是赤芍，猜错等于开错方向相反的药。
# 因此这张表是 (方名, 原文药名) → 品种，而不是药名→药名。
INGREDIENT_IDENTITY_ADJUDICATIONS = DATA_ROOT / "tcm-formula-ingredient-identity-adjudications.source.json"
INGREDIENT_IDENTITY_ADJUDICATION_FLOOR = 154  # 76(B1) + 78(B2)
# 同名异方变体表(ADJ-HOMONYM-20260725):历史并存的不同方两版并存为不同身份(加味逍遥散模式)。
HOMONYM_VARIANTS = DATA_ROOT / "tcm-formula-homonym-variants.source.json"
# 方名与自身记录组成是否自洽的逐条裁定(ADJ-NAME-COMPOSITION-20260809)。
# 目录里存在名实不符的条目：理气化痰汤《惠直堂经验方》记的是 人参黄芪当归身白芍茯苓白术炙甘草
# ——纯补益组成，方名却指向理气化痰。这类小条目会在命名层以「完整包含」压过它所属的更大真方
# （实测：归脾汤类处方被命名为「理气化痰汤加减」，而归脾汤缺远志/龙眼肉共 2 味、
# 超过减味兜底层「最多缺 1 味」上限，正确方名结构上够不着）。
# 裁定为 mismatched 的条目在此取消身份资格；unknown 只作为人工复核待办，不改变行为。
NAME_COMPOSITION_ADJUDICATIONS = DATA_ROOT / "tcm-formula-name-composition-adjudications.source.json"
FORMULA_RETRIEVAL_INDEX_OUTPUT = DATA_ROOT / "tcm-formula-retrieval-index.json"
HERB_OUTPUT = DATA_ROOT / "tcm-herb-identity-catalog.json"
MANIFEST_OUTPUT = DATA_ROOT / "clinical-governance-table-manifest.json"
SOURCE_REGISTRY = DATA_ROOT / "clinical-governance-source-registry.json"
TCM_KNOWLEDGE = DATA_ROOT / "tcm-knowledge.json"
CLINICIAN_DOSE_POLICY = DATA_ROOT / "tcm-herb-dose-clinician-policy.source.json"


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

# OCR 拆字修复批次(2026-07-25):源表把双字药名拆成两条(如 炙甘+草→炙甘草),全部确定性合并修复
FORMULA_STANDARD_OVERRIDES.update({
    "再造散": {
        "ingredients": ["黄芪", "人参", "桂枝", "甘草", "炮附片", "细辛", "羌活", "防风", "川芎", "煨姜", "大枣"],
    },
    "参苓白术散": {
        "ingredients": ["莲子", "薏苡仁", "砂仁", "桔梗", "炙甘草", "炒白扁豆", "茯苓", "人参", "白术", "山药"],
    },
    "和营通气散": {
        "ingredients": ["当归", "丹参", "醋香附", "川芎", "醋延胡索", "麸炒青皮", "枳壳", "郁金", "姜半夏", "木香", "小茴香"],
    },
    "安老汤": {
        "ingredients": ["人参", "黄芪", "土白术", "酒当归", "熟地黄", "山萸肉", "阿胶珠", "芥穗炭", "醋香附", "木耳炭", "甘草"],
    },
    "定痛膏": {
        "ingredients": ["芙蓉叶", "紫金皮", "独活", "制南星", "白芷"],
    },
    "小柴胡汤": {
        "ingredients": ["柴胡", "黄芩片", "人参", "炙甘草", "法半夏", "生姜", "大枣"],
    },
    "左归丸": {
        "ingredients": ["熟地黄", "麸炒山药", "山萸肉", "枸杞子", "盐菟丝子", "酒川牛膝", "鹿胶珠", "龟胶珠"],
    },
    "归灵内托散": {
        "ingredients": ["川芎", "当归", "白芍", "熟地黄", "薏苡仁", "木瓜", "防己", "天花粉", "金银花", "白鲜皮", "人参", "白术", "甘草", "威灵仙", "牛膝", "土茯苓"],
    },
    "新伤续断汤": {
        "ingredients": ["当归", "土鳖虫", "醋乳香", "醋没药", "丹参", "煅自然铜", "烫骨碎补", "泽兰", "醋延胡索", "苏木", "续断", "桑枝", "燀桃仁"],
    },
    "柏子养心丸": {
        "ingredients": ["柏子仁", "枸杞子", "麦冬", "当归", "石菖蒲", "茯神", "玄参", "熟地黄", "甘草"],
    },
    "桃仁红花煎": {
        "ingredients": ["丹参", "赤芍", "燀桃仁", "红花", "醋香附", "醋延胡索", "醋青皮", "当归", "川芎", "地黄"],
    },
    "棕蒲散": {
        "ingredients": ["棕榈炭", "蒲黄炭", "当归", "川芎", "地黄", "炒白芍", "牡丹皮", "秦艽", "泽兰", "盐杜仲"],
    },
    "海藻玉壶汤": {
        "ingredients": ["海藻", "贝母", "陈皮", "昆布", "青皮", "川芎", "当归", "连翘", "法半夏", "甘草", "独活"],
    },
    "清胃解毒汤": {
        "ingredients": ["当归", "黄连", "生地黄", "天花粉", "连翘", "升麻", "牡丹皮", "赤芍药"],
    },
    "生血补髓汤": {
        "ingredients": ["当归", "地黄", "熟地黄", "白术", "枳壳", "荆芥", "白芍", "防风", "陈皮", "盐杜仲", "牡丹皮", "川芎", "干姜", "牛膝", "独活", "五加皮", "续断", "黄芪", "炒艾叶", "香附", "羌活", "红花", "甘草", "茯苓"],
    },
    "益气活血通脉汤": {
        "ingredients": ["葛根", "黄芪", "党参", "丹参", "川芎", "地龙", "燀桃仁"],
    },
    "续骨活血汤": {
        "ingredients": ["当归", "赤芍", "白芍", "地黄", "红花", "土鳖虫", "烫骨碎补", "煅自然铜", "续断", "积雪草", "醋乳香", "醋没药"],
    },
    "苍附导痰丸": {
        "ingredients": ["茯苓", "姜半夏", "陈皮", "甘草", "麸炒苍术", "醋香附", "制天南星", "麸炒枳壳", "生姜", "麸炒神曲"],
    },
    "菊花决明散": {
        "ingredients": ["决明子", "石决明", "木贼", "防风", "羌活", "蔓荆子", "菊花", "炙甘草", "川芎", "石膏", "黄芩片"],
    },
    "血府逐瘀汤": {
        "ingredients": ["燀桃仁", "红花", "当归", "地黄", "川芎", "赤芍", "牛膝", "桔梗", "柴胡", "枳壳", "甘草"],
    },
    "调营饮": {
        "ingredients": ["醋莪术", "川芎", "当归", "大黄", "赤芍", "醋延胡索", "瞿麦", "槟榔", "陈皮", "大腹皮", "炒葶苈子", "茯苓", "桑白皮", "细辛", "肉桂", "炙甘草", "生姜", "大枣", "白芷"],
    },
    "金匮肾气丸": {
        "ingredients": ["熟地黄", "山药", "山萸肉", "牡丹皮", "泽泻", "茯苓", "桂枝", "炮附片"],
    },
    "陀僧膏": {
        "ingredients": ["南佗僧", "赤芍", "当归", "乳香", "没药", "赤石脂", "苦参", "百草霜", "银黝", "桐油", "香油", "血竭", "孩儿茶", "川大黄"],
    },
    "鳖甲煎丸": {
        "ingredients": ["醋鳖甲", "射干", "黄芩片", "柴胡", "鼠妇虫", "干姜", "大黄", "白芍", "桂枝", "葶苈子", "石韦", "厚朴", "牡丹皮", "瞿麦", "凌霄花", "法半夏", "人参", "土鳖虫", "阿胶珠", "制蜂房", "硝石", "蜣螂", "桃仁"],
    },
    "黎峒丸": {
        "ingredients": ["牛黄", "冰片", "麝香", "阿魏", "大黄", "儿茶", "血竭", "醋乳香", "醋没药", "三七粉", "天竺黄"],
    },
})

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
# 受控源域（经典名方 ~173 + SZJG 703 + 项目补充，去重后）方书二批入库（+826 首）后实测 ~2850 首。
# 上限低于源域时，排在后面的标准方会被静默截断——温病批入库（+174 首）后把真武汤等挤出目录；
# 方书二批后再次实撞：406/703 首 SZJG 标准方（右归丸、三仁汤、七味白术散、三妙丸…）被挤出，
# 因为项目补充先于标准方占位。上限的作用是给构建规模一个显式天花板，不是替代治理；
# 正确性由 fail-closed 校验守住（下方新增：标准方/经典名方必须全量在册，缺一即构建失败）。
FORMULA_CATALOG_TARGET = 3200

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


def load_name_composition_mismatches() -> dict[tuple[str, str], dict[str, Any]]:
    """(方名, 出处) → 名实不符裁定。只收 verdict=mismatched 且 confidence=high 的行。

    fail-closed 的方向在这里是**反的**，要想清楚：这张表的作用是「取消资格」，
    所以宁可少收也不能多收——错误地取消一条正当条目的资格，等于凭空少给医生一个方名。
    因此 unknown / low-confidence 一律不取消资格，只留在源表里当人工复核待办。
    """
    payload = read_json(NAME_COMPOSITION_ADJUDICATIONS)
    entries = payload.get("entries", [])
    if not entries:
        raise SystemExit("name-composition adjudication table is empty")
    resolved: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in entries:
        verdict = compact(entry.get("verdict"))
        if verdict not in {"consistent", "unknown", "mismatched"}:
            raise SystemExit(f"name-composition adjudication has unknown verdict: {entry}")
        if verdict != "mismatched":
            continue
        if compact(entry.get("confidence")) != "high":
            # 低置信的 mismatched 不取消资格：取消一条正当条目的代价高于留着一个错名。
            continue
        formula_name = compact(entry.get("formulaName"))
        source = compact(entry.get("source"))
        reason = compact(entry.get("reason"))
        if not (formula_name and source and reason):
            raise SystemExit(f"name-composition adjudication row is incomplete: {entry}")
        key = (formula_name, source)
        if key in resolved:
            raise SystemExit(f"name-composition adjudication has duplicate row: {formula_name}@{source}")
        resolved[key] = {"reason": reason, "recorded": entry.get("recordedIngredients") or []}
    return resolved


def load_ingredient_identity_adjudications(
    resolution_index: dict[str, dict[str, Any]],
) -> dict[tuple[str, str], dict[str, str]]:
    """(方名, 原文药名) → 裁定品种。每一条都 fail-closed 校验。

    赤芍与白芍功效方向相反（清热凉血 vs 养血敛阴），猜错不是少给剂量而是给反了药。
    所以这里宁可拒绝入库也不接受任何无法逐条证成的行。
    """
    payload = read_json(INGREDIENT_IDENTITY_ADJUDICATIONS)
    entries = payload.get("entries", [])
    if len(entries) < INGREDIENT_IDENTITY_ADJUDICATION_FLOOR:
        raise SystemExit(
            "T8 ingredient identity adjudication table must contain at least "
            f"{INGREDIENT_IDENTITY_ADJUDICATION_FLOOR} rows; found {len(entries)}"
        )
    resolved: dict[tuple[str, str], dict[str, str]] = {}
    for entry in entries:
        formula_name = compact(entry.get("formulaName"))
        raw_ingredient = compact(entry.get("rawIngredient"))
        resolved_ingredient = compact(entry.get("resolvedIngredient"))
        if not (formula_name and raw_ingredient and resolved_ingredient):
            raise SystemExit(f"T8 ingredient identity adjudication row is incomplete: {entry}")
        if (formula_name, raw_ingredient) in resolved:
            raise SystemExit(
                f"T8 ingredient identity adjudication has duplicate row: {formula_name}->{raw_ingredient}"
            )
        # 裁定必须落到 T9 里真实存在且可自动解析的标准名，否则它解不出剂量边界，写了也没用。
        target = resolution_index.get(resolved_ingredient)
        if not target or not target.get("autoResolvable"):
            raise SystemExit(
                "T8 ingredient identity adjudication resolves to a name that T9 cannot auto-resolve: "
                f"{formula_name}->{raw_ingredient}->{resolved_ingredient}"
            )
        if not compact(entry.get("evidence")):
            raise SystemExit(
                f"T8 ingredient identity adjudication row lacks evidence: {formula_name}->{raw_ingredient}"
            )
        resolved[(formula_name, raw_ingredient)] = {
            "resolvedIngredient": resolved_ingredient,
            "evidence": compact(entry.get("evidence")),
            "basis": compact(entry.get("basis")),
        }
    return resolved


def linked_ingredients(
    ingredients: list[object],
    resolution_index: dict[str, dict[str, Any]],
    formula_name: str = "",
    identity_adjudications: dict[tuple[str, str], dict[str, str]] | None = None,
) -> list[dict[str, Any]]:
    result = []
    for value in ingredients:
        raw_name = compact(value)
        # 按方裁定优先：只替换**本方**的这一味，全局归一不动。
        adjudication = (identity_adjudications or {}).get((formula_name, raw_name))
        lookup_name = adjudication["resolvedIngredient"] if adjudication else raw_name
        resolution = resolution_index.get(lookup_name)
        # 单字残片一律按歧义处理，绝不自动落到某味真药上——实测放开的后果是
        # 豉→淡豆豉、草→甘草、本→藁本、芎→川芎，四味被静默解析并配上数值剂量区间。
        # 与运行时 resolveGovernedTcmHerbIdentity 的同名判据同集。
        if resolution and is_identity_indeterminate_herb_name(raw_name):
            resolution = None
        if not resolution:
            result.append({"rawName": raw_name, "canonicalName": None, "linkageStatus": "unmapped"})
        else:
            result.append({
                "rawName": raw_name,
                **({"adjudicatedIngredient": adjudication["resolvedIngredient"],
                    "adjudicationEvidence": adjudication["evidence"],
                    "adjudicationBasis": adjudication["basis"]} if adjudication else {}),
                "canonicalName": resolution.get("canonicalName"),
                **({"doseCanonicalName": resolution["doseCanonicalName"]} if resolution.get("doseCanonicalName") else {}),
                "linkageStatus": resolution["status"],
                "autoResolvable": bool(resolution.get("autoResolvable")),
                **({"preparation": resolution["preparation"]} if resolution.get("preparation") else {}),
                **({"medicinalPart": resolution["medicinalPart"]} if resolution.get("medicinalPart") else {}),
                **({"candidates": resolution["candidates"]} if resolution.get("candidates") else {}),
            })
    return result


# 只有药典背书的剂量边界才能授权自动配剂量。
# KB 里的数值边界有两类依据：药典条目（`中华人民共和国药典：2020年版．一部` /
# `中国药典2020一部【用法与用量】…`），以及「常用药典用量/调剂规范待人工复核」
# 「高置信中药饮片剂量校准层」「甲方反馈补充」这类**尚未复核**的推定值。
# 后者是给药师看的参考，不是可以拿来自动开方的口径。
PHARMACOPOEIA_DOSE_BASIS = re.compile(r"中华人民共和国药典|中国药典2020一部")
DECOCTION_ROUTE = re.compile(r"煎服|汤剂|另煎|另炖")
PILL_POWDER_ROUTE = re.compile(r"丸散|丸剂|胶囊")


def pharmacopoeia_forbids_internal_decoction(herb: dict[str, Any]) -> bool:
    """True when the pharmacopoeia enumerates this herb's routes and none of them is a decoction.

    本函数名叫 `numeric_decoction_dose_names`——煎剂——但它此前从不检查药典是否允许煎服。
    KB 里 44 味药的药典分途径条目**只有丸散/外用、没有煎服**，却照样拿到了煎剂配剂量许可：
    马钱子、巴豆霜、斑蝥、蟾酥、雄黄、朱砂、轻粉、洋金花、闹羊花、甘遂、红大戟、麝香、牛黄…
    实测 155 首可编译剂量的方含这类药材，其中 18 首方名/剂型明确是汤剂——
    升麻鳖甲汤[雄黄]、散瘀和伤汤[马钱子]、硫黄汤[硫黄]、十枣汤/大陷胸汤/甘遂半夏汤[甘遂]。
    十枣汤尤其典型：其经典用法本就是甘遂/大戟/芫花**研末、枣汤送服**，三药根本不入煎。

    判据只用**药典自己列的途径**，不做推断：
    · 药典分途径条目存在，且其中有丸散/胶囊、却没有任何煎服项 ⇒ 药典不认煎服，排除；
    · 根本没有分途径条目 ⇒ 药典没说限制，不排除（缺数据不等于证据，与 §12.3 同一原则）；
    · 「高置信中药饮片剂量校准层」给雄黄/朱砂/轻粉凭空补出的「煎服/汤剂」途径**不计入**——
      它未经复核，且与药典同表的「丸散」「有毒且不入汤剂」直接冲突。
    """
    pharmacopoeia_routes = [
        f"{entry.get('routeForm') or ''}{entry.get('method') or ''}"
        for entry in herb.get("entries", [])
        if entry.get("type") == "routeDose"
        and PHARMACOPOEIA_DOSE_BASIS.search(compact(entry.get("basis")) or "")
    ]
    if not pharmacopoeia_routes:
        return False
    if any(DECOCTION_ROUTE.search(route) for route in pharmacopoeia_routes):
        return False
    return any(PILL_POWDER_ROUTE.search(route) for route in pharmacopoeia_routes)


def controlled_toxic_herb_names() -> set[str]:
    """受管制毒性药材：法规身份使系统**结构上无法合规地**替医生开出，故不得自动编制剂量。

    这条门禁按**监管身份**而不是药典毒性标签建模，因为两者回答的不是同一个问题：
    毒性标签回答"这药毒不毒"，回答不了"系统能不能替医生把它开出去"。后者取决于三件
    系统结构上做不到的事——处方权资格核验、专用处方载体、跨处方累积用量。

    最能说明问题的是罂粟壳：它药典剂量 3-6g 完全正常，但《医院中药饮片管理规范》要求
    "每张处方不得超过三日用量，连续使用不得超过七天"——这是**跨处方、跨就诊**的累积约束，
    而剂量编制是单方无状态计算，**原理上算不出来**。给它配一个合规区间内的 3-6g，
    仍然是把一个需要麻醉药品处方权的受限动作默认放行。

    反过来，药典标注"有毒/小毒"但非管制的品种（附子、半夏、苦杏仁、吴茱萸、全蝎…）
    **不在这里阻断**：一刀切会让麻黄汤(苦杏仁)、吴茱萸汤、胶艾汤(艾叶)这类常规经方
    全部不可用，是过防。它们靠药典剂量上下限硬钳制 + 煎法要求 + 特殊人群门禁 +
    处方后审兜底，毒性以审方警示呈现。

    28 目录条目多写作"生"品（生附子/生半夏/生南星…），而药典同名饮片本就是炮制品
    （KB 里"半夏"的 doseText 原文即"内服一般炮制后使用"），两者在 KB 中是独立条目，
    故这里只按表中写明的名字与别名匹配，不做前缀推断——把"附子"当成"生附子"阻断，
    等于误伤 132 首含附片的常规方。
    """
    payload = read_json(CONTROLLED_TOXIC_POLICY)
    names: set[str] = set()
    for entry in payload.get("entries", []):
        if entry.get("policy") != "blocked":
            continue
        for value in [entry.get("herb"), *(entry.get("aliases") or [])]:
            if compact(value):
                names.add(compact(value))
    if not names:
        raise SystemExit(
            "controlled toxic herb policy table is empty; refusing to build a catalog that would "
            "silently authorize narcotic/catalogued-toxic herbs for automatic dose compilation"
        )
    return names


def numeric_decoction_dose_names() -> set[str]:
    """Return herbs with a pharmacopoeia-backed numeric internal-decoction boundary in the KB.

    T9 identity resolution alone does not authorize a dose. Keeping this derivation in the T8
    builder makes the catalog flag and the M04 runtime gate share the same concrete requirement.

    依据来源必须是药典条目。此前本函数只看「有没有数字」，不看「数字是哪来的」，于是
    13 首方靠未复核的推定值获得了自动配剂量许可——其中 11 首经由**天南星**，而天南星
    `toxicity=有毒`、`pregnancy_forbidden`、列入高风险监管目录，它那条 3-6g 的依据原文
    就写着「属毒性中药，待人工复核」。给毒性药按未复核值自动配剂量，是典型的把「未知」
    当「无风险」。`commonHerbs` 整表 99 条依据全部未复核，因此整表不再授权（其中 95 味
    另有药典条目背书，不受影响；真正掉出的只有 4 味）。
    """
    knowledge = read_json(TCM_KNOWLEDGE)
    names: set[str] = set()
    for herb in knowledge.get("herbs", []):
        if pharmacopoeia_forbids_internal_decoction(herb):
            continue
        for entry in herb.get("entries", []):
            try:
                minimum = float(entry.get("minG"))
                maximum = float(entry.get("maxG"))
            except (TypeError, ValueError):
                continue
            if minimum <= 0 or maximum < minimum:
                continue
            if not PHARMACOPOEIA_DOSE_BASIS.search(compact(entry.get("basis")) or ""):
                continue
            entry_type = entry.get("type")
            if entry_type in {"dose", "curatedDose"}:
                names.add(compact(herb.get("name")))
            elif entry_type == "routeDose" and re.search(
                DECOCTION_ROUTE,
                f"{entry.get('routeForm') or ''}{entry.get('method') or ''}",
            ):
                names.add(compact(herb.get("name")))
    if not names:
        raise SystemExit(
            "no pharmacopoeia-backed numeric dose boundary found in the runtime KB; "
            "the dose basis vocabulary likely changed — fix this derivation instead of "
            "letting every formula silently lose dose compilation"
        )
    return {name for name in names if name}





def clinician_dose_ingredient_names() -> set[str]:
    """缺法定数值边界、改由医师确定用量的成分（甲方 2026-08-01 决策：降低门禁、审方兜底）。

    这些成分不再阻断整方的剂量可编译性。系统对它们不校验数值边界——本来也没有边界可校验——
    而是在 HIS 载荷里按类别标注核验级别（管制毒性/禁用动物药 → toxic_regulated，
    其余 → unverified_dose），用量由医师确定，并照常提交灵犀审方。

    此前 fail-closed 的代价：1352/2915 的受控方一旦被 M03 锁定，M04 只能返回非剂量结果，
    医生连一张自拟方都拿不到。责任没有消失，只是从「系统替医师定量」明确移交为
    「系统标注 + 医师定量 + 审方复核」。

    与运行时 tcm-knowledge.clinicianDoseHerbClass 共用同一张表，避免目录与运行时判定分叉。
    """
    policy = read_json(CLINICIAN_DOSE_POLICY)
    names: set[str] = set()
    # 管制毒性与法律禁用动物药不参与豁免（监管门槛，非数据缺口）——与运行时
    # tcm-knowledge.isClinicianDoseHerb 的 REGULATORY_BLOCKED_CLASSES 同口径。
    regulatory_blocked = {"controlled_or_toxic", "endangered_or_banned"}
    for group, items in (policy.get("ingredients") or {}).items():
        if group in regulatory_blocked:
            continue
        for item in items:
            compacted = compact(item.get("name"))
            if compacted:
                names.add(compacted)
    return names


CLINICIAN_DOSE_AFFIX = re.compile(
    r"^(?:蜜炙|麸炒|土炒|盐炒|酒炒|醋炒|姜炒|炒|炙|醋|酒|盐|姜|煅|制|生|焦|熟|鲜|明|上|净|真)|(?:炭|霜|片|粉|末|丝|段|块)$"
)


def name_variants(*values: object) -> list[str]:
    """处方用名 → 候选查名。同一味药在古方里写作 生明没药 / 大蓟炭 / 朱砂粉，
    而剂量表与豁免表按规范名收录。两侧任一处漏了剥离，就会出现「构建期说缺剂量、
    运行时查得到」的分叉——实测大蓟炭(药典 5-10g)与生明没药(豁免表已收没药)都栽在这里。
    """
    out: list[str] = []
    for value in values:
        compacted = compact(value)
        if not compacted or compacted in out:
            continue
        out.append(compacted)
        base = CLINICIAN_DOSE_AFFIX.sub("", compacted).strip()
        # 多重前后缀（生明没药 = 生 + 明 + 没药）需要反复剥离到不动点。
        while base and base != compacted:
            if base not in out:
                out.append(base)
            compacted, base = base, CLINICIAN_DOSE_AFFIX.sub("", base).strip()
    return out


def is_identity_indeterminate_herb_name(raw: object) -> bool:
    """药名身份不可判定：单个汉字。与运行时 tcm-herb-identity.isIdentityIndeterminateHerbName 同集。

    现代饮片规范名没有单字的。目录里的单字有两个来源——古籍抽取丢字（源书 GB18030，
    「黄芪」丢字只剩「黄」），以及古文简写（《医方集解》写「桂」）。两者性质相同：
    **从名字判不出是哪味药**。「黄」= 黄芪/黄芩/黄连/大黄，「桂」= 肉桂/桂枝。
    """
    text = compact(raw)
    return len(text) == 1 and bool(re.match(r"[\u4e00-\u9fff]", text))


def is_clinician_dose_name(raw: object, names: set[str]) -> bool:
    """与运行时 clinicianDoseHerbClass 同口径：炮制变体查基名。

    醋没药→没药、煅龙骨→龙骨、朱砂粉→朱砂。炮制不改变「有没有法定剂量边界」，
    不剥离的话变体名查不到基名，会让 71 张方继续阻断而运行时却认为可编译——两侧分叉。

    单字残片不在豁免范围内：豁免的前提是「知道是哪味药、只是没有法定数值边界」，
    残片连是不是药都不知道。这条不是多余的防御——豁免表本身是按「哪些药名卡住了方剂」
    自动汇总的，40 个残片（含「用」「汤」「身」「坯」「绢」这些根本不是药的词）
    因此被收成了合法豁免成分，反过来放行含残片的方。是个自我授权的闭环。
    """
    if is_identity_indeterminate_herb_name(raw):
        return False
    return any(variant in names for variant in name_variants(raw))


# ── 给药途径闸：外用方不得进入内服候选池 ────────────────────────────────────────
# 判据只取**明确写出给药途径**的词，不取创面处置目标词（生肌/收口/去腐/敛疮）。
# 两者性质不同：途径词说明「怎么给药」，创面词只说明「治什么」。
# 四妙汤「溃后排脓去瘀、生肌长肉、气血内虚」、托里黄汤「人参黄芪补气固卫」、
# 山豆根汤「噙之咽下即愈」都是正经的**内服**托里生肌方，按创面词一刀切会把它们误伤。
#
# 立这道闸的原因是一处**已经上线**的 fail-open（本机全量实测，非推断）：
# 裁定表 983 行里有 34 行主治写明外用途径，20 行可编译数值剂量，6 行含管制毒性药；
# 更要命的是其中几首是所在证候池的**唯一成员**——
#   剪草散（含巴豆的顽癣外用散）→「湿毒蕴肤」池仅 1 首
#   木瓜酒（外敷治香港脚）→「风湿入络」池仅 1 首
#   伤风腿疼方（外用熏洗）→「风寒阻络」池仅 1 首
#   咽肿喉闭外治方（名字即外治方，外敷涌泉）→「寒凝阳虚」「肾阳不足」
# 医生走到这些证，拿到的唯一候选就是一张外用膏散，而且配得出剂量。
#
# syndromeTags 非空不只是「允许锁定」：tcm-formula-indications 从 syndromeToFormulaIds 反查候选，
# 标签就是把该方注入该证候候选池的门票。目录里 dosageForm 只有 616 条非空、且是剂型不是途径，
# 上述最坏用例全为 null，运行时没有任何一处能把外用方挡回内服池——标签是唯一的门。
EXTERNAL_ROUTE_MARKERS = (
    "外敷", "外用", "外贴", "外涂", "外擦", "外洗", "点眼", "洗眼", "吹喉", "吹之",
    "塞耳", "掺药", "贴敷", "熏洗", "敷之", "涂之", "搽此", "围敷", "膏贴", "灸疮", "点痣",
)
# 源书自述不作辨证：原文明说「不问虚实/通治/悉主之」，给它勾一个主证就是替原文表态。
NO_DIFFERENTIATION_MARKERS = (
    "不问", "无问", "不拘", "不论虚实", "悉主之", "皆可服", "一切风疾", "无所不治",
    "通治", "随症加减", "随证加减", "未详述", "原文未明确", "原文缺失", "主治未明确",
)


def syndrome_tag_route_rejection(indication_text: str) -> str:
    """人工裁定的证候标签为何不该被接受。空串 = 可接受。

    与候选生成器（build-formula-syndrome-tag-candidates.mjs）的关系：那边是**弃权**启发式，
    宁可多弃权（它还收创面词），代价只是少自动建议一条；这里是**硬拒**，宁可窄，
    因为过度拒收会把合法的内服托里方从医生手里拿走。两处判据不同宽度是有意的。
    """
    text = compact(indication_text)
    if not text:
        return ""
    for marker in EXTERNAL_ROUTE_MARKERS:
        if marker in text:
            return f"external_route:{marker}"
    for marker in NO_DIFFERENTIATION_MARKERS:
        if marker in text:
            return f"source_declines_differentiation:{marker}"
    return ""


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


# 派生概念 id 的前缀。用哈希而不是英文 slug：词族名是中文，任何「中文→英文 id」的对照
# 都是新手写词表，正是 test:clinical-vocabulary 要终结的东西。哈希由词族内容决定，
# 词族不变则 id 不变，可作为测试与索引的稳定键。
SYMPTOM_AXIS_CONCEPT_PREFIX = "symptom_axis_"
# 检索概念覆盖率闸门。降低=召回维度退化，必须显式改这两个常量并说明理由。
RETRIEVAL_CONCEPT_FLOOR = 39 + 31  # 人工受治理 39 条 + 词族派生 31 条
SYMPTOM_TAGGED_FORMULA_FLOOR = 1100
# 词族派生概念的权重。人工表用 1（泛症状）/2（特异症状）——那是逐条裁定过鉴别力的；
# 派生条目没有经过这一步，治理层级更低，因此一律取人工表的**下**档 1，不按
# chiefComplaintAnchor 升到 2。
# 三档实测（686 例现代医案，金标准方在目录内）：
#   0.5（压到单条不足以独立准入） recall@8=107 @20=155 @50=208
#   1（本选择）                   recall@8=109 @20=155 @50=208
#   2（主症族升档）               recall@8=109 @20=155 @50=208
# 权重不是本层的敏感参数（候选分由主治词路的 3–48 分主导，概念项 1–2×focus 量级小得多），
# 三档 @20/@50 完全一致。既然测不出差异，就按治理层级取低档，而不是按测点挑。
DERIVED_CONCEPT_WEIGHT = 1


def build_retrieval_concepts() -> list[dict[str, Any]]:
    """把受治理症状词族表合成进检索概念表，并把生成物写回 FORMULA_RETRIEVAL_CONCEPTS。

    为什么需要这一步：概念表原本是 39 条人工正则，是**唯一**的症状召回词汇来源，于是
    2937 首受治理方里只有 906 首（30.8%）能拿到 symptomTags，益气聪明汤这类方的 symptomTags
    恒为空数组，症状路对它们等于不存在。而项目里**已经有**一张受治理的症状词族表
    （tcm-symptom-axis-map.source.json，69 族，证候词表轴值域校验过，
    已被 tcm-syndrome-hypothesis / tcm-chief-complaint-anchor 消费）——腰痛、耳鸣、咽痛、
    呃逆、畏寒肢冷这些门诊常见词全在里面，只是从没接进召回概念。

    合成规则全部是确定性推导，不新增任何一个中文词：
      · 词族与既有概念**已有交集**（族内任一词能被该概念的 patientPattern/indicationPattern
        命中）⇒ 把该族全部同义词并进这条概念的两个模式，概念数不变、召回口径变宽；
      · 词族与所有既有概念**无交集** ⇒ 派生一条新概念，模式即该族同义词的字面并集，
        权重取自数据本身（chiefComplaintAnchor 主症族=2，伴随症状族=1），与人工表同量级。

    这不是词表扩写，是同一批受治理词汇在第二个消费点上的复用；词族表改了这里自动跟随。
    """
    curated_payload = read_json(FORMULA_RETRIEVAL_CONCEPTS_SOURCE)
    curated = curated_payload.get("entries", [])
    families = read_json(SYMPTOM_AXIS_MAP).get("entries", [])
    if not curated or not families:
        raise SystemExit("T8 retrieval concepts: curated source or symptom axis map is empty")

    def family_terms(family: dict[str, Any]) -> list[str]:
        # 长词在前：正则交替按顺序取首个匹配，短词在前会把「头痛不适」只匹到「头痛」。
        # 对命中集合无影响（只影响捕获长度），但保持与词族表一致的可读顺序更利于排错。
        return sorted({compact(term) for term in family.get("terms", []) if compact(term)}, key=lambda t: (-len(t), t))

    linked_terms: dict[str, set[str]] = {entry["id"]: set() for entry in curated}
    derived: list[dict[str, Any]] = []
    for family in families:
        terms = family_terms(family)
        if not terms:
            continue
        matched = [
            entry for entry in curated
            if any(
                re.search(entry["patientPattern"], term) or re.search(entry["indicationPattern"], term)
                for term in terms
            )
        ]
        if matched:
            for entry in matched:
                linked_terms[entry["id"]].update(terms)
            continue
        derived.append({
            "id": SYMPTOM_AXIS_CONCEPT_PREFIX + hashlib.sha256("\0".join(terms).encode()).hexdigest()[:10],
            "key": terms[0],
            "patientPattern": "|".join(re.escape(term) for term in terms),
            "indicationPattern": "|".join(re.escape(term) for term in terms),
            "weight": DERIVED_CONCEPT_WEIGHT,
            "origin": "derived_symptom_axis_family",
            "derivedFromTerms": terms,
        })

    entries: list[dict[str, Any]] = []
    for entry in curated:
        extra = sorted(
            (term for term in linked_terms[entry["id"]]
             if not re.search(entry["patientPattern"], term) or not re.search(entry["indicationPattern"], term)),
            key=lambda t: (-len(t), t),
        )
        widened = [re.escape(term) for term in extra]
        entries.append({
            **entry,
            "patientPattern": "|".join([entry["patientPattern"], *widened]) if widened else entry["patientPattern"],
            "indicationPattern": "|".join([entry["indicationPattern"], *widened]) if widened else entry["indicationPattern"],
            "origin": "curated_widened_by_symptom_axis_family" if widened else "curated",
            **({"derivedFromTerms": extra} if extra else {}),
        })
    entries.extend(sorted(derived, key=lambda item: item["id"]))
    for entry in entries:
        # 生成物必须自身可编译：一条坏正则会让运行时 new RegExp 抛错、整个召回层挂掉。
        re.compile(entry["patientPattern"])
        re.compile(entry["indicationPattern"])
    if len(entries) < RETRIEVAL_CONCEPT_FLOOR:
        raise SystemExit(
            f"T8 retrieval concepts regressed: {len(entries)} < floor {RETRIEVAL_CONCEPT_FLOOR}"
        )
    write_json(FORMULA_RETRIEVAL_CONCEPTS, {
        "schemaVersion": "tcm-formula-retrieval-concepts-v3",
        "governanceTable": "T8",
        "generated": True,
        "policy": curated_payload.get("policy", ""),
        "note": "生成物：受治理人工概念表 + 受治理症状词族表的确定性合成。请改两个来源文件，不要手改本文件。",
        "sources": [
            {"file": FORMULA_RETRIEVAL_CONCEPTS_SOURCE.name, "sha256": sha256(FORMULA_RETRIEVAL_CONCEPTS_SOURCE)},
            {"file": SYMPTOM_AXIS_MAP.name, "sha256": sha256(SYMPTOM_AXIS_MAP)},
        ],
        "summary": {
            "curatedCount": len(curated),
            "symptomAxisFamilyCount": len(families),
            "widenedCuratedCount": sum(1 for item in entries if item.get("origin") == "curated_widened_by_symptom_axis_family"),
            "derivedCount": len(derived),
            "conceptCount": len(entries),
        },
        "entries": entries,
    })
    return entries


def build_formula_catalog(
    resolution_index: dict[str, dict[str, Any]],
    numeric_dose_names: set[str],
) -> dict[str, Any]:
    controlled_toxic_names = controlled_toxic_herb_names()
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
            # 同名异方具名变体也是受控源域的一部分(ADJ-HOMONYM-20260725):变体在三个来源层之外,
            # 裁定表引用变体名时若不纳入源域,会被「outside governed source universe」误杀。
            *((pair.get("variant") or {}).get("name") for pair in read_json(HOMONYM_VARIANTS).get("entries", [])),
        ]
        if name and compact(name)
    }
    adjudicated_tags_by_formula = load_syndrome_tag_adjudications(governed_formula_names)
    identity_adjudications = load_ingredient_identity_adjudications(resolution_index)
    name_composition_mismatches = load_name_composition_mismatches()

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
    malformed_standard_rows: list[str] = []
    for standard_item in [*prioritized_standard_rows, *[item for item in standard_rows if item["code"] not in prioritized_codes]]:
        if len(governed) >= FORMULA_CATALOG_TARGET:
            break
        # PDF 第 85 页有 4 行被解析成整体错位一列：name 存的是编码、source 存的才是方名、
        # ingredients 存的是出处书名、functions 存的是未切分的连写药串。
        # 后果是目录里出现方名为「0602010025」、组成为「《医方集解》」的条目，且 identityLockEligible=true——
        # 医生可能看到「候选方：0602010025」，组成是一本书。
        # 不做自动纠偏：药串无分隔符，按 T9 最长匹配切分实测只有 2/4 能切干净（熟大黄、海带不在词表），
        # 猜出来的组成会直接变成处方。整行拒收，记入复核队列等回源重录。
        if compact(standard_item.get("name")) == compact(standard_item.get("code")):
            malformed_standard_rows.append(compact(standard_item.get("code")))
            continue
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

    # 同名异方变体通道(ADJ-HOMONYM-20260725):历史并存的不同方,两版并存为不同身份。
    # 基线条目身份不变(可带裁定级基线换版);变体以「方名（《出处》氏/特征）」具名入库。
    # 全部校验 fail-closed:基线必须在册、变体身份不得碰撞、变体组成必须与基线不同——
    # 同名同组成的「变体」是数据缺陷,不是同名异方。
    homonym_payload = read_json(HOMONYM_VARIANTS)
    for pair in homonym_payload.get("entries", []):
        baseline_name = compact(pair.get("baselineName"))
        if baseline_name not in governed:
            raise SystemExit(f"T8 homonym variant baseline missing from catalog: {baseline_name}")
        base_entry = governed[baseline_name]
        override = pair.get("baselineOverride")
        if override:
            # 基线换版是裁定级改动:裁定说明与出处进 verification 留痕,不许静默覆盖。
            base_entry["ingredients"] = override.get("ingredients") or base_entry["ingredients"]
            base_entry["source"] = compact(override.get("source")) or base_entry["source"]
            base_entry["adjudicatedIndications"] = override.get("indications") or []
            base_entry.setdefault("verification", []).append({
                "title": f"同名异方裁定基线换版:{compact(override.get('note'))}",
                "url": f"urn:tcm-cdss:adjudication:{homonym_payload.get('adjudicationRef')}:{baseline_name}",
                "sourceRef": homonym_payload.get("adjudicationRef"),
            })
        variant = pair.get("variant") or {}
        vname = compact(variant.get("name"))
        vkey = formula_identity_key(vname)
        if not vname or baseline_name not in vname:
            raise SystemExit(f"T8 homonym variant name must carry the baseline name: {vname}")
        if vkey in governed_identity_keys:
            raise SystemExit(f"T8 homonym variant identity collides with an existing entry: {vname}")
        v_ingredients = variant.get("ingredients") or []
        if sorted(v_ingredients) == sorted(base_entry.get("ingredients") or []):
            raise SystemExit(f"T8 homonym variant composition identical to baseline: {vname}")
        governed[vname] = {
            "name": vname,
            "aliases": variant.get("aliases") or [],
            **({"aliasResolutionRule": variant.get("aliasResolutionRule")} if variant.get("aliasResolutionRule") else {}),
            "source": compact(variant.get("source")),
            "sourceOriginal": compact(variant.get("source")),
            "prescriptionOriginal": None,
            "ingredients": v_ingredients,
            "dosageForm": None,
            "sourceClass": "verified_reference_catalog",
            "sourceCatalog": "adjudicated_homonym_variant",
            "adjudicatedIndications": variant.get("indications") or [],
            "verification": [{
                "title": f"同名异方裁定变体;基线「{baseline_name}」维持教材正选,本版按出处独立成身份",
                "url": f"urn:tcm-cdss:adjudication:{homonym_payload.get('adjudicationRef')}:{vname}",
                "sourceRef": homonym_payload.get("adjudicationRef"),
            }],
            "curatedSyndromeTags": [],
        }
        governed_identity_keys.add(vkey)

    # fail-closed 覆盖断言：SZJG 标准方与经典名方**必须全量在册**。
    # 项目补充先于标准方占位 + 上限截断 = 标准方被静默挤出（方书二批后实测 406/703 缺失，
    # 右归丸/三仁汤都在其中，检索回归立刻变红）。上限再充裕也只是缓冲，这里才是门禁：
    # 源域继续增长撞上 FORMULA_CATALOG_TARGET 时，构建直接失败，而不是悄悄少几首标准方。
    # 等价口径与构建自身去重一致（formula_identity_key）：济生肾气丸加减 由 济生肾气丸 覆盖、
    # 苇茎汤 由经典层同名条目覆盖,均视为在册——否则断言会把去重语义误报成截断。
    governed_keys = {formula_identity_key(name) for name in governed}
    # 结构性错位的行是**显式拒收**，不是截断——它们的 name 字段存的是编码而不是方名，
    # 整行数据都错了位（组成里是书名）。把它们计入「被截断」会让这条守卫报一个假警，
    # 促使人去调 FORMULA_CATALOG_TARGET，而真正该做的是回源重录。两者必须分开。
    malformed_standard_keys = {formula_identity_key(code) for code in malformed_standard_rows}
    missing_standard = sorted(
        {formula_identity_key(item["name"]) for item in standard_rows}
        - governed_keys
        - malformed_standard_keys
        # 加味逍遥散按治理裁定以具名变体「加味逍遥散（《审视瑶函》暴盲方）」入库,本名不出现属预期
        - ({formula_identity_key("加味逍遥散")} if any("审视瑶函" in name and "加味逍遥散" in name for name in governed) else set())
    )
    if malformed_standard_rows:
        print(json.dumps({
            "warning": "szjg_standard_rows_rejected_as_malformed",
            "note": "整行错位（name=编码、ingredients=出处书名），已拒收，需回源第 85 页重录",
            "codes": malformed_standard_rows,
        }, ensure_ascii=False))
    if missing_standard:
        raise SystemExit(
            f"T8 catalog silently truncated {len(missing_standard)} SZJG standard formulas "
            f"(e.g. {missing_standard[:5]}); raise FORMULA_CATALOG_TARGET or reprioritise — never ship a truncated standard layer."
        )

    entries = []
    # 被给药途径闸中和掉的**人工裁定**行：它们仍留在 source 表里（是人工判断的记录），
    # 但不再生效。每次构建打印出来，避免变成一笔看不见的债——
    # 「源表里有、实际不生效」正是本项目最怕的那种静默分叉。
    neutralized_curated_tags: list[str] = []
    dropped_name_composition_mismatches: list[str] = []
    for name, item in sorted(governed.items()):
        # 名实不符的条目**整条剔除**（甲方 2026-08-09 决策）。
        # 此前的做法是只取消身份资格、保留为文献证据；甲方口径是这类数据错配的条目
        # 连证据资格一并去掉，避免它再以任何形式参与检索与呈现。
        # 只对 verdict=mismatched 且 confidence=high 生效，见 load_name_composition_mismatches。
        if (name, item.get("source") or "") in name_composition_mismatches:
            dropped_name_composition_mismatches.append(f"{name}@{item.get('source') or ''}")
            continue
        indication_entry = indications_by_name.get(name, {})
        # 裁定级主治(同名异方基线换版/变体)优先于各来源层——换版后来源层的旧版主治必须让位。
        indications = item.get("adjudicatedIndications") or indication_entry.get("indications") or verified.get(name, {}).get("indications") or item.get("standardIndications") or []
        if not indications and item["sourceClass"] == "official_classic_catalog":
            source_indication = official_source_indication(item.get("sourceOriginal"))
            if source_indication:
                indications = [source_indication]
        searchable_text = "；".join([name, *item.get("aliases", []), *indications])
        ingredient_links = linked_ingredients(item["ingredients"], resolution_index, name, identity_adjudications)
        identity_blocking_reasons = []
        if not item["source"]:
            identity_blocking_reasons.append("missing_standard_source")
        if not item["ingredients"]:
            identity_blocking_reasons.append("missing_standard_ingredients")
        if not indications:
            identity_blocking_reasons.append("missing_governed_indication")
        dose_blocking_reasons = []
        clinician_dose_names = clinician_dose_ingredient_names()
        # 「由医师确定用量」类成分不参与剂量可编译性判定（见 clinician_dose_ingredient_names）。
        unresolved_ingredients = [
            link["rawName"] for link in ingredient_links
            if not link.get("autoResolvable") and not is_clinician_dose_name(link.get("rawName"), clinician_dose_names)
        ]
        # 单字药名不是「解析不出剂量」，是**数据缺陷**：源书为 GB18030，古籍生僻字（如黄芪的「耆」）
        # 丢字后只剩单字残留（实测 13 处「黄」、若干「芍」）。把它按普通剂量缺口埋进
        # unresolvedDoseIngredientNames，会让一个抽取 bug 长期伪装成治理进度问题。
        # 这里单列出来，使其以数据缺陷的身份可见；不做任何猜测性补全——
        # 单字药名无法安全推断（黄=黄芪/黄芩/黄连/大黄…），必须回源修抽取或人工裁定。
        corrupt_ingredient_names = sorted({
            link["rawName"] for link in ingredient_links
            if is_identity_indeterminate_herb_name(link.get("rawName"))
        })
        if unresolved_ingredients:
            dose_blocking_reasons.append("ingredient_identity_requires_resolution")
        # 单字残片独立成一条阻断理由，不并进上面那条：它的处置不是「补一条剂量」，
        # 而是**回源修抽取或人工裁定品种**，下游据此给出正确的转人工提示。
        # 这条阻断在下面的「扣除毒性/无边界味」分支里不会被摘除——扣除只处理
        # 身份可解析的味，残片按定义身份不可解析。
        if corrupt_ingredient_names:
            dose_blocking_reasons.append("ingredient_name_corrupt_requires_source_repair")
        missing_dose_boundaries = [
            link["rawName"]
            for link in ingredient_links
            if link.get("autoResolvable")
            # 只认原名与 T9 规范名，**不做炮制剥离**：炮制不改变「有没有豁免身份」，
            # 却实实在在改变用法用量——煅石膏主外用收湿敛疮，套用石膏 15-60g 的内服区间
            # 是错的。剥离只用于豁免表分类（is_clinician_dose_name），不用于数值边界。
            and not any(
                compact(value) in numeric_dose_names
                for value in (
                    link.get("doseCanonicalName"), link.get("canonicalName"), link.get("rawName"),
                )
                if compact(value)
            )
            and not is_clinician_dose_name(link.get("rawName"), clinician_dose_names)
        ]
        if missing_dose_boundaries:
            dose_blocking_reasons.append("ingredient_numeric_dose_boundary_missing")
        # 监管轴：管制品种(麻醉药品 / 医疗用毒性药品目录 28 种)不得自动编制剂量。
        # 与上面两项并列而不合并——它阻断的理由不是"算不出剂量"，而是"这个动作系统没资格做"，
        # 在 doseBlockingReasons 里保留独立取值，下游才能给出正确的转人工提示。
        controlled_toxic_ingredients = sorted({
            link["rawName"]
            for link in ingredient_links
            if link.get("autoResolvable")
            and compact(link.get("doseCanonicalName") or link.get("canonicalName")) in controlled_toxic_names
        })
        # 管制品种不再阻断整方编译（甲方 2026-08-01 决策：降低门禁、审方兜底），但**必须**
        # 在载荷里保持独立可见：下游据此把该药味标为 toxic_regulated、提升告警级别，
        # 医师按监管要求单独处理，灵犀审方另有一道复核。保留字段而不保留阻断，是本次下调的边界。
        # 监管轴保留阻断（即便产品侧已降低其余门禁）：处方权绑定医师个人、须走专用处方载体，
        # 这不是「算不出剂量」而是「系统没有资格做」，审方兜底替代不了处方权。
        if controlled_toxic_ingredients:
            dose_blocking_reasons.append("ingredient_controlled_toxic_requires_manual_prescription")

        # ── 毒性/管制味不作废整方，改为「扣除该味 + 其余正常编译 + 医师单独处理 + 强制审方」──
        # 原口径把「方里有一味系统不敢定量」等同于「这张方不能用」。代价是 521/2915 张受治理方
        # 整体退化为只给方名：天王补心丹因古方组成含朱砂（可解析、但剂量库无数值边界）被整方作废，
        # 病例锁到方了仍然 0 味。而项目既有政策本就是「毒性药走审方警示而非剂量阻断」——
        # 整方作废与该政策自相矛盾。
        #
        # 扣除的边界（不是全面放开）：
        #   · 只扣**身份可解析**的味。水银/黄丹/穿山甲/犀角这类连规范名都定不下来的，
        #     以及单字残缺（数据缺陷，如「黄」「砂」），继续整方阻断——把它们印成
        #     「用量由医师确定」比不给更糟。
        #   · 扣除后可编译组成必须仍 ≥3 味且 ≥ 原方 60%：安宫牛黄丸这类**方义就在毒性味上**的，
        #     扣完不成方，保持阻断。
        #   · 扣除的味整体进 manualDoseIngredientNames，下游必须显式呈现并转医师/审方，
        #     系统不替它们担保剂量。
        deducted_dose_ingredients = sorted({
            link["rawName"] for link in ingredient_links
            if link.get("autoResolvable")
            and link["rawName"] in set(missing_dose_boundaries) | set(controlled_toxic_ingredients)
        })
        compilable_ingredient_count = len([
            link for link in ingredient_links
            if link["rawName"] not in set(deducted_dose_ingredients)
        ])
        deduction_preserves_formula = (
            compilable_ingredient_count >= 3
            and compilable_ingredient_count >= 0.6 * max(1, len(ingredient_links))
        )
        if deducted_dose_ingredients and deduction_preserves_formula:
            dose_blocking_reasons = [
                reason for reason in dose_blocking_reasons
                if reason not in {
                    "ingredient_numeric_dose_boundary_missing",
                    "ingredient_controlled_toxic_requires_manual_prescription",
                }
            ]
        else:
            deducted_dose_ingredients = []
        controlled_toxic_notice = (
            "ingredient_controlled_toxic_requires_manual_prescription" if controlled_toxic_ingredients else ""
        )
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
        # 给药途径闸放在**标签组装处**，一次覆盖全部四个来源：verified 补充表的
        # curatedSyndromeTags、人工裁定表、T8 高频证候-方剂关系表，以及 derived_tag_ids 机器派生。
        # 分别在每扇门加闸就是又一次「同一判据多处各写各的」——实测机器派生那一扇占泄漏的一半以上，
        # 只堵人工门等于堵了一半。
        syndrome_tag_rejection = syndrome_tag_route_rejection("；".join(indications))
        if syndrome_tag_rejection and (adjudicated_tags_by_formula.get(name) or curated_syndrome_relations
                                       or (item.get("curatedSyndromeTags") or [])):
            neutralized_curated_tags.append(f"{name}({syndrome_tag_rejection})")
        if syndrome_tag_rejection:
            curated_syndrome_tags = []
            curated_syndrome_relations = []
            machine_syndrome_tags = []
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
            "syndromeTagRejection": syndrome_tag_rejection,
            "tagGovernanceStatus": (
                "external_route_or_source_declines_differentiation" if syndrome_tag_rejection
                else "governed_source_text_derived_plus_curated_relations" if curated_syndrome_tags
                else "governed_source_text_derived_index"
            ),
            "governanceStatus": governance_status,
            "retrievalEligible": identity_lock_eligible,
            "identityLockEligible": identity_lock_eligible,
            "prescriptionLockEligible": identity_lock_eligible,
            "doseCompilationEligible": identity_lock_eligible and not dose_blocking_reasons,
            "requiresPatientSpecificDoseCompilation": True,
            "requiresPostPrescriptionAudit": True,
            "identityBlockingReasons": identity_blocking_reasons,
            "doseBlockingReasons": dose_blocking_reasons,
            "controlledToxicIngredientNames": controlled_toxic_ingredients,
            "controlledToxicNotice": controlled_toxic_notice,
            "unresolvedDoseIngredientNames": unresolved_ingredients,
            "corruptIngredientNames": corrupt_ingredient_names,
            "missingDoseBoundaryIngredientNames": missing_dose_boundaries,
            # 已从可编译组成中扣除、转由医师单独确定用量并经审方复核的味（见上方扣除边界）。
            "manualDoseIngredientNames": deducted_dose_ingredients,
            "clinicianDoseIngredientNames": sorted({
                link["rawName"] for link in ingredient_links
                if is_clinician_dose_name(link.get("rawName"), clinician_dose_names)
            }),
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
                "ingredientLinks": linked_ingredients(item.get("ingredients") or [], resolution_index, compact(item.get("name")), identity_adjudications),
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
            "syndromeTagRouteRejectedCount": sum(bool(item.get("syndromeTagRejection")) for item in entries),
            "syndromeTagCuratedNeutralizedCount": len(neutralized_curated_tags),
            # 名实不符被整条剔除的条目。落进 summary 而不只是打印，
            # 是为了让测试能对「剔除集合 == 裁定集合」做确定性断言。
            "nameCompositionMismatchDropped": dropped_name_composition_mismatches,
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
    # 概念表是目录标注（symptomTags/diseaseTags）与检索倒排索引的共同输入，必须先于二者生成。
    retrieval_concepts = build_retrieval_concepts()
    formula_catalog = build_formula_catalog(resolution_index, numeric_decoction_dose_names())
    symptom_tagged = formula_catalog["summary"]["symptomTaggedFormulaCount"]
    if symptom_tagged < SYMPTOM_TAGGED_FORMULA_FLOOR:
        raise SystemExit(
            f"T8 symptomTags coverage regressed: {symptom_tagged} < floor {SYMPTOM_TAGGED_FORMULA_FLOOR}"
        )
    formula_retrieval_index = build_formula_retrieval_index(formula_catalog)
    print(json.dumps({
        "retrievalConcepts": len(retrieval_concepts),
        "symptomTaggedFormulas": symptom_tagged,
        "symptomRelations": formula_retrieval_index["summary"]["symptomRelationCount"],
    }, ensure_ascii=False))
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
    dropped_mismatch = formula_catalog["summary"].get("nameCompositionMismatchDropped") or []
    if dropped_mismatch:
        print(json.dumps({
            "warning": "entries_dropped_name_composition_mismatch",
            "count": len(dropped_mismatch),
            "entries": dropped_mismatch,
            "note": "方名与自身记录组成矛盾，按甲方 2026-08-09 决策整条剔除（连文献证据资格一并去掉）。"
                    "裁定见 tcm-formula-name-composition-adjudications.source.json，只对 mismatched+high 生效。",
        }, ensure_ascii=False))
    neutralized = formula_catalog["summary"]["syndromeTagCuratedNeutralizedCount"]
    if neutralized:
        print(json.dumps({
            "warning": "curated_syndrome_tags_neutralized_by_route_gate",
            "count": neutralized,
            "note": "这些人工裁定行仍在 source 表里，但因主治写明外用途径或源书自述不辨证而不再生效。"
                    "留着是人工判断的记录，打印出来是为了不让它变成一笔看不见的债。",
        }, ensure_ascii=False))
    print(json.dumps(manifest["buildSummary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
