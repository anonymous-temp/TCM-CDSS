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
import importlib.util
import json
import re
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
    # 《推拿学》第 76636 行「小儿脑瘫…属中医“五迟”“五软”“痿症”范畴」（针灸节的写法见 EXTRA_ACUPUNCTURE_ALIASES）。
    "小儿脑瘫": ["五迟", "五软", "五迟五软", "脑性瘫痪", "小儿脑性瘫痪"],
}

# 只加在针刺（acupuncture）教材节上的等价病名（2026-10-19，r1019 验收集 H/M：病名对不上教材节时，卡片落到按伴随症状对上的
# 院内目录模板——「产后小便不通」给腹胀取穴、「月经后期」给腹胀取穴、「经行风疹块」给便秘取穴）。每条都是教材该节自己写明的
# 范围或分型，不是相近病：
#   · 月经不调：《针灸治疗学》本节分「月经先期 / 月经后期 / 月经先后无定期」三套基本治疗（运行时按病名字面取对应一套）；
#   · 隐疹：经行风疹块是月经期发作的瘾疹（《中医妇科学》经行风疹块：「每值临经时或经行期间，周身皮肤突起红疹…」）；
#   · 疝气：本节证型即寒疝、湿热疝、狐疝，西医范围含睾丸鞘膜积液（水疝）；
#   · 癃闭 / 尿失禁：本节定义不分是否产后（产后小便不通即产后癃闭，产后小便频数、失禁即产后尿失禁）；
#   · 视神经萎缩：中医「青盲」；目赤肿痛：「风热赤眼」「暴风客热」（《中医眼科学》同病异名）；
#   · 踝关节扭伤：西医写法「踝关节外侧韧带扭伤」；面瘫：西医写法「面神经麻痹」「周围性面瘫」「贝尔面瘫」；
#   · 慢性前列腺炎 / 良性前列腺增生：中医「精浊」「精癃」；哮喘：「哮病」；淋证：「石淋」等五淋之一。
# 只用于把本例病名对到针刺教材节，不改食疗、推拿的取节（那两类教材有各自的同名节）。
EXTRA_ACUPUNCTURE_ALIASES = {
    "月经不调": ["月经先期", "月经后期", "月经先后无定期"],
    "隐疹": ["经行风疹块"],
    "疝气": ["水疝", "狐疝", "寒疝"],
    "癃闭": ["产后小便不通"],
    "尿失禁": ["产后小便频数", "产后小便失禁", "小便失禁"],
    "视神经萎缩": ["青盲"],
    "目赤肿痛": ["风热赤眼", "暴风客热"],
    "急性踝关节扭伤": ["踝关节扭伤", "踝关节外侧韧带扭伤", "踝关节外侧韧带损伤", "踝关节韧带损伤"],
    "踝关节扭伤": ["踝关节外侧韧带扭伤", "踝关节外侧韧带损伤", "踝关节韧带损伤"],
    "面瘫": ["面神经麻痹", "周围性面瘫", "周围性面神经麻痹", "贝尔面瘫"],
    "慢性前列腺炎": ["精浊"],
    "良性前列腺增生": ["精癃"],
    "哮喘": ["哮病"],
    "淋证": ["石淋", "热淋", "血淋", "膏淋", "劳淋"],
    # ── 2026-10-19 晚（第九轮 WP9-D）：H 集「没有针刺方案、只给居家按揉」的病例里，教材有节、只是本例病名写法对不上的几类。
    # 每条都是教材该节（或另一本十三五教材）自己写明的又名、范围或西医对应，括注为原文行号（TCM Educational Materials.txt）：
    #   · 小儿脑性瘫痪：《针灸治疗学》第 11209、11210 行「简称小儿脑瘫」「属中医学“五迟”“五软”等范畴」；《针灸学》第 116258 行「简称脑瘫」
    #     「属中医学“五软”“五迟”…范畴」。「胎弱」「胎怯」同句并列，但指早产低体重，不收；
    #   · 鼻衄：第 12459 行「古代文献又称“鼻红”“鼻洪”，妇女经期鼻出血为“倒经”」（《针灸学》第 116913 行同）；
    #   · 痔疮：第 11682 行「根据痔核与肛门齿状线的位置关系将痔疮分为内痔、外痔和混合痔」（《针灸学》第 116552 行同）；
    #   · 痄腮：第 11559 行「本病相当于西医学的流行性腮腺炎」（《针灸学》第 116474 行同）；
    #   · 小儿积滞 / 小儿食积：儿科病名省去「小儿」的写法（《中医食疗学》第 41583 行节名即「积滞」，「各个年龄均可发病，以婴幼儿为多见」）；
    #     运行时小儿节不对成人取（见 tcm-nondrug-textbook-plan.server.ts 的 pediatricSectionExcludes）；
    #   · 注意力缺陷多动症 / 小儿多动症：《针灸学》第 116277 行「又称注意力缺陷多动障碍」，《针灸治疗学》第 11233 行「又称小儿多动症」；
    #   · 急性踝关节扭伤：第 11808 行「是指踝关节软组织韧带损伤引起的踝关节肿胀、疼痛…」，西医写「踝关节外侧韧带损伤」即本节；
    #   · 咽喉肿痛：第 12154 行「多见于急性咽炎、扁桃体炎…」，乳蛾即喉核（扁桃体）红肿（《中医诊断学》第 80897 行）。
    "小儿脑性瘫痪": ["五迟", "五软", "五迟五软", "脑性瘫痪", "脑瘫", "小儿脑瘫"],
    "鼻衄": ["倒经", "鼻出血", "经期鼻出血"],
    "痔疮": ["内痔", "外痔", "混合痔"],
    "痄腮": ["流行性腮腺炎"],
    "小儿积滞": ["积滞"],
    "小儿食积": ["积滞", "食积"],
    "注意力缺陷多动症": ["注意力缺陷多动障碍", "小儿多动症"],
    "小儿多动症": ["注意力缺陷多动障碍", "注意力缺陷多动症"],
    "咽喉肿痛": ["乳蛾"],
    #   · 耳鸣、耳聋：《针灸学》第 116890 行耳针法「暴聋者，毫针强刺激；一般耳鸣、耳聋用中等刺激量」——暴聋即突发性耳聋，本节自己点名；
    #     第 12035 行「耳鸣、耳聋可见于多种耳科疾病」。
    "耳鸣、耳聋": ["暴聋", "突发性耳聋"],
}

