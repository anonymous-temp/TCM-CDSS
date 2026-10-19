#!/usr/bin/env python3
"""Build the Western-drug pharmacological class table (药理学分类) used to collapse same-class recommendations.

2026-10-19（第九轮 WP9-G，甲方 P1「中成药/西药推荐无矛盾」）：验收评审在同一页看到两种促胃肠动力药（多潘立酮＋甲氧氯普胺）、
两种渗透性泻药（聚乙二醇4000＋乳果糖）、两种非甾体抗炎药（塞来昔布＋双氯芬酸钠栓）并列推荐。第五轮只对解热镇痛抗炎药
读说明书里的「其他非甾体抗炎药」自我指涉去重，别的类别没有判据。「按类名写死药名表」不可取，所以用一份受治理的药理分类：

  药学基础数据/药学相关资料/药品分类-药理学分类（基于医脉通-用药参考APP）-有更新-20250703.xlsx
  （四级分类，大体对应 WHO ATC 的 解剖/治疗亚组/药理学亚组/化学亚组）

只取「化药及生物制品」里一级分类不是「其他」的行（「其他」行是同一药品的兜底重复行，没有分类信息）。
一个药品在不同剂型/给药途径下可以有多条分类（双氯芬酸二乙胺凝胶：皮肤用药、局部用非甾体抗炎药；双氯芬酸钠栓：抗炎和抗风湿药），
所以按「药品全名」存各自的分类，另按「通用名」（五级名称）存并集作兜底；运行时先查全名、再查通用名。
中成药在这份表里几乎都是「其他」，不用它判中成药同类（中成药用功能主治、组成与对应问题判，见 patent-medicine-duplication.server.ts）。

用法：python3 scripts/build-western-drug-class.py [--source <xlsx>] [--output <json>]
不依赖 openpyxl：xlsx 用标准库 zipfile 解析。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "药学基础数据/药学相关资料/药品分类-药理学分类（基于医脉通-用药参考APP）-有更新-20250703.xlsx"
DEFAULT_OUTPUT = PROJECT_ROOT / "src/data/western-drug-pharmacology-class.json"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_rows(path: Path):
    """逐行产出 {列字母: 文本}（只读第一张表）。"""
    archive = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in archive.namelist():
        for _event, element in ET.iterparse(archive.open("xl/sharedStrings.xml")):
            if element.tag.endswith("}si"):
                shared.append("".join(node.text or "" for node in element.iter() if node.tag.endswith("}t")))
                element.clear()
    sheet = sorted(name for name in archive.namelist() if name.startswith("xl/worksheets/sheet"))[0]
    for _event, row in ET.iterparse(archive.open(sheet)):
        if not row.tag.endswith("}row"):
            continue
        cells: dict[str, str] = {}
        for cell in row:
            column = re.match(r"[A-Z]+", cell.get("r", "")).group(0)
            value = None
            for child in cell:
                if child.tag.endswith("}v"):
                    value = child.text
                elif child.tag.endswith("}is"):
                    value = "".join(node.text or "" for node in child.iter() if node.tag.endswith("}t"))
            if value is not None and cell.get("t") == "s":
                value = shared[int(value)]
            cells[column] = (value or "").strip()
        yield cells
        row.clear()


def normalize_name(value: str) -> str:
    text = unicodedata.normalize("NFKC", value or "")
    return re.sub(r"\s+", "", text)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()
    source = Path(args.source)
    rows = list(read_rows(source))
    header, body = rows[0], rows[1:]
    assert header.get("A") == "药品名称" and header.get("C") == "一级分类", header

    classes: list[str] = []
    class_index: dict[str, int] = {}

    def class_id(parts: list[str]) -> int:
        path = ">".join(part for part in parts if part)
        if path not in class_index:
            class_index[path] = len(classes)
            classes.append(path)
        return class_index[path]

    by_product: dict[str, set[int]] = {}
    by_generic: dict[str, set[int]] = {}
    used = 0
    for row in body:
        if row.get("B") != "化药及生物制品" or not row.get("C") or row.get("C") == "其他":
            continue
        used += 1
        cid = class_id([row.get("C", ""), row.get("D", ""), row.get("E", ""), row.get("F", "")])
        product = normalize_name(row.get("A", ""))
        generic = normalize_name(row.get("G", ""))
        if product:
            by_product.setdefault(product, set()).add(cid)
        if generic:
            by_generic.setdefault(generic, set()).add(cid)

    output = {
        "schemaVersion": "western-drug-pharmacology-class-v1",
        "source": {
            "file": source.name,
            "sha256": file_sha256(source),
            "basis": "医脉通用药参考APP药理学分类（四级），2025-07-03 更新版；只收化药及生物制品、一级分类非「其他」的行",
            "rowsUsed": used,
        },
        "note": "classes[i] 为「一级>二级>三级>四级」路径；byProduct 按药品全名、byGeneric 按通用名（五级名称）给出分类下标。"
                "同类判据在运行时：共享四级路径即同药理类；共享三级路径且对应问题重合亦判同类（patent-medicine-duplication.server.ts）。",
        "classes": classes,
        "byProduct": {name: sorted(ids) for name, ids in sorted(by_product.items())},
        "byGeneric": {name: sorted(ids) for name, ids in sorted(by_generic.items())},
    }
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"classes={len(classes)} products={len(by_product)} generics={len(by_generic)} rows={used}")


if __name__ == "__main__":
    main()
