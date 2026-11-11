#!/usr/bin/env python3
"""
原方组成表（2026-11-10 第四十二轮，根因一「这张方的原方组成没有唯一权威」）。

为什么：人参养荣汤、天麻钩藤饮等 545 条受治理目录条目来自深圳《中药方剂编码规则》（SZJG/T 38.2-2011，调剂编码标准）：
药名是调剂品名（姜天麻、煅石决明、黄芩片），组成有的被现代改过（人参养荣汤多枸杞子、首乌藤而无肉桂），出处却标原书。
「原方」核对、加减后缀、药引、原方炮制、出处此前各读各的（目录、教材「常用药」、方解、original-text 表），
同一张被改过的表既是模型抄的对象、又是核对的基准，所以「本方用人参养荣汤原方」通过。

这张表是「原方组成」的唯一权威：键（方名, 出处书[, variant]），每条的药味、原文炮制、药引都摘自原书原文，
带可逐字核对的摘句（jicheng.tw 中醫笈成全文、本地古籍/教材语料行号、国家经典名方目录原文）。
深圳标准条目与教材「常用药」不算原方依据。表里没有的方，系统不写「原方」。

输入（人工维护）：src/data/tcm-formula-original-compositions.source.json
输出（生成物，勿手改）：src/data/tcm-formula-original-compositions.json
  entries[]            运行时用的紧凑条目
  textbookCitations{}  教材行 id → {方名: 该教材写的出处书}（教材行原文「白术散（《全生指迷方》）」，或该教材方剂索引里的出处）

核对：
  · 结构、取值闭集、每味药的原文写法必须在摘句里（任何机器上都核）；
  · 本地语料证据（kind=local）在语料目录存在时逐字核对；
  · jicheng 证据在设置 FORMULA_ORIGINAL_JICHENG_CACHE=<简体全文缓存目录> 时逐字核对（scripts/formula-original/fetch-jicheng.py 生成缓存）。
用法：python3 scripts/build-formula-original-compositions.py [--check]   （--check 只核对、不写文件，生成物与输入不一致时退出码 1）
"""
import json
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src", "data")
SOURCE = os.path.join(DATA, "tcm-formula-original-compositions.source.json")
OUT = os.path.join(DATA, "tcm-formula-original-compositions.json")
TABLE = os.path.join(DATA, "tcm-textbook-syndrome-formula-table.json")
EDU = os.path.join(ROOT, "中医补充数据", "灵丹GitHub", "TCM Educational Materials.txt")
JICHENG_CACHE = os.environ.get("FORMULA_ORIGINAL_JICHENG_CACHE", "")

STATUS = {"verified", "verified_other_edition", "modern_formula"}
TIERS = ["original_text", "national_catalog", "fangjixue", "textbook_appendix", "modern_source"]
PREPARATIONS = {"炙", "蜜炙", "炒", "麸炒", "土炒", "煅", "酒", "盐", "醋", "姜", "炮", "煨", "焙", "制", "蒸", "炭", "焦", "烧", "熬", "生"}
EVIDENCE_KINDS = {"jicheng", "local", "web", "national_catalog"}
# 原书炮制里今天仍随方写进饮片名的几味（《方剂学》教材照写）：其余原书炮制（当归微炒、白术煨）通行方不写，交付时不改药名。
CONVENTIONAL_PREPARATIONS = {("甘草", "炙"), ("黄芪", "炙"), ("酸枣仁", "炒")}
# 国家经典名方目录的方，原文写明这几类炮制时交付时随方写进药名（完带汤「白术土炒」「山药炒」）。
DELIVERABLE_PREPARATIONS = {"炙", "炒", "麸炒", "土炒", "煅", "酒", "盐", "醋", "姜", "炮", "煨", "制", "炭", "焦"}


def norm(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text or ""))


def fail(errors):
    for error in errors[:60]:
        print("ERR", error)
    print(f"errors {len(errors)}")
    sys.exit(1)


_cache = {}


def local_lines(path):
    if path not in _cache:
        raw = open(path, "rb").read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("gb18030", "ignore")
        _cache[path] = text.split("\n")
    return _cache[path]


def jicheng_text(book):
    path = os.path.join(JICHENG_CACHE, book + ".txt")
    if path not in _cache:
        _cache[path] = norm(open(path, encoding="utf-8").read()) if os.path.exists(path) else None
    return _cache[path]


def canonical_book(aliases, book):
    b = (book or "").strip().strip("《》")
    b0 = re.sub(r"卷[一二三四五六七八九十百上中下之\d]+.*$", "", b).strip("·• ")
    if b0 in aliases:
        return aliases[b0]
    head = re.split(r"[·•]", b0)[0]
    return aliases.get(head, head)


