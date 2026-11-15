#!/usr/bin/env python3
"""
《方剂学》（全国中医药行业高等教育“十三五”规划教材，李冀、连建伟主编）每首正方与附方写的出处书（2026-11-15 第四十六轮）。

为什么：出处此前在同名方的各书写法里按组成最贴近的取（名录里一首常用方有十几条后世转载），处方恰好与某本后出书的写法逐味相同时，
出处就署了那本书（桃红四物汤《妇科冰鉴》、一贯煎《医方絜度》、小半夏加茯苓汤《卫生宝鉴·补遗》；第四十五轮逐字复核判出处错）。
方剂学教材给每首方写了原书，交付时处方覆盖了这本书的原方组成，出处就用它（tcm-formula-provenance.ts textbookCitedOriginalSource）。

读法（只认两种版式，逐行带行号）：
  · 正方：单独一行方名，下一行以「《书名》」开头（「一贯煎」↵「《续名医类案》」）；
  · 附方：「【附方】」或「N.」起头，方名后括注「（《书名》…）」（「3.桃红四物汤 （《医垒元戎》录自《玉机微义》，原名加味四物汤）」）。
取括注里第一个书名；「录自」后面的是转引，不取。

输入：本地教材语料（中医补充数据/灵丹GitHub/TCM Educational Materials.txt，方剂学一书的范围由书内章节标题定）。
输出：src/data/tcm-fangjixue-formula-citations.json（生成物，勿手改）。
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(ROOT, "中医补充数据", "灵丹GitHub", "TCM Educational Materials.txt")
OUT = os.path.join(ROOT, "src", "data", "tcm-fangjixue-formula-citations.json")

# 方剂学正文：从各论第一章「解表剂」的正文起，到书末参考文献（「1.汉·张仲景.伤寒论」）止。
START_MARK = re.compile(r"^第一章\s*解表剂$")
END_MARK = re.compile(r"^1\.汉·张仲景\.伤寒论")
NAME = r"[一-鿿]{2,14}"
MAIN_HEADER = re.compile(rf"^({NAME})(?:[（(]((?:原名|又名)[^）)]{{1,40}})[）)])?$")
MAIN_SOURCE = re.compile(r"^《([^》]{1,30})》")
APPENDIX = re.compile(rf"^(?:【附方】)?\s*(?:\d+[.．、]\s*)?({NAME})\s*[（(]\s*《([^》]{{1,30}})》")
NOT_FORMULA = re.compile(r"^(?:第.+[章节]|方歌|鉴别|附方|组成|用法|功用|主治|方解|运用|按语|小结)")


def main():
    lines = open(CORPUS, encoding="utf-8", errors="ignore").read().split("\n")
    starts = [index for index, line in enumerate(lines) if START_MARK.match(line.strip())]
    # 书前目录也有「第一章 解表剂」：取正文那一处（其后紧接「第一节 辛温解表剂」与概述段）。
    start = starts[-1] if starts else 0
    end = next((index for index in range(start, len(lines)) if END_MARK.match(lines[index].strip())), len(lines))
    out = {}
    for index in range(start, end):
        text = lines[index].strip()
        main = MAIN_HEADER.match(text)
        if main and index + 1 < end and not NOT_FORMULA.match(text):
            source = MAIN_SOURCE.match(lines[index + 1].strip())
            if source:
                entry = {"book": source.group(1).strip(), "kind": "main", "line": index + 2,
                         "quote": f"{text}↵{lines[index + 1].strip()[:60]}"}
                out.setdefault(main.group(1), entry)
                # 「（原名地黄丸）」「（又名《金匮》肾气丸、崔氏八味丸）」：原名、又名也指这一首方（书名号里的简称并进方名）。
                for alias in re.split(r"[、，,]", re.sub(r"^(?:原名|又名)", "", main.group(2) or "")):
                    alias = re.sub(r"[《》]", "", alias.strip())
                    if re.fullmatch(NAME, alias) and alias != main.group(1):
                        out.setdefault(alias, {**entry, "aliasOf": main.group(1)})
                continue
        appendix = APPENDIX.match(text)
        if appendix and re.search(r"[汤散丸饮丹膏煎方剂]$", appendix.group(1)):
            out.setdefault(appendix.group(1), {"book": appendix.group(2).strip(), "kind": "appendix", "line": index + 1,
                                               "quote": text[:80]})
    result = {
        "schemaVersion": "tcm-fangjixue-formula-citations-v1",
        "generatedBy": "scripts/build-fangjixue-formula-citations.py",
        "source": {"file": "中医补充数据/灵丹GitHub/TCM Educational Materials.txt",
                   "book": "《方剂学》李冀、连建伟主编，全国中医药行业高等教育“十三五”规划教材（第4版，2016）", "range": [start + 1, end]},
        "count": len(out),
        "formulas": dict(sorted(out.items())),
    }
    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    print(f"fangjixue citations: {len(out)} formulas ({sum(1 for v in out.values() if v['kind'] == 'main')} main), lines {start + 1}–{end}")


if __name__ == "__main__":
    main()
