#!/usr/bin/env python3
"""Deterministic extractor: 规划教材 non-drug TCM treatments -> structured JSON.

Usage:
    python3 extract_nondrug.py "<TCM Educational Materials.txt>" <out.json>

Stdlib only, no model calls, no randomness, no timestamps in the output: the same
source file always yields a byte-identical JSON (the source sha256 is recorded).

Every extracted item carries the 1-based line number(s) of the source file it came
from ("line" / "lines" = [first, last]) so a reviewer can open the text and check.

Sources (全国中医药行业高等教育“十三五”规划教材, 中国中医药出版社):
  针灸治疗学 (高树中, 杨骏)   -> acupuncture[sourceBook=zhenjiu_zhiliao]   (primary)
  针灸学 (梁繁荣, 王华)       -> acupuncture[sourceBook=zhenjiu_xue]       (cross-check)
  推拿学 (房敏, 宋柏林)       -> tuina, daoyin (推拿功法)
  中医食疗学 (施洪飞, 方泓)   -> diet
  中医养生学 (马烈光, 蒋力生) -> daoyin (传统运动养生), yangshengChronic
  经络腧穴学 (沈雪勇)         -> acupoint lexicon used to split concatenated point lists
Book ranges are found from the CIP lines ("书名/主编….—") and run until the next
book's CIP block, as instructed; see REPORT for places where the OCR dump interleaves.
"""

import hashlib
import json
import re
import sys
from collections import Counter, OrderedDict

SCRIPT_VERSION = "1.0.0"

CJK = "一-鿿"
CN_NUM = "一二三四五六七八九十百零〇两"

# --------------------------------------------------------------------------------------
# Books
# --------------------------------------------------------------------------------------

BOOK_KEYS = OrderedDict([
    ("zhenjiu_zhiliao", "针灸治疗学"),
    ("zhenjiu_xue", "针灸学"),
    ("tuina", "推拿学"),
    ("shiliao", "中医食疗学"),
    ("yangsheng", "中医养生学"),
    ("cifa_jiufa", "刺法灸法学"),
    ("jingluo_shuxue", "经络腧穴学"),
])
# OCR turned every "、" into "→" in these books only (推拿学 uses real sequence arrows).
ARROW_IS_OCR_COMMA = {"zhenjiu_zhiliao", "jingluo_shuxue"}

CIP_RE = re.compile(r"^(?P<title>[^/\s]{2,20})/(?P<editors>[^/]+?)主编(?P<rest>.*)$")
ISBN_RE = re.compile(r"ISBN\s*([0-9Xx\-–—]{10,20})")


def format_isbn(raw):
    digits = re.sub(r"[^0-9Xx]", "", raw)
    if len(digits) == 13 and digits.startswith("97875132"):
        return "978-7-5132-%s-%s" % (digits[8:12], digits[12])
    return raw.replace("–", "-").replace("—", "-")


def detect_books(lines):
    """All CIP lines in the dump -> ordered list of (start_line_idx, title, meta)."""
    starts = []
    for i, raw in enumerate(lines):
        if "主编" not in raw or "/" not in raw:
            continue
        m = CIP_RE.match(raw.strip())
        if not m or ".—" not in raw and "—" not in raw:
            continue
        rest = m.group("rest")
        tail = rest + " " + (lines[i + 1] if i + 1 < len(lines) else "")
        ed = re.search(r"—\s*(\d+)\s*版", rest)
        yr = re.search(r"(20\d\d)\.(\d{1,2})", tail)
        isbn = None
        for j in range(i, min(i + 8, len(lines))):
            mm = ISBN_RE.search(lines[j])
            if mm:
                isbn = format_isbn(mm.group(1))
                break
        reprint = re.search(r"（(20\d\d\.\d{1,2})重印）", rest)
        meta = {
            "title": m.group("title"),
            "editors": m.group("editors").strip(),
            "edition": (ed.group(1) + "版") if ed else None,
            "publisher": "中国中医药出版社",
            "year": int(yr.group(1)) if yr else None,
            "publishedMonth": ("%s.%s" % (yr.group(1), yr.group(2))) if yr else None,
            "isbn": isbn,
            "series": "全国中医药行业高等教育“十三五”规划教材",
            "cipLine": i + 1,
        }
        if reprint:
            meta["reprint"] = reprint.group(1)
        starts.append((i, m.group("title"), meta))
    return starts


# --------------------------------------------------------------------------------------
# Generic text helpers
# --------------------------------------------------------------------------------------

def clean(s):
    s = s.replace("\u3000", " ").replace("\t", " ")
    s = re.sub(r" {2,}", " ", s)
    return s.strip()


def nospace(s):
    return re.sub(r"[\s\u3000]+", "", s)


def join_text(parts):
    out = ""
    for p in parts:
        p = clean(p)
        if not p:
            continue
        out = p if not out else out + p
    return out


def sentences(text):
    return [s for s in re.split(r"(?<=[。；;！？])", text) if s.strip()]


LIST_SPLIT_RE = re.compile(r"[、，,；;。/\s\u3000]+|或者|或|及其|以及|及|与")


def split_list(text):
    text = re.sub(r"[。．]$", "", text.strip())
    toks = []
    for t in LIST_SPLIT_RE.split(text):
        t = t.strip().strip("。．")
        t = re.sub(r"等+$", "", t)
        if t:
            toks.append(t)
    return toks


def uniq(seq):
    seen = set()
    out = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# --------------------------------------------------------------------------------------
# Acupoint lexicon (from 经络腧穴学 headings + a small documented supplement)
# --------------------------------------------------------------------------------------

POINT_HEAD_RE = re.compile(
    r"^(?:\d+[\.．]\s*)?((?:[" + CJK + r"]{1,5}\s*\*?\s*){1,2}?)\s*"
    r"[A-ZĀÁǍÀĒÉĚÈŌÓǑÒ][A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüÜ\s]*"
    r"[（(]\s*((?:LU|LI|ST|SP|HT|SI|BL|KI|PC|TE|SJ|GB|LR|LIV|GV|DU|CV|RN|EX)[-A-Z0-9，,\s]*)[）)]"
)

# Standard names the OCR'd headings miss (安眠/臂臑/风府/后顶 lose their heading
# format), plus 经外奇穴 / composite names that the treatment chapters write as one
# prescription item.  Kept short and explicit so a reviewer can audit it.
LEXICON_SUPPLEMENT = [
    "安眠", "臂臑", "风府", "后顶",
    "阿是穴", "夹脊穴", "颈夹脊", "胸夹脊", "腰夹脊", "华佗夹脊", "颈夹脊穴", "胸夹脊穴", "腰夹脊穴",
    "十二井穴", "十二井", "手十二井", "十宣穴", "八髎", "八髎穴",
    "牵正", "夹承浆", "上廉泉", "百劳", "落枕", "落枕穴", "肩前", "肩内陵", "膝眼", "外膝眼",
    "三角灸", "提托", "新设", "血压点", "崇骨", "环中", "陵后", "腰宜", "下极俞",
    "胆囊穴", "阑尾穴", "痞根穴", "气端", "里内庭", "利尿穴", "膏肓俞", "绝骨",
    "金津", "玉液", "子宫", "子宫穴",
]


def build_lexicon(lines, lo, hi):
    names = OrderedDict()
    for i in range(lo, hi):
        m = POINT_HEAD_RE.match(lines[i].strip())
        if not m:
            continue
        for n in re.split(r"[\s\*]+", m.group(1)):
            if len(n) >= 2 and n not in names:
                names[n] = {"line": i + 1, "code": clean(m.group(2))}
    from_book = list(names.keys())
    supplement_added = [n for n in LEXICON_SUPPLEMENT if n not in names]
    lex = set(from_book) | set(LEXICON_SUPPLEMENT)
    return lex, from_book, supplement_added, names


POINT_CANON = {
    "阿是": "阿是穴", "夹脊穴": "夹脊", "颈夹脊穴": "颈夹脊", "胸夹脊穴": "胸夹脊", "腰夹脊穴": "腰夹脊",
    "十二井": "十二井穴", "十宣穴": "十宣", "八髎穴": "八髎", "胆囊穴": "胆囊", "阑尾穴": "阑尾",
    "痞根穴": "痞根", "子宫穴": "子宫", "落枕穴": "落枕",
}


