#!/usr/bin/env python3
"""
教材代表方的原书出处表（2026-11-10 第四十一轮，r1054 回顾「出处写教材」：加味清胃散、逍遥蒌贝散、泻心导赤散、补虚汤、参蛤散
的出处栏写成了《中医内科学》《中医儿科学》，甲方 11.05 病历13 批注「《中医儿科学》？？」）。

方剂目录里没有、或组成对不上的教材代表方（textbookFormulaOriginalSource 返回空的那一批），出处按两路取：
  1 本地教材语料各书的方剂索引/附录写法「方名（《书名》）：组成」或「方名（经验方）」逐行摘取（带行号）；
    同一首方几处写法不同时，去掉规划教材自身（《中医内科学》等不是出处）与书名简写（《局方》=《太平惠民和剂局方》）后只剩一本才用；
  2 剩下的由联网核对补齐（src/data/tcm-textbook-formula-sources-web.source.json，每条带网址或古籍文件行号与原文摘句）。
都没有的不写教材名（运行时出处栏写「经验方」以外的说明由调用方决定）。

输入：src/data/tcm-textbook-syndrome-formula-table.json（教材行）、本地教材语料、web 核对表。
输出：src/data/tcm-textbook-formula-sources.json（生成物，勿手改）。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data")
CORPUS = os.path.join(ROOT, "中医补充数据", "灵丹GitHub", "TCM Educational Materials.txt")
WEB = os.path.join(DATA, "tcm-textbook-formula-sources-web.source.json")
OUT = os.path.join(DATA, "tcm-textbook-formula-sources.json")

TEXTBOOK = re.compile(r"^《(?:中医|中西医结合)(?:内|外|妇|儿|眼|耳鼻咽喉|骨伤|妇产)科?学》|^《方剂学》|^《针灸治疗学》|^《中医诊断学》|药典")
EXPERIENCE = re.compile(r"^(?:经验方|验方|[^）)]{0,10}经验方)$")


def norm_book(book: str) -> str:
    return re.sub(r"卷.*$", "", book).strip()


def main():
    table = json.load(open(os.path.join(DATA, "tcm-textbook-syndrome-formula-table.json"), encoding="utf-8"))["rows"]
    names = sorted({name for row in table for name in row.get("formulas") or []})
    lines = open(CORPUS, encoding="utf-8", errors="ignore").read().split("\n")
    by_name = {}
    for name in names:
        pat = re.compile(re.escape(name) + r"\s*[（(]\s*(《[^》]{1,30}》[^）)]{0,12}|经验方|验方|[^）)《》]{0,10}经验方)\s*[）)]")
        hits = {}
        for i, line in enumerate(lines):
            if name not in line:
                continue
            for m in pat.finditer(line):
                # 方名前一字也是汉字时是更长方名的一部分（「加味」+「四物汤」），不算。
                if m.start() > 0 and re.match(r"[一-鿿]", line[m.start() - 1]):
                    continue
                hits.setdefault(m.group(1).strip(), []).append((i + 1, line.strip()[:120]))
        by_name[name] = hits
    out = {}
    for name, hits in by_name.items():
        if not hits:
            continue
        named = {}
        for book, refs in hits.items():
            if book.startswith("《"):
                named.setdefault(norm_book(book), []).extend(refs)
        candidates = {b: r for b, r in named.items() if not TEXTBOOK.search(b)}
        titles = sorted(candidates, key=len, reverse=True)
        kept = []
        for t in titles:
            core = t.strip("《》")
            if any(all(ch in k for ch in core) for k in kept):
                continue
            kept.append(t)
        if len(kept) == 1:
            refs = candidates[kept[0]] + [r for b, rs in candidates.items() if b != kept[0] for r in rs]
            out[name] = {"source": kept[0], "kind": "corpus", "evidence": [{"file": "中医补充数据/灵丹GitHub/TCM Educational Materials.txt", "line": ln, "quote": q} for ln, q in refs[:2]]}
        elif not kept and any(EXPERIENCE.match(b) for b in hits):
            refs = [r for b, rs in hits.items() if EXPERIENCE.match(b) for r in rs]
            out[name] = {"source": "经验方", "kind": "corpus_experience", "evidence": [{"file": "中医补充数据/灵丹GitHub/TCM Educational Materials.txt", "line": ln, "quote": q} for ln, q in refs[:2]]}
    # 每条带上原文写的组成（「方名（《书》）：药、药、药」或「方名(《书》)药 药 药」），运行时据此排除同名异方。
    def composition_from_quote(name, quote):
        m = re.search(re.escape(name) + r"\s*[（(][^）)]*[）)]\s*[：:]?\s*(.+)$", quote)
        if not m:
            return []
        body = re.sub(r"[（(][^）)]*[）)]", "", m.group(1))
        body = re.split(r"[。；;]", body)[0]
        items = [x.strip() for x in re.split(r"[、，,\s]+", body) if x.strip()]
        items = [re.sub(r"[\d.]+\s*(?:g|克|两|钱|分)?$", "", x) for x in items]
        # 剂量与煎服写法不是药名（「柴胡各一钱」「各五分」「水煎服」）；药名后缀的炮制字（白术炒、甘草炙）去掉，比对按药名。
        items = [re.sub(r"各[一二三四五六七八九十半两钱分]+$", "", x) for x in items]
        items = [re.sub(r"(?<=[\u4e00-\u9fff]{2})(?:炒|炙|制|煨|酒洗|去心)$", "", x) for x in items]
        items = [re.sub(r"[一二三四五六七八九十半]+(?:斤|两|钱|分)(?:[一二三四五六七八九十半]+(?:钱|分))?$", "", x) for x in items]
        items = [re.sub(r"(?:去皮|去芦|去毛|去木|去心|取肉|锉|炮|酒蒸|酒洗)$", "", x) for x in items]
        items = [x for x in items if not re.search(r"^各|煎|服$|杯|为末|细末|为丸|上药|不见火|^[一二三四五六七八九十半]+[两钱分]|^(?:与|以|加)", x)]
        items = [x for x in items if len(x) >= 2]
        return [x for x in items if 1 <= len(x) <= 6 and re.fullmatch(r"[\u4e00-\u9fff]+", x)][:20]
    for name, entry in out.items():
        for ev in entry.get("evidence", []):
            comp = composition_from_quote(name, ev.get("quote", ""))
            if len(comp) >= 2:
                entry["composition"] = comp
                break
    web_count = 0
    if os.path.exists(WEB):
        web = json.load(open(WEB, encoding="utf-8"))
        for item in web.get("formulas", []):
            if not item.get("source") or item.get("kind") == "unknown":
                continue
            out[item["name"]] = {"source": item["source"], "kind": f"web_{item.get('kind')}", "evidence": item.get("evidence", [])[:2]}
            web_count += 1
    payload = {
        "schemaVersion": 1,
        "generatedBy": "scripts/build-textbook-formula-sources.py",
        "note": "教材代表方的原书出处：本地教材语料方剂索引逐行摘取（corpus），其余联网核对（web_*）。运行时只在方剂目录没有可用出处时用（textbookFormulaOriginalSource）。",
        "formulas": dict(sorted(out.items())),
    }
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    open(OUT, "a", encoding="utf-8").write("\n")
    print(f"textbook formula names {len(names)}, sourced {len(out)} (web {web_count})")


if __name__ == "__main__":
    sys.exit(main())
