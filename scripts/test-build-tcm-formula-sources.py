#!/usr/bin/env python3
"""Regression tests for formula workbook parsing and generated catalog output."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = PROJECT_ROOT / "scripts/build-tcm-formula-sources.py"
SPEC = importlib.util.spec_from_file_location("tcm_formula_builder", BUILDER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load formula catalog builder")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class FormulaBuilderTests(unittest.TestCase):
    def test_ancient_quantity_ranges_and_wrapped_herb_names(self) -> None:
        prescription = "人参、黄芪（炙）各三、五钱，炙甘草一、二钱，升麻五、七分（炒用），白\n术一、二钱（炒）。"
        self.assertEqual(BUILDER.ingredient_names(prescription), ["人参", "黄芪", "炙甘草", "升麻", "白术"])

    def test_herb_name_colliding_with_quantity_unit(self) -> None:
        self.assertEqual(BUILDER.ingredient_names("百合七枚（擘），生地黄汁一升。"), ["百合", "生地黄汁"])

    def test_relative_and_historical_quantity_phrases_do_not_become_herb_names(self) -> None:
        self.assertEqual(
            BUILDER.ingredient_names("当归、生地黄、熟地黄、黄柏、黄芩、黄连各等分，黄芪加一倍。"),
            ["当归", "生地黄", "熟地黄", "黄柏", "黄芩", "黄连", "黄芪"],
        )
        self.assertEqual(
            BUILDER.ingredient_names("厚朴五两，石膏如鸡子大，半夏大者八枚。"),
            ["厚朴", "石膏", "半夏"],
        )
        self.assertEqual(
            BUILDER.ingredient_names("白芍钱五分，川当归两半，柴胡数分或一钱余，或加至一、二两。"),
            ["白芍", "川当归", "柴胡"],
        )

    def test_builder_writes_clean_temporary_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "formula.xlsx"
            classic_path = root / "classic.xlsx"
            output_path = root / "catalog.json"

            source_book = Workbook()
            source_sheet = source_book.active
            source_sheet.append(["名称", "配方", "出处"])
            source_sheet.append(["举元煎", "人参、黄芪各三、五钱，炙甘草一、二钱，升麻五、七分，白\n术一、二钱。", "《景岳全书》"])
            source_book.save(source_path)

            classic_book = Workbook()
            classic_sheet = classic_book.active
            classic_sheet.append([None] * 7)
            classic_sheet.append([None] * 7)
            classic_sheet.append([None, "举元煎", "《景岳全书》（明·张介宾）", "人参、黄芪各三、五钱，炙甘草一、二钱，升麻五、七分，白\n术一、二钱。", None, "汤剂", "测试目录"])
            classic_book.save(classic_path)

            subprocess.run([
                sys.executable,
                str(BUILDER_PATH),
                "--source", str(source_path),
                "--classic-source", str(classic_path),
                "--output", str(output_path),
            ], check=True, capture_output=True, text=True)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["formulas"]["举元煎"][0]["ingredients"], ["人参", "黄芪", "炙甘草", "升麻", "白术"])
            self.assertEqual(payload["officialClassicFormulas"]["举元煎"]["ingredients"], ["人参", "黄芪", "炙甘草", "升麻", "白术"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