class PointParser:
    QUALIFIERS = ("患侧", "健侧", "对侧", "双侧", "同侧", "病侧", "两侧", "局部", "患部", "左", "右",
                  "重灸", "温灸", "灸", "点刺")
    SITE_WORDS = re.compile(r"经|脉|部|侧线|线|区|椎|处|周围|局部|两侧|沿|至|以上|上述|相应|皮损|病变|疣|肿|斑|\d")
    CONNECTORS = {"透": "through"}

    def __init__(self, lexicon):
        self.lex = lexicon
        self.maxlen = max(len(w) for w in lexicon)
        self.unresolved = Counter()
        self.others = Counter()
        self.ambiguous = OrderedDict()   # chunk -> chosen split, when >1 full-cover split exists
        self.concatenated = Counter()    # chunks that needed splitting (no separators)

    def count_full_covers(self, chunk):
        n = len(chunk)
        ways = [0] * (n + 1)
        ways[0] = 1
        for i in range(n):
            if not ways[i]:
                continue
            for L in range(2, min(self.maxlen, n - i) + 1):
                if chunk[i:i + L] in self.lex:
                    ways[i + L] += ways[i]
            if chunk[i] in self.CONNECTORS:
                ways[i + 1] += ways[i]
        return ways[n]

    def segment(self, chunk):
        """DP: minimise (#unknown chars, #pieces). Returns list of (kind, text)."""
        n = len(chunk)
        best = [None] * (n + 1)
        back = [None] * (n + 1)
        best[0] = (0, 0)
        for i in range(n):
            if best[i] is None:
                continue
            u, p = best[i]
            for L in range(min(self.maxlen, n - i), 1, -1):
                w = chunk[i:i + L]
                if w in self.lex:
                    c = (u, p + 1)
                    if best[i + L] is None or c < best[i + L]:
                        best[i + L] = c
                        back[i + L] = (i, "pt", w)
            ch = chunk[i]
            if ch in self.CONNECTORS:
                c = (u, p)
                if best[i + 1] is None or c < best[i + 1]:
                    best[i + 1] = c
                    back[i + 1] = (i, "conn", ch)
            c = (u + 1, p)
            if best[i + 1] is None or c < best[i + 1]:
                best[i + 1] = c
                back[i + 1] = (i, "unk", ch)
        seq = []
        j = n
        while j > 0:
            i, kind, w = back[j]
            seq.append((kind, w))
            j = i
        seq.reverse()
        merged = []
        for kind, w in seq:
            if kind == "unk" and merged and merged[-1][0] == "unk":
                merged[-1] = ("unk", merged[-1][1] + w)
            else:
                merged.append((kind, w))
        return merged

    def resolve_chunk(self, chunk):
        """-> dict(points, others, fragments, through)"""
        res = {"points": [], "others": [], "fragments": [], "through": []}
        chunk = re.sub(r"^(?:取穴|选穴|选取|选用|可取|取|选|以|如|即)", "", chunk)
        chunk = re.sub(r"(?:为主|为宜)$", "", chunk)
        chunk = re.sub(r"(?:等穴位|等穴|等腧穴|等部位|穴位|等)$", "", chunk)
        if not chunk:
            return res
        if chunk in POINT_CANON:
            res["points"].append(POINT_CANON[chunk])
            return res
        if "腧" in chunk and chunk.replace("腧", "俞") in self.lex:
            chunk = chunk.replace("腧", "俞")
        if chunk in self.lex:
            res["points"].append(POINT_CANON.get(chunk, chunk))
            return res
        if chunk.endswith("穴") and chunk[:-1] in self.lex:
            res["points"].append(POINT_CANON.get(chunk[:-1], chunk[:-1]))
            return res
        for q in self.QUALIFIERS:
            if chunk.startswith(q) and len(chunk) > len(q):
                rest = chunk[len(q):]
                sub = self.segment(rest)
                if all(k != "unk" for k, _ in sub) and any(k == "pt" for k, _ in sub):
                    chunk = rest
                    break
        seg = self.segment(chunk)
        has_unknown = any(k == "unk" for k, _ in seg)
        if has_unknown and len(seg) == 2 and seg[0][0] == "unk" and seg[1][0] == "pt" \
                and re.search(r"(?:部|侧|处|周围|相应|节段|局部|患处)$", seg[0][1]):
            # "肩部阿是穴" / "相应夹脊穴" / "疱疹患处阿是穴": region qualifier + point
            res["points"].append(POINT_CANON.get(seg[1][1], seg[1][1]))
            res["others"].append(seg[0][1])
            return res
        if has_unknown and (self.SITE_WORDS.search(chunk) and len(chunk) >= 4):
            res["others"].append(chunk)
            return res
        n_pts = sum(1 for k, _ in seg if k == "pt")
        if n_pts > 1:
            self.concatenated["".join(w for _, w in seg)] += 1
            if not has_unknown and self.count_full_covers(chunk) > 1:
                self.ambiguous[chunk] = [w for k, w in seg if k == "pt"]
        prev_pt = None
        for idx, (kind, w) in enumerate(seg):
            if kind == "pt":
                w = POINT_CANON.get(w, w)
                res["points"].append(w)
                prev_pt = w
            elif kind == "conn":
                nxt = seg[idx + 1][1] if idx + 1 < len(seg) and seg[idx + 1][0] == "pt" else None
                if prev_pt and nxt:
                    res["through"].append(prev_pt + w + nxt)
            else:
                if w in ("穴", "穴位", "等", "等穴", "及其", "其"):
                    if w == "其":
                        res["fragments"].append(w)
                    continue
                if len(w) >= 2:
                    res["others"].append(w)
                else:
                    res["fragments"].append(w)
        return res

    def parse(self, text, system="body"):
        """Parse a textbook point list. system: body | ear | scalp | other."""
        out = {"points": [], "others": [], "fragments": [], "through": [], "alternatives": []}
        if not text:
            return out
        s = re.sub(r"[①②③④⑤⑥⑦⑧⑨⑩]", "、", text)
        if system == "body":
            for alt in re.findall(r"[（(]或([^）)]+)[）)]", s):  # "阳池（或太渊）"
                out["alternatives"].extend(self.resolve_chunk(alt)["points"])
            s = re.sub(r"[（(][^）)]*[）)]", "", s)
            s = re.sub(r"([颈胸腰])、([颈胸腰])夹脊", r"\1夹脊、\2夹脊", s)
            s = re.sub(r"内外(膝眼|踝尖)", r"内\1、外\1", s)
        else:
            # "相应病变脏腑（肺、脾、肝、肾）" -> list items; "胰（胆）" stays one ear point "胰胆"
            s = re.sub(r"[（(]([^）)]*[、，][^）)]*)[）)]", r"、\1", s)
            s = s.replace("（", "").replace("）", "").replace("(", "").replace(")", "")
        s = re.sub(r"^(?:取穴|选穴|选取|选用|可取|取|选)", "", s.strip())
        s = re.sub(r"(?:等穴位|等穴|等腧穴|等部位|等)[。．]?$", "", s)
        for chunk in split_list(s):
            if system != "body":
                c = re.sub(r"^(?:取穴|选穴|选取|选用|取|选)", "", chunk)
                c = re.sub(r"(?:等穴位|等穴|等)$", "", c)
                if len(c) >= 2 and c.endswith("穴"):
                    c = c[:-1]  # 耳穴 names carry no 穴 suffix: "肾穴" -> "肾"
                if c:
                    out["points"].append(c)
                continue
            r = self.resolve_chunk(chunk)
            for k in r:
                out[k].extend(r[k])
        for k in out:
            out[k] = uniq(out[k])
        for f in out["fragments"]:
            self.unresolved[f] += 1
        for o in out["others"]:
            self.others[o] += 1
        return out


# --------------------------------------------------------------------------------------
# Acupuncture (针灸治疗学 + 针灸学)
# --------------------------------------------------------------------------------------

SECTION_HEAD_RE = re.compile(r"^第[" + CN_NUM + r"]+\s*节\s*(.+)$")
CHAPTER_HEAD_RE = re.compile(r"^第[" + CN_NUM + r"]+\s*章\s*(.+)$")
APPENDIX_HEAD_RE = re.compile(r"^[［\[]附[］\]]\s*(.+)$")
TAG_RE = re.compile(r"^【([^】]{1,10})】\s*(.*)$")

BASIC_KEYS = ["治法", "主穴", "处方", "取穴", "配穴", "方义", "操作"]
BASIC_KEY_RE = re.compile(r"^(治法|主穴|处方|取穴|配穴|方义|操作)[\s:：]*(.*)$")

METHOD_NAMES = sorted([
    "穴位激光照射法", "穴位敷贴法", "穴位贴敷法", "穴位注射法", "穴位埋线法", "穴位割治法", "穴位熨敷",
    "穴位按压", "穴位贴敷", "穴位注射", "穴位埋线", "穴位敷贴", "刺络拔罐法", "刺络拔罐", "针刀疗法",
    "隔姜灸法", "隔蒜灸法", "灯火灸法", "灯火灸", "热敏灸", "温针灸", "三棱针法", "三棱针", "皮肤针法",
    "皮肤针", "皮内针法", "皮内针", "激光针", "腕踝针", "耳针法", "耳针", "头针法", "头针", "电针法",
    "电针", "火针法", "火针", "芒针", "艾灸法", "艾灸", "灸法", "拔罐法", "拔罐", "刮痧法", "刮痧",
    "捏脊法", "捏脊", "割治法", "割治", "指针", "指压", "针刀", "皮肤",
], key=len, reverse=True)
METHOD_CANON = {
    "耳针法": "耳针", "头针法": "头针", "三棱针法": "三棱针", "皮肤针法": "皮肤针", "皮肤": "皮肤针",
    "皮内针法": "皮内针", "电针法": "电针", "火针法": "火针", "拔罐法": "拔罐", "刺络拔罐法": "刺络拔罐",
    "穴位注射法": "穴位注射", "穴位贴敷法": "穴位贴敷", "穴位敷贴法": "穴位贴敷", "穴位敷贴": "穴位贴敷",
    "穴位埋线法": "穴位埋线", "穴位割治法": "穴位割治", "刮痧法": "刮痧", "捏脊法": "捏脊", "割治法": "割治",
    "艾灸法": "艾灸", "隔姜灸法": "隔姜灸", "隔蒜灸法": "隔蒜灸", "灯火灸法": "灯火灸", "针刀疗法": "针刀",
    "穴位激光照射法": "穴位激光照射",
}
METHOD_SYSTEM = {"耳针": "ear", "头针": "scalp", "腕踝针": "other"}


def parse_aliases(text):
    aliases = []
    for m in re.finditer(r"(?:又称|亦称|俗称|又名|古称|简称|也称|统称)((?:“[^”]{1,15}”[、，]?)+)", text):
        aliases.extend(re.findall(r"“([^”]{1,15})”", m.group(1)))
    return uniq(aliases)


def parse_tcm_terms(text):
    terms = []
    for m in re.finditer(r"(?:属于?|归属)中医学?((?:“[^”]{1,15}”[、，]?)+)(?:等)?范畴", text):
        terms.extend(re.findall(r"“([^”]{1,15})”", m.group(1)))
    for m in re.finditer(r"归属中医学?([^“”。]{2,30}?)等?范畴", text):
        terms.extend([t for t in re.split(r"[、，]", m.group(1)) if 1 < len(t) <= 8])
    return uniq(terms)


def parse_western_scope(intro_lines):
    for ln, text in intro_lines:
        if "西医学" not in text and "现代医学" not in text:
            continue
        for sent in re.split(r"(?<=。)", text):
            if "西医学" not in sent and "现代医学" not in sent:
                continue
            sent = sent.strip()
            pats = [
                r"西医学中的(.+?)属本病范畴",
                r"西医学中[，,]?.*?(?:多见于|常见于|见于)(.+?)(?:等疾病中|等疾病|等病中|中)?。",
                r"(?:多见于|常见于|见于)西医学的?(.+?)(?:等疾病中|等疾病|等病|中)?。",
                r"现代医学(?:之|中的|中)(.+?)(?:等|属|参照)",
                r"现代医学[^，。]*?[，,]\s*如(.+?)等",
            ]
            for p in pats:
                m = re.search(p, sent)
                if m:
                    scope = m.group(1).strip("，, ")
                    scope = re.sub(r"等$", "", scope)
                    return scope, sent, ln
            return None, sent, ln
    return None, None, None


