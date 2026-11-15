#!/usr/bin/env python3
"""
原方组成表补「煎服法里的药引」（2026-11-15 第四十六轮）。

为什么：表里 2269 行只摘了组成一句，没有摘煎服法，药引因此缺了（参苓白术散原文「每服二钱，枣汤调下」，表里 guides 为空；
第四十五轮逐字复核判「本方用参苓白术散原方」不实：原方枣汤调下，处方未用大枣也未说明）。

做法：对只有组成摘句、guideHerbs 为空的行，在本地古籍缓存（jicheng 抓取的书，FORMULA_ORIGINAL_JICHENG_CACHE，默认 /var/tmp/r1057/jc）
里找到那句组成，取紧接着的煎服法一句（到下一个方题「#h」为止，最多两行），按闭集写法认药引：
  「X汤调下/送下/下/化下/煎」「入X（同）煎」「X为引」「以X煎汤」「加X…煎」「鲜苇根汤煎」，X 只认药引闭集（GUIDE_WORDS）。
认到的药引写进 guideHerbs（herb 基础名、written 原文写法），那句煎服法原样追加进 evidence（逐字，生成器 check 会再核一次）。
只增不删；已在药味里的不算药引；找不到组成句或煎服法的行不动。

用法：python3 scripts/formula-original/add_usage_guides.py [--write]
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, "src", "data", "tcm-formula-original-compositions.source.json")
CACHE = os.environ.get("FORMULA_ORIGINAL_JICHENG_CACHE", "/var/tmp/r1057/jc")

# 药引写法 → 饮片基础名（闭集；米饮、酒、醋、盐汤、蜜这类送服的液体不是药引药味，不收）。
GUIDE_WORDS = {
    "大枣": "大枣", "红枣": "大枣", "枣子": "大枣", "枣": "大枣",
    "生姜": "生姜", "姜": "生姜", "姜片": "生姜",
    "灯心草": "灯心草", "灯心": "灯心草", "灯草": "灯心草",
    "鲜苇根": "芦根", "苇根": "芦根", "芦根": "芦根",
    "葱白": "葱白", "葱": "葱白",
    "淡竹叶": "淡竹叶", "竹叶": "淡竹叶",
    "薄荷": "薄荷", "粳米": "粳米", "乌梅": "乌梅",
}
WORD = "|".join(sorted(GUIDE_WORDS, key=len, reverse=True))
PATTERNS = [
    re.compile(rf"((?:{WORD})(?:、(?:{WORD}))?)汤(?:调|送|化|吞)?(?:下|服|煎)"),
    re.compile(rf"入((?:{WORD})(?:[一二三四五六七八九十两半\d]{{0,3}}(?:片|枚|茎|根|个|寸|撮|钱|握)?)?(?:[、，]?(?:{WORD})(?:[一二三四五六七八九十两半\d]{{0,3}}(?:片|枚|茎|根|个|寸|撮|钱|握)?)?)?)(?:同)?煎"),
    re.compile(rf"加((?:{WORD})(?:[一二三四五六七八九十两半\d]{{0,3}}(?:片|枚|茎|根|个|寸|撮|钱|握)?)?(?:[、，]?(?:{WORD})(?:[一二三四五六七八九十两半\d]{{0,3}}(?:片|枚|茎|根|个|寸|撮|钱|握)?)?)?)(?:同)?煎"),
    re.compile(rf"以?((?:{WORD}))为引"),
    # 「空心姜盐汤下」「姜、盐汤下」：姜与盐同作汤送下（盐不是药引药味）。
    re.compile(rf"((?:{WORD}))、?盐汤(?:调|送)?下"),
    # 「姜煎冷服」：煎时加姜，单列一句或句首。
    re.compile(rf"(?:^|[，。；])((?:{WORD})(?:、?(?:{WORD}))?)煎(?:服|冷服|温服|去滓|$)"),
]
SIMPLIFY = str.maketrans({"薑": "姜", "棗": "枣", "燈": "灯", "蔥": "葱", "葦": "苇", "湯": "汤", "煎": "煎", "調": "调"})


def norm(text):
    return re.sub(r"[\s，。、；：:（）()「」“”\"']", "", text or "")


def book_text(book, cache):
    if book in cache:
        return cache[book]
    text = ""
    for candidate in (f"{book}.txt", f"{book}_1.txt"):
        path = os.path.join(CACHE, candidate)
        if os.path.exists(path):
            text += open(path, encoding="utf-8", errors="ignore").read() + "\n"
    # 摘句与缓存原文的空格写法不一（全角空格、制表符）：两边都去掉行内空白再找。
    cache[book] = re.sub(r"[ \t\u3000]+", "", text)
    return text


def usage_after(text, quote):
    """组成那一句之后的煎服法：从组成句末到下一个方题（#h）之前，最多两行。"""
    at = text.find(re.sub(r"[ \t\u3000]+", "", quote))
    if at < 0:
        return ""
    tail = text[at + len(re.sub(r"[ \t\u3000]+", "", quote)):]
    stop = tail.find("#h")
    tail = tail[: stop if stop >= 0 else 400]
    lines = [line.strip() for line in tail.split("\n") if line.strip()]
    return "\n".join(lines[:2])


