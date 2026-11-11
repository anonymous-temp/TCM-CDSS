#!/usr/bin/env python3
"""把 out/*.json 里核过的行并成仓库的人工维护输入 src/data/tcm-formula-original-compositions.source.json。
逐行过 check_rows；按（方名, 规范书名, variant）去重（agent 核过的优先于自动行；original_text 优先）。"""
import json, re, os, sys, glob, collections
sys.path.insert(0, '/var/tmp/r1057/tools')
import check_rows
WT = '/var/tmp/r1057/wt'; OUT = WT + '/src/data/tcm-formula-original-compositions.source.json'
BOOK_ALIASES = {
 '局方': '太平惠民和剂局方', '和剂局方': '太平惠民和剂局方', '太平惠民合剂局方': '太平惠民和剂局方', '宋·太平惠民和剂局方': '太平惠民和剂局方',
 '济生方': '严氏济生方', '重订严氏济生方': '严氏济生方', '严氏济生续方': '严氏济生方', '济生续方': '严氏济生方',
 '金匮': '金匮要略', '金匮要略方论': '金匮要略', '千金要方': '备急千金要方', '千金方': '备急千金要方', '千金': '备急千金要方', '圣惠方': '太平圣惠方', '圣惠': '太平圣惠方',
 '三因方': '三因极一病证方论', '三因': '三因极一病证方论', '本事方': '普济本事方', '妇人良方': '妇人大全良方', '妇人良方大全': '妇人大全良方', '宣明论方': '黄帝素问宣明论方', '宣明论': '黄帝素问宣明论方',
 '保命集': '素问病机气宜保命集', '通俗伤寒论': '重订通俗伤寒论', '小儿药证直决': '小儿药证直诀', '外台': '外台秘要', '杂病证治新义': '中医内科杂病证治新义',
 '正宗': '外科正宗', '金鉴': '医宗金鉴', '准绳': '证治准绳', '外科全生集': '外科证治全生集', '全生集': '外科证治全生集', '景岳': '景岳全书', '条辨': '温病条辨', '内外伤辨': '内外伤辨惑论', '辨惑论': '内外伤辨惑论',
 '丹溪': '丹溪心法', '医醇剩义': '医醇賸义', '医醇滕义': '医醇賸义', '医醇义': '医醇賸义', '校注医醇賸义': '医醇賸义', '伤寒论（宋本）': '伤寒论', '伤寒杂病论': '伤寒论', '瘟疫论': '温疫论',
 '衷中参西录': '医学衷中参西录', '傅青主女科·产后编': '傅青主女科', '女科': '傅青主女科', '万氏妇人科': '万氏女科', '南阳活人书': '类证活人书', '活人书': '类证活人书', '慎斋遗书': '周慎斋遗书',
 '沈氏尊生书': '杂病源流犀烛', '古今医统': '古今医统大全', '名医方论': '古今名医方论', '增订十药神书': '十药神书', '随息居重订霍乱论': '霍乱论', '立斋外科发挥': '外科发挥', '痘疹心法': '痘疹世医心法',
 '叶天士女科诊治秘方': '叶氏女科证治', '叶天士妇科诊治秘方': '叶氏女科证治', '仁斋直指': '仁斋直指方论', '仁斋直指方': '仁斋直指方论', '直指方': '仁斋直指方论', '世医得效': '世医得效方', '得效方': '世医得效方',
 '脾胃论·卷中': '脾胃论', '兰室秘藏·卷上': '兰室秘藏', '证治准绳·类方': '证治准绳', '证治准绳·幼科': '证治准绳', '证治准绳·疡医': '证治准绳', '证治准绳·女科': '证治准绳', '疡医准绳': '证治准绳', '幼科准绳': '证治准绳', '女科准绳': '证治准绳',
 '医宗金鉴·外科心法要诀': '医宗金鉴', '医宗金鉴·妇科心法要诀': '医宗金鉴', '医宗金鉴·幼科心法要诀': '医宗金鉴', '外科心法要诀': '医宗金鉴', '妇科心法要诀': '医宗金鉴', '幼科心法要诀': '医宗金鉴', '删补名医方论': '医宗金鉴', '正骨心法要旨': '医宗金鉴', '眼科心法要诀': '医宗金鉴', '杂病心法要诀': '医宗金鉴',
 '景岳全书·新方八阵': '景岳全书', '新方八阵': '景岳全书', '古方八阵': '景岳全书', '景岳全书·妇人规': '景岳全书', '妇人规': '景岳全书',
}
SUBSTITUTIONS = [
 {'original': '犀角', 'substitutes': ['水牛角'], 'reason': '犀角禁用（国务院 1993 年《关于禁止犀牛角和虎骨贸易的通知》），《中国药典》水牛角项下「功能与主治」同犀角，临床与教材均以水牛角代。'},
 {'original': '梓白皮', 'substitutes': ['桑白皮'], 'reason': '麻黄连轺赤小豆汤「生梓白皮」今药房不备，《方剂学》及通行本以桑白皮代。'},
 {'original': '连轺', 'substitutes': ['连翘'], 'reason': '连轺为连翘根，今以连翘代（《方剂学》麻黄连翘赤小豆汤）。'},
]
# 同一味药的不同写法（古名、处方名、规格名），受治理药名身份表没有并起来的：原方表与目录、处方比药味时算同一味。
EQUIVALENT_HERB_NAMES = [
 ['草决明', '决明子'], ['细茶', '茶叶', '茶'], ['升药', '黄灵药', '红升丹'], ['松香', '松脂'], ['砒石', '白砒', '信石'], ['穿山甲', '山甲', '炮山甲', '醋山甲', '炮甲珠', '甲珠', '甲片'],
 ['乌头', '川乌', '川乌头'], ['白花蛇', '金钱白花蛇', '蕲蛇'], ['虎骨', '虎胫骨', '炙虎骨'], ['桑炭', '桑芽炭', '青桑炭'], ['藿香', '广藿香', '杜藿香', '藿香叶'], ['苏子', '紫苏子', '南苏子'],
 ['刘寄奴', '北刘寄奴'], ['萆薢', '粉萆薢', '川萆薢', '绵萆薢'], ['牵牛子', '白牵牛', '黑牵牛', '黑丑', '白丑', '二丑'], ['半夏曲', '炒半夏曲'], ['雄黄', '雄黄粉', '明雄黄'], ['朱砂', '朱砂粉', '辰砂', '丹砂'],
 ['芒硝', '朴硝', '玄明粉', '元明粉'], ['龟甲', '龟板', '败龟板', '醋龟甲'], ['牡丹皮', '丹皮', '粉丹皮'], ['淡豆豉', '豆豉', '香豉'], ['石菖蒲', '菖蒲', '九节菖蒲'], ['天花粉', '栝蒌根', '瓜蒌根', '栝楼根', '花粉'],
 ['瓜蒌', '栝蒌', '栝楼', '全瓜蒌', '瓜蒌实', '栝蒌实'], ['地黄', '生地黄', '干地黄', '生地'], ['肉桂', '桂心', '官桂'], ['山茱萸', '山萸肉', '萸肉'], ['莲子', '莲肉', '莲子肉', '石莲肉'], ['薏苡仁', '苡仁', '薏仁', '米仁'],
 ['延胡索', '元胡', '玄胡索', '延胡'], ['牛蒡子', '鼠粘子', '大力子', '牛子'], ['赭石', '代赭石', '代赭'], ['旋覆花', '旋复花'], ['豆蔻', '白豆蔻', '白蔻仁', '蔻仁'], ['六神曲', '神曲', '焦六神曲'],
 ['冰片', '龙脑', '梅片', '天然冰片'], ['蝉蜕', '蝉衣', '蝉退'], ['僵蚕', '白僵蚕', '炒僵蚕'], ['首乌藤', '夜交藤'], ['补骨脂', '破故纸'], ['淫羊藿', '仙灵脾'], ['墨旱莲', '旱莲草'], ['益智', '益智仁'], ['没药', '醋没药'], ['乳香', '醋乳香'],
]
def _merged_equivalents():
    # 对账裁决里判为「同一味药、只是写法不同」的名字对（work/equiv-pairs.json）并进同药异写组。
    groups = [set(g) for g in EQUIVALENT_HERB_NAMES]
    path = '/var/tmp/r1057/work/equiv-pairs.json'
    for a, b in (json.load(open(path)) if os.path.exists(path) else []):
        hit = [g for g in groups if a in g or b in g]
        merged = set([a, b]).union(*hit) if hit else {a, b}
        groups = [g for g in groups if g not in hit] + [merged]
    return [sorted(g) for g in sorted(groups, key=lambda g: sorted(g)[0])]