SYN_COLON_RE = re.compile(r"^([" + CJK + r"→、]{2,14})[：:]\s*(.+)$")
WEI_LABEL_RE = re.compile(
    r"^(?P<desc>.+?)[，,]?\s*(?:者)?(?:多|即|则)?(?:为|属于|属)(?P<label>[" + CJK + r"]{2,10})$")
LABEL_STOP = {"主", "宜", "佳", "度", "主症", "常见", "多见", "本病", "实", "虚", "明显", "最常见", "危急之候"}
LABEL_STOP_PREFIX = ("主", "何", "最", "辨", "本")


def parse_syndromes(sec_lines):
    """sec_lines: [(line_no, text)] of 辨证要点/辨证/临床表现 -> (syndromes, mainSymptoms)."""
    syndromes = []
    main_symptoms = []
    group = None
    for ln, t in sec_lines:
        t = clean(t)
        if not t:
            continue
        g = re.match(r"^\d+[\.．]\s*([" + CJK + r"]{2,12})(?:[\s\u3000]+(.*))?$", t)
        if g:
            group = g.group(1)
            if not g.group(2):
                continue
            t = g.group(2)
        paragraph = None
        pm = re.match(r"^[(（]\s*\d+\s*[)）]\s*([" + CJK + r"]{2,8})[\s\u3000]+(.+)$", t)
        if pm and pm.group(1).startswith("辨"):
            group = pm.group(1)
            paragraph = pm.group(2)
        elif pm:
            ks = clean(pm.group(2))
            cut = re.search(r"[，,]?\s*(?:者)?为" + re.escape(pm.group(1)) + r"[。；;]", ks)
            if cut:
                ks = ks[:cut.start()]
            syndromes.append({"label": pm.group(1), "keySymptoms": ks,
                              "group": group, "line": ln, "form": "numbered_label"})
            paragraph = pm.group(2)
        elif t.startswith("主症"):
            body = clean(t[2:])
            main_symptoms.append({"group": group, "text": body, "line": ln})
            paragraph = body
        else:
            m = SYN_COLON_RE.match(t)
            if m and not m.group(1).startswith("主症"):
                label = m.group(1).replace("→", "、")
                syndromes.append({"label": label, "keySymptoms": clean(m.group(2)),
                                  "group": group, "line": ln, "form": "label_colon"})
                continue
            paragraph = t
        for seg in re.split(r"[；;。]", paragraph):
            seg = seg.strip()
            if not seg:
                continue
            m = WEI_LABEL_RE.match(seg)
            if not m:
                continue
            label = m.group("label")
            if "之" in label:  # "阳明火盛之胃火牙痛" -> "胃火牙痛"
                label = label.split("之")[-1]
            if len(label) > 8 or len(label) < 2:
                continue
            desc = re.sub(r"^兼见", "", m.group("desc")).strip("，, ")
            if label in LABEL_STOP or label.startswith(LABEL_STOP_PREFIX) or len(desc) < 4:
                continue
            syndromes.append({"label": label, "keySymptoms": desc, "group": group,
                              "line": ln, "form": "wei_label"})
    dedup, seen = [], set()
    for s in syndromes:
        if s["label"] in seen:
            continue
        seen.add(s["label"])
        dedup.append(s)
    syndromes = dedup
    for s in syndromes:
        if s["group"] is None:
            del s["group"]
    for s in main_symptoms:
        if s["group"] is None:
            del s["group"]
    return syndromes, main_symptoms


def label_match(cond, labels):
    c = nospace(cond)
    for lab in labels:
        l = nospace(lab)
        if c == l:
            return True
        short, long_ = (c, l) if len(c) <= len(l) else (l, c)
        if len(short) >= 3:
            inter = len(set(short) & set(long_))
            if inter / len(short) >= 0.75 and (short in long_ or inter == len(set(short))):
                return True
    return False


# Closed vocabulary of 证候 building blocks.  A 配穴 condition made only of these
# tokens (e.g. 气滞血瘀, 肝肾阴虚, 湿热下注) is a pattern, not a symptom.
PATTERN_TOKEN_RE = re.compile(
    r"^(?:心|肝|脾|肺|肾|胃|胆|胞宫|冲任|肠|大肠|小肠|膀胱|三焦|中焦|下焦|上焦|中|营|卫|气|血|阴|阳|精|津|"
    r"痰|湿|热|寒|火|风|燥|暑|毒|瘀|食|虚|实|滞|郁|亏|虚弱|不足|两虚|不固|下陷|下注|上亢|亢盛|亢|伤|"
    r"结聚|壅盛|内停|内阻|内生|内扰|阻|阻滞|夹|惊恐|失养|凝|化火|犯|乘|蕴|动|生风|不交|失调|不调|虚寒|衰|"
    r"亏虚|亏损|俱虚|凝滞|郁结|气滞|血瘀)+$")
PATTERN_TYPE_NAMES = {"冷秘", "热秘", "气秘", "虚秘", "实秘", "疳气", "疳积", "干疳", "行痹", "痛痹", "着痹",
                      "热痹", "阳水", "阴水", "阳黄", "阴黄"}


def is_pattern_condition(cond):
    parts = [p for p in re.split(r"[、，,]", nospace(cond)) if p]
    return bool(parts) and all(p in PATTERN_TYPE_NAMES or PATTERN_TOKEN_RE.match(p) for p in parts)


def parse_add_points(text, labels, pp, variant=None):
    """配穴 text -> (syndromeAddPoints, symptomAddPoints, notes)."""
    syn, sym, notes = [], [], []
    sents = [s for s in re.split(r"。", text) if s.strip()]
    parsed = []  # (sentence_idx, cond, pts, raw, group)
    clause_group = None
    for si, sent in enumerate(sents):
        for clause in re.split(r"[；;]", sent):
            clause = clause.strip()
            if not clause:
                continue
            gm = re.match(r"^([" + CJK + r"]{2,8})[：:]\s*(.+)$", clause)
            if gm:
                clause_group = gm.group(1)
                clause = gm.group(2)
            pieces = re.split(r"[，,]", clause)
            prefix = ""
            for pc in pieces:
                pc = pc.strip()
                if not pc:
                    continue
                if "配" not in pc:
                    if prefix:
                        prefix += "，" + pc
                    else:
                        prefix = pc
                    continue
                cond, pts = pc.split("配", 1)
                cond = cond.strip()
                if prefix:
                    cond = prefix + "，" + cond if cond else prefix
                cond = re.sub(r"(?:者|时)$", "", cond)
                parsed.append((si, cond, pts, pc, clause_group))
            if prefix and "配" not in clause:
                notes.append(prefix)
    first_sentence_has_label = any(
        si == 0 and label_match(cond, labels) for si, cond, _, _, _ in parsed) if labels else False
    for si, cond, pts, raw, cgroup in parsed:
        r = pp.parse(pts, "body")
        if label_match(cond, labels):
            basis = "label_match"
        elif si == 0 and first_sentence_has_label:
            basis = "same_sentence_as_labels"
        elif re.search(r"(?:证|型)$", cond):
            basis = "suffix_证型"
        elif is_pattern_condition(cond):
            basis = "pattern_vocabulary"
        else:
            basis = None
        item = OrderedDict()
        if basis:
            item["syndrome"] = cond
        else:
            item["symptom"] = cond
        item["points"] = r["points"]
        if r["others"]:
            item["otherItems"] = r["others"]
        if r["through"]:
            item["throughNeedling"] = r["through"]
        if cgroup:
            item["group"] = cgroup
        if variant:
            item["variant"] = variant
        if basis:
            item["classifiedBy"] = basis
            syn.append(item)
        else:
            sym.append(item)
    return syn, sym, notes


def parse_point_groups(lines_text, pp):
    """主穴 content (possibly multi-line with '标签：' groups)."""
    groups = []
    for ln, t in lines_text:
        t = clean(t)
        if not t:
            continue
        m = re.match(r"^([" + CJK + r" ]{1,14}?)[：:]\s*(.*)$", t)
        if m:
            groups.append({"label": nospace(m.group(1)), "text": m.group(2), "line": ln})
        elif groups and groups[-1].get("label") and not groups[-1]["text"]:
            groups[-1]["text"] = t
        else:
            groups.append({"label": None, "text": t, "line": ln})
    out_groups = []
    all_pts, all_other, frags, through = [], [], [], []
    for g in groups:
        r = pp.parse(g["text"], "body")
        if r["alternatives"]:
            all_other.extend("或" + a for a in r["alternatives"])
        all_pts += r["points"]
        all_other += r["others"]
        frags += r["fragments"]
        through += r["through"]
        og = OrderedDict()
        if g["label"]:
            og["label"] = g["label"]
        og["points"] = r["points"]
        if r["others"]:
            og["otherItems"] = r["others"]
        og["raw"] = g["text"]
        og["line"] = g["line"]
        out_groups.append(og)
    return uniq(all_pts), uniq(all_other), uniq(frags), uniq(through), out_groups


