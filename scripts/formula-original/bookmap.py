#!/usr/bin/env python3
"""目标书名 → jicheng.tw 书目 / 本地古籍语料文件；并标记 P1。"""
import json, re, os, collections, zhconv
W = '/var/tmp/r1057/work/'; WT = '/var/tmp/r1057/wt'
T = json.load(open(W + 'targets.json'))
jc = json.load(open('/var/tmp/r1057/web/jicheng-books.json'))
local = {}
for f in sorted(os.listdir(WT + '/中医补充数据/TCM-Ancient-Books-master')):
    if f.endswith('.txt'): local[re.sub(r'^\d+-', '', f[:-4])] = f
cc = json.load(open(WT + '/src/data/tcm-modern-case-formula-index.json')).get('formulaCaseCounts', {})
ALIAS = {'局方': '太平惠民和剂局方', '和剂局方': '太平惠民和剂局方', '太平惠民合剂局方': '太平惠民和剂局方', '济生方': '严氏济生方', '重订严氏济生方': '严氏济生方',
 '金匮': '金匮要略方论', '金匮要略': '金匮要略方论', '千金要方': '备急千金要方', '千金方': '备急千金要方', '千金': '备急千金要方', '圣惠方': '太平圣惠方', '圣惠': '太平圣惠方',
 '三因方': '三因极一病证方论', '三因': '三因极一病证方论', '本事方': '普济本事方', '妇人良方': '妇人大全良方', '良方': '妇人大全良方', '宣明论方': '黄帝素问宣明论方', '宣明论': '黄帝素问宣明论方',
 '保命集': '素问病机气宜保命集', '通俗伤寒论': '重订通俗伤寒论', '小儿药证直决': '小儿药证直诀', '外台': '外台秘要', '医学衷中参西录': '医学衷中参西录', '杂病证治新义': '中医内科杂病证治新义',
 '正宗': '外科正宗', '金鉴': '医宗金鉴', '准绳': '证治准绳', '全生集': '外科证治全生集', '外科全生集': '外科证治全生集', '景岳': '景岳全书', '条辨': '温病条辨', '内外伤辨': '内外伤辨惑论', '辨惑论': '内外伤辨惑论',
 '丹溪': '丹溪心法', '医醇剩义': '医醇賸义', '医醇滕义': '医醇賸义'}
def canon(b):
    b = re.sub(r'[·•\.\s]', '·', b.strip()); b = b.split('·')[0]
    b = re.sub(r'卷.*$', '', b)
    return ALIAS.get(b, b)
def find(b, table):
    if b in table: return b
    cands = [k for k in table if k.startswith(b) or b.startswith(k)]
    cands = [k for k in cands if len(k) >= 3 and not re.search(r'_|歌括|注|发挥$', k[len(b):] if k.startswith(b) else '')]
    return cands[0] if len(cands) == 1 else None
bm = {}
for t in T:
    b = t['book']
    if not b: continue
    c = canon(b)
    if b not in bm:
        bm[b] = {'canon': c, 'jicheng': find(c, jc), 'local': find(c, local)}
    t['bookCanon'] = c
for t in T:
    o = t['origins']
    common = any(c['sourceClass'] != 'verified_reference_catalog' or cc.get(c['id'], 0) >= 3 for c in t['catalog'])
    t['p1'] = bool(common or any(x.startswith(('textbook', 'fangjixue')) for x in o))
json.dump(T, open(W + 'targets.json', 'w'), ensure_ascii=False, indent=0)
json.dump(bm, open(W + 'bookmap.json', 'w'), ensure_ascii=False, indent=0)
p1 = [t for t in T if t['p1']]
print('P1', len(p1), 'P2', len(T) - len(p1))
bc = collections.Counter(t['book'] for t in p1)
print('P1 books', len(bc), 'no book', bc[''])
nojc = [(b, n) for b, n in bc.most_common() if b and not bm[b]['jicheng']]
print('P1 books without jicheng:', len(nojc), sum(n for _, n in nojc)); print(nojc[:80])
print('with jicheng formulas', sum(n for b, n in bc.items() if b and bm[b]['jicheng']))
need = sorted({bm[t['book']]['jicheng'] for t in T if t['book'] and bm[t['book']]['jicheng']})
json.dump(need, open(W + 'jicheng-need.json', 'w'), ensure_ascii=False)
print('jicheng books needed (all targets)', len(need))
allnojc = collections.Counter(t['book'] for t in T if t['book'] and not bm[t['book']]['jicheng'])
print('ALL without jicheng', len(allnojc), sum(allnojc.values()), allnojc.most_common(25))
