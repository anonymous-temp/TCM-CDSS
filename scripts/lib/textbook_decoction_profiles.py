#!/usr/bin/env python3
"""Build formula-decoction-profiles.json from textbook-formulas.json (方剂学 李冀/连建伟 4版).

Deterministic, stdlib only. Re-running produces byte-identical output.

Per main formula (kind == "main") that has a 【用法】 line:
  name, chapter, section, line, usageLine, usageOriginal, usageModern,
  sweatingRegimen  porridge_and_cover | cover_light_sweat_no_porridge | no_sweat_induction | none
  timing           fasting | before_meal | after_meal | bedtime | any | null  (+ timingAll, timingWords, timingSource)
  decoctionNotes   [{kinds[], text, source}]   source = usage_original | usage_modern | application
  postDoseNotes    [{kinds[], text, source}]   porridge / warm water / cover / dietary avoidance / stop-when-effective ...
plus a top-level chapterCautions object keyed by chapter.

Rules (all keyed on the textbook's own words; nothing is inferred from other books):
  sweatingRegimen
    porridge_and_cover              an un-negated 啜(热)(稀)粥 appears in 用法 (原文 or 现代用法)
    cover_light_sweat_no_porridge   a cover phrase (温覆/覆取/衣被盖/盖被/被盖/醉盖/渐渐覆/绕腰...) together with 汗
                                    and no un-negated 啜粥 (麻黄汤: 覆取微似汗，不须啜粥 -> this class)
    no_sweat_induction              chapter 解表剂, but the usage names neither porridge nor a cover phrase
    none                            everything else (non-解表 formulas that do not instruct sweating)
  timing  = words found in the 现代用法 if it has any, else in the 原文 用法; null when neither says anything.
    空腹/空心 -> fasting; 食前/饭前/先食 -> before_meal; 食后/饭后 -> after_meal;
    临卧/睡前/临睡/卧时/夜卧 -> bedtime; 不拘时/不计时/无时/食远/食前后 -> any (raw words kept in timingWords).
    When several words occur, `timing` is the first one in the text and `timingAll` lists them all.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1]
OUT = sys.argv[2]

t = json.load(open(SRC, encoding='utf-8'))

# ---------------------------------------------------------------- helpers
def sentences(text):
    """Split into 。；-delimited sentences, keeping the terminator out."""
    return [s.strip() for s in re.split(r'[。；]', text or '') if s.strip()]

def clause_span(sentence, start, end, maxlen=70):
    """Whole sentence when short, else the comma-clauses spanning [start, end)."""
    if len(sentence) <= maxlen:
        return sentence
    a = sentence.rfind('，', 0, start) + 1
    b = sentence.find('，', end)
    b = len(sentence) if b < 0 else b
    return sentence[a:b].strip()

def clause_around(sentence, m, maxlen=70):
    return clause_span(sentence, m.start(), m.end(), maxlen)

def scan(text, table, source):
    """table: list of (kind, compiled_regex). One note per distinct clipped text, with all its kinds."""
    notes, index = [], {}
    for s in sentences(text):
        hits = []  # (kind, match)
        for kind, rx in table:
            m = rx.search(s)
            if m:
                if kind == 'porridge' and porridge_negated_at(s, m):
                    kind = 'porridge_not_needed'
                hits.append((kind, m))
        if not hits:
            continue
        txt = clause_span(s, min(m.start() for _, m in hits), max(m.end() for _, m in hits))
        if txt in index:
            n = notes[index[txt]]
            for k, _ in hits:
                if k not in n['kinds']:
                    n['kinds'].append(k)
        else:
            index[txt] = len(notes)
            notes.append({'kinds': [k for k, _ in hits], 'text': txt, 'source': source})
    return notes

NEG = ('不须', '不必', '不用', '不可', '勿', '无需', '不需', '毋')

def porridge_negated_at(sentence, m):
    before = sentence[max(0, m.start() - 3):m.start()]
    return any(n in before for n in NEG)

def porridge_instructed(text):
    for m in re.finditer(r'啜(?:热)?(?:稀)?粥', text or ''):
        before = text[max(0, m.start() - 3):m.start()]
        if not any(before.endswith(n) or n in before for n in NEG):
            return True
    return False

def porridge_negated(text):
    for m in re.finditer(r'啜(?:热)?(?:稀)?粥', text or ''):
        before = text[max(0, m.start() - 3):m.start()]
        if any(n in before for n in NEG):
            return True
    return False

COVER_RX = re.compile(r'温覆|覆取|覆被|覆之|衣被盖|盖被|被盖|醉盖|渐渐覆|绕腰')
SWEAT_TARGET_RX = re.compile(r'微似|取微汗|微汗|取汗|出汗|汗出愈|欲汗|急汗|缓汗|发汗|令微汗|盖被取汗|被盖出汗')

def sweating(chapter, usage_all):
    porridge = porridge_instructed(usage_all)
    cover = bool(COVER_RX.search(usage_all))
    sweat_word = '汗' in usage_all
    if porridge:
        reg = 'porridge_and_cover'
    elif cover and sweat_word:
        reg = 'cover_light_sweat_no_porridge'
    elif chapter == '解表剂':
        reg = 'no_sweat_induction'
    else:
        reg = 'none'
    evidence = []
    for s in sentences(usage_all):
        m = re.search(r'啜(?:热)?(?:稀)?粥', s) or COVER_RX.search(s) or SWEAT_TARGET_RX.search(s)
        if m:
            evidence.append(clause_around(s, m))
    conditional = bool(re.search(r'(如|若)欲|若缓汗|若急汗|如觉欲汗', usage_all)) and reg != 'porridge_and_cover'
    return {
        'sweatingRegimen': reg,
        'lightSweatTarget': bool(SWEAT_TARGET_RX.search(usage_all)),
        'porridgeNegated': porridge_negated(usage_all),
        'sweatingConditional': conditional,
        'sweatingEvidence': evidence[:4],
    }

# ---------------------------------------------------------------- timing
TIMING_TABLE = [
    ('any', re.compile(r'食前后|不拘时|不计时|无时|随病不拘时|食远')),
    ('fasting', re.compile(r'空腹|空心|平旦空')),
    ('before_meal', re.compile(r'食前|饭前|先食')),
    ('after_meal', re.compile(r'食后|饭后')),
    ('bedtime', re.compile(r'临卧|睡前|临睡|卧时|夜卧|睡时')),
]

def timing_of(text):
    hits = []  # (position, kind, word)
    for kind, rx in TIMING_TABLE:
        for m in rx.finditer(text or ''):
            # 食前后 also contains 食前 - keep only the longer match
            hits.append((m.start(), kind, m.group(0)))
    # drop "食前" that is really the prefix of "食前后"
    spans = [(p, w) for p, k, w in hits if w == '食前后']
    hits = [h for h in hits if not (h[2] == '食前' and any(h[0] == p for p, _ in spans))]
    hits.sort()
    if not hits:
        return None, [], []
    kinds = []
    for _, k, _w in hits:
        if k not in kinds:
            kinds.append(k)
    words = []
    for _, _k, w in hits:
        if w not in words:
            words.append(w)
    return kinds[0], kinds, words

# ---------------------------------------------------------------- decoction / post-dose notes
DECOCT = [
    ('pre_decoct', re.compile(r'先煎|先煮|先将.{0,8}煎')),
    ('post_add', re.compile(r'后下|后入|后煎|内诸药|纳诸药|内(?:大黄|芒硝|胶饴|阿胶)|纳(?:大黄|芒硝|胶饴|阿胶)|余药后下')),
    ('skim_foam', re.compile(r'去沫|去上沫')),
    ('decoct_again', re.compile(r'去滓再煎|去滓，再煎|再煎')),
    ('short_decoction', re.compile(r'勿过煮|不宜久煎|不可久煎|煎煮太过|煎熬太过|香气大出|煎煮时间不宜过长|不宜煎煮')),
    ('heat', re.compile(r'微火|文火|武火|慢火|急火')),
    ('boil_count', re.compile(r'三沸|数沸|二三沸|一二沸|煎数沸')),
    ('wrap', re.compile(r'包煎|布包|绢袋|生绢小袋|纱布包|纱布袋')),
    ('melt_or_dissolve', re.compile(r'烊化|溶服|溶芒硝|兑入|化服|溶化')),
    ('infuse_powder', re.compile(r'冲服|冲入')),
    ('special_water', re.compile(r'劳水|甘澜水|流水|泉水|井花水|米泔|苇根汤')),
    ('wine_decoction', re.compile(r'水酒各半|酒煎|加无灰酒|入酒|加酒')),
]

POST = [
    ('porridge', re.compile(r'啜(?:热)?(?:稀)?粥|饮热粥|糜粥|米粥|羹粥|饮粥|食糜|冷粥|稀粥')),
    ('warm_water', re.compile(r'多饮暖水|多饮热水|暖水')),
    ('cover_warm', re.compile(r'温覆|覆取|衣被盖|盖被|被盖|醉盖|渐渐覆|勿发揭衣被|绕腰')),
    ('avoid_wind', re.compile(r'避风')),
    ('dietary_avoidance', re.compile(r'禁生冷|禁食|忌')),
    ('stop_when_effective', re.compile(r'停后服|不必尽剂|得快下利|中病即止|以利为度|嗽住止后服|得下止后服|得吐止')),
    ('external_powder', re.compile(r'温粉扑之')),
]

def flatten_notes(*lists):
    out, seen = [], set()
    for lst in lists:
        for n in lst:
            k = (tuple(n['kinds']), n['text'])
            if k not in seen:
                seen.add(k)
                out.append(n)
    return out

def profile(f):
    orig = f.get('usageOriginal') or f.get('usageRaw') or ''
    modern = f.get('usageModern')
    # usageOriginal is the part before （现代用法…）; when the extractor did not split, usageRaw is the whole text.
    usage_all = (orig + ('（现代用法：' + modern + '）' if modern else '')).strip()
    sw = sweating(f['chapter'], usage_all)
    tm_src = 'usage_modern' if modern and timing_of(modern)[0] else ('usage_original' if timing_of(orig)[0] else None)
    if tm_src == 'usage_modern':
        tm, tm_all, tm_words = timing_of(modern)
    elif tm_src == 'usage_original':
        tm, tm_all, tm_words = timing_of(orig)
    else:
        tm, tm_all, tm_words = None, [], []
    dec = flatten_notes(scan(orig, DECOCT, 'usage_original'), scan(modern or '', DECOCT, 'usage_modern'))
    app = []
    for c in (f.get('applicationCautions') or []):
        if re.search(r'煎|煮', c):
            app.append({'kinds': ['short_decoction' if re.search(r'久煎|过煮|时间不宜过长', c) else 'application_note'],
                        'text': c, 'source': 'application'})
    dec = flatten_notes(dec, app)
    post = flatten_notes(scan(orig, POST, 'usage_original'), scan(modern or '', POST, 'usage_modern'))
    rec = {
        'name': f['name'],
        'chapter': f['chapter'],
        'section': f['section'],
        'line': f['line'],
        'usageLine': f['lines'].get('usage'),
        'usageOriginal': orig,
        'usageModern': modern,
        'sweatingRegimen': sw['sweatingRegimen'],
        'lightSweatTarget': sw['lightSweatTarget'],
        'sweatingConditional': sw['sweatingConditional'],
        'sweatingEvidence': sw['sweatingEvidence'],
        'timing': tm,
        'timingAll': tm_all,
        'timingWords': tm_words,
        'timingSource': tm_src,
        'decoctionNotes': dec,
        'postDoseNotes': post,
    }
    return rec

# ---------------------------------------------------------------- chapter cautions
TAGS = [
    ('avoid_prolonged_decoction', re.compile(r'不宜久煎')),
    ('warm_serving', re.compile(r'宜温服')),
    ('avoid_wind_cold', re.compile(r'避风寒')),
    ('cover_or_porridge_for_sweat', re.compile(r'增衣被|啜热粥')),
    ('light_sweat_target', re.compile(r'遍身微汗|微汗为佳')),
    ('stop_when_effective', re.compile(r'得效即止|中病即止|不必尽剂|即当停服|应中病即止')),
    ('avoid_raw_cold_greasy', re.compile(r'禁食生冷|忌食油腻|忌食生冷')),
    ('pills_powders_not_decocted', re.compile(r'不宜加热煎煮')),
    ('take_on_empty_stomach', re.compile(r'空腹服用')),
    ('avoid_long_term_use', re.compile(r'不宜久服|不可久服|不宜长期服用')),
    ('hot_drug_cold_or_reverse_serving', re.compile(r'热药冷服|服寒凉剂入口即吐|服药入口即吐')),
    ('after_emetic_care', re.compile(r'避风寒，以防吐后体虚|冷粥|稀粥自养|多饮热水以助涌吐')),
    ('porridge', re.compile(r'热粥|稀粥|冷粥')),
]

def general_rule_sentence(pattern):
    """Pull a sentence (with its line) from the 第五章 煎服法 text so nothing is typed by hand."""
    rx = re.compile(pattern)
    for blk in t['generalRules']['decoction'] + t['generalRules']['administration']:
        for s in re.findall(r'[^。]+。?', blk['text']):
            if rx.search(s):
                return {'text': s.strip().lstrip('\u201d\u201c'), 'line': blk['line']}
    return None

# chapters whose decoction / timing follow a 第五章 general rule (basis is quoted from the book, not invented)
GENERAL_DECOCTION = {
    '解表剂': general_rule_sentence(r'解表和泻下剂，煎煮时间宜短'),
    '泻下剂': general_rule_sentence(r'解表和泻下剂，煎煮时间宜短'),
    '补益剂': general_rule_sentence(r'补益之剂，煎煮时间宜长'),
}
GENERAL_TIMING = {
    '补益剂': general_rule_sentence(r'补益药和泻下药，宜空腹服'),
    '泻下剂': general_rule_sentence(r'补益药和泻下药，宜空腹服'),
    '安神剂': general_rule_sentence(r'安神药宜临卧服'),
}

def chapter_cautions():
    out = {}
    for c in t['categories']:
        ch = c['chapter']
        entry = out.setdefault(ch, {'line': None, 'sentences': [], 'tags': [],
                                    'generalDecoctionRule': GENERAL_DECOCTION.get(ch),
                                    'generalTimingRule': GENERAL_TIMING.get(ch),
                                    'note': None})
        if c['section'] is None:
            entry['line'] = c['line']
        for s in c['usageCautionSentences']:
            entry['sentences'].append({'text': s['text'], 'line': s['line'], 'section': c['section']})
    for ch, e in out.items():
        tags = []
        for s in e['sentences']:
            for tag, rx in TAGS:
                if rx.search(s['text']) and tag not in tags:
                    tags.append(tag)
        e['tags'] = tags
        if not e['sentences']:
            e['note'] = ('章节导语中没有煎服/使用注意类句子（按本脚本的规则未抽到）；'
                         '此类方剂的煎服法只能取自各方自己的【用法】。')
    return out

# ---------------------------------------------------------------- build
main = [f for f in t['formulas'] if f['kind'] == 'main' and (f.get('usageOriginal') or f.get('usageRaw'))]
appended = [f for f in t['formulas'] if f['kind'] == 'appended' and (f.get('usageOriginal') or f.get('usageRaw'))]

profiles = [profile(f) for f in main]
appended_profiles = []
for f in appended:
    p = profile(f)
    p['parent'] = f.get('parent')
    appended_profiles.append(p)

from collections import Counter
doc = {
    'schemaVersion': 'formula-decoction-profiles-v1',
    'source': {
        'book': '方剂学 李冀、连建伟主编 4版 中国中医药出版社 2016',
        'extraction': 'textbook-formulas.json (extract_formula_profiles.py)',
        'sha256OfTextFile': t['sourceFile']['sha256'],
        'generalDecoctionChapterLine': t['generalRules']['chapter']['line'],
    },
    'rules': __doc__.strip().split('\n'),
    'counts': {
        'mainFormulasWithUsage': len(profiles),
        'appendedFormulasWithUsage': len(appended_profiles),
        'sweatingRegimen': dict(Counter(p['sweatingRegimen'] for p in profiles)),
        'timing': dict(Counter(str(p['timing']) for p in profiles)),
        'withDecoctionNotes': sum(1 for p in profiles if p['decoctionNotes']),
        'withPostDoseNotes': sum(1 for p in profiles if p['postDoseNotes']),
    },
    'chapterCautions': chapter_cautions(),
    'formulas': profiles,
    'appendedFormulas': appended_profiles,
}
with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump(doc, fh, ensure_ascii=False, indent=1)
print('wrote', OUT, json.dumps(doc['counts'], ensure_ascii=False))