def parse_other_treatment(text, ln_first, ln_last, pp):
    m = re.match(r"^[(（]\s*\d+\s*[)）]\s*(.*)$", text)
    rest = m.group(1) if m else text
    method_raw = None
    for name in METHOD_NAMES:
        if rest.startswith(name):
            method_raw = name
            break
    if method_raw is None:
        mm = re.match(r"^([" + CJK + r"]{1,8})[\s\u3000]", rest)
        method_raw = mm.group(1) if mm else rest[:4]
    content = clean(rest[len(method_raw):])
    method = METHOD_CANON.get(method_raw, method_raw)
    system = METHOD_SYSTEM.get(method, "body")
    first_sent = re.split(r"[。]", content, 1)[0]
    clauses = re.split(r"[，,]", first_sent)
    first_clause = clauses[0]
    if system != "body":
        for c in clauses[1:]:
            if re.search(r"\d|刺|针|留|次|每|用|法|分钟|选|取|压|埋|贴|适|可", c):
                break
            first_clause += "、" + c
    pt_text = first_clause if re.match(r"^(?:取|选)", first_clause) or system != "body" else first_clause
    r = pp.parse(pt_text, system)
    points_from = "first_clause"
    if system == "body" and not r["points"]:
        # e.g. "麝香粉0.5g，放入神阙穴内…敷于双侧涌泉穴": take explicit "<穴名>穴" mentions
        scanned = []
        for m in re.finditer(r"穴", content):
            for L in (4, 3, 2):
                w = content[max(0, m.start() - L):m.start()]
                if len(w) == L and w in pp.lex:
                    scanned.append(w)
                    break
        scanned = uniq(scanned)
        if scanned:
            r = dict(r)
            r["points"] = scanned
            points_from = "xue_suffix_scan"
    indication = []
    for s in sentences(content):
        if re.search(r"适用于|适宜于|多用于|用于|适合", s):
            indication.append(s.strip())
    item = OrderedDict()
    item["method"] = method
    if method_raw != method:
        item["methodRaw"] = method_raw
    item["pointSystem"] = system
    item["content"] = content
    item["points"] = r["points"]
    if points_from != "first_clause":
        item["pointsFrom"] = points_from
    if r["others"]:
        item["sites"] = r["others"]
    item["indication"] = "".join(indication)
    item["lines"] = [ln_first, ln_last]
    return item, r["fragments"]


def split_numbered_items(sec_lines):
    """[(ln, text)] -> [(first_ln, last_ln, text)] merging unnumbered continuation lines."""
    items = []
    expanded = []
    for ln, t in sec_lines:
        for piece in re.split(r"\s+(?=\d+[\.．][" + CJK + r"])", clean(t)):
            expanded.append((ln, piece))
    for ln, t in expanded:
        t = clean(t)
        if not t:
            continue
        if re.match(r"^(?:\d+[\.．、]|[(（]\d+[)）]|[①②③④⑤⑥⑦⑧⑨])", t) or not items:
            items.append([ln, ln, t])
        else:
            items[-1][1] = ln
            items[-1][2] += t
    out = []
    for a, b, t in items:
        t = re.sub(r"^(?:\d+[\.．、]\s*|[①②③④⑤⑥⑦⑧⑨]\s*)", "", t)
        out.append((a, b, t))
    return out


class AcuChapter:
    def __init__(self, book, name, head_ln, category, parent=None):
        self.book = book
        self.name = name
        self.head_ln = head_ln
        self.category = category
        self.parent = parent
        self.umbrella = False
        self.body = []  # [(ln, text)]


def find_acu_chapters(lines, lo, hi, book):
    """Return AcuChapter list for chapters that contain a 【治疗】 section."""
    heads = []
    category = None
    last_main = None
    for i in range(lo, hi):
        t = clean(lines[i])
        if not t:
            continue
        mc = CHAPTER_HEAD_RE.match(t)
        ms = SECTION_HEAD_RE.match(t)
        ma = APPENDIX_HEAD_RE.match(t)
        if mc:
            heads.append((i, "chapter", nospace(mc.group(1))))
            category = nospace(mc.group(1))
            continue
        if ma:
            heads.append((i, "appendix", nospace(ma.group(1))))
            continue
        if ms:
            nm = nospace(ms.group(1))
            if book == "zhenjiu_xue" and re.search(r"病证$|急症$|其他病证$", nm):
                heads.append((i, "category", nm))
            else:
                heads.append((i, "section", nm))
            continue
        if book == "zhenjiu_xue":
            k = nospace(t)
            if 2 <= len(k) <= 16 and not re.search(r"[，。：；【】（）()\d《》“”·]", k):
                # next non-empty line starts with the same name
                j = i + 1
                while j < hi and not lines[j].strip():
                    j += 1
                nxt = nospace(lines[j]) if j < hi else ""
                if (nxt.startswith(k[:2]) and len(nxt) > len(k) + 4) or re.match(r"^[（(]一[）)]", nxt):
                    heads.append((i, "bare", k))
    chapters = []
    category = None
    for idx, (i, kind, nm) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else hi
        if kind in ("chapter", "category"):
            category = nm
            continue
        body = [(j + 1, lines[j]) for j in range(i + 1, end)]
        if not (any(clean(t).startswith("【治疗") for _, t in body)
                and any(re.match(r"^(?:治法|主穴|处方)", clean(t)) for _, t in body)):
            # TOC entries list the 【…】 tags without any content
            if kind != "appendix":
                last_main = None if kind == "section" and not body else last_main
            continue
        parent = last_main if kind == "appendix" else None
        n_treat = sum(1 for _, t in body if clean(t).startswith("【治疗"))
        subs = [k for k, (ln, t) in enumerate(body)
                if re.match(r"^(?:[" + CN_NUM + r"]+、|[（(][" + CN_NUM + r"]+[）)])\s*[" + CJK + r"、]{2,16}$",
                            clean(t))]
        if n_treat >= 2 and subs:
            # umbrella chapter (内脏绞痛 / 出血证 / 戒断综合征 / 美容 …): one entry per sub-disease
            for si, k in enumerate(subs):
                k_end = subs[si + 1] if si + 1 < len(subs) else len(body)
                sub_body = body[k + 1:k_end]
                if not any(clean(t).startswith("【治疗") for _, t in sub_body):
                    continue
                sub_name = re.sub(r"^(?:[" + CN_NUM + r"]+、|[（(][" + CN_NUM + r"]+[）)])\s*", "",
                                  clean(body[k][1]))
                sc = AcuChapter(book, nospace(sub_name), body[k][0], category, nm)
                sc.body = sub_body
                sc.umbrella = True
                chapters.append(sc)
        else:
            ch = AcuChapter(book, nm, i + 1, category, parent)
            ch.body = body
            chapters.append(ch)
        if kind != "appendix":
            last_main = nm
    return chapters


def extract_acu_chapter(ch, pp, warnings):
    body = ch.body
    # split into tagged sections
    sections = OrderedDict()
    cur = "_intro"
    sections[cur] = []
    for ln, raw in body:
        t = clean(raw)
        m = TAG_RE.match(t)
        if m:
            cur = m.group(1)
            if cur in sections:
                cur = cur + "#%d" % ln
            sections[cur] = []
            if m.group(2):
                sections[cur].append((ln, m.group(2)))
            continue
        sections[cur].append((ln, t))

    def sec(*names):
        for k, v in sections.items():
            base = k.split("#")[0]
            if base in names:
                return v
        return []

    intro = [(ln, t) for ln, t in sections["_intro"] if t]
    intro_text = "".join(t for _, t in intro)
    aliases = parse_aliases(intro_text)
    tcm_terms = parse_tcm_terms(intro_text)
    scope, scope_raw, scope_ln = parse_western_scope(intro)

    syn_lines = sec("辨证要点", "辨证", "临床表现")
    syndromes, main_symptoms = parse_syndromes(syn_lines)
    labels = [s["label"] for s in syndromes]

    treat = sec("治疗", "治疗方法")
    basic, other = [], []
    mode = "basic"
    for ln, t in treat:
        if not t:
            continue
        if re.match(r"^(?:1[\.．]\s*)?基本治疗", t):
            mode = "basic"
            continue
        if re.match(r"^2[\.．]\s*其他治疗", t):
            mode = "other"
            continue
        if re.match(r"^3[\.．]", t) and mode == "other":
            mode = "tail"
        (basic if mode == "basic" else other if mode == "other" else []).append((ln, t))

    # variants inside 基本治疗
    variants = []
    cur_v = {"label": None, "line": None, "keys": OrderedDict()}
    cur_key = None
    for ln, t in basic:
        vm = re.match(r"^[(（]\s*\d+\s*[)）]\s*([^。；]{2,24})$", t)
        if vm:
            if cur_v["keys"]:
                variants.append(cur_v)
            cur_v = {"label": vm.group(1), "line": ln, "keys": OrderedDict()}
            cur_key = None
            continue
        km = BASIC_KEY_RE.match(t)
        if km and (km.group(1) != "操作" or True):
            key = km.group(1)
            if key in ("处方", "取穴"):
                key = "主穴"
            cur_key = key
            cur_v["keys"].setdefault(key, []).append((ln, km.group(2)))
            continue
        if cur_key:
            cur_v["keys"][cur_key].append((ln, t))
        else:
            cur_v["keys"].setdefault("_pre", []).append((ln, t))
    if cur_v["keys"]:
        variants.append(cur_v)

    for v in variants:
        if v["keys"].get("_pre"):
            warnings.append({"where": "basicTreatment", "issue": "unkeyed lines before 治法/主穴",
                             "disease": ch.name, "lines": [ln for ln, _ in v["keys"]["_pre"]],
                             "text": join_text(t for _, t in v["keys"]["_pre"])[:120]})
    out_variants = []
    all_main, all_other_main, syn_add, sym_add = [], [], [], []
    therapy_parts, op_parts, rat_parts = [], [], []
    for v in variants:
        k = v["keys"]
        ov = OrderedDict()
        if v["label"]:
            ov["label"] = v["label"]
            ov["line"] = v["line"]
        therapy = join_text(t for _, t in k.get("治法", []))
        ov["therapy"] = therapy
        mp, mo, mf, mt, groups = parse_point_groups(k.get("主穴", []), pp)
        if mf:
            warnings.append({"where": "mainPoints", "variant": v["label"], "fragments": mf,
                             "line": k["主穴"][0][0] if k.get("主穴") else None})
        ov["mainPoints"] = mp
        if mo:
            ov["mainPointsOther"] = mo
        if mt:
            ov["throughNeedling"] = mt
        if len(groups) > 1 or (groups and groups[0].get("label")):
            ov["mainPointGroups"] = groups
        ov["mainPointsRaw"] = join_text(t for _, t in k.get("主穴", []))
        add_text = join_text(t for _, t in k.get("配穴", []))
        s1, s2, notes = parse_add_points(add_text, labels, pp, v["label"])
        ov["syndromeAddPoints"] = s1
        ov["symptomAddPoints"] = s2
        if notes:
            ov["addPointNotes"] = notes
        ov["addPointsRaw"] = add_text
        ov["rationale"] = join_text(t for _, t in k.get("方义", []))
        ov["operation"] = join_text(t for _, t in k.get("操作", []))
        lns = [ln for vals in k.values() for ln, _ in vals]
        ov["lines"] = [min(lns), max(lns)] if lns else None
        out_variants.append(ov)
        all_main += mp
        all_other_main += mo
        syn_add += s1
        sym_add += s2
        lab = (v["label"] + "：") if (v["label"] and len(variants) > 1) else ""
        if therapy:
            therapy_parts.append(lab + therapy)
        if ov["operation"]:
            op_parts.append(lab + ov["operation"])
        if ov["rationale"]:
            rat_parts.append(lab + ov["rationale"])

    others_out = []
    for a, b, t in split_numbered_items([(ln, t) for ln, t in other]):
        # split_numbered_items strips "1." but keeps "(1)"; items come as "(n)..."
        item, frags = parse_other_treatment(t, a, b, pp)
        if frags:
            warnings.append({"where": "otherTreatments", "method": item["method"], "fragments": frags, "line": a})
        others_out.append(item)

    cautions = []
    for a, b, t in split_numbered_items(sec("按语")):
        cautions.append({"text": t, "lines": [a, b]})

    all_lns = [ln for ln, _ in body if clean(_)]
    entry = OrderedDict()
    entry["disease"] = ch.name
    if ch.parent:
        entry["parentDisease"] = ch.parent
        entry["parentKind"] = "umbrella_chapter" if ch.umbrella else "appendix"
    entry["category"] = ch.category
    entry["aliases"] = aliases
    if tcm_terms:
        entry["tcmCategoryTerms"] = tcm_terms
    entry["westernScope"] = scope or ""
    if scope_raw:
        entry["westernScopeSentence"] = scope_raw
        entry["westernScopeLine"] = scope_ln
    entry["line"] = ch.head_ln
    entry["definition"] = intro[0][1] if intro else ""
    entry["mainSymptoms"] = main_symptoms
    entry["syndromes"] = syndromes
    entry["therapy"] = " | ".join(therapy_parts)
    entry["mainPoints"] = uniq(all_main)
    if all_other_main:
        entry["mainPointsOther"] = uniq(all_other_main)
    entry["syndromeAddPoints"] = syn_add
    entry["symptomAddPoints"] = sym_add
    entry["rationale"] = " | ".join(rat_parts)
    entry["operation"] = " | ".join(op_parts)
    if len(out_variants) > 1 or (out_variants and out_variants[0].get("label")):
        entry["basicTreatmentVariants"] = out_variants
    else:
        v0 = out_variants[0] if out_variants else {}
        entry["mainPointsRaw"] = v0.get("mainPointsRaw", "")
        entry["addPointsRaw"] = v0.get("addPointsRaw", "")
        if v0.get("mainPointGroups"):
            entry["mainPointGroups"] = v0["mainPointGroups"]
        if v0.get("throughNeedling"):
            entry["throughNeedling"] = v0["throughNeedling"]
        if v0.get("addPointNotes"):
            entry["addPointNotes"] = v0["addPointNotes"]
    entry["otherTreatments"] = others_out
    entry["cautions"] = cautions
    entry["sourceBook"] = ch.book
    entry["lines"] = [ch.head_ln, max(all_lns) if all_lns else ch.head_ln]
    if not out_variants or not entry["mainPoints"]:
        warnings.append({"where": "chapter", "issue": "no main points parsed", "line": ch.head_ln})
    return entry


