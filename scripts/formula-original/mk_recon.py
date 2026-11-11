#!/usr/bin/env python3
"""对账差异 → 裁决批次。用法：mk_recon.py <recon.json（report 脚本 --json 的输出）> <每批条数> [前缀]"""
import json, sys, re, glob, os
WT = '/var/tmp/r1057/wt'; D = WT + '/src/data/'
diffs = json.load(open(sys.argv[1]))['unresolved']; size = int(sys.argv[2]); prefix = sys.argv[3] if len(sys.argv) > 3 else 'r'
src = json.load(open(D + 'tcm-formula-original-compositions.source.json'))
aliases = src['bookAliases']
def canon(b):
    b = (b or '').strip(); m = re.search(r'《([^》]{1,40})》', b); b = m.group(1) if m else b
    b0 = re.sub(r'卷[一二三四五六七八九十百上中下之\d]+.*$', '', b).strip('·• ')
    if b0 in aliases: return aliases[b0]
    return aliases.get(re.split(r'[·•]', b0)[0], re.split(r'[·•]', b0)[0])
rows = {}
for r in src['rows']:
    for n in [r['name']] + r.get('aliases', []):
        for b in [r['book']] + r.get('citedBooks', []): rows.setdefault((n, b), r)
cat = {e['id']: e for e in json.load(open(D + 'tcm-formula-governed-catalog.json'))['entries']}
tf = {e['name']: e for e in json.load(open(D + 'tcm-formula-textbook-functions.json'))['entries']}
names = json.load(open(D + 'tcm-formula-sources.json'))['formulas']
notes = {}
for f in glob.glob('/var/tmp/r1057/out/w*.json'):
    try: data = json.load(open(f))
    except Exception: continue
    for r in (data['rows'] if isinstance(data, dict) else data):
        if not isinstance(r, dict): continue
        for d in r.get('catalogDiff') or []:
            if isinstance(d, dict) and d.get('id') and d.get('verdict') not in (None, 'same'):
                notes[d['id']] = f"{d.get('verdict')}：{d.get('comment', '')}"
items = []
for d in sorted(diffs, key=lambda x: (x['book'], x['name'])):
    e = cat[d['id']]; row = rows.get((d['name'], d['book']))
    if not row: continue
    item = {'name': d['name'], 'book': d['book'],
            'catalog': {k: e.get(k) for k in ('id', 'sourceClass', 'source', 'ingredients', 'prescriptionOriginal')},
            'row': {k: row.get(k) for k in ('name', 'book', 'variant', 'aliases', 'tier', 'status', 'ingredients', 'guideHerbs', 'evidence', 'note', 'review') if row.get(k) not in (None, '', [])},
            'extraInCatalog': d['extraInCatalog'], 'missingInCatalog': d['missingInCatalog']}
    if d['name'] in tf and tf[d['name']].get('composition'): item['fangjixue'] = {'source': tf[d['name']].get('source'), 'composition': tf[d['name']]['composition']}
    same = [v['ingredients'] for v in names.get(d['name'], []) if canon(v.get('source')) == d['book']]
    if same: item['sameBookNameCatalog'] = same[:3]
    if d['id'] in notes: item['verifierNote'] = notes[d['id']]
    items.append(item)
n = 0
for i in range(0, len(items), size):
    n += 1
    json.dump({'batch': f'{prefix}{n:02d}', 'items': items[i:i + size]}, open(f'/var/tmp/r1057/recon/batches/{prefix}{n:02d}.json', 'w'), ensure_ascii=False, indent=1)
print('items', len(items), 'batches', n)
