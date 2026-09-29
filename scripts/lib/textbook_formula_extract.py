#!/usr/bin/env python3
"""
Deterministic extractor for 《方剂学》(李冀、连建伟主编，第4版，中国中医药出版社 2016) inside the OCR'd
"TCM Educational Materials.txt".  stdlib only.

usage:  python3 extract_formula_profiles.py <source.txt> <out.json>

Layout facts this relies on (verified against the source, see REPORT):
  * book block: CIP line "方剂学/李冀，连建伟主编" ... 附录 方名索引 ... 参考书目 (the 金匮要略 textbook
    follows; the task brief's end line 62626 is the 经络腧穴学 CIP, the 方剂学 body ends at the index).
  * 总论 第五章 方剂的煎服法 → "一、煎药法" / "二、服药法" (extracted verbatim, one record per line).
  * 各论: "第X章 名" → chapter intro → "第X节 名" → section intro → formulas.
  * main formula:  name line (optional "（原名…/又名…）") / source line containing 《…》 / 【组成】 …
    fields are 【label】-delimited; labels can also appear mid-line (e.g. 增液承气汤 【功用】).
  * 【附方】 items: one line each, "N.方名 （《出处》…） 组成… 用法…功用：…。主治：…".
  * OCR artefacts: "→" == "、", stray ASCII spaces inside words, a few dropped glyphs (䗪, 㕮).
Every field carries its source line number.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys

# ----------------------------------------------------------------------------------------------
# constants
# ----------------------------------------------------------------------------------------------
CN_NUM = "一二三四五六七八九十百千廿两半数"
UNITS = [
    "钱匕", "方寸匕", "两", "钱", "分", "斤", "升", "合", "枚", "个", "粒", "片", "茎", "枝", "握", "具",
    "条", "只", "对", "丸", "匙", "字", "铢", "斗", "撮", "把", "尾", "头", "寸", "尺", "梃", "挺", "杯",
    "盏", "碗", "朵", "节", "块", "团", "叶", "瓣", "根", "盅", "钟", "角", "丁", "茶匙", "汤匙", "厘",
]
UNIT_RE = "|".join(sorted(map(re.escape, UNITS), key=len, reverse=True))
DOSE_ORIG_RE = re.compile(
    rf"^(各)?(?:(?:[{CN_NUM}]+(?:{UNIT_RE}))+(?:[{CN_NUM}]+)?半?"
    rf"|(?:各)?等分|适量|少许|少量|若干|不拘多少|随宜|如[^，,]{{1,8}}大(?:[{CN_NUM}]+(?:{UNIT_RE}))?"
    rf"|大者[{CN_NUM}]+(?:{UNIT_RE}))$"
)
# modern dose in parentheses: （9g）（各6g）（3枚）（4.5～6g）（15～30g）（适量）
MODERN_DOSE_RE = re.compile(r"^[（(]\s*(各)?\s*([0-9０-９.．～~\-—至]+\s*(?:g|克|mg|kg|ml|mL|ML|枚|个|片|粒|条|只|对|茎|cm|支|滴|匙|丸|具|根|朵|节)|适量|少许|少量|酌量|[一二三四五六七八九十]+(?:枚|个|片|粒|条|只|对|茎|支))\s*[）)]$")

# processing / preparation / descriptor tokens that may FOLLOW the herb name in the textbook
SUFFIX_TOKENS = [
    "去节", "去根节", "不去根节", "不去节", "去皮尖", "不去皮尖", "去双仁者", "去双仁", "去皮", "不去皮", "去尖", "去心", "连心",
    "去白", "不去白", "去芦头", "去芦", "去核", "去瓤", "去子", "去须", "去毛", "去土", "去壳", "去油", "去皮脐",
    "去脐", "去粗皮", "去梗", "去翅足", "去头足", "去足", "去苗", "去枝梗", "去皮弦子", "去弦", "去沙土", "去蒂", "去目",
    "去核取肉", "去刺", "去头", "去衣", "去骨", "去翅", "去筋", "去膜",
    "不炙", "炙令香", "炙黄", "蜜炙", "醋炙", "酒炙", "姜炙", "盐炙", "炙",
    "炒香", "炒黄", "炒黑", "炒焦", "炒炭", "炒令香", "炒令黄", "炒去汗", "微炒", "麸炒", "酒炒", "醋炒", "盐炒", "盐水炒",
    "姜汁炒", "姜炒", "土炒", "米炒", "浸炒", "蛤粉炒", "炒",
    "焙干", "焙", "煨过", "煨", "煅", "炮", "酒蒸", "蒸", "水洗", "酒洗", "汤洗", "洗净", "洗", "汤泡", "泡",
    "酒浸", "醋浸", "姜汁浸", "汤浸", "浸", "擘", "切", "碎", "另研", "细研", "研细", "研末", "研", "水飞", "生用", "生",
    "熟", "捣", "锉", "绵裹", "大者", "新好者", "净", "酒制", "醋制", "姜制", "制", "烧存性", "烧灰", "烧", "酢炙", "酢",
    "晒干", "阴干", "头末", "别研", "俱", "以上", "包煎", "包", "后下", "先煎", "另煎", "冲服", "烊化", "镑", "镑为细末", "为末", "末", "熬", "熬黑", "熬令黄", "去汁", "炭", "鲜", "生者", "干者",
]
SUFFIX_TOKENS = sorted(set(SUFFIX_TOKENS), key=len, reverse=True)

# processing words that may PRECEDE the herb name (stripped only when the remainder is attested as a
# bare ingredient name elsewhere in the book, and the whole word is not in KEEP_WHOLE)
PREFIX_TOKENS = sorted([
    "炙", "炒", "麸炒", "酒炒", "醋炒", "盐炒", "焦", "煅", "生", "制", "姜", "法", "清", "酒", "醋", "盐", "蜜",
    "细", "净", "鲜", "熟", "炮", "土炒", "蜜炙", "嫩", "陈",
], key=len, reverse=True)

# words that look like "prefix/suffix + herb" but are distinct standard herbs / names
KEEP_WHOLE = {
    "生姜", "生地黄", "生地", "生铁落", "熟地黄", "熟地", "干姜", "炮姜", "生晒参", "桑寄生", "姜黄", "陈皮", "蜜蜂",
    "清酒", "熟附片", "法罗海", "焦三仙", "鲜竹沥", "竹沥", "姜汁", "酒", "陈仓米", "陈米", "熟艾", "熟大黄",
    "生铁", "细辛", "细茶", "陈胆星", "胆南星", "制南星",
}

# textbook spelling → Chinese Pharmacopoeia-style standard name (small, explicit; the comparison step
# additionally uses the repo's governed herb identity index read-only)
STANDARD_NAME = {
    "丹皮": "牡丹皮", "粉丹皮": "牡丹皮", "生地": "地黄", "生地黄": "地黄", "干地黄": "地黄", "细生地": "地黄", "鲜地黄": "地黄",
    "熟地": "熟地黄", "银花": "金银花", "忍冬花": "金银花", "双花": "金银花", "苇根": "芦根", "干葛": "葛根",
    "川军": "大黄", "锦纹": "大黄", "枣仁": "酸枣仁", "山萸肉": "山茱萸", "萸肉": "山茱萸", "山茱萸肉": "山茱萸",
    "龙胆草": "龙胆", "胆草": "龙胆", "香白芷": "白芷", "苦桔梗": "桔梗", "香附子": "香附", "赤芍药": "赤芍",
    "白芍药": "白芍", "桂心": "肉桂", "官桂": "肉桂", "肉桂心": "肉桂", "薄荷叶": "薄荷", "苏叶": "紫苏叶",
    "苏子": "紫苏子", "杏仁": "苦杏仁", "象贝": "浙贝母", "象贝母": "浙贝母", "元参": "玄参", "元胡": "延胡索",
    "玄胡": "延胡索", "延胡": "延胡索", "附片": "附子", "黄耆": "黄芪", "绵黄芪": "黄芪", "代赭": "代赭石", "赭石": "代赭石",
    "栝楼": "瓜蒌", "栝蒌": "瓜蒌", "栝楼实": "瓜蒌", "瓜蒌实": "瓜蒌", "全瓜蒌": "瓜蒌", "栝楼根": "天花粉", "栝蒌根": "天花粉",
    "瓜蒌根": "天花粉", "花粉": "天花粉", "山栀": "栀子", "山栀子": "栀子", "黑栀": "栀子", "广木香": "木香",
    "云苓": "茯苓", "白茯苓": "茯苓", "麦门冬": "麦冬", "天门冬": "天冬", "芥穗": "荆芥穗", "荆芥穗": "荆芥穗",
    "粉草": "甘草", "国老": "甘草", "甘草节": "甘草", "条芩": "黄芩", "枯芩": "黄芩", "子芩": "黄芩",
    "川连": "黄连", "川黄连": "黄连", "川柏": "黄柏", "黄檗": "黄柏", "川朴": "厚朴", "紫厚朴": "厚朴", "枳实壳": "枳壳",
    "淮山药": "山药", "怀山药": "山药", "薯蓣": "山药", "干山药": "山药", "怀牛膝": "牛膝", "淮牛膝": "牛膝", "川牛膝": "川牛膝",
    "北五味": "五味子", "北五味子": "五味子", "五味": "五味子", "姜半夏": "半夏", "法半夏": "半夏", "清半夏": "半夏",
    "半夏曲": "半夏曲", "旋覆": "旋覆花", "覆花": "旋覆花", "蒲公英": "蒲公英", "公英": "蒲公英", "地丁": "紫花地丁",
    "紫地丁": "紫花地丁", "银柴胡": "银柴胡", "青蒿": "青蒿", "鳖甲": "鳖甲", "龟板": "龟甲", "龟版": "龟甲", "败龟板": "龟甲",
    "牡蛎粉": "牡蛎", "左牡蛎": "牡蛎", "石决": "石决明", "羚羊角": "羚羊角", "犀角": "犀角", "乌犀角": "犀角",
    "明天麻": "天麻", "钩藤钩": "钩藤", "双钩": "钩藤", "双钩藤": "钩藤", "嫩钩藤": "钩藤", "桑叶": "桑叶", "冬桑叶": "桑叶",
    "滁菊": "菊花", "杭菊": "菊花", "甘菊": "菊花", "甘菊花": "菊花", "川贝": "川贝母", "浙贝": "浙贝母",
    "苡仁": "薏苡仁", "薏仁": "薏苡仁", "生苡仁": "薏苡仁", "米仁": "薏苡仁", "蔻仁": "豆蔻", "白蔻仁": "豆蔻",
    "白豆蔻": "豆蔻", "白蔻": "豆蔻", "砂仁": "砂仁", "缩砂仁": "砂仁", "缩砂": "砂仁", "缩砂仁": "砂仁", "草蔻": "草豆蔻",
    "川椒": "花椒", "蜀椒": "花椒", "椒红": "花椒", "吴萸": "吴茱萸", "淡吴萸": "吴茱萸", "茴香": "小茴香", "茴香子": "小茴香",
    "大茴香": "八角茴香", "良姜": "高良姜", "干生姜": "干姜", "炮干姜": "炮姜", "黑姜": "炮姜",
    "台乌药": "乌药", "天台乌药": "乌药", "台乌": "乌药", "郁金": "郁金", "广郁金": "郁金", "川郁金": "郁金",
    "当归身": "当归", "归身": "当归", "当归尾": "当归", "归尾": "当归", "全当归": "当归", "西当归": "当归",
    "川芎": "川芎", "芎䓖": "川芎", "抚芎": "川芎", "芎": "川芎", "紫丹参": "丹参", "红花": "红花", "草红花": "红花",
    "桃仁泥": "桃仁", "光桃仁": "桃仁", "炒桃仁": "桃仁", "五灵脂": "五灵脂", "灵脂": "五灵脂", "蒲黄": "蒲黄",
    "乳香": "乳香", "明乳香": "乳香", "滴乳香": "乳香", "没药": "没药", "明没药": "没药", "三七": "三七", "田七": "三七",
    "参三七": "三七", "党参": "党参", "潞党参": "党参", "台党参": "党参", "人参": "人参", "吉林参": "人参", "高丽参": "人参",
    "太子参": "太子参", "孩儿参": "太子参", "西洋参": "西洋参", "洋参": "西洋参", "沙参": "沙参", "北沙参": "北沙参",
    "南沙参": "南沙参", "白术": "白术", "於术": "白术", "冬术": "白术", "苍术": "苍术", "茅术": "苍术", "茅苍术": "苍术",
    "茯神木": "茯神", "赤茯苓": "茯苓", "茯苓皮": "茯苓皮", "猪苓": "猪苓", "泽泻": "泽泻", "建泽泻": "泽泻", "福泽泻": "泽泻",
    "车前": "车前子", "车前仁": "车前子", "木通": "木通", "关木通": "木通", "川木通": "川木通", "通草": "通草",
    "滑石": "滑石", "飞滑石": "滑石", "滑石粉": "滑石", "寒水石": "寒水石", "石膏": "石膏", "软石膏": "石膏",
    "芒硝": "芒硝", "朴硝": "芒硝", "硝石": "硝石", "元明粉": "玄明粉", "玄明粉": "玄明粉", "风化硝": "玄明粉",
    "枳实": "枳实", "江枳实": "枳实", "枳壳": "枳壳", "江枳壳": "枳壳", "陈皮": "陈皮", "橘皮": "陈皮", "广陈皮": "陈皮",
    "新会皮": "陈皮", "橘红": "橘红", "化橘红": "化橘红", "青皮": "青皮", "青橘皮": "青皮", "大腹皮": "大腹皮", "腹皮": "大腹皮",
    "槟榔": "槟榔", "大腹子": "槟榔", "使君子": "使君子", "使君子仁": "使君子", "苦楝皮": "苦楝皮", "川楝子": "川楝子",
    "金铃子": "川楝子", "楝实": "川楝子", "鹤虱": "鹤虱", "雷丸": "雷丸", "芜荑": "芜荑", "乌梅": "乌梅", "乌梅肉": "乌梅",
    "甘草梢": "甘草", "生甘草": "甘草", "炙甘草": "甘草", "大枣": "大枣", "红枣": "大枣", "枣": "大枣", "饴糖": "饴糖", "胶饴": "饴糖",
    "阿胶": "阿胶", "驴皮胶": "阿胶", "阿胶珠": "阿胶", "鹿角胶": "鹿角胶", "龟板胶": "龟甲胶", "龟胶": "龟甲胶",
    "山楂": "山楂", "山查": "山楂", "山楂肉": "山楂", "神曲": "六神曲", "六神曲": "六神曲", "建曲": "六神曲", "麦芽": "麦芽",
    "谷芽": "稻芽", "莱菔子": "莱菔子", "萝卜子": "莱菔子", "鸡内金": "鸡内金", "内金": "鸡内金",
    "菖蒲": "石菖蒲", "九节菖蒲": "石菖蒲", "远志肉": "远志", "远志筒": "远志", "炙远志": "远志", "朱砂": "朱砂", "辰砂": "朱砂",
    "丹砂": "朱砂", "龙齿": "龙齿", "龙骨": "龙骨", "磁石": "磁石", "灵磁石": "磁石", "珍珠母": "珍珠母", "真珠母": "珍珠母",
    "琥珀": "琥珀", "柏子仁": "柏子仁", "柏仁": "柏子仁", "合欢皮": "合欢皮", "夜交藤": "首乌藤", "首乌藤": "首乌藤",
    "何首乌": "何首乌", "首乌": "何首乌", "赤首乌": "何首乌", "制首乌": "何首乌", "女贞": "女贞子", "旱莲草": "墨旱莲",
    "旱莲": "墨旱莲", "墨旱莲": "墨旱莲", "枸杞": "枸杞子", "杞子": "枸杞子", "甘枸杞": "枸杞子", "枸杞子": "枸杞子",
    "菟丝": "菟丝子", "菟丝饼": "菟丝子", "巴戟": "巴戟天", "巴戟肉": "巴戟天", "仙灵脾": "淫羊藿", "仙茅": "仙茅",
    "肉苁蓉": "肉苁蓉", "苁蓉": "肉苁蓉", "淡苁蓉": "肉苁蓉", "锁阳": "锁阳", "补骨脂": "补骨脂", "破故纸": "补骨脂",
    "故纸": "补骨脂", "益智": "益智", "益智仁": "益智", "杜仲": "杜仲", "川杜仲": "杜仲", "续断": "续断", "川断": "续断",
    "川续断": "续断", "狗脊": "狗脊", "金毛狗脊": "狗脊", "鹿茸": "鹿茸", "鹿角": "鹿角", "鹿角霜": "鹿角霜",
    "紫河车": "紫河车", "蛤蚧": "蛤蚧", "冬虫夏草": "冬虫夏草", "胡桃肉": "核桃仁", "胡桃仁": "核桃仁", "核桃肉": "核桃仁",
    "莲子": "莲子", "莲肉": "莲子", "莲子肉": "莲子", "建莲肉": "莲子", "芡实": "芡实", "鸡头实": "芡实", "金樱子": "金樱子",
    "桑螵蛸": "桑螵蛸", "覆盆子": "覆盆子", "山茱萸": "山茱萸", "五倍子": "五倍子", "诃子": "诃子", "诃黎勒": "诃子",
    "诃子肉": "诃子", "肉豆蔻": "肉豆蔻", "肉果": "肉豆蔻", "罂粟壳": "罂粟壳", "御米壳": "罂粟壳", "赤石脂": "赤石脂",
    "禹余粮": "禹余粮", "浮小麦": "浮小麦", "麻黄根": "麻黄根", "糯稻根": "糯稻根须", "椿根皮": "椿皮", "樗白皮": "椿皮",
    "白果": "白果", "银杏": "白果", "海螵蛸": "海螵蛸", "乌贼骨": "海螵蛸", "茜草根": "茜草", "茜草": "茜草", "茜根": "茜草",
    "侧柏叶": "侧柏叶", "柏叶": "侧柏叶", "白茅根": "白茅根", "茅根": "白茅根", "小蓟": "小蓟", "大蓟": "大蓟",
    "藕节": "藕节", "棕榈": "棕榈", "棕榈皮": "棕榈", "陈棕": "棕榈", "艾叶": "艾叶", "艾": "艾叶", "熟艾": "艾叶", "灶心土": "灶心土",
    "伏龙肝": "灶心土", "黄土": "灶心土", "槐花": "槐花", "槐角": "槐角", "地榆": "地榆", "仙鹤草": "仙鹤草",
    "白及": "白及", "白芨": "白及", "血余炭": "血余炭", "乱发": "血余炭", "牛黄": "牛黄", "犀黄": "牛黄", "西牛黄": "牛黄",
    "麝香": "麝香", "当门子": "麝香", "冰片": "冰片", "龙脑": "冰片", "梅片": "冰片", "安息香": "安息香", "苏合香": "苏合香",
    "苏合香油": "苏合香", "檀香": "檀香", "白檀香": "檀香", "沉香": "沉香", "丁香": "丁香", "公丁香": "丁香", "香附": "香附",
    "木香": "木香", "青木香": "木香", "薤白": "薤白", "瓜蒌皮": "瓜蒌皮", "瓜蒌仁": "瓜蒌子", "栝楼仁": "瓜蒌子",
    "瓜蒌子": "瓜蒌子", "贝母": "贝母", "川贝母": "川贝母", "浙贝母": "浙贝母", "土贝母": "土贝母", "桔梗": "桔梗",
    "前胡": "前胡", "白前": "白前", "紫菀": "紫菀", "款冬花": "款冬花", "款冬": "款冬花", "冬花": "款冬花", "百部": "百部",
    "杏仁": "苦杏仁", "苦杏仁": "苦杏仁", "甜杏仁": "甜杏仁", "桑白皮": "桑白皮", "桑根白皮": "桑白皮", "桑皮": "桑白皮",
    "葶苈": "葶苈子", "葶苈子": "葶苈子", "苏子": "紫苏子", "紫苏子": "紫苏子", "白芥子": "芥子", "芥子": "芥子",
    "海浮石": "海浮石", "浮海石": "海浮石", "海蛤壳": "蛤壳", "蛤壳": "蛤壳", "海蛤粉": "蛤壳", "蛤粉": "蛤壳", "青黛": "青黛",
    "竹茹": "竹茹", "竹沥": "竹沥", "天竺黄": "天竺黄", "天竹黄": "天竺黄", "胆南星": "胆南星", "胆星": "胆南星",
    "天南星": "天南星", "南星": "天南星", "白附子": "白附子", "僵蚕": "僵蚕", "白僵蚕": "僵蚕", "全蝎": "全蝎", "蝎尾": "全蝎",
    "蜈蚣": "蜈蚣", "地龙": "地龙", "蚯蚓": "地龙", "水蛭": "水蛭", "虻虫": "虻虫", "䗪虫": "土鳖虫", "土鳖虫": "土鳖虫",
    "蛴螬": "蛴螬", "穿山甲": "穿山甲", "山甲": "穿山甲", "皂角刺": "皂角刺", "皂刺": "皂角刺", "皂荚": "皂荚", "皂角": "皂荚",
    "牙皂": "猪牙皂", "猪牙皂": "猪牙皂", "黄芪": "黄芪", "生黄芪": "黄芪", "炙黄芪": "黄芪", "升麻": "升麻", "柴胡": "柴胡",
    "北柴胡": "柴胡", "软柴胡": "柴胡", "葛根": "葛根", "粉葛": "葛根", "粉葛根": "葛根", "荆芥": "荆芥", "防风": "防风",
    "关防风": "防风", "羌活": "羌活", "独活": "独活", "川独活": "独活", "藁本": "藁本", "白芷": "白芷", "细辛": "细辛",
    "北细辛": "细辛", "辛夷": "辛夷", "苍耳子": "苍耳子", "薄荷": "薄荷", "苏薄荷": "薄荷", "牛蒡子": "牛蒡子", "牛蒡": "牛蒡子",
    "大力子": "牛蒡子", "鼠粘子": "牛蒡子", "蝉蜕": "蝉蜕", "蝉衣": "蝉蜕", "蝉退": "蝉蜕", "淡豆豉": "淡豆豉", "豆豉": "淡豆豉",
    "香豉": "淡豆豉", "豉": "淡豆豉", "葱白": "葱白", "葱": "葱白", "连须葱白": "葱白", "浮萍": "浮萍", "紫苏": "紫苏叶",
    "紫苏叶": "紫苏叶", "苏梗": "紫苏梗", "紫苏梗": "紫苏梗", "香薷": "香薷", "藿香": "广藿香", "广藿香": "广藿香", "藿香叶": "广藿香",
    "佩兰": "佩兰", "佩兰叶": "佩兰", "厚朴": "厚朴", "川厚朴": "厚朴", "草果": "草果", "草果仁": "草果", "知母": "知母",
    "黄芩": "黄芩", "黄连": "黄连", "黄柏": "黄柏", "栀子": "栀子", "连翘": "连翘", "大青叶": "大青叶", "板蓝根": "板蓝根",
    "蓝根": "板蓝根", "马勃": "马勃", "玄参": "玄参", "黑参": "玄参", "僵蚕": "僵蚕", "鸭跖草": "鸭跖草", "芦根": "芦根",
    "竹叶": "淡竹叶", "淡竹叶": "淡竹叶", "竹叶卷心": "竹叶卷心", "天花粉": "天花粉", "石斛": "石斛", "鲜石斛": "石斛",
    "金石斛": "石斛", "玉竹": "玉竹", "葳蕤": "玉竹", "萎蕤": "玉竹", "黄精": "黄精", "百合": "百合", "麦冬": "麦冬",
    "天冬": "天冬", "五味子": "五味子", "白芍": "白芍", "赤芍": "赤芍", "芍药": "芍药", "当归": "当归", "熟地黄": "熟地黄",
    "地黄": "地黄", "牡丹皮": "牡丹皮", "地骨皮": "地骨皮", "骨皮": "地骨皮", "秦艽": "秦艽", "胡黄连": "胡黄连",
    "茵陈": "茵陈", "茵陈蒿": "茵陈", "金钱草": "金钱草", "萆薢": "萆薢", "粉萆薢": "萆薢", "川萆薢": "萆薢",
    "萹蓄": "萹蓄", "瞿麦": "瞿麦", "石韦": "石韦", "海金沙": "海金沙", "冬葵子": "冬葵子", "灯心": "灯心草", "灯心草": "灯心草",
    "防己": "防己", "汉防己": "防己", "木防己": "防己", "粉防己": "防己", "五加皮": "五加皮", "桑寄生": "桑寄生", "寄生": "桑寄生",
    "牛膝": "牛膝", "威灵仙": "威灵仙", "灵仙": "威灵仙", "海风藤": "海风藤", "络石藤": "络石藤", "桑枝": "桑枝", "嫩桑枝": "桑枝",
    "木瓜": "木瓜", "宣木瓜": "木瓜", "蚕沙": "蚕沙", "晚蚕沙": "蚕沙", "桂枝": "桂枝", "嫩桂枝": "桂枝", "肉桂": "肉桂",
    "附子": "附子", "熟附子": "附子", "黑附子": "附子", "川乌": "川乌", "川乌头": "川乌", "乌头": "乌头", "草乌": "草乌",
    "干姜": "干姜", "生姜": "生姜", "煨姜": "生姜", "生姜汁": "生姜汁", "姜汁": "生姜汁", "吴茱萸": "吴茱萸", "小茴香": "小茴香",
    "荜茇": "荜茇", "胡椒": "胡椒", "花椒": "花椒", "丁香": "丁香", "肉豆蔻": "肉豆蔻", "高良姜": "高良姜", "麻黄": "麻黄",
    "石菖蒲": "石菖蒲", "牡蛎": "牡蛎", "石决明": "石决明", "代赭石": "代赭石", "龟甲": "龟甲", "鳖甲": "鳖甲",
    "大黄": "大黄", "生大黄": "大黄", "酒大黄": "大黄", "锦纹大黄": "大黄", "川大黄": "大黄", "番泻叶": "番泻叶",
    "火麻仁": "火麻仁", "麻子仁": "火麻仁", "麻仁": "火麻仁", "郁李仁": "郁李仁", "甘遂": "甘遂", "大戟": "大戟",
    "京大戟": "京大戟", "芫花": "芫花", "牵牛子": "牵牛子", "黑丑": "牵牛子", "白丑": "牵牛子", "黑白丑": "牵牛子",
    "巴豆": "巴豆", "巴豆霜": "巴豆霜", "商陆": "商陆", "轻粉": "轻粉", "瓜蒂": "甜瓜蒂", "甜瓜蒂": "甜瓜蒂",
    "常山": "常山", "蜀漆": "蜀漆", "赤小豆": "赤小豆", "粳米": "粳米", "薏苡仁": "薏苡仁", "扁豆": "白扁豆", "白扁豆": "白扁豆",
    "山药": "山药", "茯苓": "茯苓", "茯神": "茯神", "炒白术": "白术", "人中白": "人中白", "蜂蜜": "蜂蜜", "白蜜": "蜂蜜",
    "蜜": "蜂蜜", "食蜜": "蜂蜜", "醋": "醋", "苦酒": "醋", "米醋": "醋", "黄酒": "黄酒", "清酒": "黄酒", "酒": "黄酒",
    "童便": "童便", "人参须": "人参", "参须": "人参", "党参须": "党参", "鹿角胶": "鹿角胶", "龟甲胶": "龟甲胶", "紫石英": "紫石英",
    "钟乳石": "钟乳石", "石钟乳": "钟乳石", "硫黄": "硫黄", "雄黄": "雄黄", "明雄黄": "雄黄", "白矾": "白矾", "明矾": "白矾",
    "枯矾": "白矾", "胆矾": "胆矾", "硼砂": "硼砂", "礞石": "青礞石", "青礞石": "青礞石", "金礞石": "金礞石",
    "海藻": "海藻", "昆布": "昆布", "海带": "海带", "夏枯草": "夏枯草", "猫爪草": "猫爪草", "蒲公英": "蒲公英",
    "金银花": "金银花", "紫花地丁": "紫花地丁", "野菊花": "野菊花", "天葵子": "天葵子", "紫背天葵子": "天葵子", "败酱": "败酱草",
    "败酱草": "败酱草", "薏苡附子败酱散": "薏苡附子败酱散", "冬瓜子": "冬瓜子", "冬瓜仁": "冬瓜子", "瓜瓣": "冬瓜子",
    "苇茎": "芦根", "鱼腥草": "鱼腥草", "红藤": "大血藤", "大血藤": "大血藤",
    "苇": "芦根", "牵牛": "牵牛子", "黑牵牛": "牵牛子", "白牵牛": "牵牛子", "柏皮": "黄柏", "乌犀": "犀角",
    "吃力伽": "白术", "诃黎勒皮": "诃子", "麦蘖": "麦芽", "麦蘖面": "麦芽", "大麦糵": "麦芽", "大麦蘖": "麦芽",
    "草豆蔻仁": "草豆蔻", "白豆蔻仁": "豆蔻", "苦楝根": "苦楝皮", "当归梢": "当归", "川归": "当归", "辣桂": "肉桂",
    "䗪虫": "土鳖虫", "紫葳": "凌霄花", "胡麻": "黑芝麻", "蚌粉": "蛤壳", "白胶香": "枫香脂", "露蜂房": "蜂房",
    "豉": "淡豆豉", "葱": "葱白", "姜": "生姜", "新豉": "淡豆豉", "老葱": "葱白", "文蛤": "五倍子", "续随子": "千金子",
    "广皮": "陈皮", "陈广皮": "陈皮", "子芩": "黄芩", "真珠母": "珍珠母", "虎胫骨": "虎骨", "禹余粮": "禹余粮",
    "瓜瓣": "冬瓜子", "竹茹": "竹茹", "白沙蜜": "蜂蜜",
    "木鳖": "木鳖子", "全虫": "全蝎", "光明砂": "朱砂", "别直参": "人参", "湖广术": "白术", "河车": "紫河车",
    "鹿胶": "鹿角胶", "炙草": "甘草", "焦栀": "栀子", "栀皮": "栀子", "山栀仁": "栀子", "山栀子仁": "栀子", "熟附": "附子",
    "黑附块": "附子", "片子姜黄": "姜黄", "片脑": "冰片", "生决明": "石决明", "生怀地黄": "地黄", "大怀熟地": "熟地黄",
    "生杭芍": "白芍", "杭芍": "白芍", "犀牛黄": "牛黄", "紫瑶桂": "肉桂", "羚角片": "羚羊角", "羚角": "羚羊角",
    "红芽大戟": "红大戟", "霜桑叶": "桑叶", "鲜扁豆花": "扁豆花", "晚蚕砂": "蚕沙", "鼠黏子": "牛蒡子", "朱茯神": "茯神",
    "白雷丸": "雷丸", "白通草": "通草", "白粳米": "粳米", "棕边": "棕榈", "炒曲": "六神曲", "瓜子": "冬瓜子",
    "龙脑香": "冰片", "藿香梗": "广藿香", "藿梗": "广藿香", "桂": "肉桂", "东白薇": "白薇", "京川贝": "川贝母",
    "丁子香": "丁香", "椿树根皮": "椿皮", "胡麻仁": "黑芝麻", "大豆黄卷": "大豆黄卷", "片黄芩": "黄芩", "黑丑": "牵牛子",
    "虎胫": "虎骨", "陈胆星": "胆南星", "犀角屑": "犀角", "白矾": "白矾", "薏苡": "薏苡仁", "辛夷仁": "辛夷",
    "益智仁": "益智", "石莲肉": "石莲子", "楂肉": "山楂", "山楂肉": "山楂", "沙苑蒺藜": "沙苑子", "白蒺藜": "蒺藜",
    "赤硝": "赤硝", "风化朴硝": "芒硝", "葵子": "冬葵子", "蜂窠": "蜂房", "金银箔": "金箔", "铁粉": "铁粉",
    "西河柳": "西河柳", "梨皮": "梨皮", "荷梗": "荷梗", "浓朴": "厚朴", "冬葵果": "冬葵子",
}


def clean(text: str) -> str:
    """Normalize OCR noise inside a Chinese phrase (stray spaces, → == 、)."""
    text = text.replace("→", "、")
    text = re.sub(r"(?<=[一-龥，。；：、（）《》“”])[ \t]+(?=[一-龥，。；：、（）《》“”0-9])", "", text)
    text = re.sub(r"(?<=[一-龥0-9])[ \t]+(?=[一-龥，。；：、（）《》])", "", text)
    return text.strip()


def fix_glyphs(text: str) -> str:
    """Known dropped glyphs in this OCR (documented; deterministic)."""
    text = re.sub(r"上\s*咀", "上㕮咀", text)
    text = re.sub(r"(?<![㕮])(?<=[，。\s　])咀(?=[，为])", "㕮咀", text)
    text = re.sub(r"大黄\s+虫丸", "大黄䗪虫丸", text)
    text = text.replace("☒虫", "䗪虫")
    return text


# ----------------------------------------------------------------------------------------------
# ingredient parsing
# ----------------------------------------------------------------------------------------------
def split_items(text: str) -> list[str]:
    """Split a composition string into raw ingredient chunks (parenthesis-aware).

    Separators (outside parentheses only): any whitespace run containing U+3000; an ASCII space run right
    after a closing parenthesis when followed by a CJK char.  Other whitespace is OCR noise inside a word
    ("麻 黄去节", "一钱五 分", "（2　枚）") and is dropped.
    """
    text = text.replace("\u00a0", " ").strip()
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if ch in " \t\u3000":
            j = i
            while j < len(text) and text[j] in " \t\u3000":
                j += 1
            run = text[i:j]
            nxt = text[j] if j < len(text) else ""
            prev = buf[-1] if buf else ""
            if depth == 0 and ("\u3000" in run or (prev in "）)" and re.match(r"[一-龥]", nxt or ""))):
                if buf:
                    out.append("".join(buf).strip())
                buf = []
            i = j
            continue
        buf.append(ch)
        i += 1
    if buf:
        out.append("".join(buf).strip())
    return [x for x in out if x]


DOSE_CHARS = set(CN_NUM + "至或各加减厘毫钱半") | set("".join(UNITS))
UNIT_CHARS = set("".join(UNITS)) | {"厘"}
PART_CHARS = set("皮身尾梢叶子仁花根须头芯心肉实枝藤茎壳霜核节刺毛胶汁油")
SINGLE_OK = {"豉", "葱", "姜", "枣", "蜜", "酒", "醋", "艾", "苇", "芎", "桂", "盐", "水"}
DESCRIPTORS = sorted([
    "真", "上", "明", "净", "好", "新", "嫩", "大", "小", "细", "粉", "川", "广", "淮", "怀", "杭", "滁", "北", "南", "西",
    "台", "建", "云", "仙", "淡", "陈", "鲜", "干", "乌角", "梅花", "新罗", "雪白", "瓜儿", "粉口", "丁头", "赤白", "白沙",
    "光", "青", "老", "肥", "绵", "紫", "黑", "生", "熟", "炙", "炒", "焦", "煅", "制", "酒", "醋", "盐", "蜜", "姜", "法",
    "清", "麸炒", "土炒", "蜜炙", "择", "拣", "去皮", "连皮", "酒浸", "酒洗", "酒蒸", "酒炒", "盐炒", "盐水炒", "姜汁炒", "醋炒", "醋炙", "原", "太乙", "吴", "尖", "法制", "老", "新", "辣", "香", "东", "京", "片子", "片", "莲花", "炒黑", "霜", "煨", "杜",
], key=len, reverse=True)
PROCESSING_LIKE = set(PREFIX_TOKENS) | {"麸炒", "土炒", "蜜炙", "去皮", "连皮", "酒浸", "酒洗", "酒蒸", "酒炒", "盐炒", "盐水炒", "姜汁炒", "醋炒", "醋炙"}
# curated core lexicon (synonyms + extra standard names that occur in the book); book-derived names are added at run time
EXTRA_HERBS = {
    "血竭", "儿茶", "苇茎", "苇", "白酒", "椒目", "瓜瓣", "广皮", "陈广皮", "竹茹", "子芩", "麝香", "牛黄", "石膏", "滑石", "青黛",
    "鸡子黄", "鸡子白", "蜂蜜", "饴糖", "粳米", "大枣", "生姜", "葱白", "白蜜", "文蛤", "续随子", "千金子", "山慈菇", "红大戟",
    "雄黄", "朱砂", "琥珀", "珍珠", "真珠", "真珠母", "珍珠母", "冰片", "安息香", "苏合香", "熏陆香", "荜茇", "诃子", "香附",
    "白附子", "天麻", "钩藤", "羚羊角", "水牛角", "玳瑁", "金箔", "银箔", "郁金", "雄黄", "蟾酥", "轻粉", "铅丹", "黄丹",
    "胆矾", "瓜蒂", "藜芦", "常山", "赤小豆", "槟榔", "使君子", "鹤虱", "芜荑", "雷丸", "榧子", "南瓜子", "贯众",
    "龙眼肉", "荷叶", "益母草", "芦荟", "骨碎补", "白花蛇", "乌梢蛇", "紫葳", "胡麻", "蚌粉", "白胶香", "草豆蔻",
    "豆蔻", "生姜皮", "虎胫骨", "禹余粮", "牵牛", "黑牵牛", "白牵牛", "柏皮", "乌犀", "吃力伽", "诃黎勒皮", "麦蘖",
    "麦蘖面", "大麦糵", "大麦蘖", "草豆蔻仁", "白豆蔻仁", "苦楝根", "当归梢", "川归", "辣桂", "豉", "葱", "姜", "苇",
    "盐", "水", "枇杷叶", "木鳖子", "两头尖", "葛花", "白薇", "炒曲", "河车", "龙脑香", "藿香梗", "海浮石", "扁豆花",
    "䗪虫", "土鳖虫", "凌霄花", "阿魏", "五谷虫", "蜣螂", "鼠妇", "蜂房", "露蜂房", "紫菀", "马兜铃", "蛤蚧", "紫河车",
}
CORE_LEX = set(STANDARD_NAME) | set(STANDARD_NAME.values()) | EXTRA_HERBS
TIER_RE = re.compile(r"(大剂|中剂|小剂)([^（(；;]*)[（(]([^）)]*)[）)]")
MODERN_IN_PAREN_RE = re.compile(r"^\s*(各)?\s*([0-9０-９.．]+(?:\s*[～~\-—至]\s*[0-9０-９.．]+)?\s*(?:g|克|mg|kg|ml|mL|枚|个|片|粒|条|只|对|茎|cm|支|滴|匙|丸|具|根|朵|节)(?:[～~\-—至][0-9.]+\s*(?:g|枚|个|片))?|适量|少许|少量|酌量|[一二三四五六七八九十]+(?:枚|个|片|粒|条|只|对|茎|支))\s*[，,；;]?\s*(.*)$")
BARE_MODERN_RE = re.compile(r"(各)?([0-9.]+(?:[～~\-][0-9.]+)?\s*(?:g|克|mg))$")


def split_dose_suffix(seg: str, lex: set[str] | None = None) -> tuple[str, str | None]:
    """'芍药三两' → ('芍药', '三两'); '苦桔梗一钱至钱半' → ('苦桔梗', '一钱至钱半').

    The dose suffix is the longest tail made only of numeral/unit/range characters, starting with a numeral
    or 各/钱 and containing a unit; at least 2 characters of name must remain and the tail must not itself
    be a known herb (野百合 ≠ 野 + 百合)."""
    lex = lex or set()
    for start in range(1 if seg[:1] in SINGLE_OK else 2, len(seg)):
        tail = seg[start:]
        if not (tail[0] in CN_NUM or tail[0] in "各钱") or not all(ch in DOSE_CHARS for ch in tail):
            continue
        if not any(ch in UNIT_CHARS for ch in tail) and tail not in ("各等分", "等分"):
            continue
        if tail in lex or tail in CORE_LEX:
            continue
        return seg[:start], tail
    m = re.search(r"(各?等分|适量|少许|少量|若干|不拘多少)$", seg)
    if m and m.start() >= 2:
        return seg[: m.start()], m.group(1)
    return seg, None


def strip_suffix_processing(seg: str) -> tuple[str, list[str]]:
    removed: list[str] = []
    changed = True
    while changed and seg not in KEEP_WHOLE and seg not in CORE_LEX:
        changed = False
        for tok in SUFFIX_TOKENS:
            if seg.endswith(tok) and len(seg) - len(tok) >= 2:
                removed.insert(0, tok)
                seg = seg[: -len(tok)]
                changed = True
                break
    return seg, removed


def longest_at(s: str, p: int, lex: set[str], min_len: int = 2) -> str | None:
    for L in range(min(8, len(s) - p), 0, -1):
        w = s[p:p + L]
        if w in lex and (L >= min_len or w in SINGLE_OK):
            rem = s[p + L:]
            # a single-char word ('酒', '姜') only counts when nothing but processing follows ('酒浸枸杞子' ≠ 酒)
            if L == 1 and rem and not any(rem.startswith(t) for t in SUFFIX_TOKENS) and not re.match(r"[一二三四五六七八九十半两各]", rem):
                continue
            return w
    return None


def part_guard(rem: str) -> bool:
    """True when the remainder after a lexicon word looks like a plant part (茯苓+皮) rather than processing."""
    if not rem:
        return False
    if any(rem.startswith(t) for t in SUFFIX_TOKENS if len(t) >= 2):
        return False
    return rem[0] in PART_CHARS


def lexicon_split(s: str, book: set[str]) -> tuple[str, str, str, str] | None:
    """Return (name, descriptor, remainder, method) or None."""
    if s in CORE_LEX or s in KEEP_WHOLE:
        return s, "", "", "core_exact"
    w = longest_at(s, 0, CORE_LEX)
    if w and not part_guard(s[len(w):]):
        return w, "", s[len(w):], "core_prefix"
    for d in DESCRIPTORS:
        if s.startswith(d) and len(s) > len(d):
            w2 = longest_at(s, len(d), CORE_LEX, 1 if len(s) - len(d) == 1 else 2)
            if w2 and not part_guard(s[len(d) + len(w2):]):
                return w2, d, s[len(d) + len(w2):], "descriptor_core"
    if s in book:
        return s, "", "", "book_exact"
    w = longest_at(s, 0, book)
    if w and not part_guard(s[len(w):]):
        return w, "", s[len(w):], "book_prefix"
    return None


def parse_ingredient(raw: str, book: set[str] | None = None) -> dict:
    book = book or set()
    item: dict = {"raw": raw}
    text = clean(fix_glyphs(raw)).rstrip("。")
    notes: list[str] = []
    dose = None
    dose_orig = None
    shared = False
    # tiered doses (清瘟败毒饮): 大剂…（…）；中剂…（…）；小剂…（…）
    tm = re.search(r"大剂", text)
    if tm and TIER_RE.search(text[tm.start():]):
        tiers = TIER_RE.findall(text[tm.start():])
        dose = "；".join(f"{a}{c}" for a, _, c in tiers)
        dose_orig = "；".join(f"{a}{b}" for a, b, _ in tiers)
        text = text[: tm.start()]
    # every parenthetical group: modern dose / substitute / components / note
    substitute = None
    components = None
    def paren(m: re.Match) -> str:
        nonlocal dose, shared, substitute, components
        c = m.group(1)
        mm = MODERN_IN_PAREN_RE.match(c)
        if mm and dose is None:
            dose = re.sub(r"\s+", "", mm.group(2))
            if mm.group(1):
                shared = True
            if mm.group(3):
                notes.append(mm.group(3))
            return ""
        if re.fullmatch(r"(.{1,6})代", c):
            substitute = c[:-1]
            notes.append(c)
            return ""
        if "、" in c and all(1 <= len(x) <= 5 for x in c.split("、")):
            components = c.split("、")
            return ""
        notes.append(c)
        return ""
    text = re.sub(r"[（(]([^（）()]*)[）)]", paren, text).strip("，, ")
    if dose is None:
        bm = BARE_MODERN_RE.search(text)
        if bm and bm.start() >= 2:
            dose = bm.group(2).replace(" ", "")
            shared = shared or bool(bm.group(1))
            text = text[: bm.start()].rstrip("，, ")
    segs = [s for s in re.split(r"[，,]\s*", text) if s]
    if not segs:
        item.update({"name": None, "processing": None, "dose": dose, "doseOriginal": dose_orig, "lowConfidence": True})
        return item
    first, rest = segs[0], segs[1:]
    if rest and dose_orig is None:
        tail_name, tail_dose = split_dose_suffix("xx" + rest[-1])
        if tail_name == "xx" and tail_dose:
            dose_orig = rest[-1]
            rest = rest[:-1]
    name_part, suffix_dose = split_dose_suffix(first, book)
    if suffix_dose and name_part.endswith("以上") and len(name_part) > 3:
        name_part = name_part[:-2]
        shared = True
    if suffix_dose:
        dose_orig = suffix_dose if dose_orig is None else suffix_dose + "，" + dose_orig
    if dose_orig and dose_orig.startswith("各"):
        shared = True
    alias = None
    am = re.search(r"一名(.+)$", name_part)
    if am and am.start() >= 2:
        alias = am.group(1)
        name_part = name_part[: am.start()]
    alternative = None
    om = re.search(r"或(.+)$", name_part)
    if om and om.start() >= 2:
        alternative = om.group(1)
        name_part = name_part[: om.start()]
    split = lexicon_split(name_part, book)
    descriptor = ""
    if split:
        name, descriptor, remainder, method = split
        processing = [remainder.strip("、，")] if remainder.strip("、，") else []
    else:
        name, processing = strip_suffix_processing(name_part)
        method = "suffix_strip"
    if descriptor and descriptor in PROCESSING_LIKE:
        processing.insert(0, descriptor)
        descriptor = ""
    if descriptor == "熟" and name in ("干地黄", "地黄"):
        name, descriptor = "熟地黄", ""
    processing_all = processing + [r for r in rest if r]
    item.update({
        "name": name,
        "processing": "，".join(processing_all) or None,
        "dose": dose,
        "doseOriginal": dose_orig,
        "method": method,
    })
    if descriptor:
        item["descriptor"] = descriptor
    if shared:
        item["sharedDose"] = True
    if alias:
        item["alias"] = alias
    if alternative:
        item["alternative"] = alternative
    if substitute:
        item["substitute"] = substitute
    if components:
        item["components"] = components
    if notes:
        item["note"] = "；".join(notes)
    return item


def resplit_glued(raws: list[str], book: set[str]) -> list[str]:
    """'甘草桔梗' (two herbs whose separator was lost in OCR) → ['甘草', '桔梗'] when both halves are lexicon words."""
    lex = CORE_LEX | book
    out: list[str] = []
    for r in raws:
        c = clean(r)
        head = re.split(r"[，,（(]", c)[0]
        done = False
        if head == c or re.match(r"^[一-龥]+(?:[，,（(]|$)", c):
            for k in range(2, len(head) - 1):
                a, b = head[:k], head[k:]
                bb, _ = split_dose_suffix(b, book)
                same = STANDARD_NAME.get(a, a) == STANDARD_NAME.get(b, b) or STANDARD_NAME.get(b) == a
                if a in lex and (b in lex or (bb in lex and bb != b)) and head not in lex and not same:
                    out += [a, c[k:]]
                    done = True
                    break
        if not done:
            out.append(r)
    return out


def finalize_ingredients(items: list[dict], bare_names: set[str]) -> list[dict]:
    """Prefix stripping (needs the book-wide bare-name set), shared '各' dose propagation, standard names."""
    for it in items:
        name = it.get("name")
        if not name:
            continue
        if name not in KEEP_WHOLE:
            for tok in PREFIX_TOKENS:
                if name.startswith(tok) and len(name) - len(tok) >= 2 and name[len(tok):] in bare_names:
                    it["name"] = name[len(tok):]
                    it["processing"] = tok + ("，" + it["processing"] if it.get("processing") else "")
                    it["prefixStripped"] = name
                    break
        std = STANDARD_NAME.get(it.get("prefixStripped") or "") or STANDARD_NAME.get(it["name"]) or it["name"]
        if it.get("alias") and it["alias"] in STANDARD_NAME and it["name"] not in STANDARD_NAME:
            std = STANDARD_NAME[it["alias"]]
        it["standardName"] = std
        known = it["name"] in bare_names or it["name"] in CORE_LEX
        if not known:
            it["unrecognizedName"] = True  # informational: a real herb seen only once / not in the curated list
        if (not known and (len(it["name"]) > 4 or re.search(r"[如用取去以为炒炙浸洗泡研切煎]", it["name"]))) or len(it["name"]) > 5 \
                or not re.fullmatch(r"[\u3400-\u4dbf一-龥]+", it["name"]) or (len(it["name"]) < 2 and it["name"] not in SINGLE_OK):
            it["lowConfidence"] = True
    # propagate shared ("各") doses backwards to preceding items that have no dose of their own
    for idx, it in enumerate(items):
        if it.get("sharedDose") and (it.get("dose") or it.get("doseOriginal")):
            j = idx - 1
            while j >= 0 and not items[j].get("dose") and not items[j].get("doseOriginal"):
                items[j]["dose"] = it.get("dose")
                items[j]["doseOriginal"] = it.get("doseOriginal")
                items[j]["sharedDose"] = True
                items[j]["doseInheritedFrom"] = it["name"]
                j -= 1
    return items


# ----------------------------------------------------------------------------------------------
# book structure
# ----------------------------------------------------------------------------------------------
CHAPTER_RE = re.compile(r"^第([一二三四五六七八九十]+)章[\s　]+(.+?)\s*$")
SECTION_RE = re.compile(r"^第([一二三四五六七八九十]+)节[\s　]+(.+?)\s*$")
LABEL_RE = re.compile(r"【([^】]{1,6})】")
LABEL_ALIASES = {"主用": "主治"}
CAUTION_RE = re.compile(r"煎|服|忌|慎|不宜|禁|注意|孕|中病即止|停|尽剂|过剂|久服|生冷|油腻|辛辣|避风|取汗|汗出|中毒|用量|剂量")


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？])", text)
    return [p.strip() for p in parts if p.strip()]


def find_book(lines: list[str]) -> tuple[int, int, int, int, int]:
    """CIP line, 上篇总论 (body, after the TOC), 下篇各论 (body), 附录方名索引, 参考书目."""
    norm = lambda s: re.sub(r"[\s　]", "", s)
    cip = next(i for i, l in enumerate(lines) if l.startswith("方剂学/李冀"))
    # the TOC also lists 附录/参考书目; the real index is the one followed by the stroke-count headings
    index = next(i for i in range(cip, len(lines)) if norm(lines[i]) == "附录方名索引" and norm(lines[i + 1]) == "一画")
    end = next(i for i in range(index, len(lines)) if lines[i].startswith("参考书目"))
    body = max(i for i in range(cip, index) if norm(lines[i]) == "下篇各论")  # last one = body (first is the TOC)
    general = max(i for i in range(cip, body) if norm(lines[i]) == "上篇总论")
    return cip, general, body, index, end


def parse_book_meta(lines: list[str], cip: int) -> dict:
    meta = {"title": "方剂学", "editors": "李冀，连建伟", "edition": "4版", "publisher": "中国中医药出版社", "year": 2016}
    for i in range(cip, cip + 30):
        m = re.search(r"ISBN\s*([0-9\-\s]{13,20})", lines[i])
        if m:
            meta["isbn"] = re.sub(r"\s+", "", m.group(1))
            meta["isbnLine"] = i + 1
            break
    meta["cipLine"] = cip + 1
    meta["cipText"] = lines[cip].strip()
    return meta


def parse_general_rules(lines: list[str], general: int, body: int) -> dict:
    start = next(i for i in range(general, body) if re.match(r"^第五章[\s　]+方剂的煎服法", lines[i]))
    end = next(i for i in range(start + 1, body) if CHAPTER_RE.match(lines[i]))
    dec = next(i for i in range(start, end) if lines[i].startswith("一、煎药法"))
    adm = next(i for i in range(start, end) if lines[i].startswith("二、服药法"))
    rec = lambda a, b: [{"text": lines[i].strip(), "line": i + 1} for i in range(a, b) if lines[i].strip()]
    return {
        "chapter": {"text": lines[start].strip(), "line": start + 1},
        "intro": rec(start + 1, dec),
        "decoction": rec(dec, adm),
        "administration": rec(adm, end),
    }


def is_name_line(lines: list[str], i: int) -> bool:
    """A main-formula name line is followed by a source line and then 【组成】."""
    return i + 2 < len(lines) and lines[i + 2].lstrip().startswith("【组成】") and "《" in lines[i + 1]


def parse_name_line(text: str) -> tuple[str, list[str], str | None]:
    text = fix_glyphs(text.strip())
    m = re.match(r"^([^（(]+?)\s*[（(](.+)[）)]\s*$", text)
    aliases: list[str] = []
    note = None
    if m:
        name, note = m.group(1), m.group(2)
        for kind, rest in re.findall(r"(原名|又名|亦名|一名)([^，；]+)", note):
            for a in re.split(r"[、，]", rest):
                a = a.strip()
                if a:
                    aliases.append(a)
    else:
        name = text
    name = re.sub(r"\s+", "", name)
    return name, aliases, note


def parse_source(text: str) -> dict:
    t = re.sub(r"[\s　]+", "", text.strip())
    books = re.findall(r"《([^》]+)》", t)
    primary = books[0] if books else None
    recorded = None
    m = re.search(r"录自《([^》]+)》", t)
    if m:
        recorded = m.group(1)
    cited_in = None
    m = re.search(r"《([^》]+)》引", t)
    if m:
        cited_in = m.group(1)
    return {
        "sourceRaw": t,
        "source": f"《{primary}》" if primary else None,
        "sourceBooks": books,
        "recordedIn": f"《{recorded}》" if recorded else None,
        "citedIn": f"《{cited_in}》" if cited_in else None,
    }


def fields_from_block(block: list[tuple[int, str]]) -> dict:
    """Split joined block text by 【label】 markers (anywhere in a line). Returns label → (text, line)."""
    fields: dict[str, dict] = {}
    order: list[str] = []
    current = None
    for lineno, text in block:
        pos = 0
        for m in LABEL_RE.finditer(text):
            if current is not None:
                chunk = text[pos:m.start()].strip()
                if chunk:
                    fields[current]["parts"].append((lineno, chunk))
            label = LABEL_ALIASES.get(m.group(1), m.group(1))
            if label in fields:  # repeated label: keep first occurrence, append
                current = label
            else:
                fields[label] = {"line": lineno, "parts": []}
                order.append(label)
                current = label
            pos = m.end()
        if current is not None:
            chunk = text[pos:].strip()
            if chunk:
                fields[current]["parts"].append((lineno, chunk))
    for k, v in fields.items():
        v["order"] = order.index(k)
    return fields


def ftext(fields: dict, label: str, sep: str = "\n") -> str | None:
    f = fields.get(label)
    if not f:
        return None
    return sep.join(clean(p) for _, p in f["parts"]) or None


def split_usage(usage: str | None) -> tuple[str | None, str | None]:
    if not usage:
        return None, None
    u = usage.replace("\n", "")
    m = re.search(r"[（(]现代用法[：:]\s*(.+?)[）)]\s*[。.]?\s*$", u)
    if m:
        orig = u[: m.start()].strip()
        return (orig.rstrip("。") + "。" if orig and not orig.endswith(("。", "）")) else orig) or None, m.group(1).strip().rstrip("。")
    m = re.search(r"[（(]现代用法[：:]\s*(.+)$", u)
    if m:
        return u[: m.start()].strip() or None, m.group(1).strip().rstrip("）)。")
    return u.strip(), None


USAGE_START_RE = re.compile(
    r"^(?:上|右|以上|共|并|先|每|将|凡|用法|现代用法|[一二三四五六七八九十]+味(?!子)|水煎|以水|用水|水[一二三四五六七八九十]+|为末|为细末|为粗末|"
    r"研为|研末|炼蜜|入|同|分|作|煎|煮|和匀|加|取|诸药|将息|温服|顿服|空心|食前|食后|临卧|不拘|酒煎|酒调|姜汤|米饮|温开水)"
)
USAGE_HINT_RE = re.compile(r"服|煎|煮|为末|为散|丸如|为丸|每用|水一|水二|酒调|和匀|糊丸|蜜丸|吞下|送下|调下|外用|敷|贴")


def looks_like_usage(chunk: str) -> bool:
    """Is this chunk of an appended-formula line the start of the usage text (vs. another ingredient)?"""
    c = clean(chunk)
    if USAGE_START_RE.match(c) and ("，" in c or "服" in c or "。" in c or len(c) > 6):
        return True
    if re.search(r"[（(][^（）()]*\d[^（）()]*[）)]$", c):  # ends with a modern dose → ingredient
        return False
    head = re.split(r"[，,（(]", c)[0]
    split = lexicon_split(head, set())
    if split and split[3] in ("core_exact", "core_prefix", "descriptor_core") and "服" not in c:
        return False
    if re.search(r"服[。]?$", c):
        return True
    if "，" in c and USAGE_HINT_RE.search(c):
        return True
    return False


def parse_appended_line(text: str) -> dict | None:
    t = fix_glyphs(text.strip())
    m = re.match(
        r"^(?:【附方】)?\s*(?:附[：:]\s*)?(?:(\d{1,2})\s*[.．、]\s*)?([^\s（(【]{2,24}?)\s*[（(]\s*(《[^\n]*?)[）)](?=\s|　|$)",
        t,
    )
    if not m:
        return None
    num, name, src = m.group(1), m.group(2), m.group(3)
    rest = t[m.end():]
    rec: dict = {"number": int(num) if num else None, "name": re.sub(r"\s+", "", name)}
    s = parse_source(src.split("，")[0] if "，" in src else src)
    # aliases after the source: "（《…》，又名妙应丸、子龙丸）" / "原名…" / "名见《…》"
    aliases = []
    for kind, al in re.findall(r"(原名|又名|亦名|一名)([^，；）]+)", src):
        aliases += [a for a in re.split(r"[、，]", al) if a]
    s["sourceRaw"] = re.sub(r"\s+", "", src)
    s["sourceBooks"] = re.findall(r"《([^》]+)》", src)
    rm = re.search(r"录自《([^》]+)》", src)
    s["recordedIn"] = f"《{rm.group(1)}》" if rm else None
    rec.update(s)
    rec["aliases"] = aliases
    # functions / indications
    fm = re.search(r"功用[：:；;]\s*(.+?)(?=主治[：:；;]|$)", rest)
    im = re.search(r"主治[：:；;]\s*(.+)$", rest)
    rec["functions"] = clean(fm.group(1)) if fm else None
    rec["indications"] = clean(im.group(1)) if im else None
    rec["attachedNote"] = None
    if rec["indications"] and "附：" in rec["indications"]:  # 冷哮丸 … 附：三建膏方 (continuation line)
        rec["indications"], rec["attachedNote"] = [x.strip() for x in rec["indications"].split("附：", 1)]
        rec["attachedNote"] = "附：" + rec["attachedNote"]
    body = rest[: fm.start()] if fm else (rest[: im.start()] if im else rest)
    chunks = split_items(body)
    ingredients_raw: list[str] = []
    usage_chunks: list[str] = []
    rec["derivedFrom"] = None
    if chunks:
        dm = re.match(r"^即(.{2,12}?)加(.+)$", clean(chunks[0]))
        if dm:
            rec["derivedFrom"] = dm.group(1)
            chunks[0] = dm.group(2)
    for c in chunks:
        if not usage_chunks:
            # "竹叶三十片（3g）（甚者加石膏五钱，冬米一撮）水煎服。" → ingredient + glued usage
            gm = re.match(r"^([^，,（(]+(?:[（(][^（）()]*[）)])+)([^，,（）()][^（）()]*(?:服|煎|煮)[^（）()]*)$", c)
            if gm and re.search(r"[（(][^（）()]*\d", gm.group(1)) and not re.search(r"\dg", gm.group(2)) \
                    and not USAGE_START_RE.match(clean(c)):
                ingredients_raw.append(gm.group(1))
                usage_chunks.append(gm.group(2))
                continue
        if usage_chunks or looks_like_usage(c):
            usage_chunks.append(c)
        else:
            ingredients_raw.append(c)
    # "甘草5g（原著本方无用量）水煎服" → usage glued after the last ingredient
    if ingredients_raw and not usage_chunks:
        gm = re.search(r"(?<=[）)])\s*([^（）()]*(?:服|煎)[^（）()]*)$", ingredients_raw[-1])
        if gm and not re.search(r"[0-9]g", gm.group(1)):
            usage_chunks.append(gm.group(1))
            ingredients_raw[-1] = ingredients_raw[-1][: gm.start()]
    usage = clean(fix_glyphs("".join(usage_chunks))) if usage_chunks else None
    rec["ingredientsRaw"] = ingredients_raw
    rec["usageRaw"] = usage
    uo, um = split_usage(usage)
    rec["usageOriginal"], rec["usageModern"] = uo, um
    return rec


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_formula_profiles.py <source.txt> <out.json>", file=sys.stderr)
        return 2
    src_path, out_path = sys.argv[1], sys.argv[2]
    raw = open(src_path, "rb").read()
    lines = raw.decode("utf-8", errors="replace").split("\n")
    cip, general, body, index, end = find_book(lines)
    book = parse_book_meta(lines, cip)
    book["bodyLines"] = {"generalPart": general + 1, "specificPart": body + 1, "formulaIndex": index + 1, "end": end}
    general_rules = parse_general_rules(lines, general, body)

    categories: list[dict] = []
    formulas: list[dict] = []
    chapter = section = None
    cat_cur: dict | None = None
    i = body + 1
    formula_starts = [j for j in range(body, index) if is_name_line(lines, j)]
    formula_start_set = set(formula_starts)
    while i < index:
        line = lines[i]
        s = line.strip()
        cm = CHAPTER_RE.match(s)
        sm = SECTION_RE.match(s)
        if cm or sm:
            if cm:
                chapter, section = re.sub(r"\s+", "", cm.group(2)), None
            else:
                section = re.sub(r"\s+", "", sm.group(2))
            cat_cur = {"chapter": chapter, "section": section, "line": i + 1, "intro": []}
            categories.append(cat_cur)
            i += 1
            continue
        if i in formula_start_set:
            cat_cur = None
            nxt = next((j for j in formula_starts if j > i), index)
            # block ends at next formula, next heading or 复习思考题
            stop = nxt
            for j in range(i + 3, nxt):
                if CHAPTER_RE.match(lines[j].strip()) or SECTION_RE.match(lines[j].strip()) or lines[j].startswith("复习思考题"):
                    stop = j
                    break
            block = [(j + 1, lines[j]) for j in range(i + 2, stop)]
            name, aliases, name_note = parse_name_line(lines[i])
            src = parse_source(lines[i + 1])
            fields = fields_from_block(block)
            comp = fields.get("组成")
            comp_text = fix_glyphs(" ".join(p for _, p in comp["parts"])) if comp else ""
            # trailing notes on the composition line e.g. "（原著本方无用量）"
            ingr_raw = split_items(comp_text)
            usage_raw = ftext(fields, "用法", "")
            usage_raw = fix_glyphs(usage_raw) if usage_raw else None
            uo, um = split_usage(usage_raw)
            application = ftext(fields, "运用", "")
            cautions = [x for x in split_sentences(application or "") if re.search(r"忌|慎|不宜|禁|不可|孕|过服|中病即止|停后服|过剂|久服|不能|勿|中毒|用量", x)]
            rec = {
                "name": name,
                "aliases": aliases,
                "nameNote": name_note,
                "kind": "main",
                "chapter": chapter,
                "section": section,
                **src,
                "compositionRaw": clean(comp_text),
                "ingredientsRaw": ingr_raw,
                "usageRaw": usage_raw,
                "usageOriginal": uo,
                "usageModern": um,
                "functions": ftext(fields, "功用", ""),
                "indications": ftext(fields, "主治", "\n"),
                "compatibilityFeatures": ftext(fields, "配伍特点", ""),
                "application": application,
                "applicationCautions": cautions,
                "line": i + 1,
                "lines": {
                    "name": i + 1,
                    "source": i + 2,
                    **{k: fields[k]["line"] for k, key in [("组成", 0), ("用法", 0), ("功用", 0), ("主治", 0), ("配伍特点", 0), ("运用", 0), ("附方", 0)] if k in fields},
                },
            }
            # rename CJK keys in lines map
            rec["lines"] = {
                {"组成": "composition", "用法": "usage", "功用": "functions", "主治": "indications", "配伍特点": "compatibilityFeatures", "运用": "application", "附方": "appended"}.get(k, k): v
                for k, v in rec["lines"].items()
            }
            flags = []
            if name != re.sub(r"\s+", "", lines[i].split("（")[0]):
                flags.append("name_glyph_repaired")
            for need in ("组成", "用法", "功用", "主治"):
                if need not in fields:
                    flags.append(f"missing_{need}")
            if "主用" in " ".join(t for _, t in block):
                flags.append("label_ocr_主用_as_主治")
            rec["flags"] = flags
            formulas.append(rec)
            # appended formulas: lines of the 【附方】 field (first line may carry an item inline)
            fu = fields.get("附方")
            if fu:
                items: list[tuple[int, str, list[str]]] = []
                for lineno, part in fu["parts"]:
                    if re.match(r"^(?:\d{1,2}\s*[.．、]\s*)?[^\s（(]{2,24}?\s*[（(]\s*《", part) and not part.startswith("附："):
                        items.append((lineno, part, []))
                    elif items:
                        prev = items[-1]
                        items[-1] = (prev[0], prev[1] + " " + part, prev[2] + [f"merged_continuation_line_{lineno}"])
                for lineno, part, merged in items:
                    ap = parse_appended_line(part)
                    if not ap:
                        formulas.append({"name": None, "kind": "appended", "parent": name, "raw": part, "line": lineno, "lowConfidence": True, "flags": ["unparsed"]})
                        continue
                    ingr_raw_ap = ap.pop("ingredientsRaw")
                    flags_ap = list(merged)
                    ap_rec = {
                        "name": ap["name"],
                        "aliases": ap.pop("aliases"),
                        "kind": "appended",
                        "parent": name,
                        "number": ap.pop("number"),
                        "chapter": chapter,
                        "section": section,
                        "sourceRaw": ap["sourceRaw"],
                        "source": ap["source"],
                        "sourceBooks": ap["sourceBooks"],
                        "recordedIn": ap["recordedIn"],
                        "citedIn": ap.get("citedIn"),
                        "ingredientsRaw": ingr_raw_ap,
                        "usageRaw": ap["usageRaw"],
                        "usageOriginal": ap["usageOriginal"],
                        "usageModern": ap["usageModern"],
                        "functions": ap["functions"],
                        "indications": ap["indications"],
                        "compatibilityFeatures": None,
                        "derivedFrom": ap.get("derivedFrom"),
                        "attachedNote": ap.get("attachedNote"),
                        "raw": clean(part),
                        "line": lineno,
                        "lines": {"name": lineno, "source": lineno, "composition": lineno, "usage": lineno, "functions": lineno, "indications": lineno},
                        "flags": flags_ap,
                    }
                    formulas.append(ap_rec)
            i = stop
            continue
        if cat_cur is not None and s:
            cat_cur["intro"].append({"text": clean(s), "line": i + 1})
        i += 1

    # ---- ingredient parsing. pass 1 (no book lexicon) collects clean short names; pass 2 uses them.
    book_lex: set[str] = set()
    for f in formulas:
        for r in f.get("ingredientsRaw", []):
            it = parse_ingredient(r)
            n = it.get("name")
            if n and 2 <= len(n) <= 4 and re.fullmatch(r"[一-龥]+", n) and (it.get("dose") or it.get("doseOriginal") or it.get("processing")):
                if not any(n.startswith(d) and n[len(d):] in CORE_LEX for d in DESCRIPTORS):
                    book_lex.add(n)
    bare = book_lex | CORE_LEX
    for f in formulas:
        f["ingredientsRaw"] = resplit_glued(f.get("ingredientsRaw", []), book_lex)
        items = [parse_ingredient(r, book_lex) for r in f["ingredientsRaw"]]
        items = [it for it in items if it.get("name") or it.get("dose")]
        # formula-level notes such as "（以上十味，原著本方无用量）" / "（原著本方无用量）"
        comp_notes = []
        for it in items:
            if it.get("note") and re.search(r"原著|以上|原方|本方", it["note"]):
                comp_notes.append(it.pop("note"))
        if comp_notes:
            f["compositionNotes"] = comp_notes
        f["ingredients"] = finalize_ingredients(items, bare)
        del f["ingredientsRaw"]
    # derived appended formulas ("即六味地黄丸加知母、黄柏"): prepend the base formula's ingredients
    by_name = {}
    for f in formulas:
        if f.get("name") and f["kind"] == "main":
            by_name.setdefault(f["name"], f)
            for a in f.get("aliases", []):
                by_name.setdefault(a, f)
    for f in formulas:
        base_name = f.get("derivedFrom")
        if not base_name:
            continue
        base = by_name.get(base_name)
        additions = f["ingredients"]
        for it in additions:
            it["addedToBase"] = True
        if base:
            f["ingredients"] = [dict(x, fromBase=base_name) for x in base["ingredients"]] + additions
            f["derivedFromLine"] = base["line"]
        else:
            f["flags"].append(f"derivation_base_not_found:{base_name}")
    for f in formulas:
        low = [it["name"] for it in f["ingredients"] if it.get("lowConfidence")]
        if f["kind"] == "appended":
            if not f["ingredients"]:
                f["flags"].append("no_ingredients_parsed")
            if not f.get("functions"):
                f["flags"].append("no_functions")
            if not f.get("usageRaw"):
                f["flags"].append("no_usage_parsed")
            if not f.get("source"):
                f["flags"].append("no_source")
        if low:
            f["flags"].append("suspicious_ingredient_names:" + "、".join(low))
        f["lowConfidence"] = bool(f.get("flags")) and any(
            x.startswith(("no_", "unparsed", "merged", "suspicious", "missing_", "derivation_base_not_found")) for x in f["flags"]
        )
        f["ingredientCount"] = len(f["ingredients"])

    # ---- categories: caution sentences
    for c in categories:
        sents = []
        for rec in c["intro"]:
            for sent in split_sentences(rec["text"]):
                if CAUTION_RE.search(sent) and not re.search(r"代表方|分为|统称为|适用于.*证[。]$", sent):
                    sents.append({"text": sent, "line": rec["line"]})
        c["usageCautionSentences"] = sents
        c["usageCautions"] = "".join(x["text"] for x in sents) or None

    # ---- index coverage (附录 方名索引): "温经汤（《金匮要略》）" pairs, "八珍汤（原名八珍散）" names
    index_names = []
    for j in range(index + 1, end):
        m = re.match(r"^(\S+?)[\s　]+(\d+)$", lines[j].strip())
        if m:
            raw_name = fix_glyphs(m.group(1)).replace("☒", "䗪")
            base = re.sub(r"[（(].*$", "", raw_name)
            books = re.findall(r"《([^》]+)》", raw_name)
            index_names.append({"name": raw_name, "baseName": base, "sourceHint": books[0] if books else None, "page": int(m.group(2)), "line": j + 1})
    missing = []
    for x in index_names:
        cands = [f for f in formulas if f.get("name") == x["baseName"] or x["baseName"] in f.get("aliases", [])]
        if x["sourceHint"]:
            cands = [f for f in cands if x["sourceHint"] in (f.get("sourceBooks") or []) or x["sourceHint"] in (f.get("sourceRaw") or "")]
        x["matched"] = [{"name": f["name"], "kind": f["kind"], "line": f["line"]} for f in cands]
        if not cands:
            missing.append(x)
    extracted_not_in_index = sorted({f["name"] for f in formulas if f.get("name")} - {x["baseName"] for x in index_names} - {a for x in index_names for a in [x["baseName"]]})

    main_n = sum(1 for f in formulas if f["kind"] == "main")
    app_n = sum(1 for f in formulas if f["kind"] == "appended")
    payload = {
        "schemaVersion": "textbook-formula-profiles-v1",
        "sourceFile": {"path": src_path, "sha256": hashlib.sha256(raw).hexdigest(), "lineCount": len(lines)},
        "book": book,
        "generalRules": general_rules,
        "categories": categories,
        "formulas": formulas,
        "counts": {
            "main": main_n,
            "appended": app_n,
            "withSource": sum(1 for f in formulas if f.get("source")),
            "withUsage": sum(1 for f in formulas if f.get("usageRaw")),
            "withModernUsage": sum(1 for f in formulas if f.get("usageModern")),
            "withFunctions": sum(1 for f in formulas if f.get("functions")),
            "withIngredients": sum(1 for f in formulas if f.get("ingredients")),
            "lowConfidence": sum(1 for f in formulas if f.get("lowConfidence")),
            "categories": len(categories),
        },
        "indexCoverage": {"indexEntries": len(index_names), "missingFromExtraction": missing, "extractedButNotInIndex": extracted_not_in_index},
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    print(json.dumps(payload["counts"], ensure_ascii=False), json.dumps({"indexEntries": len(index_names), "indexMissing": len(missing)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