# --------------------------------------------------------------------------------------
# Tuina (推拿学)
# --------------------------------------------------------------------------------------

TUINA_KEYS = OrderedDict([
    ("治疗原则", "principle"), ("治则", "principle"), ("基本治法", "principle"),
    ("推拿治疗指征", "tuinaIndication"),
    ("部位及取穴", "sitesAndPoints"), ("取穴及部位", "sitesAndPoints"), ("部位及穴位", "sitesAndPoints"),
    ("手法", "manipulations"),
    ("基本操作", "operation"), ("处方与操作", "operation"), ("基本处方", "operation"), ("操作", "operation"),
    ("辨证加减", "syndromeModifications"), ("随症加减", "syndromeModifications"),
    ("处方", "prescription"), ("方义", "rationale"),
])
TUINA_KEY_ALT = "|".join(sorted(TUINA_KEYS, key=len, reverse=True))
TUINA_NUM_KEY_RE = re.compile(r"^\d+[\.．]\s*(" + TUINA_KEY_ALT + r")[\s:：]*(.*)$")
TUINA_COLON_KEY_RE = re.compile(r"^(" + TUINA_KEY_ALT + r")[：:]\s*(.*)$")
TUINA_NUM_LABEL_RE = re.compile(r"^\d+[\.．]\s*([" + CJK + r"]{2,8})(?:[\s\u3000]+(.*))?$")
SUB_ITEM_RE = re.compile(r"^[(（]\s*\d+\s*[)）]\s*(.*)$")
DRUG_RE = re.compile(r"中药|方用|加减|膏药|注射液|开塞露|药物|内服|外敷|外用|研末|粉适量|服用|汤$|丸$")


def normalize_manipulation(tok):
    note = None
    if "〓" in tok:
        tok = tok.replace("〓", "㨰")
        note = "〓→㨰 (OCR 缺字; 推拿学 “二、法” 条即 㨰法)"
    tok = tok.strip("。．")
    tok = re.sub(r"(?:等手法|等法|手法|等)$", "", tok)
    if not tok:
        return None, note
    if not tok.endswith("法"):
        tok = tok + "法"
    return tok, note


def extract_tuina(lines, lo, hi, pp, warnings):
    # locate 第九章 推拿治疗各论 blocks (the dump carries two copies)
    blocks = []
    i = lo
    while i < hi:
        t = clean(lines[i])
        if re.match(r"^第九章\s*推拿治疗各论", t):
            j = i + 1
            while j < hi and not re.match(r"^第[" + CN_NUM + r"]+章", clean(lines[j])):
                j += 1
            blocks.append((i, j))
            i = j
            continue
        i += 1
    entries = []
    seen = {}
    for bi, (b0, b1) in enumerate(blocks):
        heads = []
        category = None
        for k in range(b0 + 1, b1):
            t = clean(lines[k])
            ms = SECTION_HEAD_RE.match(t)
            if ms:
                heads.append((k, "category", nospace(ms.group(1))))
                continue
            md = re.match(r"^([" + CN_NUM + r"]+)、\s*([" + CJK + r"0-9]{2,16})$", t)
            if md:
                heads.append((k, "disease", nospace(md.group(2))))
                continue
            ma = re.match(r"^附[：:]\s*([" + CJK + r"]{2,12})$", t)
            if ma:
                heads.append((k, "appendix", nospace(ma.group(1))))
        last_main = None
        for idx, (k, kind, nm) in enumerate(heads):
            end = heads[idx + 1][0] if idx + 1 < len(heads) else b1
            if kind == "category":
                category = nm
                continue
            body = [(j + 1, clean(lines[j])) for j in range(k + 1, end)]
            parent = last_main if kind == "appendix" else None
            if kind == "disease":
                last_main = nm
            e = extract_tuina_chapter(nm, k + 1, category, parent, body, pp, warnings)
            if e is None:
                continue
            key = (category, nm, parent)
            if key in seen:
                first = seen[key]
                same = first["_sig"] == e["_sig"]
                first.setdefault("duplicateCopies", []).append({"lines": e["lines"], "identicalText": same})
                continue
            seen[key] = e
            entries.append(e)
    for e in entries:
        del e["_sig"]
    return entries, blocks


