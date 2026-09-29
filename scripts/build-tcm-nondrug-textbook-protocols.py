#!/usr/bin/env python3
"""中医非药物治疗的教材方案（2026-09-29，甲方 9.24/9.27 测评 2.4「中医治疗项目机械化、不能形成可执行操作」）。

此前非药物目录 22 个项目里 19 个是「类目模板、待终审」，0 个可执行：病例命中不了模板时，卡片只能写
「本轮仅进行现场适应证、禁忌与资质评估，不形成操作计划」。缺的是方案内容，不是代码。

内容来源（全国中医药行业高等教育「十三五」规划教材，中国中医药出版社 2016；本地合集
中医补充数据/灵丹GitHub/TCM Educational Materials.txt，抽取器 scripts/lib/textbook_nondrug_extract.py）：
  · 《针灸治疗学》（高树中、杨骏主编）各病证节：治法、主穴、按证型配穴、按症状配穴、操作、其他治疗；
  · 《针灸学》（梁繁荣、王华主编）同名病证节，作第二来源；
  · 《推拿学》（房敏、宋柏林主编）各病症节：治则、部位与取穴、手法、操作；
  · 《中医食疗学》（施洪飞、方泓主编）各病证节：按证型的食疗方法、推荐食材、食疗方原文；
  · 《刺法灸法学》（王富春、马铁明主编）总论：留针、留罐、施灸的通用时长（作频次缺省值）。
每条都记书名与行号，运行时原样附在卡片来源上，医生可逐条核对。

本脚本只做**整形**，不改写任何临床文字：药名、穴名、剂量、做法都是教材原句。
用法：python3 scripts/build-tcm-nondrug-textbook-protocols.py [教材合集路径] [输出路径]
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "中医补充数据/灵丹GitHub/TCM Educational Materials.txt"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "src/data/tcm-nondrug-textbook-protocols.json"
EXTRACTOR = ROOT / "scripts/lib/textbook_nondrug_extract.py"

# 「其他治疗」里的方法名 → 受控项目代码。穴位注射（注射用药）、电针/头针/皮肤针/火针等针刺变法、
# 割治与激光不映射：前者是用药，后者属针刺项目内部的技术选择或本目录没有的项目。
METHOD_PROJECT = {
    "耳针": "auricular",
    "拔罐": "cupping",
    "刺络拔罐": "bloodletting",
    "三棱针": "bloodletting",
    "灸法": "moxibustion",
    "艾灸": "moxibustion",
    "温针灸": "moxibustion",
    "热敏灸": "moxibustion",
    "隔姜灸": "moxibustion",
    "隔蒜灸": "moxibustion",
    "刮痧": "guasha",
    "穴位贴敷": "acupoint_application",
    "穴位熨敷": "medicated_ironing",
    "穴位埋线": "thread_embedding",
    "针刀": "needle_knife",
    "指针": "tuina",
    "指压": "tuina",
    "穴位按压": "tuina",
    "捏脊": "tuina",
}

# 教材病证名 → 常见等价写法（GB/T 15657 别名与教材「又称」）。只用于把本例中医病名对到教材节名，
# 不产生任何诊断；两个方向的写法都收（教材写「隐疹」，国标与模型写「瘾疹」）。
EXTRA_ALIASES = {
    "隐疹": ["瘾疹", "荨麻疹"],
    "头痛": ["头风", "头风病", "头痛病"],
    "眩晕": ["眩晕病"],
    "不寐": ["失眠", "不寐病"],
    "心悸": ["怔忡", "怔忡病", "惊悸"],
    "感冒": ["时行感冒", "伤风"],
    "胃痛": ["胃脘痛"],
    "蛇串疮": ["缠腰火丹", "带状疱疹"],
    "腰痛": ["腰痛病"],
    "颈椎病": ["项痹"],
    "漏肩风": ["肩痹", "肩周炎"],
    "膝骨性关节炎": ["膝痹", "膝骨关节炎"],
    "面瘫": ["口僻"],
    "痹病": ["痹证"],
    "湿疹": ["湿疮"],
    "牙痛": ["齿痛"],
    "鼻鼽": ["过敏性鼻炎"],
    "咽喉肿痛": ["喉痹"],
    "耳鸣、耳聋": ["耳鸣", "耳聋"],
    "胃下垂": ["胃缓"],
    "肩周炎": ["漏肩风"],
    "膝骨关节炎": ["膝痹"],
}

# 《刺法灸法学》总论里的通用时长（运行时只在该病证节没写频次时作缺省，并标明出处）。
MODALITY_DEFAULT_PATTERNS = {
    "acupuncture": "一般病症只要针下得气而施以适当的补泻手法后，即可出针或留针10～30分钟",
    "cupping": "留罐时间一般为5～15分钟，可每日1次或隔日1次",
    "moxibustion": "用温灸盒每次灸15～30分钟",
}


def first_sentence_containing(lines, needle, lo, hi):
    for number in range(lo, min(hi, len(lines)) + 1):
        line = lines[number - 1]
        index = line.find(needle)
        if index >= 0:
            end = line.find("。", index)
            return {"text": line[index:end + 1 if end >= 0 else None].strip(), "line": number}
    return None


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        extracted_path = Path(tmp) / "nondrug.json"
        subprocess.run([sys.executable, str(EXTRACTOR), str(SRC), str(extracted_path)], check=True)
        data = json.loads(extracted_path.read_text(encoding="utf-8"))
    books = data["books"]
    lines = SRC.read_text(encoding="utf-8").split("\n")
    cifa = books.get("cifa_jiufa", {}).get("rangeLines", [1, len(lines)])
    defaults = {}
    for code, needle in MODALITY_DEFAULT_PATTERNS.items():
        hit = first_sentence_containing(lines, needle, cifa[0], cifa[1])
        if hit:
            defaults[code] = {**hit, "book": "cifa_jiufa"}

    acupuncture = []
    for entry in data["acupuncture"]:
        add_by_label = {}
        for item in entry.get("syndromeAddPoints", []):
            add_by_label.setdefault(item["syndrome"], []).extend(p for p in item["points"] if p not in add_by_label.get(item["syndrome"], []))
        projects = {}
        for other in entry.get("otherTreatments", []):
            code = METHOD_PROJECT.get(other.get("method", ""))
            if not code:
                continue
            projects.setdefault(code, []).append({
                "method": other["method"],
                "content": other["content"],
                "points": other.get("points", []),
                "pointSystem": other.get("pointSystem", "body"),
                "indication": other.get("indication", ""),
                "line": other["lines"][0],
            })
        acupuncture.append({
            "disease": entry["disease"],
            "aliases": sorted(set(entry.get("aliases", []) + EXTRA_ALIASES.get(entry["disease"], []))),
            "westernScope": entry.get("westernScope", ""),
            "book": entry["sourceBook"],
            "line": entry["line"],
            "therapy": entry.get("therapy", ""),
            "mainPoints": entry.get("mainPoints", []),
            "syndromes": [{
                "label": syndrome["label"],
                "keySymptoms": syndrome.get("keySymptoms", ""),
                "addPoints": add_by_label.get(syndrome["label"], []),
                "line": syndrome.get("line"),
            } for syndrome in entry.get("syndromes", [])],
            "symptomAddPoints": [{"symptom": item["symptom"], "points": item["points"]} for item in entry.get("symptomAddPoints", [])],
            "operation": entry.get("operation", ""),
            "cautions": [item["text"] for item in entry.get("cautions", [])][:4],
            "projects": projects,
        })

    tuina = []
    for entry in data["tuina"]:
        tuina.append({
            "disease": entry["disease"],
            "aliases": sorted(set(entry.get("aliases", []) + EXTRA_ALIASES.get(entry["disease"], []))),
            "book": "tuina",
            "line": entry["line"],
            "principle": entry.get("principle", ""),
            "sites": entry.get("sites", []),
            "points": entry.get("points", []),
            "manipulations": entry.get("manipulations", []),
            "operation": [item["text"] for item in entry.get("operation", [])][:6],
            "syndromeModifications": [{"label": item.get("label", ""), "content": item.get("content", "")}
                                      for item in entry.get("syndromeModifications", [])][:6],
        })

    diet = []
    for entry in data["diet"]:
        diet.append({
            "disease": entry["disease"],
            "aliases": sorted(set(entry.get("aliases", []) + EXTRA_ALIASES.get(entry["disease"], []))),
            "westernScope": entry.get("westernScope", ""),
            "book": "shiliao",
            "line": entry["line"],
            "principle": entry.get("principle", ""),
            "syndromes": [{
                "label": syndrome["label"],
                "keySymptoms": syndrome.get("keySymptoms", ""),
                "method": syndrome.get("method", ""),
                "ingredients": syndrome.get("ingredients", []),
                "recipes": [{
                    "name": recipe.get("name", ""),
                    "classicSource": recipe.get("classicSource", ""),
                    "text": recipe.get("text", ""),
                    "line": recipe.get("line"),
                } for recipe in syndrome.get("recipes", [])][:3],
                "line": syndrome.get("line"),
            } for syndrome in entry.get("syndromes", [])],
        })

    keep_book_fields = ("title", "editors", "edition", "publisher", "year", "isbn", "series")
    output = {
        "schemaVersion": "tcm-nondrug-textbook-protocols-v1",
        "generatedBy": "scripts/build-tcm-nondrug-textbook-protocols.py",
        "sourceSha256": data.get("meta", {}).get("sourceSha256", ""),
        "note": "非药物治疗教材方案（十三五规划教材原句，逐条带书名与行号）。运行时按本例中医病名与已签名证型取用，卡片来源栏原样引用书名与章节；所有项目仍须接诊医师现场评估后实施。",
        "sources": {key: {field: books[key].get(field) for field in keep_book_fields} for key in books},
        "modalityDefaults": defaults,
        "acupuncture": acupuncture,
        "tuina": tuina,
        "diet": diet,
    }
    OUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} acupuncture={len(acupuncture)} tuina={len(tuina)} diet={len(diet)} defaults={sorted(defaults)}")


if __name__ == "__main__":
    main()