def validate(source):
    errors = []
    verified = {"local": 0, "jicheng": 0, "unverifiable_here": 0}
    seen = set()
    for index, row in enumerate(source["rows"]):
        tag = f"[{index}] {row.get('name')}《{row.get('book')}》"

        def err(message):
            errors.append(f"{tag} {message}")

        key = (row.get("name"), row.get("book"), row.get("variant", ""))
        if not row.get("name") or not row.get("book"):
            err("缺 name/book")
            continue
        if key in seen:
            err("键重复")
        seen.add(key)
        if row.get("book") != canonical_book(source["bookAliases"], row["book"]):
            err(f"book 不是规范书名（应为 {canonical_book(source['bookAliases'], row['book'])}）")
        if row.get("status") not in STATUS:
            err(f"status 非法：{row.get('status')}")
        if row.get("tier") not in TIERS:
            err(f"tier 非法：{row.get('tier')}")
        quotes = []
        for evidence in row.get("evidence") or []:
            kind = evidence.get("kind")
            quote = norm(evidence.get("quote"))
            if kind not in EVIDENCE_KINDS:
                err(f"evidence.kind 非法：{kind}")
                continue
            if len(quote) < 4:
                err("evidence.quote 太短")
                continue
            quotes.append(quote)
            if kind == "local":
                path = os.path.join(ROOT, evidence.get("file", ""))
                if os.path.exists(path):
                    lines = local_lines(path)
                    at = int(evidence.get("line", 0)) - 1
                    if quote not in norm("".join(lines[max(0, at - 1):at + 8])):
                        err(f"本地语料第 {evidence.get('line')} 行附近找不到摘句：{evidence.get('quote', '')[:30]}…")
                    else:
                        verified["local"] += 1
                else:
                    verified["unverifiable_here"] += 1
            elif kind == "jicheng":
                if not evidence.get("url") or not evidence.get("book"):
                    err("jicheng 证据缺 url/book")
                text = jicheng_text(evidence.get("book", "")) if JICHENG_CACHE else None
                if text is None:
                    verified["unverifiable_here"] += 1
                elif quote not in text:
                    err(f"jicheng《{evidence.get('book')}》里找不到摘句：{evidence.get('quote', '')[:30]}…")
                else:
                    verified["jicheng"] += 1
            elif kind == "web":
                if not evidence.get("url"):
                    err("web 证据缺 url")
                verified["unverifiable_here"] += 1
        if not quotes:
            err("没有 evidence")
            continue
        joined = "".join(quotes)
        herbs = set()
        if not row.get("ingredients"):
            err("ingredients 为空")
        for item in row.get("ingredients") or []:
            written, herb = item.get("written", ""), item.get("herb", "")
            if not written or not herb:
                err(f"药味缺 written/herb：{item}")
                continue
            if norm(written) not in joined:
                err(f"药味「{written}」不在任何摘句里")
            if herb in herbs:
                err(f"herb 重复：{herb}")
            herbs.add(herb)
            preparation = item.get("preparation")
            if preparation:
                if preparation not in PREPARATIONS:
                    err(f"preparation「{preparation}」不在闭集里")
                if not item.get("preparationRaw") or norm(item["preparationRaw"]) not in joined:
                    err(f"「{written}」的 preparationRaw 缺失或不在摘句里")
        for guide in row.get("guideHerbs") or []:
            if not guide.get("herb") or norm(guide.get("written", "")) not in joined or not guide.get("written"):
                err(f"药引缺 herb/written 或原文不在摘句里：{guide}")
            if guide.get("herb") in herbs:
                err(f"药引「{guide.get('herb')}」已在药味里")
    return errors, verified


def textbook_citations(aliases):
    """教材行 id → {方名: 出处书}。先取该行原文里「方名（《书》）」，否则取该教材方剂索引里这个方名唯一的出处。"""
    if not os.path.exists(TABLE):
        return {}
    table = json.load(open(TABLE, encoding="utf-8"))
    textbook_title = re.compile(r"^(?:中医|中西医结合)(?:内|外|妇|儿|眼|耳鼻咽喉|骨伤|妇产)科?学$|^方剂学$|^针灸治疗学$|^中医诊断学$|^温病学$|药典")
    by_book = {}
    if os.path.exists(EDU):
        lines = open(EDU, encoding="utf-8", errors="ignore").read().split("\n")
        pattern = re.compile(r"^([一-鿿]{2,14})\s*[（(]\s*《([^》]{1,30})》")
        for info in table.get("books") or []:
            index = {}
            for line in lines[info["lineStart"] - 1:info["lineEnd"]]:
                match = pattern.match(line.strip())
                if not match:
                    continue
                book = canonical_book(aliases, match.group(2))
                if textbook_title.search(book):
                    continue
                index.setdefault(match.group(1), set()).add(book)
            by_book[info["bookKey"]] = {name: next(iter(books)) for name, books in index.items() if len(books) == 1}
    out = {}
    for row in table["rows"]:
        text = row.get("formulaText") or ""
        cited = {}
        for formula in row.get("formulas") or []:
            match = re.search(re.escape(formula) + r"\s*[（(]\s*《([^》]{1,30})》", text)
            book = canonical_book(aliases, match.group(1)) if match else by_book.get(row.get("bookKey"), {}).get(formula)
            if book and not textbook_title.search(book):
                cited[formula] = book
        if cited:
            out[row["id"]] = cited
    return out