def extract_tuina_chapter(name, head_ln, category, parent, body, pp, warnings):
    sections = OrderedDict()
    cur = "_intro"
    sections[cur] = []
    for ln, t in body:
        # tags may appear mid-line: "…协助诊断。【推拿治疗】"
        parts = re.split(r"(【[^】]{1,10}】)", t)
        for p in parts:
            if not p:
                continue
            m = re.match(r"^【([^】]{1,10})】$", p)
            if m:
                cur = m.group(1)
                if cur in sections:
                    cur = cur + "#%d" % ln
                sections[cur] = []
            else:
                sections[cur].append((ln, p.strip()))

    def sec(*names):
        out = []
        for k, v in sections.items():
            if k.split("#")[0] in names:
                out += v
        return out

    treat = sec("推拿治疗", "治疗")
    if not treat:
        return None
    intro = [(ln, t) for ln, t in sections["_intro"] if t]
    fields = OrderedDict()
    fields_lines = {}
    syn_blocks = []
    cur_block = None
    cur_field = None
    for ln, t in treat:
        if not t:
            continue
        m = TUINA_NUM_KEY_RE.match(t)
        if m and not cur_block:
            cur_field = TUINA_KEYS[m.group(1)]
            fields.setdefault(cur_field, [])
            fields_lines.setdefault(cur_field, []).append(ln)
            if m.group(2):
                fields[cur_field].append((ln, m.group(2)))
            continue
        m = TUINA_COLON_KEY_RE.match(t)
        if m and cur_block is not None:
            f = TUINA_KEYS[m.group(1)]
            cur_block["fields"].setdefault(f, []).append((ln, m.group(2)))
            cur_block["last"] = f
            cur_block["lines"][1] = ln
            continue
        if m and cur_block is None:
            cur_field = TUINA_KEYS[m.group(1)]
            fields.setdefault(cur_field, []).append((ln, m.group(2)))
            fields_lines.setdefault(cur_field, []).append(ln)
            continue
        m2 = TUINA_NUM_LABEL_RE.match(t)
        if m2 and not TUINA_NUM_KEY_RE.match(t):
            cur_block = {"label": m2.group(1), "fields": OrderedDict(), "last": None, "lines": [ln, ln]}
            if m2.group(2):
                cur_block["fields"]["text"] = [(ln, m2.group(2))]
                cur_block["last"] = "text"
            syn_blocks.append(cur_block)
            continue
        if cur_block is not None:
            f = cur_block["last"] or "text"
            cur_block["fields"].setdefault(f, []).append((ln, t))
            cur_block["last"] = f
            cur_block["lines"][1] = ln
        elif cur_field:
            fields[cur_field].append((ln, t))
            fields_lines[cur_field].append(ln)
        else:
            fields.setdefault("_pre", []).append((ln, t))

    def ftext(f):
        return join_text(t for _, t in fields.get(f, []))

    e = OrderedDict()
    e["disease"] = name
    if parent:
        e["parentDisease"] = parent
    e["category"] = category
    e["line"] = head_ln
    e["definition"] = intro[0][1] if intro else ""
    e["aliases"] = parse_aliases("".join(t for _, t in intro))
    # syndromes from 临床表现 "N.label desc"
    syns = []
    for ln, t in sec("临床表现"):
        m = re.match(r"^\d+[\.．]\s*([" + CJK + r"]{2,10})[\s\u3000]+(.+)$", t)
        if m and not re.search(r"型颈椎病|颈椎病$", m.group(1)):
            syns.append({"label": m.group(1), "keySymptoms": m.group(2), "line": ln})
    e["syndromes"] = syns
    e["principle"] = ftext("principle")
    if fields.get("tuinaIndication"):
        e["tuinaIndication"] = ftext("tuinaIndication")
    sp_text = ftext("sitesAndPoints")
    e["sitesAndPointsText"] = sp_text
    r = pp.parse(sp_text, "body") if sp_text else {"points": [], "others": [], "fragments": []}
    e["points"] = r["points"]
    e["sites"] = r["others"]
    manip, notes = [], []
    mt = ftext("manipulations")
    for tok in re.split(r"[、，,]", mt):
        tok = tok.strip()
        if not tok:
            continue
        name_, note = normalize_manipulation(tok)
        if name_:
            manip.append(name_)
        if note:
            notes.append(note)
    e["manipulations"] = uniq(manip)
    if notes:
        e["manipulationNotes"] = uniq(notes)
    ops = []
    for a, b, t in split_numbered_items(fields.get("operation", [])):
        t2 = SUB_ITEM_RE.match(t)
        ops.append({"text": t2.group(1) if t2 else t, "lines": [a, b]})
    e["operation"] = ops
    mods = []
    for a, b, t in split_numbered_items(fields.get("syndromeModifications", [])):
        t2 = SUB_ITEM_RE.match(t)
        t = t2.group(1) if t2 else t
        mm = re.match(r"^([" + CJK + r"、]{2,14})[\s\u3000]+(.+)$", t)
        if mm:
            mods.append({"label": mm.group(1), "content": mm.group(2), "lines": [a, b]})
        else:
            mods.append({"label": "", "content": t, "lines": [a, b]})
    e["syndromeModifications"] = mods
    blocks_out = []
    for bl in syn_blocks:
        f = bl["fields"]
        ob = OrderedDict()
        ob["label"] = bl["label"]
        ob["principle"] = join_text(t for _, t in f.get("principle", []))
        pres = join_text(t for _, t in f.get("prescription", []))
        ob["prescription"] = [x for x in re.split(r"[、，,]", pres.rstrip("。")) if x.strip()]
        ob["rationale"] = join_text(t for _, t in f.get("rationale", []))
        extra = join_text(t for k, v in f.items() if k not in ("principle", "prescription", "rationale") for _, t in v)
        if extra:
            ob["text"] = extra
        ob["lines"] = bl["lines"]
        blocks_out.append(ob)
    if blocks_out:
        e["syndromeTreatments"] = blocks_out
    fx = [{"text": t, "lines": [a, b]} for a, b, t in split_numbered_items(sec("功能锻炼", "自我按摩"))]
    e["functionalExercise"] = fx
    oth = []
    for a, b, t in split_numbered_items(sec("其他治疗", "其他方法")):
        kind = "drug_or_herbal" if DRUG_RE.search(t) else "nondrug"
        oth.append({"text": t, "kind": kind, "lines": [a, b]})
    e["otherTreatments"] = oth
    e["cautions"] = [{"text": t, "lines": [a, b]} for a, b, t in split_numbered_items(sec("注意事项"))]
    prog = join_text(t for _, t in sec("预后"))
    if prog:
        e["prognosis"] = prog
    e["sourceBook"] = "tuina"
    all_lns = [ln for ln, t in body if t]
    e["lines"] = [head_ln, max(all_lns) if all_lns else head_ln]
    e["_sig"] = hashlib.sha1("\n".join(t for _, t in body).encode("utf-8")).hexdigest()
    if not e["principle"] and not blocks_out:
        warnings.append({"where": "tuina", "issue": "no 治则 parsed", "disease": name, "line": head_ln})
    return e


# --------------------------------------------------------------------------------------
# Diet therapy (中医食疗学)
# --------------------------------------------------------------------------------------

RECIPE_RE = re.compile(
    r"^\d+[\.．]\s*(?P<name>[^\s\u3000（(]+)\s*(?:[（(](?P<src>(?:《[^》]*》|[^）)《]{1,12}方)[^）)]*)[）)])?[\s\u3000]*(?P<text>.*)$")
UNNUMBERED_RECIPE_RE = re.compile(
    r"^(?P<name>[^\s\u3000（(\d]{2,12})\s*(?:[（(](?P<src>《[^》]*》[^）)]*)[）)])?\s*(?:取)?(?P<text>.*\d.*)$")
DIET_CAUTION_RE = re.compile(r"忌|禁|慎|不宜|避免|不可")


def extract_diet(lines, lo, hi, warnings):
    heads = []
    for i in range(lo, hi):
        t = clean(lines[i])
        mc = CHAPTER_HEAD_RE.match(t)
        if mc:
            heads.append((i, "chapter", nospace(mc.group(1))))
            continue
        ms = SECTION_HEAD_RE.match(t)
        if ms:
            heads.append((i, "section", nospace(ms.group(1))))
    entries = []
    seen = {}
    category = None
    for idx, (i, kind, nm) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else hi
        if kind == "chapter":
            category = nm
            continue
        body = [(j + 1, clean(lines[j])) for j in range(i + 1, end)]
        if not any(t.startswith("【证候】") for _, t in body):
            continue
        e = extract_diet_chapter(nm, i + 1, category, body, warnings)
        key = (category, nm)  # 口疮 exists in both 儿科 and 耳鼻喉科: different chapters
        if key in seen:
            seen[key].setdefault("duplicateCopies", []).append({"lines": e["lines"]})
            continue
        seen[key] = e
        entries.append(e)
    return entries


def extract_diet_chapter(name, head_ln, category, body, warnings):
    # top-level 一、…四、 sections
    parts = OrderedDict()
    cur = "_intro"
    parts[cur] = []
    for ln, t in body:
        m = re.match(r"^([" + CN_NUM + r"]+)、\s*(.+)$", t)
        if m and len(nospace(m.group(2))) <= 10:
            cur = nospace(m.group(2))
            parts[cur] = []
            continue
        parts[cur].append((ln, t))
    intro = [(ln, t) for ln, t in parts["_intro"] if t]
    principle_lines = parts.get("食疗原则", [])
    principle = join_text(t for _, t in principle_lines)
    diff = join_text(t for _, t in parts.get("辨证要点", []))
    dz = parts.get("辨证食疗", [])
    if not dz:
        # fall back: everything after first 【证候】 context
        dz = body
    syndromes = []
    group = None
    cur_s = None
    cur_tag = None
    for k, (ln, t) in enumerate(dz):
        if not t:
            continue
        nxt = ""
        for kk in range(k + 1, len(dz)):
            if dz[kk][1]:
                nxt = dz[kk][1]
                break
        if nxt.startswith("【证候】") and not t.startswith("【"):
            if not re.match(r"^[（(][" + CN_NUM + r"]+[）)]", t):
                group = None  # a bare label ("痰　厥") is its own heading, not a child of the last group
            lab = re.sub(r"^[（(][" + CN_NUM + r"]+[）)]\s*", "", t)
            cur_s = OrderedDict()
            cur_s["label"] = nospace(lab)
            if group:
                cur_s["group"] = group
            cur_s["line"] = ln
            cur_s["keySymptoms"] = ""
            cur_s["pathogenesis"] = ""
            cur_s["method"] = ""
            cur_s["ingredients"] = []
            cur_s["recipes"] = []
            cur_s["lines"] = [ln, ln]
            syndromes.append(cur_s)
            cur_tag = None
            continue
        if (not t.startswith("【") and not re.match(r"^\d", t) and len(nospace(t)) <= 8
                and re.match(r"^[（(][" + CN_NUM + r"]+[）)]", nxt)):
            group = nospace(t)
            continue
        if cur_s is None:
            continue
        cur_s["lines"][1] = ln
        m = TAG_RE.match(t)
        if m:
            cur_tag = m.group(1)
            val = m.group(2).strip()
            if cur_tag == "证候":
                cur_s["keySymptoms"] = val
            elif cur_tag == "证机概要":
                cur_s["pathogenesis"] = val
            elif cur_tag == "食疗方法":
                cur_s["method"] = val.rstrip("。")
            elif cur_tag == "推荐食材":
                if val.startswith("见"):
                    cur_s["ingredientsCrossReference"] = val.rstrip("。")
                else:
                    cur_s["ingredients"] = [x for x in split_list(re.sub(r"等[。．]?$", "", val)) if x]
            elif cur_tag == "推荐食疗方" and val:
                if val.startswith("见"):
                    cur_s["recipesCrossReference"] = val.rstrip("。")
            continue
        if cur_tag == "推荐食疗方":
            rm = RECIPE_RE.match(t)
            if rm:
                rec = OrderedDict()
                rec["name"] = rm.group("name")
                rec["classicSource"] = rm.group("src") or ""
                txt = clean(rm.group("text"))
                xr = re.match(r"^见“([^”]+)”节", txt)
                if xr:
                    rec["crossReference"] = xr.group(1)
                rec["text"] = txt
                rec["line"] = ln
                cur_s["recipes"].append(rec)
            elif cur_s["recipes"]:
                cur_s["recipes"][-1]["text"] += t
                cur_s["recipes"][-1].setdefault("continuationLines", []).append(ln)
            elif UNNUMBERED_RECIPE_RE.match(t):
                # a syndrome with a single, un-numbered recipe ("海藻酒　 海藻30g，…")
                um = UNNUMBERED_RECIPE_RE.match(t)
                rec = OrderedDict()
                rec["name"] = um.group("name")
                rec["classicSource"] = um.group("src") or ""
                rec["text"] = clean(um.group("text"))
                rec["line"] = ln
                rec["unnumbered"] = True
                cur_s["recipes"].append(rec)
            else:
                warnings.append({"where": "diet", "issue": "unparsed recipe line", "disease": name, "line": ln})
        elif cur_tag in ("证候", "证机概要", "食疗方法"):
            key = {"证候": "keySymptoms", "证机概要": "pathogenesis", "食疗方法": "method"}[cur_tag]
            cur_s[key] += t
    cautions = []
    for ln, t in principle_lines + [(ln, t) for ln, t in parts.get("辨证要点", [])]:
        for s in sentences(t):
            if DIET_CAUTION_RE.search(s):
                cautions.append({"text": s.strip(), "line": ln})
    e = OrderedDict()
    e["disease"] = name
    e["category"] = category
    e["line"] = head_ln
    e["definition"] = intro[0][1] if intro else ""
    e["aliases"] = parse_aliases("".join(t for _, t in intro))
    scope, scope_raw, scope_ln = parse_western_scope(intro)
    e["westernScope"] = scope or ""
    if scope_raw:
        e["westernScopeSentence"] = scope_raw
    e["differentiationPoints"] = diff
    e["principle"] = principle
    e["syndromes"] = syndromes
    e["cautions"] = cautions
    e["sourceBook"] = "shiliao"
    all_lns = [ln for ln, t in body if t]
    e["lines"] = [head_ln, max(all_lns) if all_lns else head_ln]
    for s in syndromes:
        if not s["recipes"] and not s.get("recipesCrossReference"):
            warnings.append({"where": "diet", "issue": "syndrome without recipes", "disease": name,
                             "syndrome": s["label"], "line": s["line"]})
    return e


