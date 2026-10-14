#!/usr/bin/env python3
"""
临床教材「病 → 证型 → 治法 → 代表方」对照表（2026-10-13）→ src/data/tcm-textbook-syndrome-formula-table.json。

来源：中医补充数据/灵丹GitHub/TCM Educational Materials.txt（本机外部数据，不入库；全国中医药行业高等教育
「十三五」规划教材合集，中国中医药出版社）。合集里按病逐证写出「证候/临床表现 → 治法 → 方药/代表方」的
临床教材共十本，各书排版不同（详见下方 BOOKS）：
  · 《中医内科学》      临床表现：/ 治法：/ 代表方：，下一段「本方由…组成。若…，加…」
  · 《中西医结合内科学》 症状: / 治法: / 方药:（方名后同段写加减）；病名是西医病名，另有下篇中医病证
  · 《中西医结合外科学》《中西医结合妇产科学》 证候：/ 治法：/ 方药：
  · 《中医妇科学》      主要证候：/ 证候分析：/ 治法：/ 方药：，随后「方名：药　药　药」与加减段
  · 《中医儿科学》      证候：/ 证候分析：/ 辨证要点：/ 治法：/ 主方：/ 常用药：/ 加减：（OCR 硬换行）
  · 《中医外科学》《中医眼科学》 证候：/（辨证分析：）/ 治法：/ 方药：…加减。常用…等。（OCR 硬换行）
  · 《温病学》          【证候】【病机】【治法】【方药】【临床运用】
  · 《中医骨伤科学》    叙述体，只收「N. 证名 治以…，方用…」这一种写法（无证候句）
合集里没有《中医耳鼻咽喉科学》；《针灸治疗学》《针灸学》《推拿治疗学》《中医食疗学》有证型无方药，
《伤寒论选读》《金匮要略》按条文方证编排，都不在本表内。

本脚本只做**切分与归位**，不改写任何临床文字：证候、治法、方药、加减都是教材原句（OCR 错字如
「黄苓」原样保留）；硬换行的书只是把断开的行接回去。宁缺毋滥——证型标题认不准、治法或方药对不上
的块直接跳过并计数（--stats 输出），不猜。

每行另带两个任务书之外的字段：syndromeKind（syndrome/type/stage：标题是证名、病类名还是分期名）、
tcmEquivalents（西医病名章节里教材写的「属中医学“…”范畴」）；compositionByFormula 记组成归属哪张方。

diseases[] 里每个病另带 differentials：教材【鉴别诊断】（【病证鉴别】【类证鉴别】、【诊断与鉴别诊断】下的
「（二）鉴别诊断」、【诊断】下的「2.鉴别诊断」）里要鉴别的病证，每条 {name, text}——name 是条目里写出的病名，
text 是该条的教材原文（连续片段，至多 400 字）。各书写法与识别口径见下文「鉴别诊断」一节；每条是按哪种写法
认出来的、出自哪一行，写在 --stats 的 differentialTrace / differentialRules 里（不进对照表）。

用法：python3 scripts/build-tcm-textbook-syndrome-table.py [教材合集路径] [输出路径] [--stats 统计输出路径]
同一份来源重复运行输出逐字节相同（无时间戳、无随机）。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_REL = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt"
OUT_REL = "src/data/tcm-textbook-syndrome-formula-table.json"
GENERATED_BY = "scripts/build-tcm-textbook-syndrome-table.py"

CJK = "一-鿿㐀-䶿"
CN_NUM = "一二三四五六七八九十百"

# --------------------------------------------------------------------------------------
# 教材清单：标题按版权页（CIP）「书名/某某主编」识别，范围到下一张版权页为止。
# --------------------------------------------------------------------------------------
BOOKS = [
    {
        "key": "neike", "title": "中医内科学", "department": "内科", "wrapped": False,
        "manif": ["临床表现"], "therapy": ["治法"], "formula": ["代表方"], "fused_heading": True,
        "layout": "临床表现：/治法：/代表方：；下一段「本方由…组成。若…，加…」",
    },
    {
        "key": "zxy_neike", "title": "中西医结合内科学", "department": "内科", "wrapped": False,
        "manif": ["症状", "证候"], "therapy": ["治法", "治则"], "formula": ["方药", "方剂"],
        "western_until": "下篇病证诊疗篇", "bare_titles": True,
        "layout": "症状:/治法:/方药:（或 方剂:），加减同段；上篇西医病名，下篇中医病证",
    },
    {
        "key": "zxy_waike", "title": "中西医结合外科学", "department": "外科", "wrapped": False,
        "manif": ["证候", "症状"], "therapy": ["治法", "治则"], "formula": ["方药"], "mods": ["加减"],
        "western": True,
        "layout": "证候：/治法：/方药：（个别另起「加减：」）；西医病名",
    },
    {
        "key": "zxy_fuchanke", "title": "中西医结合妇产科学", "department": "妇科", "wrapped": False,
        "manif": ["证候"], "therapy": ["治法", "治则"], "formula": ["方药"],
        "western": True, "bare_titles": True,
        "layout": "证候：/治法：/方药：方名（《出处》）。下一段「若…，加…」；西医病名，节内按中医病再分",
    },
    {
        "key": "erke", "title": "中医儿科学", "department": "儿科", "wrapped": True,
        "manif": ["证候"], "analysis": ["证候分析", "辨证要点", "辨证", "分析"],
        "therapy": ["治法"], "formula": ["主方", "方药"], "comp": ["常用药"], "mods": ["加减"], "bare_titles": True,
        "layout": "证候：/证候分析：/辨证要点：/治法：/主方：/常用药：/加减：（OCR 硬换行）",
    },
    {
        "key": "fuke", "title": "中医妇科学", "department": "妇科", "wrapped": False,
        "manif": ["主要证候"], "analysis": ["证候分析"], "therapy": ["治法"], "formula": ["方药", "主方"],
        "layout": "主要证候：/证候分析：/治法：/方药：方名（《出处》）。/「方名：药　药」/方解/「若…，加…」",
    },
    {
        "key": "waike", "title": "中医外科学", "department": "外科", "wrapped": True,
        "manif": ["证候"], "therapy": ["治法", "治则"], "formula": ["方药"],
        "dept_by_chapter": [("皮肤", "皮肤")],
        "layout": "证候：/治法：/方药：方名加减。常用…等。…者，加…（OCR 硬换行）",
    },
    {
        "key": "yanke", "title": "中医眼科学", "department": "眼科", "wrapped": True,
        "manif": ["证候"], "analysis": ["辨证分析"], "therapy": ["治法"], "formula": ["方药"],
        "layout": "证候：/辨证分析：/治法：/方药：方名〔方剂索引号〕加减。若…，加…（OCR 硬换行）",
    },
    {
        "key": "gushang", "title": "中医骨伤科学", "department": "骨伤", "wrapped": True, "inline": True, "bare_titles": True,
        "layout": "叙述体：「N. 证名 治以…，方用…」（无证候句；其余写法不收）",
    },
    {
        "key": "wenbing", "title": "温病学", "department": "其他", "wrapped": False, "bracket": True,
        "manif": ["证候"], "analysis": ["病机", "证候分析", "分析"], "therapy": ["治法", "治疗"],
        "formula": ["方药"], "usage": ["临床运用"], "disease_by_chapter": True,
        "layout": "【证候】【病机】【治法】【方药】【临床运用】；病按章（风温、春温…）",
    },
]
BOOK_ORDER = {book["key"]: index for index, book in enumerate(BOOKS)}

# 合集里查过、确认没有「证 → 治法 → 方」内容或编排不同、因而不收的书（写进统计，供报告引用）。
SURVEYED_NOT_INCLUDED = [
    ("针灸治疗学", "各病【辨证要点】有证型与表现，治法是取穴，无方药（牙痛、口疮、耳鸣耳聋、鼻渊、咽喉肿痛等只在这里有证型）"),
    ("针灸学", "各病【辨证】有证型，治法是取穴，无方药"),
    ("推拿治疗学", "【辨证论治】是手法，无方药"),
    ("推拿学", "治则/处方是手法与穴位"),
    ("中医食疗学", "【证候】后接食疗方，不是方剂"),
    ("伤寒论选读", "按条文方证编排（主症/病机/治法：…方用某汤），不是病下分证"),
    ("金匮要略", "按条文编排，无统一的证型栏目"),
    ("方剂学", "方 → 主治，不是病 → 证"),
    ("中药学", "附录「临床常用药」是病 → 证 → 药物清单，无方名、无证候"),
    ("中医诊断学", "证候定义，不分病、无方"),
]

# --------------------------------------------------------------------------------------
# 行级结构
# --------------------------------------------------------------------------------------
RE_CIP = re.compile(r"^图书在版编目")
RE_BRACKET = re.compile(r"^【([^】]{1,14})】\s*(.*)$")
# OCR 把「十一」认成「^―」「^一」：章节号里容许这几个符号，否则「第^―节药毒」之后的证型会并进上一节。
RE_CHAPTER = re.compile(rf"^第[{CN_NUM}\^―—\s]{{1,5}}章\s*(.*)$")
RE_SECTION = re.compile(rf"^第[{CN_NUM}\^―—]{{1,4}}节\s*(.*)$")
RE_APPENDIX = re.compile(r"^(?:【附[一二三四]?】|附[一二三四]?\s*[:：])\s*(.+)$")
RE_CAPTION = re.compile(r"^(?:(?:表|图|彩图)\s*\d+\s*[-－–—]\s*\d+|续表\s*$)")
NUMBERING = [
    (1, re.compile(rf"^([{CN_NUM}]{{1,3}})\s*、\s*")),
    (2, re.compile(rf"^[（(]\s*([{CN_NUM}]{{1,3}})\s*[)）]\s*")),
    (3, re.compile(r"^(\d{1,2})\s*[.．、]\s*(?!\d)")),
    (4, re.compile(r"^[（(]\s*(\d{1,2})\s*[)）]\s*")),
    (4, re.compile(r"^([⑴-⒇])\s*")),
    (5, re.compile(r"^(\d{1,2})\s*[)）]\s*")),
    (6, re.compile(r"^([①-⑳])\s*")),
]
BARE_LEVEL = 9
NAME_CHARS = rf"[{CJK}A-Za-z0-9，、·\-—－/（）()]"
RE_CLEAN_NAME = re.compile(rf"^{NAME_CHARS}{{2,26}}$")

# 小标题里纯属栏目名的词，不当作 group（也不当作病名）。
GENERIC_TITLE = re.compile(
    r"诊断|鉴别|治疗|病因|病理|病机|表现|症状|体征|并发症|预防|调护|预后|概述|分类|分型|分期|检查|处理|原则|思路|方法|要点|疗法|护理|"
    r"保健|特点|生理|解剖|机制|概念|定义|适应证|禁忌证|注意事项|手术|用药|转归|随访|辨证|论治|证治|辨治|中医|西医|流行病学|发病|"
    r"内治|外治|治法|方药|中药|药物|其他|一般|概说|小结|研究|进展|备要|经验|摘要|文献|思考|案例|病例|病案"
)
# 节名里的 OCR 错字（只改病名这一处，正文不动）：左为合集里的字形，右为教材节名。
TITLE_OCR_FIXES = {
    "waike": {"白尼": "白疕", "酒独鼻": "酒齄鼻", "息、肉痔": "息肉痔", "于痈": "子痈", "于痰": "子痰", "紫瘢风": "紫癜风"},
    "erke": {"紫瘢": "紫癜"},
    "yanke": {"日倦": "目倦"},
}
# 一个病的正文以这些【栏目】收尾；其后出现的「一、某病」才可能是下一个病。
MONOGRAPH_CLOSING = re.compile(r"预防|预后|调护|思考|文献|案例|病例|病案|示意图|小结|经验|摘要|推介|临证要点|治疗|辨证论治|其他疗法|转归|随访")
# 紧贴证候行的标题若是这些词，是栏目而不是证型。
SECTION_TITLE = re.compile(r"辨证|论治|治疗|内治|外治|证治|分型|方药|疗法|诊断|鉴别|治法|概述|用药")
STAGE_NAME = re.compile(r"(期|阶段)$")
TYPE_SUFFIX = re.compile(
    r"(感冒|咳嗽|头痛|腰痛|胃痛|腹痛|胁痛|牙痛|眩晕|喘|哮|淋|痹|疟|瘴|厥|秘|泻|消|疳|痢|痿|痉|衄|黄疸|阳黄|阴黄|急黄|水肿|阳水|阴水|"
    r"脐湿|脐疮|脐血|脐突|中经络|中脏腑|闭证|脱证|实证|虚证|型)$"
)


def display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WFA" else 1 for ch in text)


def nospace(text: str) -> str:
    return re.sub(r"[\s　]+", "", text)


class VLine:
    """一条逻辑行：no = 源文件 1 起行号；full = 硬换行书里该行是否写满（下一行是它的续行）。"""

    __slots__ = ("no", "text", "full")

    def __init__(self, no: int, text: str, full: bool):
        self.no = no
        self.text = text
        self.full = full


def numbering(text: str):
    """「1.风寒束表」→ (层级, 去掉编号后的文字)；不是编号行返回 None。"""
    for level, pattern in NUMBERING:
        match = pattern.match(text)
        if match:
            return level, text[match.end():].strip()
    return None


def build_vlines(lines: list[str], start: int, end: int, book: dict, markers: re.Pattern | None) -> list[VLine]:
    """去空行、去图表题注；把少数挤在一行里的「标题+栏目」「治法。代表方：」拆开（行号不变）。"""
    vlines: list[VLine] = []
    split_heading = None
    split_fields = None
    if markers is not None and not book.get("bracket"):
        if book.get("fused_heading"):
            # 「2.痰热风动临床表现：…」：只对栏目名足够长、不会与正文相混的书开启。
            names = "|".join(book["manif"])
            split_heading = re.compile(rf"^((?:\d{{1,2}}\s*[.．]|[（(]\s*\d{{1,2}}\s*[)）])\s*[{CJK}，、]{{2,16}}?)((?:{names})[:：].*)$")
        split_fields = re.compile(rf"^((?:{'|'.join(book['therapy'])})[:：][^。]{{2,80}}。)\s*((?:{'|'.join(book['formula'])})[:：].*)$")
    for index in range(start, end):
        raw = lines[index].replace("﻿", "")
        text = raw.strip().strip("　").strip()
        if not text or RE_CAPTION.match(text):
            continue
        full = book["wrapped"] and display_width(raw.rstrip()) >= 54
        pieces = [text]
        bracket = RE_BRACKET.match(text)
        if bracket and bracket.group(2) and numbering(bracket.group(2)) and not book.get("bracket"):
            pieces = [f"【{bracket.group(1)}】", bracket.group(2)]
        elif split_heading and split_heading.match(text):
            match = split_heading.match(text)
            pieces = [match.group(1), match.group(2)]
        elif split_fields and split_fields.match(text):
            match = split_fields.match(text)
            pieces = [match.group(1), match.group(2)]
        for position, piece in enumerate(pieces):
            vlines.append(VLine(index + 1, piece, full if position == len(pieces) - 1 else False))
    return vlines


def is_structural(text: str) -> bool:
    """编号标题、【栏目】、章节、附篇：一个证型块到这里必须结束。"""
    if RE_BRACKET.match(text) or RE_CHAPTER.match(text) or RE_SECTION.match(text) or RE_APPENDIX.match(text):
        return True
    return numbering(text) is not None


def join_wrapped(parts: list[str]) -> str:
    return "".join(part.strip() for part in parts if part.strip())


# --------------------------------------------------------------------------------------
# 栏目识别
# --------------------------------------------------------------------------------------
ROLE_ORDER = ["manif", "analysis", "therapy", "formula", "comp", "mods", "usage"]


def compile_markers(book: dict):
    roles = {}
    for role in ROLE_ORDER:
        for name in book.get(role, []):
            roles[name] = role
    names = sorted(roles, key=len, reverse=True)
    if not names:
        return None, roles
    if book.get("bracket"):
        pattern = re.compile(rf"^【({'|'.join(names)})】\s*(.*)$")
    else:
        pattern = re.compile(rf"^({'|'.join(names)})\s*[:：；;]\s*(.*)$")
    return pattern, roles


RE_UNKNOWN_LABEL = re.compile(rf"^([{CJK}]{{2,6}})[:：]")


# --------------------------------------------------------------------------------------
# 方名解析
# --------------------------------------------------------------------------------------
FORMULA_SUFFIX = r"(?:汤|散|丸子|丸|饮子|饮|丹|膏|煎|方|片|颗粒|胶囊|口服液|注射液|合剂|冲剂|糖浆|洗剂|酒|露|锭|珠)"
NAME_CHAR = rf"[{CJK}ⅠⅡⅢⅣⅤIV]"
# 方名之后必须紧跟这些：句读、连接词（合/或/加减…）或用法词。只收这么窄一组——
# 「甘露消毒丹」「仙方活命饮」里的「露」「方」后面是别的字，才不会被从中间切断。
FORMULA_BOUNDARY = (
    r"(?=$|[，,。；;、：:（(〔\[\s/“”\"]|合|或|加|去|减|送|和|及|与|化裁|为|等|以|配|并|兼|之|酌|随|主|治|口服|灌服|鼻饲|冲服|调服|"
    r"频服|内服|外|煎|水|同|再|亦|也|出入|变通|增损|意|法|类|中|可|继|后|先|方|[二三两诸]方|的|而|者|则|对|在|有|能|具|是|由|即|组|用|[⑴-⒇①-⑳\d])"
)
RE_FORMULA_TOKEN = re.compile(rf"(?:紫雪(?!丹|散)|云南白药|{NAME_CHAR}{{1,13}}?{FORMULA_SUFFIX}){FORMULA_BOUNDARY}")
RE_LEADING_VERB = re.compile(
    r"^(?:急用|先用|先予|先服|先以|继用|继服|继以|再用|再服|再予|后用|后服|可用|可选用|可选|可予|可服|可合用|可合|可配合|可加用|可配|"
    r"宜用|宜选用|宜选|宜服|应用|当用|选用|常用|常选用|多用|多选用|首选|主用|主以|主方用|主方为|主方|亦可用|也可用|亦可选用|亦可予|亦可|也可|"
    r"或用|或选用|或选|或服|或以|或合|酌用|酌选|另用|另服|兼用|兼服|并用|并服|配合|配以|配服|同用|同服|改用|拟用|试用|仍用|均可用|"
    r"均可|合用|合并|合以|合服|加用|加服|方用|方选|方以|方宜|药用|治用|治以|治宜|予以|予服|给予|投以|投用|口服|内服|外敷|外用|外搽|取用|仿用|"
    r"轻者用|重者用|轻症用|重症用|一般用|通常用|可先用|可先予|"
    r"以|用|予|投|服|合|或|与|及|即|选|则|宜|仿|拟|"
    r"加(?!味|减)|和(?!营|解|胃|中|血|肝|脾|气|络|荣|乳)|可(?!保)|当(?!归)|再(?!造)|常(?!山)|首(?!乌)|急(?!救)|如(?!意|金|圣|神)|先(?!期|天)|后(?!天)|方(?!脉))+"
)
NOT_FORMULA = re.compile(
    r"^(?:经验方|验方|自拟方|协定方|基本方|基础方|主方|本方|上方|原方|前方|后方|处方|组方|选方|用方|此方|该方|成方|偏方|单方|合方|二方|"
    r"两方|诸方|汤方|丸方|散方|代表方|常用方|复方|古方|时方|经方|全方|是方|上述方|等方|验方汤|中成药|汤剂|丸剂|散剂|膏剂|丹剂|酒剂|"
    r"石膏|生石膏|熟石膏|煅石膏|黄丹|铅丹|红丹|黄酒|白酒|米酒|清酒|药酒|红升丹|白降丹|蜂蜜膏|生姜汤|姜汤|米汤|米饮|糖浆|开水|"
    r"煎汤|水煎|浓煎|外敷药膏|药膏|软膏|油膏|硬膏|膏药|药散|药丸|药片|洗方|.*加减方)$"
)
BAD_FORMULA_CHAR = re.compile(r"[用服者若则宜应于的是而等其或与此型证期症病时且但因故以属见兼伴甚轻为在对即亦也均皆另类之该某些]")
RE_PAREN = re.compile(r"《（[^》）]*》）|（[^（）]*）|\([^()]*\)|〔[^〔〕（）)]{0,6}[〕）)]|\[[^\[\]]{0,6}\]|［[^［］]{0,6}］")
RE_INDEX_MARK = re.compile(r"[⑴-⒇①-⑳]|〔\d+|\d+〕")
# OCR 把方后的索引号认成「⑷）」「据〕」「"」这类残片：紧跟在剂型字后、以括号或引号收尾的一两个字符。
RE_INDEX_DEBRIS = re.compile(r"(?<=[汤丸散饮丹膏煎方])[^，。；、合或加]{0,2}[〕］\]）)\"”]")
RE_MODIFIED = re.compile(r"加减|加味|化裁|出入|增损|变通|加(?!入)|去|减")
RE_EMBEDDED_GAP = re.compile(rf"^(?:减去|去|加(?!味|减))(?:.+?)(合用|合|或)(?!欢|香)(?P<name>{NAME_CHAR}{{2,13}})$")


def strip_parens(text: str) -> str:
    previous = None
    while previous != text:
        previous = text
        text = RE_PAREN.sub("", text)
    text = RE_INDEX_MARK.sub("", text)
    return RE_INDEX_DEBRIS.sub("", text)


def clean_formula_candidate(raw: str, herbs: set[str]):
    """候选串 → (方名, 被剥掉的前缀)；不是方名返回 (None, 前缀)。"""
    name = raw
    stripped = ""
    embedded = RE_EMBEDDED_GAP.match(name)
    if embedded:
        # 「去牛膝合二至丸」：前一张方的减味 + 合 + 后一张方。
        stripped = name[: len(name) - len(embedded.group("name"))]
        name = embedded.group("name")
    while True:
        match = RE_LEADING_VERB.match(name)
        if not match or match.end() >= len(name) - 1:
            break
        stripped += match.group(0)
        name = name[match.end():]
    bad = list(BAD_FORMULA_CHAR.finditer(name))
    if bad:
        cut = bad[-1].end()
        stripped += name[:cut]
        name = name[cut:]
        match = RE_LEADING_VERB.match(name)
        if match and match.end() < len(name) - 1:
            stripped += match.group(0)
            name = name[match.end():]
    if len(name) < 2 or NOT_FORMULA.match(name) or name in herbs:
        return None, stripped
    if not re.fullmatch(rf"(?:紫雪|云南白药|{NAME_CHAR}{{1,13}}{FORMULA_SUFFIX})", name):
        return None, stripped
    if len(name) == 2 and name not in ("紫雪",):
        return None, stripped
    return name, stripped


STRONG_CONNECTOR = ("合", "合用", "配合", "并用", "或", "或用", "或者", "或选用", "或选")
RE_CONNECTOR_TAIL = re.compile(
    r"(合用|配合|配服|并用|合|或选用|或用|或选|或者|或|和|及|与|、|/|继服|继用|继以|再服|再用|后用|后服|送服|兼服|另服|同服|亦可用|也可用|亦可|也可)$"
)
RE_COMMA_LEAD = re.compile(r"^(?:继服|继用|继以|再服|再用|后用|后服|或用|或选用|或者|或|亦可用|也可用|亦可|也可|合用|合|配合|配服|并用|并服|同服|另服|兼服|送服)$")
RE_ALT_CLAUSE = re.compile(r"^(?:或者|或用|或选用|或选|或|亦可用|亦可予|亦可|也可用|也可)")
RE_CONDITION_LEAD = re.compile(r"(?:用|以|选用|选|予|宜用|宜|可用|方用|治以|主以)$")
RE_PURE_VERB_LEAD = re.compile(r"^(?:急|先|继|再|后|内|外|可|宜|方|常|多|首|主|或|亦可|也可|同时)?(?:用|以|服|敷|选用|选|予|宜用|宜|可用|方用|治以|主以)?$")


def classify_gap(gap: str):
    """两张方名之间的文字 → comb / alt / seq；不是并列关系返回 None。"""
    if re.search(r"[。；;]", gap):
        return None
    if gap in ("，", ","):
        return "alt"
    segment = gap.split("，")[-1] if "，" in gap else gap
    if "，" in gap:
        # 逗号之后只能是「继服/或用/配服」这类连接词；逗号之前只能是加减写法或「灌服」之类短语。
        before = "，".join(gap.split("，")[:-1])
        before = re.sub(r"加减|加味|化裁|出入|增损|变通|为主方|为主|为基础", "", before)
        if not RE_COMMA_LEAD.match(segment) or (len(before) > 6 and not re.search(r"加|去|减", before)):
            return None
    body_all = re.sub(r"加减|加味|化裁|出入|增损|变通|为主方|为主|为基础", "", gap)
    if body_all == "加":
        return "add"
    connector = RE_CONNECTOR_TAIL.search(segment)
    if not connector:
        return None
    word = connector.group(1)
    body = gap[: len(gap) - len(word)]
    body = re.sub(r"加减|加味|化裁|出入|增损|变通|为主方|为主|为基础", "", body)
    if re.search(r"加|去|减", body) and word not in STRONG_CONNECTOR:
        return None
    if re.search(rf"[{CJK}]", body) and not re.search(r"加|去|减|，", body):
        return None
    if "，" in gap and re.match(r"^(继|再|后)", segment):
        return "seq"
    if word.startswith("或") or word in ("、", "/", "亦可用", "也可用", "亦可", "也可"):
        return "alt"
    return "comb"


def scan_formula_group(clause: str, herbs: set[str]):
    """一个小句里句首这一组方名 → (方名, 连接关系, 首方之前的文字, 是否还有没归入的方名)。"""
    names: list[str] = []
    joins: list[str] = []
    position = 0
    last_end = None
    lead = ""
    leftover = False
    for match in RE_FORMULA_TOKEN.finditer(clause):
        if match.start() < position:
            continue
        name, _stripped = clean_formula_candidate(match.group(0), herbs)
        if name is None:
            continue
        start = match.end() - len(name)
        end = match.end()
        if clause[end:].startswith("加减方"):
            # 「驻景丸加减方」是方名本身。
            name += "加减方"
            end += 3
        if last_end is None:
            names.append(name)
            lead = clause[:start]
        else:
            gap = clause[last_end:start]
            kind = classify_gap(gap)
            if kind == "add":
                # 「右归丸加小金丹」算合方；「四逆散加鹿角片、桃仁」是加药。
                if clause[end:].startswith("、") or name.endswith("片"):
                    break
                kind = "comb"
            if kind is None:
                # 「…加生地黄、玄参方」是前一张方的加减写法，不算另一张方。
                leftover = not (name.endswith("方") and re.search(r"加|去", gap))
                break
            if name not in names:
                names.append(name)
                joins.append(kind)
        last_end = end
        position = end
    return names, joins, lead, leftover


def parse_formula_sentence(sentence: str, herbs: set[str]):
    """方药句 → (方名列表, join, modified, 存疑说明)。只认句首这一组方名，后文条件句里的方不算。"""
    text = strip_parens(sentence).strip()
    text = re.sub(r"《[^》]{1,20}》", "", text)
    notes: list[str] = []
    body = text.rstrip("。")
    clauses = [part.strip() for part in re.split(r"[；;]", body) if part.strip()]
    if not clauses:
        return [], "single", False, ["方药句为空"]
    # 一、按条件分列：「偏阳虚者，用右归丸；偏阴虚者，用左归丸」「轻证用保和丸，重证用枳实导滞丸」
    segments = [part.strip() for part in re.split(r"[；;，,]", body) if part.strip()]
    conditional_groups: list[tuple[list[str], list[str]]] = []
    pending = ""
    for segment in segments:
        names, joins, lead, _left = scan_formula_group(segment, herbs)
        if not names:
            pending = segment if re.search(r"者$|证$|型$|时$|为主$", segment) else ""
            continue
        condition = (pending + lead).strip()
        pending = ""
        stripped = RE_CONDITION_LEAD.sub("", condition)
        if len(stripped) >= 2 and not RE_PURE_VERB_LEAD.match(condition) and not RE_ALT_CLAUSE.match(condition):
            conditional_groups.append((names, joins))
        else:
            conditional_groups.append(([], []))
    real_groups = [group for group in conditional_groups if group[0]]
    conditional = len(real_groups) >= 2 and len(real_groups) == len(conditional_groups)
    if conditional:
        names: list[str] = []
        for group_names, _group_joins in real_groups:
            for name in group_names:
                if name not in names:
                    names.append(name)
        modified = bool(re.search(r"加减|加味|化裁", text))
        notes.append("教材按条件分列各方")
        return names, "alternative", modified, notes
    # 二、句首一组方名（合/或/、相连），后面分号小句若以「或/亦可」起头则并入备选。
    names, joins, _lead, leftover = scan_formula_group(clauses[0], herbs)
    if not names:
        bare = re.fullmatch(rf"({NAME_CHAR}{{2,10}}?)(加减|加味|化裁)?", body)
        if bare and not BAD_FORMULA_CHAR.search(bare.group(1)) and not NOT_FORMULA.match(bare.group(1)) and bare.group(1) not in herbs:
            notes.append("方名不带常见剂型字，按整句收入")
            return [bare.group(1)], "single", bool(bare.group(2)), notes
        return [], "single", False, ["方药句中未识别出方名"]
    for clause in clauses[1:]:
        if RE_ALT_CLAUSE.match(clause):
            more, _more_joins, _more_lead, _more_left = scan_formula_group(clause, herbs)
            for name in more:
                if name not in names:
                    names.append(name)
                    joins.append("alt")
        elif RE_FORMULA_TOKEN.search(clause):
            leftover = True
    residue = text[text.find(names[0].replace("加减方", "")) + len(names[0].replace("加减方", "")):]
    for name in names[1:]:
        residue = residue.replace(name, "", 1)
    if names[0].endswith("加减方"):
        residue = residue.replace("加减方", "", 1)
    modified = bool(RE_MODIFIED.search(residue))
    if not joins:
        join = "single"
    elif "alt" in joins:
        join = "alternative"
        if "comb" in joins or "seq" in joins:
            notes.append("合用（或先后）与择用并见，formulaJoin 记作 alternative")
        if ("、" in clauses[0] or "，" in clauses[0]) and "或" not in text:
            notes.append("方名以顿号并列，教材未写明合用还是择用")
    else:
        join = "combined"
        if "seq" in joins:
            notes.append("教材写先后使用")
    if leftover:
        notes.append("方药句后文另提到其他方，未归入 formulas")
    return names, join, modified, notes


# --------------------------------------------------------------------------------------
# 证候 → 舌、脉
# --------------------------------------------------------------------------------------
RE_TONGUE_START = re.compile(r"^(?:舌|苔)")
RE_PULSE_START = re.compile(r"^(?:脉|指纹|趺阳脉|寸口脉)")
RE_TONGUE_CONT = re.compile(r"苔|舌|津|腻|胖|齿痕|瘀|裂|剥|绛|少苔|无苔|花剥")
RE_PULSE_CONT = re.compile(r"^(?:或|甚则|甚或|重按|按之|久按|尺|寸|关|两|左|右)?[浮沉迟数滑涩弦细弱濡洪紧结代促虚实微芤缓大小长短疾散伏革牢动无有力而兼带稍略偏或、]{1,12}$")


def split_tongue_pulse(manifestation: str):
    """从证候句里切出舌、脉（原文子串）；只认句尾连续的舌脉小句，切不干净就留空。"""
    for sentence_match in re.finditer(r"[^。]+", manifestation):
        sentence = sentence_match.group(0)
        base = sentence_match.start()
        clauses = [(m.start(), m.group(0)) for m in re.finditer(r"[^，,；;]+", sentence)]
        if not clauses:
            continue
        kinds: list[str] = []
        for _offset, clause in clauses:
            body = clause.strip()
            if RE_TONGUE_START.match(body):
                kinds.append("T")
            elif RE_PULSE_START.match(body):
                kinds.append("P")
            elif kinds and kinds[-1] == "T" and RE_TONGUE_CONT.search(body) and len(body) <= 12:
                kinds.append("T")
            elif kinds and kinds[-1] == "P" and RE_PULSE_CONT.match(body):
                kinds.append("P")
            else:
                kinds.append("-")
        tail_start = len(kinds)
        while tail_start > 0 and kinds[tail_start - 1] in "TP":
            tail_start -= 1
        if tail_start == len(kinds):
            continue
        tail = list(range(tail_start, len(kinds)))

        def run(kind: str) -> str:
            indexes = [i for i in tail if kinds[i] == kind]
            if not indexes:
                return ""
            first = indexes[0]
            last = first
            while last + 1 in indexes:
                last += 1
            begin = base + clauses[first][0]
            finish = base + clauses[last][0] + len(clauses[last][1])
            return manifestation[begin:finish].strip()

        tongue, pulse = run("T"), run("P")
        at = tongue.find("脉")
        if at > 0 and not pulse:
            tongue, pulse = tongue[:at].rstrip("，, "), tongue[at:]
        return tongue, pulse
    return "", ""


# --------------------------------------------------------------------------------------
# 组成与加减
# --------------------------------------------------------------------------------------
HERB_FUNCTION_CHAR = re.compile(r"[以而之的者等其或与及可宜应则若如为有无是在于从对将把被让使令得用服并且但故因]")
HERB_PREFIX = r"(?:鲜|生|炙|炒|焦|煅|制|熟|干|川|广|怀|杭|北|南|酒|醋|盐|姜|蜜|法|清|淡|嫩|老|陈|净|炮|煨|麸炒|土炒|蜜炙|酒炒|炒黑|大|小|细|粉|飞|明|真|紫|白|赤|黑|青)"
RE_DOSE = re.compile(r"\d+(?:\.\d+)?\s*(?:g|克|mg|ml|mL|枚|片|条|只|个|粒|支)(?:\s*[〜~～\-－—]\s*\d+(?:\.\d+)?\s*(?:g|克|mg|ml|mL|枚|片|条|只|个|粒|支)?)?")
ADD_GUARD = (
    r"(?!减|味|剧|强|深|快|以|上|之|工|热敷|压|速|倍|盖|班|固|糖|冰|温(?!郁金)|重(?!楼)|"
    r"大(?!黄|枣|青|蓟|腹|血|贝|戟|蒜|豆|风|力|麦|茴|蜈|红|叶|腹皮))"
)
RE_ADD = re.compile(rf"(?<![五刺增更愈渐日有稍相再叠附参])(?:酌加|可加|宜加|再加|并加|常加|均加|加用|加入|加服|加){ADD_GUARD}")
RE_REMOVE = re.compile(
    r"(?<![除失过祛减退出回上下进前消散])(?:减去|去)(?!渣|皮|节|心|核|毛|油|芦|壳|净|除|其|之|掉|腐|瘀|湿|痰|翳|火|风|邪|痛|热|寒|滓|头|翅|粗|"
    r"浮|上|势|病|世|年|医|处|向|后|掉|污|垢|势|脓|痂|屑|膜|鳞)"
)
RE_COND_LEAD = re.compile(r"^(?:若是|如若|如果|倘若|若|如|倘|而|但|又|另|此外|同时|或)(?!何)")
RE_COND_AUX = re.compile(r"(?<=[，,者时])(?:则|均可|还可|亦可|也可|可以|可|宜|应|当|酌情|酌|并|再|需|须|常|多|亦|也)+$")
RE_COND_TAIL = re.compile(r"(?:[，,、]|者|时)+$")
RE_MERGE_ONLY = re.compile(r"^(?:[，,、]|或|并|再|亦可|也可|还可|同时|另|酌|可|宜|则|及|和|且|更|又|均|亦|也)*$")
COMPOSITION_SENTENCE = re.compile(rf"(本方|前方|后方|上方|[{CJK}]{{2,13}}?)(?:即|是|为|均|则|乃)?由(?:一味)?([^。；;]+?)(?:等)?(?:药物|诸药|药|味)?(?:所)?组成")


def split_outside_parens(text: str, separators: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    current = ""
    for ch in text:
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if depth == 0 and ch in separators:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return parts


def list_end_outside_parens(text: str, start: int) -> int:
    depth = 0
    for index in range(start, len(text)):
        ch = text[index]
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        elif depth == 0 and ch in "，,；;。：:":
            return index
    return len(text)


def clean_listed_herb(token: str) -> str:
    token = token.strip().strip("。．.；;，,、")
    token = re.sub(r"(?:等药|等味|等品|等)$", "", token)
    return token.strip()


def resolve_herb(token: str, lexicon: set[str], last: bool):
    """加减句里的一项 → (药名, 说明)。认不准返回 (None, 原串)。"""
    bare = RE_PAREN.sub("", token)
    bare = RE_DOSE.sub("", bare).strip()
    bare = re.sub(r"(?:各)?$", "", bare)
    bare = re.sub(r"(?:等药|等味|等品|之类|之品|之属|等)$", "", bare).strip()
    if not bare:
        return None, token
    if bare in lexicon:
        return bare, ""
    for length in range(min(len(bare), 7), 1, -1):
        prefix = bare[:length]
        if prefix in lexicon:
            return prefix, ""
        match = re.match(rf"^({HERB_PREFIX}{{1,2}})(.+)$", prefix)
        if match and match.group(2) in lexicon:
            return prefix, ""
    if re.fullmatch(rf"[{CJK}]{{2,4}}", bare) and not HERB_FUNCTION_CHAR.search(bare) and not last:
        return bare, ""
    if re.fullmatch(rf"[{CJK}]{{2,3}}", bare) and not HERB_FUNCTION_CHAR.search(bare):
        return bare, ""
    return None, bare


def parse_modifications(text: str, lexicon: set[str], herbs_as_formula_guard: set[str]):
    """加减段 → [{condition, herbs, remove, formulas, raw}]；只收解析出药或方的小句。"""
    entries: list[dict] = []
    unresolved = 0
    for sentence in re.split(r"[。]", text):
        for clause in split_outside_parens(sentence, "；;"):
            clause = clause.strip()
            if not clause or len(clause) < 4:
                continue
            if re.match(r"^(?:方中|本方|方解|此方|全方|诸药|上药|二药|两药|三药|以上|用法|服法)", clause) and "加" not in clause[:12]:
                continue
            if COMPOSITION_SENTENCE.search(clause):
                continue
            position = 0
            clause_entries: list[dict] = []
            while position < len(clause):
                add = RE_ADD.search(clause, position)
                remove = RE_REMOVE.search(clause, position)
                candidates = [m for m in (add, remove) if m]
                if not candidates:
                    break
                action = min(candidates, key=lambda m: m.start())
                condition_raw = clause[position:action.start()]
                end = list_end_outside_parens(clause, action.end())
                items = [clean_listed_herb(item) for item in split_outside_parens(clause[action.end():end], "、")]
                items = [item for item in items if item]
                herbs: list[str] = []
                formulas: list[str] = []
                notes: list[str] = []
                for index, item in enumerate(items):
                    last = index == len(items) - 1
                    bare = strip_parens(item)
                    formula_match = RE_FORMULA_TOKEN.match(bare)
                    if formula_match and action is add:
                        name, _ = clean_formula_candidate(formula_match.group(0), herbs_as_formula_guard)
                        if name and name not in lexicon and len(name) >= 3:
                            formulas.append(name)
                            continue
                    herb, doubt = resolve_herb(item, lexicon, last)
                    if herb:
                        herbs.append(herb)
                    else:
                        if action is add:
                            unresolved += 1
                            notes.append(f"未切分：{doubt[:16]}")
                        break
                if action is not add and not [h for h in herbs if h in lexicon or re.match(rf"^{HERB_PREFIX}", h)]:
                    skip_from = action.end()
                    later_add = RE_ADD.search(clause, skip_from)
                    later_remove = RE_REMOVE.search(clause, skip_from)
                    later = [m for m in (later_add, later_remove) if m]
                    if not later:
                        break
                    action = min(later, key=lambda m: m.start())
                    condition_raw = clause[position:action.start()]
                    end = list_end_outside_parens(clause, action.end())
                    items = [clean_listed_herb(item) for item in split_outside_parens(clause[action.end():end], "、")]
                    herbs = []
                    for index, item in enumerate([item for item in items if item]):
                        herb, _doubt = resolve_herb(item, lexicon, index == len(items) - 1)
                        if not herb:
                            break
                        herbs.append(herb)
                    formulas, notes = [], []
                merge = bool(clause_entries) and RE_MERGE_ONLY.match(condition_raw.strip())
                if merge:
                    target = clause_entries[-1]
                    target["_end"] = end
                else:
                    condition = condition_raw.strip().lstrip("，,、")
                    condition = RE_COND_LEAD.sub("", condition)
                    condition = RE_COND_TAIL.sub("", RE_COND_AUX.sub("", condition)).strip()
                    target = {"condition": condition, "herbs": [], "remove": [], "formulas": [], "_start": position, "_end": end, "_notes": []}
                    clause_entries.append(target)
                if action is add:
                    target["herbs"].extend(h for h in herbs if h not in target["herbs"])
                    target["formulas"].extend(f for f in formulas if f not in target["formulas"])
                else:
                    strict = [h for h in herbs if h in lexicon or re.match(rf"^{HERB_PREFIX}", h)]
                    target["remove"].extend(h for h in strict if h not in target["remove"])
                target["_notes"].extend(notes)
                position = end + 1 if end < len(clause) else len(clause)
            if clause_entries:
                clause_entries[-1]["_end"] = len(clause)
            for entry in clause_entries:
                # 「可用某汤」「合某丸」一类换方、合方：从该段原文里再扫一遍方名。
                raw = clause[entry["_start"]:entry["_end"]].strip().strip("，,、")
                for match in RE_FORMULA_TOKEN.finditer(strip_parens(raw)):
                    name, stripped = clean_formula_candidate(match.group(0), herbs_as_formula_guard)
                    if name and len(name) >= 3 and name not in lexicon and name not in entry["formulas"] and re.search(r"合|用|予|服|改|易|选|投", stripped or "") :
                        entry["formulas"].append(name)
                if not (entry["herbs"] or entry["remove"] or entry["formulas"]):
                    continue
                item = {
                    "condition": entry["condition"],
                    "herbs": entry["herbs"],
                    "remove": entry["remove"],
                    "formulas": entry["formulas"],
                    "raw": raw,
                }
                if entry["_notes"]:
                    item["note"] = "；".join(dict.fromkeys(entry["_notes"]))
                entries.append(item)
            if not clause_entries:
                # 没有加/去，但整句是「…者，可用/改用/合用 某方」。
                stripped_clause = strip_parens(clause)
                found: list[str] = []
                for match in RE_FORMULA_TOKEN.finditer(stripped_clause):
                    name, stripped = clean_formula_candidate(match.group(0), herbs_as_formula_guard)
                    if name and len(name) >= 3 and name not in lexicon and re.search(r"合|用|予|服|改|易|选|投", stripped or ""):
                        if name not in found:
                            found.append(name)
                if found and re.search(r"者|，", clause):
                    first_at = clause.find(found[0])
                    lead = clause[:first_at]
                    condition = re.sub(r"(?:则|亦|也|还|均|应|宜|当)?(?:可以|可)?(?:合用|改用|选用|加用|加服|配合|配服|合|用|予|投|服|选|宜|以)*$", "", lead.strip())
                    condition = RE_COND_TAIL.sub("", RE_COND_LEAD.sub("", condition.strip())).strip()
                    entries.append({"condition": condition, "herbs": [], "remove": [], "formulas": found, "raw": clause.strip("，,、")})
    return entries, unresolved


RE_WB_UNIT = r"(?:两|钱|分|枚|个|升|斤|合|条|片|茎|根|具|把|握|粒|只|挺|斗|尺|寸|铢|杯|碗|盏|匙|节|张|块|对|钟|字|颗|叶|朵|束|团|撮|厘|丸|茶匙|酒杯|大盏|小盏|斛)"
RE_WB_DOSE = re.compile(rf"^(?:各)?(?:[一二三四五六七八九十百半两]+{RE_WB_UNIT})+(?:半)?(?:许)?$")


def strip_classical_dose(token: str, lexicon: set[str]):
    """「麻黄（去节）四两」→「麻黄」；切不出干净药名返回 None。"""
    bare = strip_parens(token).strip()
    if not bare:
        return None
    for length in range(min(len(bare), 7), 1, -1):
        if bare[:length] in lexicon and (length == len(bare) or RE_WB_DOSE.match(bare[length:])):
            return bare[:length]
    for position in range(2, len(bare)):
        if RE_WB_DOSE.match(bare[position:]):
            name = bare[:position]
            return name if re.fullmatch(rf"[{CJK}]{{2,7}}", name) else None
    if re.fullmatch(rf"[{CJK}]{{2,6}}", bare) and not RE_WB_DOSE.match(bare):
        return bare
    return None


def listed_herbs(text: str) -> list[str]:
    """「A、B、C」原样切开（保留教材写法，含「犀角（用水牛角代）」这类括注）。"""
    herbs: list[str] = []
    for token in split_outside_parens(text, "、"):
        token = clean_listed_herb(token)
        if not token:
            continue
        match = re.match(rf"^([{CJK}]{{2,6}})合([{CJK}]{{2,8}}(?:散|丸|汤|丹))$", token)
        parts = [match.group(1), match.group(2)] if match else [token]
        for part in parts:
            if 1 < len(strip_parens(part)) <= 10 and not re.search(r"[，。；：]", strip_parens(part)):
                herbs.append(part)
            else:
                return []
    return herbs


# --------------------------------------------------------------------------------------
# 病名、别名、西医对应
# --------------------------------------------------------------------------------------
RE_ALIAS = re.compile(r"(?:又称为|又称|又名|亦称为|亦称|亦名|也称为|也称|俗称|古称|别称|别名|又叫|亦谓|又谓|亦曰|或称|古代称为|古代称|中医又称)(?:之为|为|作)?[:：]?")
RE_WESTERN_LEAD = re.compile(r"(?:现代)?西医(?:学)?(?:中|上)?(?:所称|所说|所指|所谓|称之为|称为|亦称|称|之)?(?:的)?")
RE_WESTERN_STOP = re.compile(r"可参|均可参|皆可参|也可参|亦可参|属于本|属本|归属|范畴|可按|可以参|等属|所致|引起|出现|。|；|，凡|，若|，当|，其|，临床|，在|，如|，以|时，|，可|，均|，皆|，而|，是|有相似|相类|类似|相似")


def quoted_names(text: str) -> list[str]:
    return [name for name in re.findall(r"“([^”]{1,14})”", text) if name]


def extract_aliases(intro: str, disease: str) -> list[str]:
    aliases: list[str] = []
    for match in RE_ALIAS.finditer(intro):
        tail = intro[match.end(): match.end() + 80]
        names: list[str] = []
        quoted = re.match(r"^(?:“[^”]{1,14}”(?:[、，或及和与]|以及)?)+", tail)
        if quoted:
            names = quoted_names(quoted.group(0))
        else:
            plain = re.match(rf"^([{CJK}A-Za-z、·\-]{{2,40}})", tail)
            if plain:
                body = re.split(r"等|之称|之名|之谓|的|是|为|者|而|属|其|即|，", plain.group(1))[0]
                names = [part for part in re.split(r"[、或及和与]", body) if part]
        for name in names:
            name = name.strip()
            if 1 < len(name) <= 14 and name != disease and name not in aliases and not GENERIC_TITLE.search(name) and not re.match(r"^[之的为作]", name):
                aliases.append(name)
    other = re.search(r"又有([^，。；]{2,40}?)(?:之|等)(?:别名|别称|名称|称)", intro)
    if other:
        for name in re.split(r"[、及和与]", other.group(1)):
            name = name.strip("“”")
            if 1 < len(name) <= 14 and name != disease and name not in aliases:
                aliases.append(name)
    return aliases


def extract_western(intro: str) -> list[str]:
    names: list[str] = []
    for sentence in re.split(r"(?<=[。])", intro):
        if "西医" not in sentence:
            continue
        for match in RE_WESTERN_LEAD.finditer(sentence):
            tail = sentence[match.end():]
            stop = RE_WESTERN_STOP.search(tail)
            body = tail[: stop.start()] if stop else tail
            body = re.sub(r"^(?:中|里)?的", "", body)
            body = re.sub(r"^(?:各种|多种|某些)[^，、。]{0,8}?(?:引起|所致|导致)的", "", body)
            body = re.split(r"[，,]|等", body)[0]
            body = re.sub(r"等(?:疾病|病证|病症|病变|病|症)?(?:的)?$", "", body.strip("，,、 "))
            for part in re.split(r"[、，]|以及|及其|及|和|或|与", body):
                part = re.sub(r"等(?:疾病|病证|病症|病)?$", "", part.strip())
                part = re.sub(r"^(?:亦称|称|的|中的|如)", "", part)
                part = re.sub(r"^(?:之|中)", "", part)
                if 1 < len(part) <= 18 and not re.search(r"[的是为而其与均皆各]|本病|本节|辨证|参照|治疗|诊断|认为|研究|中医|西医|表现|症状|多种|多个|原因|某些|一些|部分|其他|有关|相关|范畴|功能衰退|系统$", part) and part not in names:
                    names.append(part)
            if names:
                break
    return names


def extract_tcm_equivalents(intro: str) -> list[str]:
    names: list[str] = []
    for sentence in re.split(r"(?<=[。])", intro):
        if not re.search(r"中医|祖国医学", sentence):
            continue
        at = re.search(r"中医|祖国医学", sentence).start()
        for name in quoted_names(sentence[at:]):
            name = name.strip()
            if 1 < len(name) <= 10 and name not in names and re.fullmatch(rf"[{CJK}]+", name):
                names.append(name)
    return names


# --------------------------------------------------------------------------------------
# 鉴别诊断：栏目标题、条目里的病名
# --------------------------------------------------------------------------------------
# 各书【鉴别诊断】的写法不同（2026-10-14 逐书核对，各种写法的条数与样例见 --stats 的 differentialRules）。
# 原先只认「N.病名␠要点」和首段一句「与…鉴别」：运行时可取到的 331 个教材病名里 173 个取不到鉴别病名。
# 其中 59 个教材确实没有这一栏（内科各【附】篇、眼科大半），其余是下面几种写法没认出来（改后剩 65 个取不到）：
#   ① 「N.病名要点」病名与要点之间的空格在扫描时丢了（外科、儿科、骨伤）：依次试——括注之前、要点开头重复病名、
#      合集自己的病名词表的最长前缀、「多见于/好发于/初起…」这类起述词之前（断出来的名字须以病名常见的末字收尾）；
#   ② 栏目下只有一段、不编号的「病名␠要点」（内科：痢疾—泄泻、黄疸—萎黄、痹证—痿证…）；
#   ③ 「本病应与甲、乙、丙相鉴别（表6-1）」一句话，表不在合集里（妇科、眼科）：病名逐个拆开；
#   ④ 「甲与乙␠要点」，其中一边是本病自己的类型（内科：血证、痰饮、郁证；外科：癣、梅毒、疣）：取另一边；
#   ⑤ 「甲、乙␠要点」一条里并列几个病（内科：水肿—鼓胀、饮证）：逐个拆开。
# 口径：条目文字一律是教材原文的连续片段，不改写（以指向合集里没有的图表收尾的，到引用之前为止）；病名是条目里
# 逐字写出的名字（只订正 DIFF_NAME_OCR_FIXES 里的扫描错字、去掉括注）；认不准的病名留空（条目仍在），不猜。
# 原口径已经认出的病名照留，改动的只有这几类：几个病名并在一起的拆开；带括注的去掉括注；扫描错字订正；
# 不是病名的（被旧正则截断的半句、以「鉴别诊断」收尾的小标题）换成同一段里的真病名，取不出就留空。

# ---- 栏目与句式 ----
RE_DIFF_TITLE = re.compile(r"^(?:鉴别诊断|类证鉴别|病证鉴别|鉴别)(?:[（(]表[^（）()]{1,8}[)）])?$")
# 栏目名与第一段写在同一行（「2.鉴别诊断␠颅骨凹陷性骨折：本病好发于…」）：栏目名之后还有不少于 6 个字的正文。
RE_DIFF_TITLE_INLINE = re.compile(r"^(?:鉴别诊断|类证鉴别|病证鉴别)[\s　]*(?=[^\s　（(].{5})")
# 原口径的首段句式（保留，用来判断「原先在这一段认到了什么」）。它把「疾病/病」当作可省的后缀，会把「克山病」截成「克山」。
RE_DIFF_LEGACY_LIST = re.compile(r"与([^。，；]{2,30}?)(?:等)?(?:疾病|病证|病)?(?:相|进行|作|加以)?鉴别")
# 「（本病/某某）应与甲、乙、丙（等疾病）（相）鉴别」。「与甲鉴别的有乙、丙」里甲是本病的类型，不收；「发作相鉴别」的「作」不是助词。
RE_DIFF_SENTENCE = re.compile(
    r"与(?P<list>[^。；;，,：:]{2,90}?)"
    r"(?:等(?:[^、。；，]{0,10}?(?:疾病|病证|病症|病变|疾患|病|证|症))?|(?:[几多各]种|其他|其它|以下|下列)(?:疾病|病证|病症|病变))?"
    r"(?:进行|加以|相互|互相|相|(?<!发)作|做)?(?:的)?鉴别(?!的(?:有|疾病|病证|病种))"
)
# 「与」之前只能是主语加这类助动词、副词（「痛经应与…」「本病主要与…」「尚应与…」）；「甲与乙相鉴别」的甲不算。
RE_DIFF_SENTENCE_LEAD = re.compile(r"(?:应当|应该|必须|需要|应|需|须|当|宜|要|可|易|还|尚|亦|也|均|则|常|多|主要|首先|注意|于|并)$")
# 「除此之外，泌尿系结石、肿瘤、糖尿病、尿崩症等也可导致尿频，临床可结合相关检查进行鉴别」
RE_DIFF_SENTENCE_ALSO = re.compile(r"(?:^|[，,。；])(?P<list>[^，,。；：:]{4,60}?)等(?:疾病)?(?:也|亦|均|都)?可(?:导致|引起)[^。；]{0,40}?鉴别")

# 「本病须与其他原因所致的…内障眼病相鉴别。若晶珠混浊为与生俱来，称为胎患内障；外伤致晶珠混浊，称为惊震内障…」：
# 首句只说了一类病，具体的病名在后面的「称为某某」里。
RE_DIFF_CALLED = re.compile(rf"称为([{CJK}]{{2,8}}?)(?=[（(，,；;。])")
# 成对的限定语：「生理性啼哭…」「病理性啼哭…」两条并列时，限定语之后相同的那几个字就是病名的后半。
DIFF_QUALIFIER_PAIRS = [("生理性", "病理性"), ("原发性", "继发性"), ("真性", "假性"), ("良性", "恶性"), ("先天性", "后天性")]

# ---- 指向合集里没有的图表 ----
# 括注：「（表6-1）」「(见表9-4)」「（彩图8-13）」；整半句是指引：「，详见表11-2」「其鉴别要点见表10-1」。
RE_DIFF_TABLE_PAREN = re.compile(r"[（(]\s*(?:详见|参见|见)?\s*(?:表|彩图|图)\s*\d+\s*[-－–—]\s*\d+\s*[a-zA-Z]?\s*[)）]?")
RE_DIFF_TABLE_POINTER = re.compile(r"(?:详见|参见|见)\s*(?:表|彩图|图)\s*\d+\s*[-－–—]\s*\d+\s*[a-zA-Z]?")
RE_DIFF_TABLE_REF = re.compile(rf"{RE_DIFF_TABLE_PAREN.pattern}|{RE_DIFF_TABLE_POINTER.pattern}")
# 扫描版里表格被认成一行行碎字，表头是这几个词。
RE_DIFF_TABLE_DEBRIS = re.compile(r"^(?:鉴别点|整别点|续表)")

# ---- 病名的形状 ----
RE_DIFF_NAME = re.compile(rf"^[{CJK}A-Za-zα-ωⅠ-Ⅻ0-9·\-－]{{2,14}}$")
# 带这些字眼的是说明性的短语，不是病名（「其他原因所致的…」「以下疾病」「部分肥胖症」）。
RE_DIFF_NOT_NAME = re.compile(
    r"的|之|如|所致|所引起|引起|导致|其他|其它|某些|各种|多种|一些|(?:有关|相关)(?:疾病|病证|病变)|本病|本证|本症|该病|鉴别|诊断|以及|原因|"
    r"以下|下列|下述|上述|如下|发生在|发生于|等|是|[与和及或]|^(?:部分|少数|多数|个别|有些|有的|大多|所有|极少数|绝大多数)"
)
DIFF_NOT_NAMES = {
    "疾病", "病证", "病症", "病变", "症状", "两者", "二者", "三者", "后者", "前者", "患者", "患儿", "临床", "中医", "西医",
    "关键", "首先", "其次", "再次", "最后", "主要", "重点", "特点", "目的", "方法", "一般", "通常", "此外", "另外", "同时",
}
# 列举里承前省略剩下的部位词、病原体（「鼻腔、口腔及咽喉出血」「气管、支气管异物」「金黄色葡萄球菌、…败血症」）不是病名。
RE_DIFF_ORGAN = re.compile(r"(?:腔|管|肠|胃|腺|椎|膜|肤|脏|房|巢|宫|道|部|处|侧|菌|病毒|原体)$")
# 病名常见的收尾：只收疾病分类用字，不收「痛、血、热」这类症状字（「右侧输尿管结石腹痛」不能断成病名）。
RE_DIFF_NAME_SUFFIX = re.compile(
    r"(?:病|症|证|炎|癌|瘤|疮|痈|疽|疔|疖|疹|癣|痔|疝|瘿|岩|痨|疬|疣|疳|痫|痢|淋|疸|痹|痿|痘|厥|斑|风|毒|"
    r"翳|障|综合征|结核|囊肿|息肉|溃疡|脓肿|疖肿|血肿|肿瘤|梗阻|结石|贫血|紫癜|紫瘢|狭窄|畸形|坏疽|水肿|穿孔|积水|咬伤|螫伤|损伤|中毒|发作|失禁|早发育)$"
)
# 断出来的名字以这些字收尾的，是把要点的头一个字带进来了。
RE_DIFF_BAD_TAIL = re.compile(r"[这那此该其均都也亦乃即就并而但则不才又还仍只既便常多少更最很较甚极已曾将正者时后前仅可能会要需须应]$")

# ---- 病名与要点粘连时的断点 ----
# 病名之后不会紧跟这些：跟了就说明词表里的名字只是一个更长病名的前半截（「脂瘤染毒」「梅毒性溃疡」「卵巢囊肿扭转」）。
RE_DIFF_NAME_CONTINUES = re.compile(
    r"^(?:性|型|期|样|状|[、及和与或的之]|所致|所引起|引起|导致|合并|并发|继发|伴发|恶变|癌变|溃破|破溃|破裂|穿孔|扭转|嵌顿|脱出|染毒|感染|时|后|前|"
    r"病(?!变|在|程|灶|人|史|情|势|位|因|初|久|后|前|时|发|损|多|起))"
)
# 要点的起述词：病名到这里为止。
RE_DIFF_ONSET = re.compile(
    r"^(?:绝大多数|大多数|大多|多发生于|多发生在|多发生|多发于|多见于|多发|多见|多数|多为|多有|多由|多从|多在|多伴|多无|多因|"
    r"常发生于|常发生在|常见于|常发于|常有|常为|常在|常位于|常伴|常由|常因|常以|通常|好发于|好发|发生于|发生在|发于|生于|见于|位于|"
    r"发病|起病|初起|早期|典型|主要表现|主要由|主要|表现为|临床表现|一般|具有|持续|突发|是一种|是由|是指|是|的主症|系|为|有|无|可|虽|亦|也|由|因|以|除|"
    r"患处|患部|患者|患儿|病人|病变|病在|病程|病灶|皮损|皮疹|肿块|肿物|疼痛|分布|该病|本病|此病|这是|两者|二者|中医称|西医学|"
    r"[0-9０-９①-⑳]|X线|B超|CT)"
)
# 下定义的起述（「肌阵挛是癫痫发作的一个类型」「小便生成障碍的主症为…」）：其前的名字不要求以病名末字收尾。
RE_DIFF_DEFINING_ONSET = re.compile(r"^(?:是一种|是由|是指|是|的主症)")
# 病名之前的限定语：「男性乳岩」「新生儿水肿」——限定语加词表里的病名，仍是一个病名。
RE_DIFF_QUALIFIER = re.compile(r"^(?:男性|女性|小儿|儿童|成人|老年|新生儿|婴儿|婴幼儿|急性|慢性|亚急性|原发性|继发性|先天性|后天性|单纯性|复发性|早期|晚期)")

# ---- 病名里的扫描错字 ----
# 与 TITLE_OCR_FIXES 同一口径：只改病名这一处，条目文字不动。左为合集里的字形，右为教材的写法；每一条都能在同一本书
# 别处的正确写法或已有的节名订正里得到印证（「白尼」→「白疕」、「紫瘢风」→「紫癜风」已在节名订正里）。
DIFF_NAME_OCR_FIXES = [
    ("紫白瘢风", "紫白癜风"), ("白瘢风", "白癜风"), ("紫瘢", "紫癜"), ("座疮", "痤疮"), ("苔薛", "苔藓"),
    ("酒髓鼻", "酒齄鼻"), ("酒独鼻", "酒齄鼻"), ("白定", "白疕"), ("骶骼", "骶髂"), ("螟蚣", "蜈蚣"),
]


def fix_differential_name(name: str) -> str:
    for scanned, printed in DIFF_NAME_OCR_FIXES:
        name = name.replace(scanned, printed)
    return name


def diff_name_ok(name: str) -> bool:
    """像不像一个病名（只看形状）：2–14 个字，至少有一个汉字，不含「的、所致、其他、鉴别…」这类说明性的字眼。"""
    if not RE_DIFF_NAME.match(name) or not re.search(rf"[{CJK}]", name):
        return False
    return not RE_DIFF_NOT_NAME.search(name) and name not in DIFF_NOT_NAMES


def drop_parenthetical(name: str) -> str:
    """「乳岩(乳腺癌)」「粟疮（彩图8-13）」「原发性脑干损伤（primary」→ 括注之前的病名。"""
    return re.split(r"[（(]", name, maxsplit=1)[0].strip()


def split_listed_names(text: str, known: set[str] | None = None) -> list[str]:
    """「甲、乙及丙等疾病」→ [甲, 乙, 丙]。顿号隔开的某一项不像病名（承前省略、带说明字眼）就整体作废，返回 []。
    用「和、及、或」连起来的两项常共用后半截（「骶前囊肿和囊性畸胎瘤感染」「肾上腺皮质增生或肿瘤」「心源性及肾性腹水」）：
    这样拆出来的每一项都要以病名常见的末字收尾、或在合集的病名词表（known）里，否则这一组不收（其余各项照收）。"""
    body = nospace(text).strip("。：:")
    body = re.sub(r"等(?:[^、，。]{0,10}?(?:疾病|病证|病症|病变|疾患|病|证|症))?$", "", body)
    names: list[str] = []
    for chunk in split_outside_parens(body, "、"):
        pieces = [drop_parenthetical(part) for part in re.split(r"以及|及其|[及和或]", chunk)]
        pieces = [part for part in pieces if part]
        shaped = all(diff_name_ok(part) and not RE_DIFF_ORGAN.search(part) and not part.endswith("性") for part in pieces)
        if len(pieces) > 1:
            if not shaped or not all(RE_DIFF_NAME_SUFFIX.search(part) or (known and part in known) for part in pieces):
                continue
        elif not shaped:
            return []
        for part in pieces:
            if part not in names:
                names.append(part)
    return names


def cut_table_reference(text: str) -> str:
    """条目文字以图表引用收尾时，到引用之前为止（合集里没有这些表）；引用之后还有正文的原样保留。
    括注只去掉括注（「…相鉴别（表6-1）。」→「…相鉴别」）；「某某见表13-1」整半句都是指引，退到上一个句读
    （「…等。其鉴别要点见表10-1。」→「…等。」；「本病须与湿翳及凝脂翳相鉴别，详见表11-2。」→「…相鉴别」）。"""
    match = RE_DIFF_TABLE_REF.search(text)
    if not match:
        return text
    rest = text[match.end():].lstrip("。.o 　")
    if rest and not RE_DIFF_TABLE_DEBRIS.match(rest):
        return text
    if match.group(0)[0] in "（(":
        return text[: match.start()]
    cut = max(text.rfind(mark, 0, match.start()) for mark in "，,。；; 　")
    if cut < 0:
        return ""
    return text[: cut + 1] if text[cut] in "。；;" else text[:cut]


# --------------------------------------------------------------------------------------
# 单本书的抽取
# --------------------------------------------------------------------------------------
class BookParser:
    def __init__(self, book: dict, lines: list[str], start: int, end: int):
        self.book = book
        self.start = start
        self.end = end
        self.marker, self.roles = compile_markers(book)
        self.vl = build_vlines(lines, start, end, book, self.marker)
        self.rows: list[dict] = []
        self.skips: list[dict] = []
        self.disease_spans: list[dict] = []
        self.unresolved_herbs = 0
        self.differential_trace: list[dict] = []   # 每条鉴别条目是按哪种写法认出来的（只进 --stats，不进对照表）

    # ---- 段落（硬换行书把续行接回去） ----
    def paragraph(self, index: int, limit: int = 40):
        """从 index 起的一个自然段 → (文本, 下一段起点)。"""
        parts = [self.vl[index].text]
        position = index
        while (
            self.book["wrapped"]
            and self.vl[position].full
            and position + 1 < len(self.vl)
            and position - index < limit
            and not is_structural(self.vl[position + 1].text)
            and not (self.marker and self.marker.match(self.vl[position + 1].text))
        ):
            position += 1
            parts.append(self.vl[position].text)
        return join_wrapped(parts), position + 1

    # ---- 病名定位 ----
    def find_diseases(self):
        vl = self.vl
        count = len(vl)
        window = 90 if self.book["wrapped"] else 16
        starts: dict[int, dict] = {}
        chapter_dept = self.book["department"]
        western = bool(self.book.get("western")) or bool(self.book.get("western_until"))
        line_counts: dict[str, int] = {}
        for line in vl:
            if len(line.text) <= 26:
                key = nospace(line.text)
                line_counts[key] = line_counts.get(key, 0) + 1
        last_bracket = ""
        previous_rank = None
        chapter_title = ""
        section_title = ""
        for index, line in enumerate(vl):
            text = line.text
            if index - 1 in starts:
                last_bracket = ""
            found_bracket = RE_BRACKET.match(text)
            if found_bracket:
                last_bracket = found_bracket.group(1)
            if self.book.get("western_until") and nospace(text) == self.book["western_until"]:
                western = False
                starts[index] = {"kind": "break", "name": "", "dept": chapter_dept, "western": western}
                continue
            chapter = RE_CHAPTER.match(text)
            if chapter and len(text) <= 30:
                title = nospace(chapter.group(1))
                chapter_dept = self.book["department"]
                for needle, dept in self.book.get("dept_by_chapter", []):
                    if needle in title:
                        chapter_dept = dept
                kind = "disease" if self.book.get("disease_by_chapter") and title and not re.search(r"[《》论概]|诊法|治疗|预防|病因|辨证", title) else "break"
                if kind == "break" and title and not self.book.get("disease_by_chapter"):
                    # 不分节的章（「第二十章门静脉高压症」）：章名之后先见到【栏目】而不是「第一节」，这一章就是一个病。
                    for probe in range(index + 1, min(index + 1 + window, count)):
                        if RE_SECTION.match(vl[probe].text) or RE_CHAPTER.match(vl[probe].text):
                            break
                        if RE_BRACKET.match(vl[probe].text):
                            if not re.search(r"思考|目的|内容|小结", vl[probe].text):
                                kind = "disease"
                            break
                starts[index] = {"kind": kind, "name": title, "dept": chapter_dept, "western": western, "rank": 0}
                previous_rank = 0
                chapter_title = title
                section_title = ""
                continue
            section = RE_SECTION.match(text)
            if section and len(text) <= 40 and not self.book.get("disease_by_chapter"):
                name = nospace(section.group(1))
                if name.count("（") > name.count("）") and index + 1 < count and "）" in vl[index + 1].text[:8]:
                    # 节名折行：「第三节 脐部疾病（脐湿、脐疮、脐血、」+「脐突）」
                    name += nospace(vl[index + 1].text)
                name = TITLE_OCR_FIXES.get(self.book["key"], {}).get(name, name)
                if GENERIC_TITLE.search(name) and chapter_title and not GENERIC_TITLE.search(chapter_title) and chapter_title in name:
                    # 「第二节 休克的预防和治疗」：节名是栏目，病名取章名。
                    name = chapter_title
                starts[index] = {"kind": "disease", "name": name, "dept": chapter_dept, "western": western, "rank": 1}
                previous_rank = 1
                section_title = name
                continue
            appendix = RE_APPENDIX.match(text)
            if appendix and len(text) <= 30 and not self.book.get("disease_by_chapter"):
                starts[index] = {"kind": "disease", "name": nospace(appendix.group(1)), "dept": chapter_dept, "western": western, "rank": 2}
                previous_rank = 2
                continue
            if self.book.get("disease_by_chapter") or self.book.get("inline_sections_only"):
                continue
            # 节内再分的病：「一、月经先期」或单独成行的病名，须有定义段点到该名，且其后不远就有【栏目】。
            candidate = None
            numbered = numbering(text)
            if numbered and numbered[0] == 1 and len(text) <= 26:
                candidate = numbered[1]
            elif (
                self.book.get("bare_titles")
                and not numbered
                and 2 <= len(text) <= 26
                and not RE_BRACKET.match(text)
                and not re.search(r"[。，；：:,;？！“”]", text)
            ):
                next_is_opener = index + 1 < count and re.match(r"^【(?:中医)?(?:病因|解剖|概述|病理)", vl[index + 1].text)
                listed = line_counts.get(nospace(text), 0) >= 2
                if not (self.marker and self.marker.match(text)) and (next_is_opener or listed or not (index > 0 and vl[index - 1].full)):
                    candidate = text
            if candidate and numbered:
                # 「四、甲状腺炎的中医治疗」：节内各病分述之后合写的中医治疗，归回本节病名。
                shared = re.match(r"^(.+?)的(?:中医|中医药)?(?:辨证)?(?:治疗|论治|辨证论治|辨证施治)$", nospace(candidate))
                if shared and section_title and shared.group(1) == section_title:
                    starts[index] = {"kind": "disease", "name": section_title, "dept": chapter_dept, "western": western, "rank": 3}
                    previous_rank = 3
                    continue
            if not candidate or GENERIC_TITLE.search(candidate) or not re.search(rf"[{CJK}]", candidate):
                continue
            # 上一个【栏目】若是【临床表现】【诊断】这类，说明还在前一个病的正文中间，这只是其中的小标题（除非它后面紧跟【病因…】）。
            mid_monograph = bool(last_bracket) and not MONOGRAPH_CLOSING.search(last_bracket)
            name = nospace(candidate)
            in_contents = line_counts.get(name, 0) >= 2
            if re.fullmatch(r"[早中晚初后末]期|(?:急性|慢性|恢复|缓解|发作|进展|稳定|活动|迁延|围手术|围术)期|.*(?:阶段|型|者|疗法|手术|术)", name):
                continue
            first = re.split(r"[和与及、（(]", name)[0]
            mentioned = False
            bracket_at = None
            probe = index + 1
            reach = window
            while probe < count and probe - index <= reach:
                probe_text = vl[probe].text
                probe_bracket = RE_BRACKET.match(probe_text)
                if probe_bracket and re.search(r"病例|案例|病案|病历", probe_bracket.group(1)):
                    # 病名下先放一则病例，再写定义与【病因病理】：越过病例继续找。
                    reach += 14
                    probe += 1
                    continue
                if probe_bracket:
                    bracket_at = probe
                    break
                if RE_SECTION.match(probe_text) or RE_CHAPTER.match(probe_text) or RE_APPENDIX.match(probe_text):
                    break
                probe_numbered = numbering(probe_text)
                if probe_numbered and probe_numbered[0] == 1:
                    break
                if probe - index <= (60 if self.book["wrapped"] else 4) or reach > window:
                    body = nospace(probe_text)
                    if (
                        body.startswith(name)
                        or (len(first) >= 2 and body.startswith(first))
                        or f"“{name}”" in body
                        or f"称为{name}" in body
                        or f"称{name}" in body
                        or (len(first) == 1 and re.match(rf"^{re.escape(first)}(?:[（(][^）)]*[）)])?[是指为又属系]", body))
                    ):
                        mentioned = True
                probe += 1
            confirmed = False
            if bracket_at is not None:
                bracket_name = RE_BRACKET.match(vl[bracket_at].text).group(1)
                opener = bool(re.match(r"^(?:中医)?(?:病因|解剖|概述|病理)", bracket_name))
                if opener and (numbered or bracket_at == index + 1 or mentioned):
                    confirmed = True
                elif numbered and mentioned and not mid_monograph and not re.search(r"思考|案例|病例|病案|文献|目的|内容|小结", bracket_name):
                    confirmed = True
                elif not numbered and in_contents and (mentioned or bracket_at == index + 1) and not re.search(r"思考|案例|病例|病案|文献|目的|内容|小结", bracket_name):
                    # 单独成行的病名同时列在目录里（同一行文字在全书出现两次以上），且其后有定义句或紧跟【栏目】。
                    confirmed = True
            if not confirmed and numbered and previous_rank == 3 and not self.book["wrapped"] and not mid_monograph:
                # 「一、低血容量性休克 … 二、感染性休克」：同一节里并列的病，后一个没有【栏目】也另起。
                confirmed = True
            if confirmed:
                starts[index] = {"kind": "disease", "name": name, "dept": chapter_dept, "western": western, "rank": 3}
                previous_rank = 3
        self.starts = starts

    # ---- 证型块 ----
    def heading_name(self, text: str):
        """证型标题行 → (层级, 名称, 说明)；不像证型标题返回 None。"""
        numbered = numbering(text)
        level, rest = numbered if numbered else (BARE_LEVEL, text)
        note = ""
        rest = rest.strip()
        labelled = re.match(rf"^(?:内治|辨证论治|辨证治疗|中医治疗)[:：]\s*([{CJK}，、]{{2,14}}证)。?$", rest)
        if labelled:
            rest = labelled.group(1)
            note = "标题行写作「内治：某证」"
        elif " " in rest or "　" in rest:
            head = re.split(r"[\s　]+", rest, maxsplit=1)
            if RE_CLEAN_NAME.match(head[0]) and head[0].endswith("证") and len(head[1]) > 10:
                note = "标题行后带说明文字"
                rest = head[0]
            elif len(nospace(rest)) <= 26:
                rest = nospace(rest)
        if not RE_CLEAN_NAME.match(rest):
            return None
        if SECTION_TITLE.search(rest) and not rest.endswith("证"):
            return None
        if level == BARE_LEVEL and not (rest.endswith("证") or len(rest) <= 10):
            return None
        return level, rest, note

    def extract(self):
        if self.book.get("inline"):
            self.find_diseases()
            self.extract_inline()
            return
        self.find_diseases()
        vl = self.vl
        count = len(vl)
        manif_at = [i for i, line in enumerate(vl) if self.marker.match(line.text) and self.roles[self.marker.match(line.text).group(1)] == "manif"]
        heading_at = {i - 1 for i in manif_at if i > 0}
        manif_set = set(manif_at)
        stack: list[tuple[int, str]] = []
        disease = None
        disease_index = None
        for index, line in enumerate(vl):
            text = line.text
            if index in self.starts:
                info = self.starts[index]
                stack = []
                if info["kind"] == "disease":
                    disease = dict(info)
                    disease["line"] = line.no
                    disease["index"] = index
                    disease_index = index
                    self.disease_spans.append(disease)
                else:
                    disease = None
                continue
            if index in manif_set:
                self.build_row(index, heading_at, disease, stack)
                continue
            bracket = RE_BRACKET.match(text)
            if bracket and not (self.marker.match(text) if self.book.get("bracket") else False):
                stack = []
                continue
            numbered = numbering(text)
            if not numbered and index + 1 in heading_at and re.fullmatch(rf"[{CJK}]{{2,8}}", text) and index not in heading_at:
                # 不带编号的小类标题（「常证」「变证」「发作期」），紧接着就是编号证型。
                if numbering(vl[index + 1].text):
                    stack = [(0, text)]
                continue
            if numbered:
                level, rest = numbered
                title = rest
                if len(nospace(rest)) > 20:
                    head = re.split(r"[\s　]+", rest, maxsplit=1)[0]
                    title = head if len(head) <= 12 and len(head) < len(rest) else ""
                title = nospace(title)
                stack = [item for item in stack if item[0] < level]
                stack.append((level, title))
        del disease_index
        for span_index, span in enumerate(self.disease_spans):
            later = [other["index"] for other in self.disease_spans[span_index + 1:]]
            breaks = [i for i in self.starts if i > span["index"]]
            span["end"] = min(breaks) if breaks else count
            del later

    def build_row(self, manif_index: int, heading_at: set[int], disease, stack: list[tuple[int, str]]):
        vl = self.vl
        count = len(vl)
        heading_index = manif_index - 1
        heading_line = vl[heading_index]

        def skip(reason: str):
            self.skips.append({"book": self.book["key"], "line": vl[manif_index].no, "heading": heading_line.text[:40], "reason": reason})

        parsed = self.heading_name(heading_line.text) if heading_index >= 0 else None
        if parsed is None and not self.book["wrapped"] and heading_index >= 1:
            # 「二、暑秽」+ 一段说明 + 【证候】：标题在上上行，中间只隔一段正文。
            above = vl[heading_index - 1]
            if numbering(above.text) and not is_structural(heading_line.text) and not self.marker.match(heading_line.text):
                candidate = self.heading_name(above.text)
                if candidate and len(nospace(numbering(above.text)[1])) <= 12:
                    parsed = (candidate[0], candidate[1], "标题与证候之间隔一段说明")
                    heading_index -= 1
                    heading_line = above
        if parsed is None:
            skip("证候行上一行不是证型标题")
            return
        level, name, heading_note = parsed
        if disease is None:
            skip("不在任何病名节内")
            return
        if heading_index in self.starts:
            skip("证候行上一行是病名标题")
            return
        # 栏目：manif → (analysis) → therapy → formula → (comp/mods/usage) → 正文尾段
        fields: dict[str, list[str]] = {"manif": [self.marker.match(vl[manif_index].text).group(2)]}
        current = "manif"
        tail: list[str] = []
        tail_open = False
        index = manif_index + 1
        anomaly = ""
        field_notes: list[str] = []

        def later_marker_within(position: int, reach: int = 3) -> bool:
            """position 之后 reach 行内是否还有本块后续栏目（说明这行是当前栏目的续段）。"""
            for probe in range(position + 1, min(position + 1 + reach, count)):
                probe_text = vl[probe].text
                found = self.marker.match(probe_text)
                if found:
                    role = self.roles[found.group(1)]
                    return role != "manif" and ROLE_ORDER.index(role) >= ROLE_ORDER.index(current)
                if is_structural(probe_text) or probe in heading_at or probe in self.starts:
                    return False
            return False

        while index < count:
            text = vl[index].text
            if index in heading_at or index in self.starts:
                break
            match = self.marker.match(text)
            if match:
                role = self.roles[match.group(1)]
                content = match.group(2)
                if role == "manif":
                    break
                if role == "analysis":
                    fields["analysis"] = [content]
                    current = role
                    tail_open = False
                    index += 1
                    continue
                if role == "therapy" and "therapy" in fields and "formula" not in fields and RE_FORMULA_TOKEN.search(strip_parens(content)):
                    role = "formula"
                    field_notes.append("教材把方药行标作「治法」")
                if role in fields:
                    if role in ("therapy", "formula"):
                        anomaly = f"块内出现第二个「{match.group(1)}」"
                    break
                if ROLE_ORDER.index(role) < ROLE_ORDER.index(current):
                    anomaly = f"栏目顺序异常：{current}→{role}"
                    break
                fields[role] = [content]
                current = role
                tail_open = False
                index += 1
                continue
            if is_structural(text):
                break
            unknown = RE_UNKNOWN_LABEL.match(text)
            if current in ("formula", "comp", "mods", "usage"):
                if self.book["wrapped"]:
                    if vl[index - 1].full and not tail_open:
                        fields[current].append(text)
                    else:
                        # 硬换行书：方药段写完后的新自然段不属于本证。
                        break
                elif current == "usage":
                    fields["usage"].append(text)
                else:
                    if unknown and not self.label_is_formula(unknown.group(1), fields) and unknown.group(1) not in ("加减",):
                        break
                    tail.append(text)
                    tail_open = True
            else:
                if self.book["wrapped"] and vl[index - 1].full:
                    fields[current].append(text)
                elif later_marker_within(index):
                    fields[current].append(text)
                    if current == "therapy":
                        field_notes.append("治法栏下另有一段说明，一并收入")
                else:
                    anomaly = f"「{current}」之后出现无栏目的段落"
                    break
            index += 1
        if "therapy" not in fields and "formula" not in fields:
            skip(anomaly or "证候之后既无治法也无方药")
            return
        if anomaly and "therapy" not in fields:
            skip(anomaly)
            return
        joiner = join_wrapped
        manifestations = joiner(fields["manif"])
        if len(manifestations) < 4:
            skip("证候为空")
            return
        therapy = joiner(fields.get("therapy", [])).strip()
        formula_field = joiner(fields.get("formula", []))
        comp_field = joiner(fields.get("comp", []))
        mods_field = joiner(fields.get("mods", []))
        usage_field = joiner(fields.get("usage", []))
        notes: list[str] = list(dict.fromkeys(field_notes))
        if heading_note:
            notes.append(heading_note)
        if anomaly:
            notes.append(anomaly)
        # 「治法：…。方用某汤。」个别写在一行里
        if therapy and "formula" not in fields:
            match = re.match(r"^(.*?[。；，])\s*(?:方用|方选|方药用)(.+)$", therapy)
            if match:
                therapy, formula_field = match.group(1), match.group(2)
        therapy_clean = therapy.strip().rstrip("。．. ")
        if not formula_field and comp_field and RE_FORMULA_TOKEN.search(strip_parens(comp_field)):
            formula_field = comp_field
            notes.append("本证无主方行，方名取自「常用药」句")
        # group：祖先小标题里去掉栏目名
        ancestors = [title for lvl, title in stack if lvl < level and title]
        groups: list[str] = []
        for title in ancestors:
            cleaned = re.sub(r"(?:的)?(?:辨证论治|辨证治疗|辨证施治|分证论治|分型论治|证治分类|治疗|论治|证治)$", "", title)
            if not cleaned or GENERIC_TITLE.search(cleaned) or not RE_CLEAN_NAME.match(cleaned) or cleaned == disease["name"]:
                continue
            groups.append(cleaned)
        row = {
            "_book": self.book,
            "_disease": disease,
            "_level": level,
            "line": heading_line.no,
            "group": "／".join(groups),
            "syndrome": name,
            "manifestations": manifestations,
            "therapy": therapy_clean,
            "_formula_field": formula_field,
            "_comp_field": comp_field,
            "_mods_field": mods_field,
            "_usage_field": usage_field,
            "_tail": tail,
            "_notes": notes,
        }
        if not therapy_clean:
            notes.append("教材此证未写治法")
        self.rows.append(row)

    def label_is_formula(self, label: str, fields: dict) -> bool:
        return bool(re.search(rf"{FORMULA_SUFFIX}$", label)) and label not in ("处方", "主方", "验方")

    # ---- 《中医骨伤科学》叙述体 ----
    RE_INLINE = re.compile(
        rf"^(?:\d{{1,2}}\s*[.．]|[（(]\s*\d{{1,2}}\s*[)）]|[①-⑩])\s*(?P<name>[{CJK}]{{2,8}}?)(?P<kind>证|型)?\s*[：:]?\s*(?:者)?\s*"
        rf"(?P<verb>治疗原则为|治疗原则以|治以|治宜|宜)(?P<therapy>[^。；]*?)[，。]\s*(?:方用|可用|选用)(?P<formula>[^。；]+)[。；]"
    )

    def extract_inline(self):
        vl = self.vl
        count = len(vl)
        disease = None
        region = ""
        index = 0
        while index < count:
            line = vl[index]
            if index in self.starts:
                info = self.starts[index]
                disease = None
                if info["kind"] == "disease":
                    disease = dict(info)
                    disease["line"] = line.no
                    disease["index"] = index
                    self.disease_spans.append(disease)
                region = ""
                index += 1
                continue
            bracket = RE_BRACKET.match(line.text)
            if bracket:
                region = bracket.group(1)
                index += 1
                continue
            if region == "治疗" and numbering(line.text) and re.search(r"治疗原则|治以|治宜|宜", line.text[:24]):
                text, following = self.paragraph(index)
                match = self.RE_INLINE.match(text)
                if match and disease is not None:
                    name = match.group("name") + (match.group("kind") or "")
                    if STAGE_NAME.search(name) or GENERIC_TITLE.search(name) or re.search(r"[早初中后晚末]期|者$", name):
                        self.skips.append({"book": self.book["key"], "line": line.no, "heading": text[:40], "reason": "叙述体条目是分期或栏目名"})
                    else:
                        therapy = match.group("therapy").strip("，。 ")
                        therapy = re.sub(r"^(?:为|以)", "", therapy)
                        self.rows.append({
                            "_book": self.book, "_disease": disease, "_level": 3, "line": line.no, "group": "",
                            "syndrome": name, "manifestations": "", "therapy": therapy,
                            "_formula_field": match.group("formula").strip() + "。", "_comp_field": "", "_mods_field": "",
                            "_usage_field": "", "_tail": [text[match.end():]] if match.end() < len(text) else [],
                            "_notes": ["骨伤教材叙述体：证候表现未随证型列出，治法取自「治以/治疗原则为…」"],
                        })
                elif disease is not None:
                    self.skips.append({"book": self.book["key"], "line": line.no, "heading": text[:40], "reason": "叙述体条目不合「证名 治以…，方用…」"})
                index = following
                continue
            index += 1
        for span in self.disease_spans:
            breaks = [i for i in self.starts if i > span["index"]]
            span["end"] = min(breaks) if breaks else count

    # ---- 病的定义、别名、鉴别、诊断要点 ----
    def disease_info(self, span: dict, known: set[str] | None = None) -> dict:
        """known：合集自己的病名词表（build_disease_name_lexicon）；不给时鉴别条目只认写得清楚的病名。"""
        vl = self.vl
        start, end = span["index"] + 1, span["end"]
        name = span["name"]
        intro_parts: list[str] = []
        definition = ""
        index = start
        paragraphs = 0
        while index < end and paragraphs < 14:
            text = vl[index].text
            if RE_BRACKET.match(text) or (numbering(text) and paragraphs > 0 and not self.book.get("disease_by_chapter")):
                break
            if numbering(text):
                break
            body, index = self.paragraph(index)
            paragraphs += 1
            if re.match(rf"^[{CJK}]{{1,3}}某[，,]", body) or re.search(r"[，,](?:男|女)[，,]\s*\d+\s*(?:岁|个月|天)", body[:30]):
                continue
            intro_parts.append(body)
            compact = nospace(body)
            first = re.split(r"[和与及、（(]", name)[0]
            if not definition and (compact.startswith(name) or (len(first) >= 2 and compact.startswith(first)) or f"“{name}”" in compact[:120] or compact.startswith("本病")):
                definition = body
        if not definition and intro_parts:
            definition = intro_parts[0]
        sentence = re.match(r"^[^。]*。", definition)
        definition = (sentence.group(0) if sentence else definition)[:200]
        intro = "".join(intro_parts)
        western = span.get("western")
        info = {
            "definition": definition,
            "diseaseAliases": extract_aliases(intro, name),
            "westernEquivalents": [] if western else extract_western(intro),
            "tcmEquivalents": extract_tcm_equivalents(intro) if western else [],
            "differentials": [],
            "diagnosisPoints": [],
        }
        # 鉴别诊断 / 诊断要点
        context = self.differential_context(span, info, known)
        index = start
        while index < end:
            text = vl[index].text
            bracket = RE_BRACKET.match(text)
            numbered = numbering(text)
            title = bracket.group(1) if bracket else (nospace(numbered[1]) if numbered and len(nospace(numbered[1])) <= 10 else "")
            level = 0 if bracket else (numbered[0] if numbered else None)
            # 「（三）鉴别诊断（表7-1）」比 10 个字长，鉴别栏目的标题另取，不走上面的长度上限。
            differential_title = bracket.group(1) if bracket else (nospace(numbered[1]) if numbered else "")
            inline = RE_DIFF_TITLE_INLINE.match(numbered[1]) if numbered else None
            if differential_title and RE_DIFF_TITLE.match(differential_title) and not info["differentials"]:
                info["differentials"] = self.collect_differentials(index + 1, end, level, context)
            elif inline and not info["differentials"]:
                # 「2.鉴别诊断␠甲状腺癌应与…鉴别。」「2. 鉴别诊断应判断不育的原因…」：栏目名与第一段写在同一行。
                body, following = self.paragraph(index)
                opening = RE_DIFF_TITLE_INLINE.sub("", numbering(body)[1], count=1)
                info["differentials"] = self.collect_differentials(following, end, level, context, opening=(vl[index].no, opening))
            elif title and re.fullmatch(r"(?:诊断要点|诊断依据|诊断|临床诊断|诊查要点)", title) and not info["diagnosisPoints"]:
                info["diagnosisPoints"] = self.collect_points(index + 1, end, level)
            index += 1
        return info

    # ---- 鉴别诊断 ----
    def differential_context(self, span: dict, info: dict, known: set[str] | None) -> dict:
        """一个病的鉴别栏目解析时要用到的东西。
        own  ：本病自己的名字——病名及其各部分、别名与西医对应名、教材在本病下分的小类（血证的鼻衄、齿衄…）。
        same ：只含与本病同名的那一层（病名及其各部分、别名）。「本病应与甲、乙鉴别」里列出来的病只去掉这一层：
               教材明说要鉴别的，即使又写了「可参照本病辨证」（痛经与盆腔炎性疾病）也照收。
        known：合集自己的病名词表；建词表的那一遍为 None，只走写得清楚的几种写法。"""
        name = span["name"]
        same = {name, "本病", "本证", "本症"}
        same.update(part for part in re.split(r"[、与和及（）()]", name) if len(part) >= 2)
        same.update(info["diseaseAliases"])
        own = set(same)
        own.update(info["westernEquivalents"])
        own.update(info["tcmEquivalents"])
        for row in self.rows:
            if row["_disease"]["index"] != span["index"]:
                continue
            own.update(part for part in row["group"].split("／") if part)
            kind, type_name = syndrome_kind_and_name(row["syndrome"])
            if kind == "type":
                own.add(type_name)
        return {"disease": name, "own": own, "same": same, "known": known, "wrapped": bool(self.book["wrapped"])}

    @staticmethod
    def own_side(part: str, context: dict) -> bool:
        """并列标题的这一边说的是不是本病（「郁证梅核气」「慢性湿疮」「未破损期输卵管妊娠」「跖疣」）。"""
        own = context["own"]
        if part in own:
            return True
        disease = context["disease"]
        if len(disease) == 1:
            return part.endswith(disease) and len(part) <= 3
        return any(len(name) >= 2 and name in part for name in own)

    def collect_differentials(self, start: int, end: int, level: int, context: dict, opening: tuple[int, str] | None = None):
        """opening：栏目名与第一段写在同一行时的那一段（行号, 文字）。原口径认不到这种栏目，所以这一段不走原口径的首段句式。"""
        vl = self.vl
        paragraphs: list[tuple[int, str]] = [opening] if opening else []
        index = start
        while index < end and len(paragraphs) < 80:
            text = vl[index].text
            if RE_BRACKET.match(text):
                break
            numbered = numbering(text)
            if numbered and level and numbered[0] <= level:
                break
            line = vl[index].no
            body, index = self.paragraph(index)
            paragraphs.append((line, body))
        # 栏目下有编号条目时，不编号的段落只是引语或补充说明，不当作一条「病名␠要点」。
        itemized = any(numbering(body) and len(numbering(body)[1]) > 12 for _line, body in paragraphs)
        items: list[dict] = []
        position: dict[str, int] = {}
        counted = 0     # 原口径下已有的条目数：首段「与…鉴别」只在此前没有条目时才认，条目满 12 条为止

        def extend(found: list[dict], line: int):
            for item in found:
                item["line"] = line
                name = item["name"]
                if name and name in position:
                    at = position[name]
                    if items[at].get("listed") and not item.get("listed"):
                        # 一句话里点到的病，后面另有专条的，用专条的文字。
                        items[at] = item
                    continue
                if name:
                    position[name] = len(items)
                items.append(item)

        for line, body in paragraphs:
            if counted >= 12:
                break
            numbered = numbering(body)
            if numbered:
                rest = numbered[1]
                if len(rest) > 12:
                    extend(self.differential_entry(rest, context), line)
                    counted += 1
                continue
            if RE_DIFF_TABLE_DEBRIS.match(nospace(body)):
                break
            legacy = None
            if counted == 0 and not opening:
                match = RE_DIFF_LEGACY_LIST.search(body)
                if match and len(body) > 20:
                    legacy = {"name": match.group(1), "text": body[:400], "rule": "首段与…鉴别（原有）"}
                    if re.match(r"疾病|病证|病", body[match.end(1):]):
                        # 原正则把「疾病/病」当作可省的后缀吞掉了，留下的是半截（「与引起水肿的多种疾病相鉴别」→「引起水肿的多种」，
                        # 「与扩张型心肌病鉴别的有…」→「扩张型心肌」）。完整的写法下面会再认一次，认不出病名时这半截不当病名用。
                        legacy = {"name": "", "text": body[:400], "rule": "首段与…鉴别：原病名是被截断的半句，留空"}
                    counted += 1
            extend(self.differential_paragraph(body, context, legacy=legacy, single=not itemized), line)
            if self.book["wrapped"] and RE_DIFF_TABLE_REF.search(body):
                # 扫描版的书里，引用的表格被认成一行行碎字，到此为止。
                break
        self.name_by_siblings(items, context)
        out: list[dict] = []
        for item in items:
            name, text = fix_differential_name(item["name"]), cut_table_reference(item["text"])
            first_stop = text.find("。")
            if item.get("listed") and 0 < first_stop < len(text) - 1 and RE_DIFF_TABLE_REF.search(text[:first_stop]):
                # 「本病应与粟疮（彩图8-13）相鉴别。二者症状相似…」：列举的那一句里夹着图表引用、后面另有要点时，从要点起。
                text = cut_table_reference(text[first_stop + 1:])
            if name != item["name"] and text.startswith(item["name"]):
                # 病名订正了扫描错字的条目，文字从病名之后起（开头那个错字形的病名不再重复）。
                text = text[len(item["name"]):].lstrip()
            out.append({"name": name, "text": text})
            if context["known"] is not None:
                self.differential_trace.append({
                    "book": self.book["key"], "disease": context["disease"], "line": item["line"], "rule": item.get("rule", ""),
                    "name": name, "scanned": item["name"] if name != item["name"] else "", "text": text[:60],
                })
        return out

    def name_by_siblings(self, items: list[dict], context: dict):
        """同一栏目里几条病名的末两字相同（「生理性黄疸…」「病理性黄疸…」；「梅毒性溃疡」与「结核性溃疡溃疡的形状…」），
        或与本病病名的末两字相同（缺铁性贫血的「地中海贫血…」）：没断开的那几条就在这两个字之后断开。"""
        if context["known"] is None:
            # 建词表的那一遍不走这一步（这样断出来的名字不进词表）。
            return
        disease = context["disease"]
        support: dict[str, int] = {}
        for item in items:
            if item["name"] and len(item["name"]) >= 3 and not item.get("listed"):
                support[item["name"][-2:]] = support.get(item["name"][-2:], 0) + 1
        if len(disease) >= 4:
            support[disease[-2:]] = support.get(disease[-2:], 0) + 1
        candidates: dict[str, list[tuple[dict, str]]] = {}
        for item in items:
            if item["name"] or item.get("listed"):
                continue
            text = item["text"]
            tried: set[str] = set()
            for size in range(3, min(len(text), 13)):
                head, tail = text[:size], text[size - 2:size]
                if tail in tried:
                    continue
                tried.add(tail)
                if not diff_name_ok(head) or not RE_DIFF_NAME_SUFFIX.search(head) or RE_DIFF_NAME_CONTINUES.match(text[size:]):
                    continue
                if head in context["own"] or (len(disease) >= 2 and disease in head):
                    # 「乳晕部疖粉刺性乳痈在急性期…」：断点落在本病病名之后，不是病名的结尾。
                    continue
                straddles = False
                for begin in range(max(2, size - 3), size):
                    onset = RE_DIFF_ONSET.match(text[begin:])
                    if onset and begin + len(onset.group(0)) >= size and len(onset.group(0)) >= 2:
                        # 「手发背病变部位…」「颈痈发病在…」：这个「病」是「病变」「发病」里的字。
                        straddles = True
                if not straddles:
                    candidates.setdefault(tail, []).append((item, head))
        for tail, found in candidates.items():
            if len(found) + support.get(tail, 0) < 2:
                continue
            for item, head in found:
                if not item["name"]:
                    item["name"] = head
                    item["rule"] = "同栏末两字相同"
        # 「生理性啼哭小儿哭时…」「病理性啼哭因疾病引起…」：成对的限定语之后相同的那几个字，到两条分岔处为止。
        unnamed = [item for item in items if not item["name"] and not item.get("listed")]
        for first, second in DIFF_QUALIFIER_PAIRS:
            for left in unnamed:
                for right in unnamed:
                    if left["name"] or right["name"] or not left["text"].startswith(first) or not right["text"].startswith(second):
                        continue
                    left_rest, right_rest = left["text"][len(first):], right["text"][len(second):]
                    shared = 0
                    while shared < min(len(left_rest), len(right_rest), 6) and left_rest[shared] == right_rest[shared]:
                        shared += 1
                    for cut in range(1, shared):
                        if RE_DIFF_ONSET.match(left_rest[cut:]):
                            shared = cut
                            break
                    if shared >= 2 and diff_name_ok(first + left_rest[:shared]) and diff_name_ok(second + right_rest[:shared]):
                        left["name"], right["name"] = first + left_rest[:shared], second + right_rest[:shared]
                        left["rule"] = right["rule"] = "同栏成对限定语"

    def differential_entry(self, rest: str, context: dict) -> list[dict]:
        """一条编号的鉴别条目 → [{name, text, rule}]。先按原口径取（空格或冒号之前是病名），取不到、或取到的是并列标题时再细分。"""
        head = re.split(r"[\s　]+", rest, maxsplit=1)
        name, description = "", ""
        if len(head) == 2 and 1 < len(head[0]) <= 16 and not re.search(r"[，。；]", head[0]):
            name, description = head[0].rstrip("：:"), head[1]
        else:
            colon = re.match(rf"^([{CJK}A-Za-z、·\-]{{2,16}})[:：]", rest)
            if colon:
                name, description = colon.group(1), rest[colon.end():]
        whole = {"name": name, "text": rest[:400], "rule": "编号：病名␠要点（原有）" if name else ""}
        if name:
            plain = re.sub(r"[（(][^（）()]*[)）]?", "", name)
            if not re.search(r"[与和及、]|鉴别", plain):
                if plain != name and diff_name_ok(plain):
                    return [{"name": plain, "text": rest[:400], "rule": "编号：病名（括注）␠要点"}]
                return [whole]
            names = self.resolve_heading(name, description, context)
            if names:
                return [{"name": item, "text": description[:400], "rule": "编号：并列标题␠要点"} for item in names]
            if "鉴别" in plain:
                # 「2.已破损期输卵管妊娠的鉴别诊断　已破损期输卵管妊娠需与流产、…相鉴别」：标题是栏目，病名在下一句。
                listed = self.listed_in_sentences(description, context)
                if listed:
                    return [{"name": item, "text": description[at:][:400], "listed": True, "rule": "编号：小标题下一句话列举"} for item, at in listed]
                examples = re.match(r"^如([^，。；：]{2,80}?)等", description)
                if examples:
                    # 「与其他原因引起的肝肿大鉴别␠如慢性肝炎、原发性肝癌、…等。」
                    names = [item for item in split_listed_names(examples.group(1), context["known"]) if item not in context["own"]]
                    if names:
                        return [{"name": item, "text": description[:400], "listed": True, "rule": "编号：小标题下举例"} for item in names]
                if re.search(r"鉴别(?:诊断|要点)?$", plain):
                    # 「闭经的鉴别诊断」「出血的鉴别」是小标题，不是病名：条目照留，病名留空。
                    return [{"name": "", "text": rest[:400], "rule": "编号：小标题不是病名，留空"}]
            whole["rule"] = "编号：并列标题（未拆，原有）"
            return [whole]
        found = self.glued_items(rest, context, "编号")
        if found:
            return found
        examples = re.match(r"^[^，。；：\s]{2,14}?如([^，。；：\s]{2,40}?)等", rest)
        if examples:
            # 「发疹性皮肤病及传染病如麻疹、猩红热等␣药毒起疹前有明确的用药史…」：一类病，教材举了例。
            names = [item for item in split_listed_names(examples.group(1), context["known"]) if item not in context["own"]]
            if names:
                return [{"name": item, "text": rest[:400], "listed": True, "rule": "编号：某类病如甲、乙等"} for item in names]
        # 整条就是一句「某某应与甲、乙相鉴别」：「与」在句首不远处，或「与」之前说的是本病
        #（「主动脉粥样硬化引起的…，应与…」）。条目讲的是另一个病、末尾才说「可与…相鉴别」的不算
        #（「神经源性膀胱…应与前列腺增生症鉴别」里后者正是本病）。
        first_sentence = re.match(r"^[^。]*。?", rest).group(0)
        opening = RE_DIFF_SENTENCE.search(first_sentence)
        if opening and (opening.start() <= 16 or any(len(item) >= 2 and item in first_sentence[: opening.start()] for item in context["same"])):
            listed = self.listed_in_sentences(first_sentence, context)
            if listed:
                return [{"name": item, "text": rest[:400], "listed": True, "rule": "编号：整条一句话列举"} for item, _at in listed]
        return [whole]

    def differential_paragraph(self, body: str, context: dict, legacy: dict | None, single: bool) -> list[dict]:
        """栏目下不编号的一段 → [{name, text, rule}]；不是「与…鉴别」的句子、也不是一条「病名␠要点」时返回 []。
        legacy：原口径在这一段取到的条目（首段第一处「与…鉴别」，病名未拆开）；新写法拆不出病名时照旧保留它。"""
        listed = self.listed_in_sentences(body, context, lenient=legacy is not None)
        if listed:
            return [{"name": item, "text": body[at:][:400], "listed": True, "rule": "不编号：一句话列举"} for item, at in listed]
        if RE_DIFF_SENTENCE.search(body):
            called = [item for item in RE_DIFF_CALLED.findall(body) if diff_name_ok(item) and RE_DIFF_NAME_SUFFIX.search(item) and item not in context["own"]]
            if called:
                return [{"name": item, "text": body[:400], "listed": True, "rule": "不编号：与某类病鉴别，称为某某"} for item in dict.fromkeys(called)]
        if legacy:
            return [legacy]
        if not single:
            return []
        pair = re.match(rf"^([{CJK}]{{2,10}})与([{CJK}]{{2,10}}?)(?=两者|二者|均|都|皆|虽)", body)
        if pair and self.own_side(pair.group(1), context) and diff_name_ok(pair.group(2)) and pair.group(2) not in context["own"]:
            # 「产后血晕与产后子痫两者都发生于新产之际…」
            return [{"name": pair.group(2), "text": body[:400], "rule": "不编号：本病与某病两者…"}]
        head = re.split(r"[\s　]+", body, maxsplit=1)
        if len(head) == 2 and len(head[1]) >= 8 and not re.search(r"[，。；]", head[0]):
            name = head[0].rstrip("：:")
            plain = re.sub(r"[（(][^（）()]*[)）]?", "", name)
            if re.search(r"[与和及、]|鉴别", plain):
                names = self.resolve_heading(name, head[1], context)
                if names:
                    return [{"name": item, "text": head[1][:400], "rule": "不编号：并列标题␠要点"} for item in names]
            elif diff_name_ok(plain) and plain not in context["own"]:
                return [{"name": plain, "text": body[:400], "rule": "不编号：病名␠要点"}]
        colon = re.match(rf"^([{CJK}A-Za-z·\-]{{2,16}})[:：]", body)
        if colon and diff_name_ok(colon.group(1)) and colon.group(1) not in context["own"]:
            # 「颅骨凹陷性骨折：本病好发于额骨及顶骨…」
            return [{"name": colon.group(1), "text": body[:400], "rule": "不编号：病名：要点"}]
        found = self.glued_items(body, context, "不编号")
        if found:
            return found
        comma = re.match(rf"^([{CJK}]{{2,10}})，(?:中医称|又称|亦称)", body)
        if comma and diff_name_ok(comma.group(1)) and RE_DIFF_NAME_SUFFIX.search(comma.group(1)) and comma.group(1) not in context["own"]:
            # 「过敏性鼻炎，中医称“鼻鼽”。临床以…」：文字从逗号之后起（病名已在 name 里）。
            return [{"name": comma.group(1), "text": body[len(comma.group(1)) + 1:][:400], "rule": "不编号：病名，中医称…"}]
        return []

    def glued_items(self, text: str, context: dict, where: str) -> list[dict]:
        """病名与要点粘在一起的一条 → [{name, text, rule}]；断不开、或断出来的是本病自己时返回 []。"""
        heading, description, rule = self.glued_heading(text, context)
        if not heading:
            return []
        if re.search(r"[与和及或、]|鉴别", heading):
            names = self.resolve_heading(heading, description, context)
            return [{"name": item, "text": description[:400], "rule": f"{where}：并列标题粘连（{rule}）"} for item in names]
        if heading in context["own"]:
            return []
        if description.startswith("，"):
            # 「过敏性鼻炎，中医称“鼻鼽”。临床以…」：病名之后是逗号，文字从逗号之后起（病名已在 name 里）。
            return [{"name": heading, "text": description[1:][:400], "rule": f"{where}：病名粘连（{rule}）"}]
        return [{"name": heading, "text": text[:400], "rule": f"{where}：病名粘连（{rule}）"}]

    def listed_in_sentences(self, text: str, context: dict, lenient: bool = False) -> list[tuple[str, int]]:
        """「本病应与甲、乙、丙等相鉴别」→ [(甲, 句首位置), (乙, …), (丙, …)]（去掉本病自己的名字）。
        句首位置：点到这个病名的那一句在 text 里从哪里开始——条目文字从这一句起，而不是从段首起。
        lenient：原口径认首段第一处时不看「与」之前是什么。"""
        found: list[tuple[str, int]] = []

        def add(listed: str, at: int):
            sentence_start = text.rfind("。", 0, at) + 1
            for name in split_listed_names(listed, context["known"]):
                if name not in context["same"] and all(name != seen for seen, _start in found):
                    found.append((name, sentence_start))

        for position, match in enumerate(RE_DIFF_SENTENCE.finditer(text)):
            clause_start = max(text.rfind(mark, 0, match.start()) for mark in "，,；;。：:") + 1
            lead = nospace(text[clause_start:match.start()])
            if not (lenient and position == 0) and lead and lead not in context["own"] and not RE_DIFF_SENTENCE_LEAD.search(lead):
                continue
            add(match.group("list"), match.start())
        for match in RE_DIFF_SENTENCE_ALSO.finditer(text):
            add(re.sub(r"^(?:除此之外|此外|另外)[，,]?", "", match.group("list")), match.start("list"))
        return found

    def resolve_heading(self, heading: str, description: str, context: dict) -> list[str]:
        """「甲与乙」「甲、乙」「与甲鉴别」一类条目标题 → 要鉴别的病名。分不清哪一边是本病时返回 []（条目保持原样）。"""
        own, known = context["own"], context["known"]
        text = nospace(heading).rstrip("。：:")
        topic = bool(re.search(r"的鉴别(?:诊断|要点)?$", text))
        text = re.sub(r"(?:的)?(?:相|进行)?鉴别(?:诊断|要点)?$", "", text)
        lead = re.match(r"^(?:需|应|须|当|宜|要)?与(.+)$", text)
        if lead:
            return [name for name in split_listed_names(lead.group(1), known) if name not in own]
        if "与" not in text:
            if topic:
                # 「脾大和脾功能亢进的鉴别」「腹水的鉴别」是小标题：说的是要分辨的表现，不是要鉴别的病。
                return []
            names = split_listed_names(text, known)
            return [name for name in names if name not in own] if len(names) >= 2 else []
        left, right = text.split("与", 1)
        left_names, right_names = split_listed_names(left, known), split_listed_names(right, known)
        if not left_names or not right_names:
            return []
        left_own = [self.own_side(name, context) for name in left_names]
        right_own = [self.own_side(name, context) for name in right_names]
        opening = nospace(description)
        if any(left_own) and not all(right_own) and (all(left_own) or not any(right_own)):
            chosen = [name for name, mine in zip(right_names, right_own) if not mine]
        elif any(right_own) and not all(left_own) and (all(right_own) or not any(left_own)):
            chosen = [name for name, mine in zip(left_names, left_own) if not mine]
        elif any(left_own) or any(right_own):
            return []
        elif opening.startswith("后者"):
            chosen = right_names
        elif context["wrapped"] and opening.startswith(nospace(drop_parenthetical(left))):
            # 外科、儿科的写法：标题之后先讲要鉴别的那个病（「白屑风与白秃疮␠白屑风多见于青年人…」）。
            chosen = left_names
        elif context["wrapped"] and opening.startswith(nospace(drop_parenthetical(right))):
            chosen = right_names
        else:
            return []
        return [name for name in chosen if name not in own]

    def glued_heading(self, text: str, context: dict) -> tuple[str, str, str]:
        """病名与要点粘在一起的条目 → (病名或并列标题, 其后的要点, 用的是哪一条判据)；断不开返回 ("", "", "")。"""
        known = context["known"]
        head = re.split(r"[\s　]+", text, maxsplit=1)
        if len(head) == 2 and 16 < len(head[0]) <= 30 and "、" in head[0] and not re.search(r"[，。；]", head[0]):
            return head[0], head[1], "较长的并列标题"
        # ① 病名后紧跟括注：「乳岩(乳腺癌)粉刺性乳痈在…」「水疥（丘疹样荨麻疹）多见春夏之交…」
        paren = re.match(rf"^([{CJK}A-Za-z0-9·\-]{{2,14}})[（(]([^（）()]{{1,60}})[)）]", text)
        if paren and diff_name_ok(paren.group(1)):
            name, note = paren.group(1), nospace(paren.group(2))
            note_is_name = bool(re.fullmatch(r"[A-Za-z，,.\- ]+", paren.group(2))) or (diff_name_ok(note) and bool(RE_DIFF_NAME_SUFFIX.search(note)))
            if RE_DIFF_NAME_SUFFIX.search(name) or (known and name in known) or note_is_name:
                return name, text[paren.end():], "括注之前"
        # ② 「硬下疳与软下疳后者病原菌为…」「扁平苔薛与扁瘊相鉴别。该病多发于…」
        latter = re.match(r"^([^，。；：\s]{2,14}与[^，。；：\s]{2,18}?)(?=后者)", text)
        if latter:
            return latter.group(1), text[latter.end():], "「后者」之前"
        versus = re.match(r"^([^，。；：\s]{2,14}与[^，。；：\s]{2,18}?(?:相)?鉴别)。", text)
        if versus:
            return versus.group(1), text[versus.end():], "「甲与乙相鉴别。」"
        # ③ 要点开头重复病名：「精囊炎精囊炎和慢性前列腺炎多同时发生…」「白屑风与白秃疮白屑风多见于青年人…」
        for size in range(2, 17):
            width = 3 if size >= 3 else 2
            if len(text) >= size + width and text[size:size + width] == text[:width]:
                candidate = text[:size]
                if candidate[-1] in "被把因由为是在" and diff_name_ok(candidate[:-1]) and RE_DIFF_NAME_SUFFIX.search(candidate[:-1]):
                    # 「毒虫咬伤被毒虫咬伤后…」：重复之前夹着一个虚字。
                    return candidate[:-1], text[size - 1:], "要点重复病名"
                if re.fullmatch(rf"[{CJK}A-Za-z、与和及·\-]+", candidate) and not RE_DIFF_BAD_TAIL.search(candidate) and candidate[-1] not in "被把因由为是在":
                    if re.search(r"[与和及、]", candidate) or diff_name_ok(candidate):
                        return candidate, text[size:], "要点重复病名"
                break
        # ④ 合集自己的病名词表里最长的前缀；「男性乳岩」这样限定语加词表里的病名也算
        if known:
            for size in range(min(14, len(text) - 2), 1, -1):
                candidate = text[:size]
                qualifier = RE_DIFF_QUALIFIER.match(candidate)
                if candidate in known or (qualifier and candidate[qualifier.end():] in known and diff_name_ok(candidate)):
                    if not RE_DIFF_NAME_CONTINUES.match(text[size:]):
                        return candidate, text[size:], "合集病名词表" if candidate in known else "限定语加词表病名"
                    break
        # ④′ 要点的第一个字与病名的第一个字相同（「腋疽␣腋部肿块初起…」「脐风␣脐部不痛不肿…」）：只在扫描版的书里用，
        # 建词表的那一遍不走这一步。
        if context["wrapped"] and known is not None:
            for size in range(2, min(len(text) - 1, 7)):
                candidate = text[:size]
                if text[size] == text[0] and diff_name_ok(candidate) and RE_DIFF_NAME_SUFFIX.search(candidate) and not RE_DIFF_NAME_CONTINUES.match(text[size:]):
                    return candidate, text[size:], "要点首字与病名首字相同"
        # ⑤ 在起述词之前断开，断出来的名字须以病名常见的末字收尾（或在词表里）。建词表的那一遍不走这一步。
        disease = context["disease"]
        for size in range(2, min(len(text), 16) if known is not None else 0):
            onset = RE_DIFF_ONSET.match(text[size:])
            if onset and text[size] == "因" and text[size - 1] == "病":
                # 「…一组病因不明的…」：「病因」不是「病」加起述词。
                continue
            candidate = text[:size]
            if not onset:
                # 要点以本病病名开头（「乳晕部疖␣粉刺性乳痈在急性期…」）也算断点；断出来不像病名时接着往后找
                #（「血栓性外痔大多…」里的「外痔」是病名的后半截）。
                if len(disease) >= 2 and text.startswith(disease, size) and diff_name_ok(candidate) and RE_DIFF_NAME_SUFFIX.search(candidate):
                    return candidate, text[size:], "要点以本病病名开头"
                continue
            if re.search(r"[、或和及]", candidate):
                # 「支气管炎、肺炎␣无鸡鸣样吸气性吼声…」「风疹或荨麻疹␣亦可见皮肤红疹…」
                parts = split_listed_names(candidate, known)
                if len(parts) >= 2 and all(RE_DIFF_NAME_SUFFIX.search(part) or (known and part in known) for part in parts):
                    return candidate, text[size:], "起述词之前"
            elif diff_name_ok(candidate) and not RE_DIFF_BAD_TAIL.search(candidate):
                defining = bool(RE_DIFF_DEFINING_ONSET.match(text[size:])) and len(candidate) <= 8 and bool(re.fullmatch(rf"[{CJK}]+", candidate))
                if RE_DIFF_NAME_SUFFIX.search(candidate) or (known and candidate in known) or defining:
                    return candidate, text[size:], "起述词之前"
            break
        return "", "", ""

    def collect_points(self, start: int, end: int, level: int):
        vl = self.vl
        points: list[str] = []
        index = start
        while index < end and len(points) < 6:
            text = vl[index].text
            if RE_BRACKET.match(text):
                break
            numbered = numbering(text)
            if numbered and level and numbered[0] <= level:
                break
            if numbered and re.fullmatch(r"(?:鉴别诊断|类证鉴别|病证鉴别|鉴别)", nospace(numbered[1])):
                break
            body, index = self.paragraph(index)
            if len(body) >= 6:
                points.append(body[:160])
        return points


# --------------------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------------------
def detect_books(lines: list[str]):
    """版权页 → [(书名, 起, 止)]（0 起行下标，止为下一张版权页）。"""
    found = []
    for index, line in enumerate(lines):
        if RE_CIP.match(line.strip()):
            for probe in range(index + 1, min(index + 4, len(lines))):
                if "/" in lines[probe] and "主编" in lines[probe]:
                    found.append((lines[probe].split("/")[0].strip(), index, lines[probe].strip()))
                    break
    ranges = []
    for position, (title, start, cip) in enumerate(found):
        end = found[position + 1][1] if position + 1 < len(found) else len(lines)
        ranges.append((title, start, end, cip))
    return ranges


def build_herb_lexicon(lines: list[str], ranges, parsers: list[BookParser]) -> set[str]:
    """药名词表（只用来切加减句末一味药后面粘着的功效语）：《中药学》各药标题 + 各书干净的药物清单。"""
    lexicon: set[str] = set()
    for title, start, end, _cip in ranges:
        if title != "中药学":
            continue
        for index in range(start, end - 1):
            name = nospace(lines[index])
            following = lines[index + 1].strip()
            if re.fullmatch(rf"[{CJK}]{{2,6}}", name) and re.match(r"^[A-Za-zÀ-ɏḀ-ỿ]", following) and "《" in following:
                lexicon.add(name)
            if lines[index].startswith("附药："):
                for part in re.split(r"[、，]", lines[index][3:].strip()):
                    part = nospace(part)
                    if re.fullmatch(rf"[{CJK}]{{2,6}}", part):
                        lexicon.add(part)
    clean = re.compile(rf"^[{CJK}]{{2,5}}$")
    for parser in parsers:
        for row in parser.rows:
            texts = [row["_formula_field"], row["_comp_field"], row["_mods_field"], row["_usage_field"], *row["_tail"]]
            for text in texts:
                for match in COMPOSITION_SENTENCE.finditer(text):
                    for token in split_outside_parens(match.group(2), "、"):
                        token = strip_parens(token).strip()
                        if clean.match(token) and not HERB_FUNCTION_CHAR.search(token):
                            lexicon.add(token)
                for match in RE_ADD.finditer(text):
                    end = list_end_outside_parens(text, match.end())
                    tokens = split_outside_parens(text[match.end():end], "、")
                    for token in tokens[:-1]:
                        token = RE_DOSE.sub("", strip_parens(token)).strip()
                        if clean.match(token) and not HERB_FUNCTION_CHAR.search(token) and not re.search(rf"{FORMULA_SUFFIX}$", token):
                            lexicon.add(token)
            if row["_comp_field"]:
                for token in split_outside_parens(row["_comp_field"].split("。")[0], "、"):
                    token = strip_parens(token).strip()
                    if clean.match(token) and not HERB_FUNCTION_CHAR.search(token) and not re.search(rf"{FORMULA_SUFFIX}$", token):
                        lexicon.add(token)
    for name in ("石膏", "生石膏", "煅石膏", "阿胶", "龟甲胶", "鹿角胶", "饴糖"):
        lexicon.add(name)
    return lexicon


def build_disease_name_lexicon(parsers: list[BookParser]) -> set[str]:
    """合集自己的病名词表，只用来给「病名要点」粘连的鉴别条目断开病名：各书的病名节标题、别名与西医对应名，
    以及各书【鉴别诊断】里写得清楚（空格、括注、逐个列举）的病名。不引入合集之外的任何名单。"""
    names: set[str] = set()

    def add(name: str, title: bool = False):
        name = drop_parenthetical(nospace(name))
        if not diff_name_ok(name) or RE_DIFF_ORGAN.search(name) or name.endswith("性"):
            return
        if title and GENERIC_TITLE.search(name):
            return
        names.add(name)

    for parser in parsers:
        for span in parser.disease_spans:
            add(span["name"], title=True)
            for part in re.split(r"[、（）()]", span["name"]):
                add(part, title=True)
            info = parser.disease_info(span)
            for name in info["diseaseAliases"] + info["westernEquivalents"] + info["tcmEquivalents"]:
                add(name)
            for item in info["differentials"]:
                add(item["name"])
    return names


def syndrome_kind_and_name(raw: str):
    """证型标题 → (syndromeKind, syndromeName)。只在确是证名时补「证」。"""
    name = raw
    dash = re.split(r"——|—|－－", name)
    if len(dash) == 2 and dash[1]:
        name = dash[1]
    trailing = re.match(r"^(.*?)[（(]([^（）()]+)[)）]$", name)
    if trailing:
        inner = trailing.group(2)
        name = inner if inner.endswith("证") and not trailing.group(1).endswith("证") else trailing.group(1)
    name = name.strip()
    if name.endswith("证") and not re.search(r"(实|虚|闭|脱|寒|热|表|里|阴|阳|变|常|兼|坏|逆|顺|轻|重|危)证$", name) or re.search(r".{3,}证$", name):
        return "syndrome", name
    if STAGE_NAME.search(name):
        return "stage", name
    if name.endswith("证"):
        return "type", name
    if TYPE_SUFFIX.search(name):
        return "type", name
    return "syndrome", name + "证"


def finalize_rows(parsers: list[BookParser], lexicon: set[str], stats: dict, known_names: set[str] | None = None):
    rows: list[dict] = []
    diseases: list[dict] = []
    used_ids: dict[str, int] = {}
    for parser in parsers:
        book = parser.book
        info_cache: dict[int, dict] = {}
        counts: dict[int, int] = {}
        book_rows: list[dict] = []
        for raw in parser.rows:
            span = raw["_disease"]
            key = span["index"]
            if key not in info_cache:
                info_cache[key] = parser.disease_info(span, known_names)
            info = info_cache[key]
            notes = list(raw["_notes"])
            formula_field = raw["_formula_field"].strip()
            sentence_match = re.match(r"^[^。]*。", formula_field)
            formula_text = sentence_match.group(0) if sentence_match else formula_field
            remainder = formula_field[len(formula_text):]
            if formula_text:
                formulas, join, modified, formula_notes = parse_formula_sentence(formula_text, lexicon)
                notes.extend(formula_notes)
            else:
                formulas, join, modified = [], "single", False
                notes.append("教材此证未写方药")
            # 组成
            by_formula: list[dict] = []
            tail_texts = [remainder, raw["_mods_field"], *raw["_tail"]]
            mods_sources: list[str] = []

            def attribute(label: str) -> str:
                if label in ("本方", "上方") and formulas:
                    return formulas[0]
                if label == "前方" and formulas:
                    return formulas[0]
                if label == "后方" and formulas:
                    return formulas[-1]
                return label

            for text in tail_texts:
                if not text:
                    continue
                keep = text
                for match in COMPOSITION_SENTENCE.finditer(text):
                    herbs = listed_herbs(match.group(2))
                    if herbs:
                        by_formula.append({"formula": attribute(match.group(1)), "herbs": herbs})
                mods_sources.append(keep)
            if raw["_comp_field"]:
                comp = raw["_comp_field"]
                first = comp.split("。")[0]
                herbs = listed_herbs(first) if not RE_FORMULA_TOKEN.search(strip_parens(first)) or "、" in first and not re.search(r"基础|加用|常用", first) else []
                if not herbs:
                    for match in re.finditer(r"常(?:加)?用([^。，；]+)", comp):
                        herbs.extend(h for h in listed_herbs(match.group(1)) if h not in herbs)
                if herbs:
                    by_formula.append({"formula": formulas[0] if formulas else "", "herbs": herbs})
                mods_sources.append("。".join(comp.split("。")[1:]))
            if book["key"] in ("waike", "yanke") and remainder:
                match = re.match(r"^(?:常用|药用|可用|常选用)([^。；]+?)(?:等)?。", remainder)
                if match:
                    herbs = listed_herbs(match.group(1))
                    if herbs:
                        by_formula.append({"formula": formulas[0] if len(formulas) == 1 else "", "herbs": herbs})
                        mods_sources[0] = remainder[match.end():]
            if book["key"] == "fuke":
                kept: list[str] = []
                for text in raw["_tail"]:
                    match = re.match(rf"^([{CJK}]{{2,14}})[:：]\s*(.+)$", text)
                    if match and re.search(rf"{FORMULA_SUFFIX}$", match.group(1)) and re.search(r"[\s　]", match.group(2)):
                        herbs = [h for h in re.split(r"[\s　]+", match.group(2).strip()) if h]
                        if herbs and all(len(strip_parens(h)) <= 8 for h in herbs):
                            by_formula.append({"formula": match.group(1), "herbs": herbs})
                            continue
                    kept.append(text)
                mods_sources = [remainder, raw["_mods_field"], *kept]
            if book["key"] == "wenbing":
                tail = raw["_tail"]
                for position, text in enumerate(tail[:-1]):
                    label = re.match(rf"^([{CJK}]{{2,14}})(?:（[^）]*）)+$", text)
                    if label and re.search(rf"{FORMULA_SUFFIX}$", label.group(1)):
                        tokens = [t for t in re.split(r"[\s　]+", tail[position + 1].strip()) if t]
                        herbs = [strip_classical_dose(t, lexicon) for t in tokens]
                        if len(herbs) >= 2 and all(herbs):
                            by_formula.append({"formula": label.group(1), "herbs": herbs})
                mods_sources = [raw["_usage_field"]]
            composition: list[str] = []
            for entry in by_formula:
                for herb in entry["herbs"]:
                    if herb not in composition:
                        composition.append(herb)
            modifications, unresolved = parse_modifications("。".join(part for part in mods_sources if part), lexicon, lexicon)
            stats["unresolvedModificationHerbs"] += unresolved
            tongue, pulse = split_tongue_pulse(raw["manifestations"])
            kind, syndrome_name = syndrome_kind_and_name(raw["syndrome"])
            if kind == "stage":
                notes.append("标题是分期名，教材按分期论治")
            row = {
                "id": "",
                "book": book["title"],
                "bookKey": book["key"],
                "line": raw["line"],
                "department": span["dept"],
                "disease": span["name"],
                "diseaseAliases": info["diseaseAliases"],
                "westernEquivalents": info["westernEquivalents"],
                "tcmEquivalents": info["tcmEquivalents"],
                "group": raw["group"],
                "syndrome": raw["syndrome"],
                "syndromeName": syndrome_name,
                "syndromeKind": kind,
                "manifestations": raw["manifestations"],
                "tongue": tongue,
                "pulse": pulse,
                "therapy": raw["therapy"],
                "formulaText": formula_text,
                "formulas": formulas,
                "formulaJoin": join,
                "modified": modified,
                "composition": composition,
                "compositionByFormula": by_formula,
                "modifications": modifications,
                "notes": "；".join(dict.fromkeys(notes)),
            }
            row["_span"] = key
            book_rows.append(row)
            counts[key] = counts.get(key, 0) + 1
        # id：书|病|证；同病同名（不同小类下）再带上 group，仍重复则加序号。
        seen: dict[str, int] = {}
        for row in book_rows:
            base = f"{row['bookKey']}|{row['disease']}|{row['syndrome']}"
            seen[base] = seen.get(base, 0) + 1
        for row in book_rows:
            base = f"{row['bookKey']}|{row['disease']}|{row['syndrome']}"
            identifier = base
            if seen[base] > 1 and row["group"]:
                identifier = f"{base}|{row['group']}"
            if identifier in used_ids:
                used_ids[identifier] += 1
                identifier = f"{identifier}#{used_ids[identifier]}"
            else:
                used_ids[identifier] = 1
            row["id"] = identifier
        for span in parser.disease_spans:
            key = span["index"]
            if key not in counts:
                stats["diseaseSectionsWithoutRows"].append({"book": book["key"], "disease": span["name"], "line": span["line"]})
                continue
            info = info_cache[key]
            diseases.append({
                "book": book["title"],
                "bookKey": book["key"],
                "department": span["dept"],
                "disease": span["name"],
                "line": span["line"],
                "definition": info["definition"],
                "diseaseAliases": info["diseaseAliases"],
                "westernEquivalents": info["westernEquivalents"],
                "tcmEquivalents": info["tcmEquivalents"],
                "differentials": info["differentials"],
                "diagnosisPoints": info["diagnosisPoints"],
                "syndromeCount": counts[key],
            })
        for row in book_rows:
            del row["_span"]
        rows.extend(book_rows)
    rows.sort(key=lambda row: (BOOK_ORDER[row["bookKey"]], row["line"], row["id"]))
    diseases.sort(key=lambda item: (BOOK_ORDER[item["bookKey"]], item["line"], item["disease"]))
    return rows, diseases


def main() -> int:
    args = [arg for arg in sys.argv[1:]]
    stats_path = None
    if "--stats" in args:
        at = args.index("--stats")
        stats_path = Path(args[at + 1])
        del args[at: at + 2]
    source = Path(args[0]) if args else ROOT / SOURCE_REL
    out = Path(args[1]) if len(args) > 1 else ROOT / OUT_REL
    if not source.exists():
        print(json.dumps({"error": "source_missing", "path": str(source)}, ensure_ascii=False))
        return 1
    raw = source.read_bytes()
    lines = raw.decode("utf-8", errors="replace").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    lines = [line.rstrip("\r") for line in lines]
    ranges = detect_books(lines)
    by_title = {title: (start, end, cip) for title, start, end, cip in ranges}
    parsers: list[BookParser] = []
    books_out: list[dict] = []
    for book in BOOKS:
        if book["title"] not in by_title:
            print(json.dumps({"error": "book_missing", "title": book["title"]}, ensure_ascii=False))
            return 1
        start, end, _cip = by_title[book["title"]]
        parser = BookParser(book, lines, start, end)
        parser.extract()
        parsers.append(parser)
    lexicon = build_herb_lexicon(lines, ranges, parsers)
    stats = {"unresolvedModificationHerbs": 0, "diseaseSectionsWithoutRows": [], "skipped": [], "herbLexiconSize": len(lexicon)}
    known_names = build_disease_name_lexicon(parsers)
    stats["differentialNameLexiconSize"] = len(known_names)
    rows, diseases = finalize_rows(parsers, lexicon, stats, known_names)
    # 鉴别条目各是按哪种写法认出来的（供核对；只在 --stats 里）。
    stats["differentialRules"] = {}
    stats["differentialTrace"] = []
    for parser in parsers:
        for entry in parser.differential_trace:
            bucket = stats["differentialRules"].setdefault(entry["rule"] or "病名未认出（条目保留，病名留空）", {"count": 0, "examples": []})
            bucket["count"] += 1
            if len(bucket["examples"]) < 3:
                bucket["examples"].append(entry)
            stats["differentialTrace"].append(entry)
    for parser in parsers:
        stats["skipped"].extend(parser.skips)
        book = parser.book
        start, end, cip = by_title[book["title"]]
        books_out.append({
            "bookKey": book["key"],
            "title": book["title"],
            "cip": cip,
            "lineStart": start + 1,
            "lineEnd": end,
            "layout": book["layout"],
            "rows": sum(1 for row in rows if row["bookKey"] == book["key"]),
            "diseases": sum(1 for item in diseases if item["bookKey"] == book["key"]),
        })
    payload = {
        "generatedBy": GENERATED_BY,
        "source": {"file": SOURCE_REL, "sha256": hashlib.sha256(raw).hexdigest(), "lines": len(lines)},
        "books": books_out,
        "diseases": diseases,
        "rows": rows,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    summary = {
        "out": str(out.relative_to(ROOT)) if out.is_relative_to(ROOT) else str(out),
        "rows": len(rows),
        "diseases": len(diseases),
        "books": {item["bookKey"]: [item["rows"], item["diseases"]] for item in books_out},
        "skipped": len(stats["skipped"]),
        "emptyFormulas": sum(1 for row in rows if not row["formulas"]),
        "emptyTherapy": sum(1 for row in rows if not row["therapy"]),
        "emptyManifestations": sum(1 for row in rows if not row["manifestations"]),
    }
    if stats_path is not None:
        stats["surveyedNotIncluded"] = [{"title": title, "reason": reason} for title, reason in SURVEYED_NOT_INCLUDED]
        stats["bookRanges"] = [{"title": title, "lineStart": start + 1, "lineEnd": end} for title, start, end, _cip in ranges]
        stats["summary"] = summary
        stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
