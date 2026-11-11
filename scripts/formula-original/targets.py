#!/usr/bin/env python3
"""目标清单：(方名, 出处书) —— 受治理目录全部条目 + 教材代表方（带教材写的出处）+ 方剂学 + 经方。"""
import json, re, collections, sys, os
WT = '/var/tmp/r1057/wt'; D = WT + '/src/data/'
def J(n): return json.load(open(D + n, encoding='utf-8'))
def books_in(s): return re.findall(r'《([^》]+)》', s or '')
cat = J('tcm-formula-governed-catalog.json')['entries']
tb = J('tcm-textbook-syndrome-formula-table.json')
tfs = J('tcm-textbook-formula-sources.json')['formulas']
tf = J('tcm-formula-textbook-functions.json')['entries']
mc = None
try:
    idx = J('tcm-modern-case-formula-index.json')
except Exception: idx = None
T = collections.OrderedDict()
def add(name, book, origin, **kw):
    name = name.strip(); book = (book or '').strip()
    if not name: return
    k = (name, book)
    t = T.setdefault(k, {'name': name, 'book': book, 'origins': [], 'catalog': []})
    if origin not in t['origins']: t['origins'].append(origin)
    for a, b in kw.items():
        if a == 'catalog': t['catalog'].append(b)
        else: t.setdefault(a, b)
for e in cat:
    bs = books_in(e.get('source'))
    add(e['name'], bs[0] if bs else '', 'catalog:' + e['sourceClass'], catalog={
        'id': e['id'], 'sourceClass': e['sourceClass'], 'source': e.get('source'), 'ingredients': e['ingredients'],
        'prescriptionOriginal': e.get('prescriptionOriginal'), 'lockable': bool(e.get('identityLockEligible')), 'doseCompilable': bool(e.get('doseCompilationEligible'))})
# 教材行：formulaText 里「方名（《书》）」，否则该名在教材方剂索引里的书
cite = re.compile(r'([一-鿿]{2,12}?)\s*[（(]\s*《([^》]{1,30})》')
for r in tb['rows']:
    ft = r.get('formulaText') or ''
    cited = {}
    for f in r.get('formulas') or []:
        m = re.search(re.escape(f) + r'\s*[（(]\s*《([^》]{1,30})》', ft)
        if m: cited[f] = m.group(1)
    for f in r.get('formulas') or []:
        b = cited.get(f)
        if not b:
            e = tfs.get(f)
            b = (books_in(e['source'])[0] if e and books_in(e.get('source')) else '') if e else ''
        add(f, b, 'textbook:' + r['bookKey'], textbookRow=r['id'])
for e in tf:
    bs = books_in(e.get('source'))
    add(e['name'], bs[0] if bs else '', 'fangjixue:' + e.get('kind', ''))
json.dump([v for v in T.values()], open('/var/tmp/r1057/work/targets.json', 'w'), ensure_ascii=False, indent=0)
print('targets', len(T))
bc = collections.Counter(t['book'] for t in T.values())
print('distinct books', len(bc), 'no book', bc[''])
json.dump(bc.most_common(), open('/var/tmp/r1057/work/books.json', 'w'), ensure_ascii=False, indent=0)
oc = collections.Counter()
for t in T.values():
    for o in t['origins']: oc[o.split(':')[0] + ':' + (o.split(':')[1] if o.startswith('catalog') else '')] += 1
print(oc)
print(bc.most_common(60))