def national_catalog_formulas(aliases):
    path = os.path.join(DATA, "tcm-formula-sources.json")
    if not os.path.exists(path):
        return set()
    official = json.load(open(path, encoding="utf-8")).get("officialClassicFormulas", {})
    return {(name, canonical_book(aliases, item.get("source"))) for name, item in official.items()}


def build(source):
    aliases = source["bookAliases"]
    national = national_catalog_formulas(aliases)
    entries = []
    for row in source["rows"]:
        herbs = []
        for item in row["ingredients"]:
            herb = {"herb": item["herb"], "written": item["written"]}
            preparation = item.get("preparation")
            if preparation:
                herb["preparation"] = preparation
                normalized = "炙" if preparation == "蜜炙" else preparation
                raw = item.get("preparationRaw", "")
                # 交付时随方写进药名的炮制（与第三十七、四十一轮的口径相同，只是数据改读这张表）：
                #  · 通行的三味（甘草炙、黄芪炙、酸枣仁炒）；
                #  · 国家古代经典名方目录收的方，原文写明的炮制（完带汤「白术土炒、山药炒、白芍酒炒」）。
                # 其余原书炮制只记录、不改交付药名：古书的「炙」「酒洗」与今天的蜜炙、酒炙不是一回事
                #（大承气汤「大黄酒洗」写成酒大黄会改变泻下力；「枳实炙」不是蜜炙），按字面换成饮片名会改药性。
                washed_only = preparation == "酒" and not re.search(r"酒[^，、；]{0,2}[炒炙]", raw)
                if preparation in DELIVERABLE_PREPARATIONS and not washed_only and (
                    (item["herb"], normalized) in CONVENTIONAL_PREPARATIONS
                    or (row["name"], row["book"]) in national
                ):
                    herb["deliver"] = True
            herbs.append(herb)
        first = row["evidence"][0]
        reference = first.get("book") or (f"{first.get('file')}:{first.get('line')}" if first.get("file") else "") or first.get("url") or ""
        entry = {"name": row["name"], "book": row["book"]}
        if row.get("variant"):
            entry["variant"] = row["variant"]
        if row.get("aliases"):
            entry["aliases"] = row["aliases"]
        if row.get("citedBooks"):
            entry["citedBooks"] = row["citedBooks"]
        if row.get("alternates"):
            entry["alternates"] = [{"add": alt.get("add", []), "remove": alt.get("remove", []), "basis": alt["basis"]} for alt in row["alternates"]]
        entry.update({
            "tier": row["tier"],
            "herbs": herbs,
            "guides": [guide["herb"] for guide in row.get("guideHerbs") or []],
            "evidence": {"kind": first["kind"], "ref": reference, **({"url": first["url"]} if first.get("url") else {}), "quote": first["quote"][:200]},
        })
        entries.append(entry)
    tiers = {tier: sum(1 for entry in entries if entry["tier"] == tier) for tier in TIERS}
    return {
        "schemaVersion": 1,
        "generatedBy": "scripts/build-formula-original-compositions.py",
        "note": "原方组成的唯一权威（生成物，勿手改；改 tcm-formula-original-compositions.source.json 后重跑生成器）。"
                "herbs[].herb 是饮片基础名，written 是原文写法，preparation 是原文炮制，deliver=true 的炮制交付时随方写进药名；guides 是煎服法里的药引。",
        "counts": {"entries": len(entries), "tiers": tiers},
        "substitutions": source.get("substitutions", []),
        "equivalentHerbNames": source.get("equivalentHerbNames", []),
        "bookAliases": aliases,
        "entries": entries,
        "textbookCitations": textbook_citations(aliases),
    }


def main():
    source = json.load(open(SOURCE, encoding="utf-8"))
    errors, verified = validate(source)
    if errors:
        fail(errors)
    payload = build(source)
    text = json.dumps(payload, ensure_ascii=False, indent=1) + "\n"
    if "--check" in sys.argv:
        current = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if current != text:
            print("生成物与输入不一致：请运行 python3 scripts/build-formula-original-compositions.py")
            sys.exit(1)
    else:
        open(OUT, "w", encoding="utf-8").write(text)
    print(f"entries {len(payload['entries'])} tiers {payload['counts']['tiers']} textbook rows with citations {len(payload['textbookCitations'])} evidence verified {verified}")


if __name__ == "__main__":
    main()
