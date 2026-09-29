#!/usr/bin/env python3
"""教材方剂煎服法档案（2026-09-29，甲方 9.24/9.27 测评 2.7 煎服方法错误）。

甲方点名：银翘散原书「香气大出，即取服，勿过煮」，系统却写成桂枝汤的「服后可少进热粥、加衣覆被以助微汗」；
清热方（清胃散、龙胆泻肝汤）被写成「空腹温服、得利即停」。根因是按治法关键词分档，命名方本来有教材原文用法。
本脚本从《方剂学》（李冀、连建伟主编，第4版，中国中医药出版社 2016）确定性导出每首方【用法】里的：
啜粥/温覆取汗（porridge_and_cover / cover_light_sweat_no_porridge / no_sweat_induction / none）、服药时间、煎法提示，
逐首带教材行号。抽取器与档案生成器见 scripts/lib/textbook_formula_extract.py、textbook_decoction_profiles.py。

用法：python3 scripts/build-formula-decoction-profiles.py [教材合集路径] [输出路径]
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "中医补充数据/灵丹GitHub/TCM Educational Materials.txt"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "src/data/tcm-formula-decoction-profiles.json"


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        formulas_path = Path(tmp) / "formulas.json"
        profiles_path = Path(tmp) / "profiles.json"
        subprocess.run([sys.executable, str(ROOT / "scripts/lib/textbook_formula_extract.py"), str(SRC), str(formulas_path)], check=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/lib/textbook_decoction_profiles.py"), str(formulas_path), str(profiles_path)], check=True)
        data = json.loads(profiles_path.read_text(encoding="utf-8"))
    formulas = {}
    for item in data["formulas"]:
        notes = []
        for note in item.get("decoctionNotes", []):
            text = note.get("text", "")
            for key in ("勿过煮", "不宜久煎", "先煎", "后下", "久煎", "微火", "先煮", "另煎"):
                if key in text and key not in notes:
                    notes.append(key)
        formulas[item["name"]] = {
            "name": item["name"],
            "chapter": item.get("chapter"),
            "section": item.get("section"),
            "sweating": item.get("sweatingRegimen", "none"),
            "timing": item.get("timing"),
            "notes": notes,
            "usageOriginal": item.get("usageOriginal", ""),
            "line": item.get("usageLine") or item.get("line"),
        }
    output = {
        "schemaVersion": "tcm-formula-decoction-profiles-v1",
        "generatedBy": "scripts/build-formula-decoction-profiles.py",
        "source": {"title": "方剂学", "editors": "李冀，连建伟", "edition": "4版", "publisher": "中国中医药出版社", "year": 2016},
        "note": "教材方剂煎服法档案：每首方的啜粥/取汗类型、服药时间、煎法提示，逐首带教材行号（usageLine）。命名方存在时优先于按治法分档。",
        "chapterCautions": data.get("chapterCautions", {}),
        "formulas": formulas,
    }
    OUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} formulas={len(formulas)} chapters={len(output['chapterCautions'])}")


if __name__ == "__main__":
    main()