# 扫描件识读错字（只改配穴里的穴名，逐条带书名、行号与核对依据；生成物里不写错字，教材原文件不改）。
# 《针灸治疗学》遗尿第 11191 行「肺脾气虚配肝腧→脾俞」：
#   · 同书尿失禁节第 10429 行「脾肺气虚配肺俞→脾俞」；《针灸学》遗尿节第 116178 行「脾肺气虚配肺俞、气海、足三里」；
#   · 「腧」字在本书配穴行里只此一处，其余一律作「俞」；肝俞补肝，与肺脾气虚无涉，肺俞、脾俞为本证两脏的背俞穴；
#   · 执业医师题同题干（睡中遗尿、少气懒言、便溏、自汗）的配穴选项为「气海、肺俞、足三里」。
OCR_POINT_FIXES = [
    {"book": "zhenjiu_zhiliao", "disease": "遗尿", "syndrome": "肺脾气虚", "wrong": "肝俞", "right": "肺俞", "line": 11191},
]

# 《刺法灸法学》总论里的通用时长（运行时只在该病证节没写频次时作缺省，并标明出处）。
MODALITY_DEFAULT_PATTERNS = {
    "acupuncture": "一般病症只要针下得气而施以适当的补泻手法后，即可出针或留针10～30分钟",
    "cupping": "留罐时间一般为5～15分钟，可每日1次或隔日1次",
    "moxibustion": "用温灸盒每次灸15～30分钟",
}


# 总论里的治疗次数与疗程（2026-10-19 晚，第九轮 WP9-D）：10/19 回放 H/M/X/甲方/留出 1082 例，针刺方案 790 个里 508 个（64%）、灸法方案 61 个里 36 个
# 疗程栏只有「间隔与疗程按病情和耐受确定」，没有频次——教材各病证节多数不写次数。甲方外治标准要求「具体穴位、频次、安全边界」。
# 教材总论本来就写了通行的次数与疗程，逐字取原句，运行时只在本节与联网来源都没写频次时作缺省，并标明书名：
#   · 针刺：《针灸学》总论「针灸临床治疗常规」（第 114212 行）「治疗次数：针灸治疗常规为一日治疗一次；根据病情和实际情况，也可一日两次或
#     两日一次…疗程：一般针灸治疗1～2周为一个疗程」；
#   · 艾灸：《刺法灸法学》总论「施灸疗程」（第 44100 行）「一般初灸时，每日1次，3次后改为2～3天1次…慢性病需长期灸治者，可隔2～3日灸1次」。
# 拔罐的总论时长句本来就含「可每日1次或隔日1次，5～10次为1个疗程」（MODALITY_DEFAULT_PATTERNS），不另设。
COURSE_DEFAULT_PATTERNS = {
    "acupunctureCourse": {
        "book": "zhenjiu_xue",
        "needles": ["针灸治疗常规为一日治疗一次；根据病情和实际情况，也可一日两次或两日一次", "一般针灸治疗1～2周为一个疗程"],
    },
    "moxibustionCourse": {
        "book": "cifa_jiufa",
        "needles": ["一般初灸时，每日1次，3次后改为2～3天1次", "慢性病需长期灸治者，可隔2～3日灸1次"],
    },
}


def first_sentence_containing(lines, needle, lo, hi):
    for number in range(lo, min(hi, len(lines)) + 1):
        line = lines[number - 1]
        index = line.find(needle)
        if index >= 0:
            end = line.find("。", index)
            return {"text": line[index:end + 1 if end >= 0 else None].strip(), "line": number}
    return None