def main():
    write = "--write" in sys.argv
    data = json.load(open(SOURCE, encoding="utf-8"))
    cache = {}
    added = 0
    for row in data["rows"]:
        if row.get("guideHerbs") or len(row.get("evidence") or []) != 1:
            continue
        evidence = row["evidence"][0]
        if evidence.get("kind") != "jicheng":
            continue
        text = book_text(evidence.get("book") or evidence.get("ref") or row.get("book"), cache)
        if not text:
            continue
        usage = usage_after(text, evidence.get("quote", ""))
        if not usage:
            continue
        sentence = usage.split("\n")[0]
        # 按病情另换送服的（「怯寒则煎姜枣汤下」「或薄荷汤下」「小便不利，灯芯汤下」）、做丸用的姜汁，不是这首方固定的药引。
        if re.search(r"则|若|或|随证|随病|汁", sentence):
            continue
        # 几种送服液按病情各用其一（「治风痰…生姜汤下；取食伤…枣汤下；小便不利，灯芯汤下」）：不是固定药引。
        if len(re.findall(r"汤(?:调|送|吞)?下", sentence)) >= 2:
            continue
        herbs = {item.get("herb") for item in row.get("ingredients") or []}
        guides = []
        simplified = sentence.translate(SIMPLIFY)
        for pattern in PATTERNS:
            for match in pattern.finditer(simplified):
                # 送服的汤里还有别的药（「浓煎人参茯苓姜枣汤吞下」）：那是另一张汤，不是这首方的姜枣药引。
                before = simplified[max(0, match.start(1) - 1):match.start(1)]
                if before and re.match(r"[\u4e00-\u9fff]", before) and before not in "煎用以淡温热浓入加空心":
                    continue
                for word in re.findall(WORD, match.group(1)):
                    herb = GUIDE_WORDS[word]
                    if herb in herbs or any(g["herb"] == herb for g in guides):
                        continue
                    guides.append({"herb": herb, "written": word})
        if not guides:
            continue
        row["guideHerbs"] = guides
        row["evidence"].append({"kind": "jicheng", "book": evidence.get("book"), "url": evidence.get("url"), "quote": sentence,
                                "note": "煎服法（第四十六轮补药引，scripts/formula-original/add_usage_guides.py）"})
        added += 1
        if added <= 12 or row["name"] in ("参苓白术散", "八正散", "银翘散"):
            print(row["name"], row.get("book"), [g["herb"] for g in guides], "|", sentence[:60])
    print(f"rows with guides added: {added}")
    if write:
        with open(SOURCE, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=1)
            handle.write("\n")


if __name__ == "__main__":
    main()