# --------------------------------------------------------------------------------------
# Daoyin (中医养生学 传统运动养生 + 推拿学 推拿功法)
# --------------------------------------------------------------------------------------

def extract_daoyin_yangsheng(lines, lo, hi):
    # find 第十一章传统运动养生 body (the one followed by prose, not the TOC)
    start = None
    for i in range(lo, hi):
        if re.match(r"^第十一章\s*传统运动养生", clean(lines[i])):
            nxt = clean(lines[i + 1]) if i + 1 < hi else ""
            if len(nxt) > 30:
                start = i
                break
    if start is None:
        return [], None
    end = start + 1
    while end < hi and not re.match(r"^第十二章", clean(lines[end])):
        end += 1
    # general principles: 第二节 要领 / 第三节 原则
    sect = None
    general = OrderedDict([("要领", []), ("原则", [])])
    methods = []
    cur = None
    sub = None
    for i in range(start + 1, end):
        t = clean(lines[i])
        if not t:
            continue
        ms = SECTION_HEAD_RE.match(t)
        if ms:
            sect = nospace(ms.group(1))
            cur = None
            continue
        if sect and "常见功法" in sect:
            mm = re.match(r"^([" + CN_NUM + r"]+)、\s*([" + CJK + r"]{2,8})$", t)
            if mm:
                cur = OrderedDict()
                cur["method"] = mm.group(2)
                cur["description"] = ""
                cur["features"] = []
                cur["keyPoints"] = []
                cur["movements"] = []
                cur["cautions"] = []
                cur["sourceBook"] = "yangsheng"
                cur["lines"] = [i + 1, i + 1]
                methods.append(cur)
                sub = "description"
                continue
            if cur is None:
                continue
            cur["lines"][1] = i + 1
            if re.match(r"^[（(]一[）)]\s*功法特点", t):
                sub = "features"
                continue
            if re.match(r"^[（(]二[）)]\s*练功要领", t):
                sub = "keyPoints"
                continue
            if sub == "description":
                cur["description"] += t
                continue
            im = re.match(r"^\d+\s*[\.．]\s*(\S+?)[\s\u3000]+(.+)$", t)
            if im:
                cur[sub].append({"title": im.group(1), "text": im.group(2), "line": i + 1})
            elif cur[sub]:
                cur[sub][-1]["text"] += t
            else:
                cur[sub].append({"title": "", "text": t, "line": i + 1})
        elif sect and ("要领" in sect or "原则" in sect):
            key = "要领" if "要领" in sect else "原则"
            im = re.match(r"^\d+\s*[\.．]\s*(\S+?)[\s\u3000]+(.+)$", t)
            if im:
                general[key].append({"title": im.group(1), "text": im.group(2), "line": i + 1})
            elif re.match(r"^[" + CN_NUM + r"]+、", t):
                general[key].append({"title": t, "text": "", "line": i + 1})
            elif general[key]:
                general[key][-1]["text"] += t
    for m in methods:
        text = m["description"] + "".join(f["text"] for f in m["features"])
        if m["method"] == "六字诀":
            mm = re.search(r"以“([^”]+)”六种不同的特殊发音，分别与人体([^六]+?)六个脏腑相联系", text)
            if mm:
                chars = [c for c in re.split(r"[、，]", mm.group(1)) if c]
                organs = [c for c in re.split(r"[、，]", mm.group(2)) if c]
                if len(chars) == len(organs):
                    src_line = m["features"][0]["line"] if m["features"] else m["lines"][0]
                    m["movements"] = [{"name": c + "字诀", "sound": c, "organ": o, "action": "", "indication": "",
                                       "sourceSentence": mm.group(0), "line": src_line}
                                      for c, o in zip(chars, organs)]
                    m["movementsNote"] = ("教材只给出六字与脏腑的对应（功法特点 1），未载各字诀的分式动作；"
                                          "organ 字段逐字取自 sourceSentence")
        if m["method"] == "五禽戏":
            mm = re.search(r"模仿五种动物——([^的]+)的动作", text)
            if mm:
                m["animals"] = [a for a in re.split(r"[、，]", mm.group(1)) if a]
        for kp in m["keyPoints"]:
            if re.search(r"忌|切勿|不可|不宜|避免|勿", kp["text"]):
                m["cautions"].append({"text": kp["title"] + " " + kp["text"], "line": kp["line"]})
        if not m["movements"]:
            m["movementsNote"] = "教材（中医养生学）只载功法特点与练功要领，未列分式动作名称"
    gen = {"essentials": general["要领"], "principles": general["原则"],
           "lines": [start + 1, end]} if (general["要领"] or general["原则"]) else None
    return methods, gen


def extract_daoyin_tuina(lines, lo, hi):
    """推拿学 第七章 推拿功法 第四节 实用练功方法 (易筋经 十二势)."""
    start = None
    for i in range(lo, hi):
        if clean(lines[i]).startswith("第四节 实用练功方法") or re.match(r"^第四节\s*实用练功方法", clean(lines[i])):
            nxt = clean(lines[i + 1]) if i + 1 < hi else ""
            if re.match(r"^一、", nxt):
                start = i
                break
    if start is None:
        return None
    end = start + 1
    while end < hi and not re.match(r"^第[" + CN_NUM + r"]+\s*[章节]", clean(lines[end])):
        end += 1
    movements = []
    cur = None
    tag = None
    parent = None
    for i in range(start + 1, end):
        t = clean(lines[i])
        if not t or t.startswith("图"):
            continue
        mm = re.match(r"^([" + CN_NUM + r"]+)、\s*([" + CJK + r"]{2,10}势)$", t)
        sm = re.match(r"^[（(]([" + CN_NUM + r"]+)[）)]\s*([" + CJK + r"]{2,12}势)$", t)
        if mm or sm:
            nm = (mm or sm).group(2)
            if mm:
                parent = nm
            cur = OrderedDict()
            cur["name"] = nm
            if sm:
                cur["parent"] = parent
            cur["intro"] = ""
            cur["preparation"] = ""
            cur["action"] = []
            cur["keyPoints"] = ""
            cur["indication"] = ""
            cur["lines"] = [i + 1, i + 1]
            movements.append(cur)
            tag = "intro"
            continue
        if cur is None:
            continue
        cur["lines"][1] = i + 1
        m = TAG_RE.match(t)
        if m:
            tag = {"预备": "preparation", "基本动作": "action", "动作要领": "keyPoints",
                   "应用": "indication"}.get(m.group(1))
            if tag is None:  # 【思考题】 etc. end the movement block
                cur = None
                continue
            if m.group(2):
                cur.setdefault(tag, "")
                if isinstance(cur[tag], list):
                    cur[tag].append(m.group(2))
                else:
                    cur[tag] += m.group(2)
            continue
        if tag == "action":
            cur["action"].append(re.sub(r"^\d+[\.．]\s*", "", t))
        elif tag in cur and isinstance(cur[tag], str):
            cur[tag] += t
        else:
            cur.setdefault(tag, "")
            cur[tag] += t
    # drop parent rows that only carry an intro (their 势 content lives in sub-势)
    out = []
    for mv in movements:
        if not mv["action"] and not mv["preparation"] and any(x.get("parent") == mv["name"] for x in movements):
            continue
        if mv["intro"] == "":
            del mv["intro"]
        mv["action"] = "；".join(mv["action"])
        out.append(mv)
    return OrderedDict([
        ("method", "推拿功法·实用练功方法"),
        ("description", "推拿学 第七章 推拿功法 第四节 实用练功方法（节名原文）。韦驮献杵势原文注明为“易筋经”全套动作的"
                        "起始阶段；双虎夺食势原文注明为少林内功对拉运劲之势；其余各势出处以各条 intro/indication 原文为准。"),
        ("movements", out),
        ("cautions", []),
        ("sourceBook", "tuina"),
        ("lines", [start + 1, end]),
    ])