def _extractor_module():
    spec = importlib.util.spec_from_file_location("textbook_nondrug_extract", EXTRACTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _core(label: str) -> str:
    return re.sub(r"(?:证候|证型|证|型)$", "", label.replace(" ", ""))


def syndrome_add_points_by_label(entry) -> dict:
    """配穴行的证型条件 → 辨证要点里的证型名。

    此前按条件原文与证型名逐字相等归并，写法稍有不同的整条丢失（2026-10-19 统计 25 节 76 条）：
    「肺热津伤」对「肺热伤津」、「实热证」对「实热」、「热秘」对辨证要点的「热邪壅盛（热秘）」、「血热、血瘀」一条写两个证型。
    归并顺序：逐字相等 → 括注又名相等 → 去掉末尾「证/型」后相等 → 抽取器的 label_match。都对不上的保留原条件名，作为只在配穴行出现的证型。
    """
    extractor = _extractor_module()
    syndromes = entry.get("syndromes", [])
    labels = [syndrome["label"] for syndrome in syndromes]
    by_label = {}

    def add(label, points):
        bucket = by_label.setdefault(label, [])
        bucket.extend(point for point in points if point not in bucket)

    for item in entry.get("syndromeAddPoints", []):
        condition = item["syndrome"]
        parts = [part for part in re.split(r"[、，,]", condition) if part] if "、" in condition else [condition]
        for part in parts:
            target = next((s["label"] for s in syndromes if s["label"] == part), None) \
                or next((s["label"] for s in syndromes if s.get("alias") == part), None) \
                or next((s["label"] for s in syndromes if _core(s["label"]) == _core(part)), None) \
                or next((label for label in labels if extractor.label_match(part, [label])), None)
            add(target or part, item["points"])
    return by_label


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

    for key, spec in COURSE_DEFAULT_PATTERNS.items():
        lo, hi = books.get(spec["book"], {}).get("rangeLines", [1, len(lines)])
        hits = []
        for needle in spec["needles"]:
            # 原句必须逐字在本书范围内（缺一句就报错，不静默缺省）。
            number = next((n for n in range(lo, min(hi, len(lines)) + 1) if needle in lines[n - 1]), None)
            if number is None:
                raise SystemExit(f"modality course default not found in {spec['book']}: {needle}")
            hits.append((number, needle))
        defaults[key] = {"text": "。".join(needle for _, needle in hits) + "。", "line": hits[0][0], "book": spec["book"]}

    acupuncture = []
    for entry in data["acupuncture"]:
        for fix in OCR_POINT_FIXES:
            if fix["book"] != entry["sourceBook"] or fix["disease"] != entry["disease"]:
                continue
            for item in entry.get("syndromeAddPoints", []):
                if item["syndrome"] == fix["syndrome"] and fix["wrong"] in item["points"]:
                    item["points"] = [fix["right"] if point == fix["wrong"] else point for point in item["points"]]
        add_by_label = syndrome_add_points_by_label(entry)
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
            "aliases": sorted(set(entry.get("aliases", []) + EXTRA_ALIASES.get(entry["disease"], []) + EXTRA_ACUPUNCTURE_ALIASES.get(entry["disease"], []))),
            "westernScope": entry.get("westernScope", ""),
            "book": entry["sourceBook"],
            "line": entry["line"],
            "therapy": entry.get("therapy", ""),
            "mainPoints": entry.get("mainPoints", []),
            "syndromes": [{
                "label": syndrome["label"],
                **({"alias": syndrome["alias"]} if syndrome.get("alias") else {}),
                "keySymptoms": syndrome.get("keySymptoms", ""),
                "addPoints": add_by_label.get(syndrome["label"], []),
                "line": syndrome.get("line"),
            } for syndrome in entry.get("syndromes", [])] + [{
                # 配穴行写了、辨证要点里没有对应条目的证型（《针灸学》高血压、肿瘤等节只在配穴行里分证）：照配穴行原文给出，
                # 没有辨证要点可核，运行时只按证名相符取用。
                "label": label,
                "keySymptoms": "",
                "addPoints": points,
                "line": None,
            } for label, points in add_by_label.items() if label not in {syndrome["label"] for syndrome in entry.get("syndromes", [])}],
            "symptomAddPoints": [{"symptom": item["symptom"], "points": item["points"]} for item in entry.get("symptomAddPoints", [])],
            "operation": entry.get("operation", ""),
            # 教材把基本治疗分成几套写的病（眩晕分「实证 / 虚证」，中风分「中经络 / 中脏腑」…）：每套的治法、主穴、操作各自保留，
            # 运行时按本例证候只取对应的一套。上面的 therapy / mainPoints / operation 仍是各套合并后的写法（没有分套的病只有它们）。
            **({"variants": [{
                "label": variant.get("label", ""),
                "therapy": variant.get("therapy", ""),
                "mainPoints": variant.get("mainPoints", []),
                "operation": variant.get("operation", ""),
            } for variant in entry["basicTreatmentVariants"]]} if len(entry.get("basicTreatmentVariants", [])) > 1 else {}),
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