def canon_book(b):
    b = (b or '').strip()
    m = re.match(r'^(?:经验方|验方)（《([^》]+)》方剂索引）$', b)
    if m: b = m.group(1)   # 教材方剂索引署「经验方」：出处记教材名，tier=textbook_appendix
    b = b.strip('《》')
    b0 = re.sub(r'卷[一二三四五六七八九十百上中下之\d]+.*$', '', b).strip('·• ')
    if b0 in BOOK_ALIASES: return BOOK_ALIASES[b0]
    head = re.split(r'[·•]', b0)[0]
    return BOOK_ALIASES.get(head, head)
TIER_RANK = {'original_text': 0, 'national_catalog': 1, 'fangjixue': 2, 'textbook_appendix': 3, 'modern_source': 4}
def main():
    merged = {}; stats = collections.Counter(); bad = []; unresolved = []
    files = sorted(glob.glob('/var/tmp/r1057/out/*.json'), key=lambda p: (os.path.basename(p) != 'auto.json', p))
    for f in files:
        data = json.load(open(f)); rows = data['rows'] if isinstance(data, dict) else data
        batch = os.path.basename(f)[:-5]
        for r in rows:
            if not isinstance(r, dict): continue
            st = r.get('status'); stats[(batch[:2], st)] += 1
            if st not in ('verified', 'verified_other_edition', 'modern_formula'):
                unresolved.append({'target': r.get('target'), 'status': st, 'note': r.get('note', ''), 'batch': batch}); continue
            errs = check_rows.check([r])
            if errs: bad.append((batch, errs[:3])); stats['rejected'] += 1; continue
            name = (r.get('target') or {}).get('name') or r['name']
            name = re.sub(r'\s+', '', name)
            book = canon_book(r.get('book') or (r.get('target') or {}).get('book'))
            if not book: stats['no_book'] += 1; continue
            key = (name, book, r.get('variant') or '')
            row = {'name': name, 'book': book}
            if r.get('volume'): row['volume'] = r['volume']
            if r.get('variant'): row['variant'] = r['variant']
            aliases = sorted({a for a in (r.get('aliases') or []) + ([r['name']] if r.get('name') and r['name'] != name else []) if a and a != name})
            if aliases: row['aliases'] = aliases
            tb = canon_book((r.get('target') or {}).get('book'))
            cited = []
            if tb and tb != book: cited.append(tb)
            row['citedBooks'] = cited
            row['status'] = st; row['tier'] = r['tier']
            row['ingredients'] = [{k: v for k, v in it.items() if k in ('written', 'herb', 'preparation', 'preparationRaw', 'note', 'dose') and v not in (None, '')} for it in r['ingredients']]
            _herbs = {it['herb'] for it in row['ingredients']}
            row['guideHerbs'] = [{'herb': g['herb'], 'written': g['written']} for g in (r.get('guideHerbs') or []) if g['herb'] not in _herbs]
            row['evidence'] = [{k: v for k, v in e.items() if k in ('kind', 'book', 'url', 'file', 'line', 'saved', 'quote')} for e in r['evidence']]
            if r.get('note'): row['note'] = r['note']
            row['review'] = r.get('review') or f'agent:{batch}'
            prev = merged.get(key)
            if prev:
                # 同键：agent 行覆盖自动行；同为 agent 行时留 tier 高的，并把引用书并上
                keep_prev = prev['review'].startswith('agent') and (not row['review'].startswith('agent') or TIER_RANK[prev['tier']] <= TIER_RANK[row['tier']])
                a, b = (prev, row) if keep_prev else (row, prev)
                a['citedBooks'] = sorted(set(a['citedBooks']) | set(b['citedBooks']))
                if b.get('aliases'): a['aliases'] = sorted(set(a.get('aliases', [])) | set(b['aliases']))
                merged[key] = a; stats['dup'] += 1
            else: merged[key] = row
    ov_path = '/var/tmp/r1057/work/overlay.json'
    if os.path.exists(ov_path):
        for item in json.load(open(ov_path)):
            key = (item['name'], item['book'], item.get('variant', ''))
            if item.get('drop'): merged.pop(key, None); continue
            if key in merged:
                for k, v in item.items():
                    if k not in ('name', 'book', 'variant'): merged[key][k] = v
            elif item.get('ingredients'): merged[key] = {k: v for k, v in item.items()}
    rows = [merged[k] for k in sorted(merged)]
    for r in rows:
        _h = {it['herb'] for it in r['ingredients']}
        r['guideHerbs'] = [g for g in (r.get('guideHerbs') or []) if g['herb'] not in _h]
    for r in rows:
        if not r.get('citedBooks'): r.pop('citedBooks', None)
    payload = {
        'schemaVersion': 1,
        'note': '原方组成表的人工维护输入：键（方名, 出处书[, variant]），每条的药味、原文炮制、药引都摘自原书原文（evidence.quote 逐字）。'
                'review=auto_agree 是原书片段的程序解析与方剂目录条目按药味身份一致的行；agent:<批次> 是逐条人工（模型）核对原文后写的行。'
                '深圳《中药方剂编码规则》（SZJG/T 38.2-2011）条目与教材「常用药」不是原方依据。改这份文件后运行 python3 scripts/build-formula-original-compositions.py。',
        'substitutions': SUBSTITUTIONS,
        'equivalentHerbNames': _merged_equivalents(),
        'bookAliases': dict(sorted(BOOK_ALIASES.items())),
        'rows': rows,
    }
    json.dump(payload, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1); open(OUT, 'a').write('\n')
    json.dump(unresolved, open('/var/tmp/r1057/work/unresolved.json', 'w'), ensure_ascii=False, indent=1)
    print('rows', len(rows), dict(stats)); 
    for b in bad[:20]: print('REJECTED', b)
if __name__ == '__main__':
    main()