def extract_yangsheng_chronic(lines, lo, hi):
    start = None
    for i in range(lo, hi):
        if re.match(r"^第三节\s*常见慢性病", clean(lines[i])):
            nxt = clean(lines[i + 1]) if i + 1 < hi else ""
            nxt2 = clean(lines[i + 2]) if i + 2 < hi else ""
            if re.match(r"^一、", nxt) and len(nxt2) > 30:  # skip the table of contents
                start = i
                break
    if start is None:
        return []
    out = []
    cur = None
    expect = 1
    for i in range(start + 1, hi):
        t = clean(lines[i])
        if not t:
            continue
        mm = re.match(r"^([" + CN_NUM + r"]+)、\s*([" + CJK + r"]{2,10})$", t)
        if mm:
            if cur and mm.group(1) == "一" and out:
                break
            cur = OrderedDict([("disease", mm.group(2)), ("tcmCategoryTerms", []), ("measures", []),
                               ("sourceBook", "yangsheng"), ("lines", [i + 1, i + 1])])
            out.append(cur)
            continue
        if re.match(r"^第[" + CN_NUM + r"]+\s*[章节]", t) or re.match(r"^[" + CN_NUM + r"]+、", t):
            break  # next chapter / an unrelated "一、…" heading ends the disease list
        if cur is None:
            continue
        cur["lines"][1] = i + 1
        cur["tcmCategoryTerms"] = uniq(cur["tcmCategoryTerms"] + re.findall(r"相当于中医“([^”]+)”", t)
                                       + re.findall(r"、“([^”]+)”等病", t))
        im = re.match(r"^[（(]\d+[）)]\s*([" + CJK + r"]{2,6})[\s\u3000]*(.*)$", t)
        if im:
            cur["measures"].append({"method": im.group(1), "text": im.group(2), "line": i + 1})
        elif cur["measures"]:
            cur["measures"][-1]["text"] += "\n" + t
    return out


# --------------------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------------------

PRIORITY = [
    ("感冒", ["感冒"]), ("咳嗽", ["咳嗽"]), ("心悸", ["心悸"]), ("眩晕", ["眩晕"]), ("头痛", ["头痛"]),
    ("不寐", ["不寐", "失眠"]), ("胃痛", ["胃痛", "胃脘痛"]), ("腰痛", ["腰痛"]), ("牙痛", ["牙痛"]),
    ("蛇串疮", ["蛇串疮", "带状疱疹"]), ("瘾疹", ["瘾疹", "隐疹", "荨麻疹"]), ("湿疮/湿疹", ["湿疮", "湿疹"]),
    ("便秘", ["便秘"]), ("泄泻", ["泄泻", "腹泻"]), ("郁证", ["郁证"]), ("面瘫", ["面瘫"]),
    ("项痹/颈椎病", ["项痹", "颈椎病"]), ("漏肩风/肩周炎", ["漏肩风", "肩痹", "肩关节周围炎", "肩周炎"]),
    ("膝痹", ["膝痹", "膝骨性关节炎", "膝骨关节炎"]), ("痛经", ["痛经"]), ("月经不调", ["月经不调"]),
    ("喉痹", ["喉痹", "咽喉肿痛"]), ("鼻鼽", ["鼻鼽"]), ("耳鸣耳聋", ["耳鸣、耳聋", "耳鸣耳聋", "耳鸣", "耳聋"]),
    ("呃逆", ["呃逆"]), ("呕吐", ["呕吐"]), ("汗证/虚劳", ["汗证", "自汗、盗汗", "虚劳"]),
    ("哮喘", ["哮喘", "哮病", "喘证"]), ("中风", ["中风"]),
]


def coverage(result):
    cov = []
    for label, names in PRIORITY:
        row = OrderedDict([("priority", label)])
        for sect, key in (("acupuncture:zhenjiu_zhiliao", "acupuncture"), ("acupuncture:zhenjiu_xue", "acupuncture"),
                          ("tuina", "tuina"), ("diet", "diet")):
            hits = []
            for e in result[key]:
                if sect.startswith("acupuncture:") and e["sourceBook"] != sect.split(":")[1]:
                    continue
                if e["disease"] in names:
                    how = "diseaseName"
                elif any(n in e.get("aliases", []) for n in names):
                    how = "alias"
                elif any(n in e.get("tcmCategoryTerms", []) for n in names):
                    how = "tcmCategoryTerm"
                else:
                    continue
                hits.append({"disease": e["disease"], "line": e["line"], "matchedBy": how})
            row[sect] = hits
        cov.append(row)
    return cov


# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

def main():
    if len(sys.argv) != 3:
        sys.stderr.write(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    lines = raw.decode("utf-8").split("\n")
    del raw
    lines = [l.rstrip("\r") for l in lines]
    # U+E81F is the OCR's private-use glyph for "㖞" (all 166 occurrences sit in 㖞斜/㖞僻/口㖞)
    lines = [l.replace("\ue81f", "㖞") if "\ue81f" in l else l for l in lines]

    starts = detect_books(lines)
    ranges = {}
    books_meta = OrderedDict()
    for idx, (i, title, meta) in enumerate(starts):
        lo = max(0, i - 1)  # include the "图书在版编目（CIP）数据" line
        hi = (starts[idx + 1][0] - 1) if idx + 1 < len(starts) else len(lines)
        for key, t in BOOK_KEYS.items():
            if title == t and key not in ranges:
                ranges[key] = (lo, hi)
                meta = dict(meta)
                meta["rangeLines"] = [lo + 1, hi]
                books_meta[key] = meta
    missing = [k for k in BOOK_KEYS if k not in ranges]
    if missing:
        sys.stderr.write("books not found: %s\n" % missing)
        sys.exit(1)
    # normalise OCR arrows in the books where "→" stands for "、"
    for key in ARROW_IS_OCR_COMMA:
        lo, hi = ranges[key]
        for i in range(lo, hi):
            if "→" in lines[i]:
                lines[i] = lines[i].replace("→", "、")

    lo, hi = ranges["jingluo_shuxue"]
    lex, from_book, supp_added, lex_detail = build_lexicon(lines, lo, hi)
    pp = PointParser(lex)

    warnings = []
    acupuncture = []
    for key in ("zhenjiu_zhiliao", "zhenjiu_xue"):
        lo, hi = ranges[key]
        for ch in find_acu_chapters(lines, lo, hi, key):
            acupuncture.append(extract_acu_chapter(ch, pp, warnings))

    lo, hi = ranges["tuina"]
    tuina, tuina_blocks = extract_tuina(lines, lo, hi, pp, warnings)

    lo, hi = ranges["shiliao"]
    diet = extract_diet(lines, lo, hi, warnings)

    lo, hi = ranges["yangsheng"]
    dy, dy_general = extract_daoyin_yangsheng(lines, lo, hi)
    chronic = extract_yangsheng_chronic(lines, lo, hi)
    lo, hi = ranges["tuina"]
    dy_tuina = extract_daoyin_tuina(lines, lo, hi)
    daoyin = list(dy) + ([dy_tuina] if dy_tuina else [])

    result = OrderedDict()
    result["meta"] = OrderedDict([
        ("generator", "extract_nondrug.py"),
        ("generatorVersion", SCRIPT_VERSION),
        ("source", src.rsplit("/", 1)[-1]),
        ("sourceSha256", sha),
        ("sourceLineCount", len(lines)),
        ("lineNumbering", "1-based line numbers of the source file; lines=[first,last] inclusive"),
        ("ocrNormalization", "“→” replaced by “、” in 针灸治疗学 and 经络腧穴学 only (OCR artefact); "
                             "private-use U+E81F replaced by “㖞” everywhere; "
                             "推拿学 “〓” in 手法 lists rendered as “㨰”"),
        ("modelCalls", 0),
    ])
    for key in BOOK_KEYS:
        m = books_meta[key]
        m["usedFor"] = {
            "zhenjiu_zhiliao": "acupuncture (primary)",
            "zhenjiu_xue": "acupuncture (cross-check)",
            "tuina": "tuina, daoyin",
            "shiliao": "diet",
            "yangsheng": "daoyin, yangshengChronic",
            "cifa_jiufa": "not extracted (technique textbook without disease chapters)",
            "jingluo_shuxue": "acupoint lexicon",
        }[key]
    result["books"] = books_meta
    result["acupointLexicon"] = OrderedDict([
        ("size", len(lex)),
        ("fromJingluoShuxueHeadings", len(from_book)),
        ("supplementAdded", supp_added),
    ])
    result["acupuncture"] = acupuncture
    result["tuina"] = tuina
    result["diet"] = diet
    result["daoyin"] = daoyin
    if dy_general:
        result["daoyinGeneral"] = dy_general
    result["yangshengChronic"] = chronic
    result["coverage"] = coverage(result)
    result["extractionWarnings"] = warnings
    result["pointParserAudit"] = OrderedDict([
        ("unresolvedFragments", [[k, v] for k, v in sorted(pp.unresolved.items(), key=lambda x: (-x[1], x[0]))]),
        ("nonLexiconItems", [[k, v] for k, v in sorted(pp.others.items(), key=lambda x: (-x[1], x[0]))]),
        ("concatenatedChunksSplit", [[k, v] for k, v in sorted(pp.concatenated.items(), key=lambda x: (-x[1], x[0]))]),
        ("ambiguousFullCoverSplits", [[k, v] for k, v in pp.ambiguous.items()]),
    ])
    result["stats"] = OrderedDict([
        ("acupuncture", len(acupuncture)),
        ("acupuncture.zhenjiu_zhiliao", sum(1 for e in acupuncture if e["sourceBook"] == "zhenjiu_zhiliao")),
        ("acupuncture.zhenjiu_xue", sum(1 for e in acupuncture if e["sourceBook"] == "zhenjiu_xue")),
        ("acupuncture.otherTreatments", sum(len(e["otherTreatments"]) for e in acupuncture)),
        ("tuina", len(tuina)),
        ("diet", len(diet)),
        ("diet.syndromes", sum(len(e["syndromes"]) for e in diet)),
        ("diet.recipes", sum(len(s["recipes"]) for e in diet for s in e["syndromes"])),
        ("daoyin", len(daoyin)),
        ("daoyin.movements", sum(len(e["movements"]) for e in daoyin)),
        ("yangshengChronic", len(chronic)),
        ("warnings", len(warnings)),
    ])
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
        f.write("\n")
    sys.stdout.write(json.dumps(result["stats"], ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
