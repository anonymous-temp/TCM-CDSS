#!/usr/bin/env python3
"""
从本地古籍语料（中医补充数据/TCM-Ancient-Books-master，github.com/xiaopangxia/TCM-Ancient-Books）逐方摘出原书写法：
每味药的炮制（甘草（炙）、酸枣仁（炒））与煎服法里的姜枣药引（「生姜五片，枣子一枚」），带书名、文件与行号。

为什么（2026-11-10 第四十一轮，r1054 回顾）：方义写「本方用归脾汤原方」，药味表却是生甘草、生枣仁、没有姜枣——
《严氏济生方》归脾汤原文是「甘草（炙）」「酸枣仁（炒，去壳）」「生姜五片，枣子一枚」。受治理方剂目录多数条目没有原文
（prescriptionOriginal 为空），交付面无从按原方写炮制、补药引说明。

取法（只认能核实的）：
  · 只看各书「<篇名>方名」整段（方书的条目格式），方名逐字相同；
  · 原文药味与目录（受治理条目或教材行）组成按身份比，至少六成相同才算同一首方（同名异方不取）；
  · 几本书都有时，取目录出处那本；没有时取年份最早的一本；
  · 炮制只收会改变饮片名的几类（炙、炒、煅、酒、盐、醋、姜、炮、煨、焙），去皮、去心、锉之类不收；
  · 药引只收煎服法里写明的生姜、大枣，且它们不在药味里。
输出 src/data/tcm-formula-original-text.json（生成物，勿手改）。
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS = os.path.join(ROOT, "中医补充数据", "TCM-Ancient-Books-master")
DATA = os.path.join(ROOT, "src", "data")
OUT = os.path.join(DATA, "tcm-formula-original-text.json")

ALIASES = {"黄耆": "黄芪", "茯神": "茯苓", "浓朴": "厚朴", "官桂": "肉桂", "桂心": "肉桂", "大腹子": "槟榔", "枣子": "大枣", "枣": "大枣",
           "山栀子仁": "栀子", "山栀子": "栀子", "山栀": "栀子", "栀子仁": "栀子", "白茯苓": "茯苓", "赤茯苓": "茯苓", "干地黄": "地黄",
           "生地黄": "地黄", "熟地黄": "地黄", "山茱萸": "山茱萸", "山萸肉": "山茱萸", "小蓟根": "小蓟", "淡竹": "淡竹叶", "草果仁": "草果",
           "川牛膝": "牛膝", "怀牛膝": "牛膝", "白芍药": "白芍", "芍药": "白芍", "广陈皮": "陈皮", "橘皮": "陈皮", "甘草梢": "甘草",
           "炙甘草": "甘草", "粉甘草": "甘草", "人参": "人参", "党参": "人参", "附子": "附子", "附片": "附子", "炮附片": "附子"}
PREP_RULES = [
    (re.compile(r"蜜炙|炙"), "炙"),
    (re.compile(r"煅"), "煅"),
    (re.compile(r"酒(?:洗|浸|蒸|炒|拌)"), "酒"),
    (re.compile(r"盐(?:水)?(?:炒|浸|拌)"), "盐"),
    (re.compile(r"醋(?:炒|炙|煮|浸)"), "醋"),
    (re.compile(r"姜(?:汁)?(?:制|炒|拌)"), "姜"),
    (re.compile(r"炮"), "炮"),
    (re.compile(r"煨"), "煨"),
    (re.compile(r"炒"), "炒"),
    (re.compile(r"焙"), "焙"),
]
GINGER = re.compile(r"(?:生姜|姜)[^，。、；\s]{0,2}?(?:[一二三四五六七八九十两三\d]+)(?:片|块)")
JUJUBE = re.compile(r"(?:大枣|枣子|红枣|枣)[^，。、；\s]{0,2}?(?:[一二三四五六七八九十两\d]+)(?:枚|个|颗)")
INGREDIENT_TOKEN = re.compile(r"([一-鿿]{1,6})(?:[（(]([^）)]{0,30})[）)])?")
METHOD_START = re.compile(r"^(?:上|右|已上|以上)")


def identity(name: str) -> str:
    n = re.sub(r"^(?:炙|炒|煅|蜜|酒|盐|醋|姜|制|生|焦|炮|煨)", "", name.strip())
    return ALIASES.get(name.strip(), ALIASES.get(n, n))


def book_year(text: str) -> int:
    m = re.search(r"年份：[^\n]*?(\d{3,4})", text[:400])
    return int(m.group(1)) if m else 9999


def load_books():
    books = []
    for fname in sorted(os.listdir(CORPUS)):
        if not fname.endswith(".txt"):
            continue
        raw = open(os.path.join(CORPUS, fname), "rb").read()
        try:
            text = raw.decode("gb18030")
        except UnicodeDecodeError:
            text = raw.decode("gb18030", errors="ignore")
        title = re.sub(r"^\d+-", "", fname[:-4])
        books.append({"file": fname, "title": title, "year": book_year(text), "lines": text.split("\n")})
    return books


def index_sections(books):
    idx = {}
    for book in books:
        lines = book["lines"]
        heads = [i for i, line in enumerate(lines) if line.startswith("<篇名>")]
        for k, start in enumerate(heads):
            name = lines[start][len("<篇名>"):].strip()
            end = heads[k + 1] if k + 1 < len(heads) else min(len(lines), start + 40)
            body = [line.rstrip() for line in lines[start + 1:min(end, start + 25)]]
            idx.setdefault(name, []).append({"book": book, "line": start + 1, "body": body})
    return idx


def parse_section(body):
    """返回 (药味 [(原名, 注)], 煎服法文字, 摘句)。"""
    text_lines = [line for line in body if line.strip()]
    ingredients, method, quote_lines = [], "", []
    started = False
    for line in text_lines:
        content = re.sub(r"^(?:属性|内容)：", "", line.strip())
        if METHOD_START.match(content) and started:
            method = content
            quote_lines.append(content)
            break
        if not started and re.search(r"[（(][^）)]*[两钱分][^）)]*[）)]|[（(](?:炙|炒|去)", content) is None and "：" in line[:4]:
            # 主治说明行；同一行后半常接着药味（「健忘怔忡。白术 茯神（去木）…」）
            tail = re.split(r"[。]", content, maxsplit=1)
            content = tail[1] if len(tail) > 1 else ""
            if not content.strip():
                continue
        tokens = [t for t in re.split(r"\s+", content) if t]
        if not tokens:
            continue
        parsed = []
        for token in tokens:
            m = INGREDIENT_TOKEN.fullmatch(token.strip("，。、"))
            if m:
                parsed.append((m.group(1), m.group(2) or ""))
        if parsed:
            started = True
            ingredients.extend(parsed)
            quote_lines.append(content)
    if not method:
        for line in text_lines:
            if METHOD_START.match(line.strip()):
                method = line.strip()
                break
    return ingredients, method, " ".join(quote_lines)[:200]


def preparation_of(note: str):
    for pattern, prep in PREP_RULES:
        if pattern.search(note):
            return prep
    return None


def main():
    governed = json.load(open(os.path.join(DATA, "tcm-formula-governed-catalog.json"), encoding="utf-8"))["entries"]
    table = json.load(open(os.path.join(DATA, "tcm-textbook-syndrome-formula-table.json"), encoding="utf-8"))["rows"]
    targets = {}
    for entry in governed:
        name = entry.get("name", "").strip()
        if name and not name.startswith("《"):
            targets.setdefault(name, {"ingredients": set(), "source": entry.get("source") or ""})
            targets[name]["ingredients"].update(identity(x) for x in entry.get("ingredients") or [])
    for row in table:
        for name in row.get("formulas") or []:
            t = targets.setdefault(name, {"ingredients": set(), "source": ""})
            if not t["ingredients"]:
                for item in row.get("formulaCompositions") or []:
                    if item.get("formula") == name:
                        t["ingredients"].update(identity(x) for x in item.get("herbs") or [])
    books = load_books()
    idx = index_sections(books)
    out = {}
    for name, target in sorted(targets.items()):
        wanted = target["ingredients"]
        if len(wanted) < 2 or name not in idx:
            continue
        candidates = []
        for sec in idx[name]:
            ingredients, method, quote = parse_section(sec["body"])
            ids = {identity(n) for n, _ in ingredients}
            if len(ids) < 2:
                continue
            shared = len(ids & wanted)
            if shared < max(2, round(0.6 * min(len(ids), len(wanted)))):
                continue
            catalog_book = sec["book"]["title"] in target["source"] or any(
                part and part in sec["book"]["title"] for part in re.findall(r"《([^》]+)》", target["source"]))
            candidates.append((0 if catalog_book else 1, sec["book"]["year"], sec, ingredients, method, quote))
        if not candidates:
            continue
        candidates.sort(key=lambda c: (c[0], c[1]))
        _, _, sec, ingredients, method, quote = candidates[0]
        preps = {}
        for raw, note in ingredients:
            prep = preparation_of(note)
            if prep and identity(raw) not in preps:
                preps[identity(raw)] = prep
        ingredient_ids = {identity(n) for n, _ in ingredients}
        guides = []
        if "生姜" not in ingredient_ids and GINGER.search(method):
            guides.append("生姜")
        if "大枣" not in ingredient_ids and JUJUBE.search(method):
            guides.append("大枣")
        if not preps and not guides:
            continue
        out[name] = {
            "book": f"《{sec['book']['title']}》",
            "file": sec["book"]["file"],
            "line": sec["line"],
            "preparations": preps,
            "guideHerbs": guides,
            "quote": quote,
            "method": method[:120],
        }
    payload = {
        "schemaVersion": 1,
        "generatedBy": "scripts/build-formula-original-text.py",
        "corpus": "中医补充数据/TCM-Ancient-Books-master（github.com/xiaopangxia/TCM-Ancient-Books，gb18030）",
        "note": "原书逐字摘取：preparations 是原文药味后的炮制注（只收改变饮片名的几类），guideHerbs 是煎服法里的生姜、大枣药引。",
        "formulas": out,
    }
    json.dump(payload, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    open(OUT, "a", encoding="utf-8").write("\n")
    print(f"targets {len(targets)}, written {len(out)}")


if __name__ == "__main__":
    sys.exit(main())
