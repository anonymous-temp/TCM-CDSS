#!/usr/bin/env python3
"""常用层目录条目的对账差异（按改动前目录 vs 原方表）→ 复审批次 z01…。"""
import json, glob, os, re, sys, subprocess
sys.path.insert(0, '/var/tmp/r1057/tools')
WT = '/var/tmp/r1057/wt'; D = WT + '/src/data/'; W = '/var/tmp/r1057/work/'
old = {e['id']: e for e in json.load(open(W + 'catalog-head.json'))['entries']}
new = {e['id']: e for e in json.load(open(D + 'tcm-formula-governed-catalog.json'))['entries']}
cc = json.load(open(D + 'tcm-modern-case-formula-index.json')).get('formulaCaseCounts', {})
common = lambda e: e['sourceClass'] != 'verified_reference_catalog' or cc.get(e['id'], 0) >= 3
src = json.load(open(D + 'tcm-formula-original-compositions.source.json'))
import merge_rows
rows = {}
for r in src['rows']:
    for n in [r['name']] + r.get('aliases', []):
        for b in [r['book']] + r.get('citedBooks', []): rows.setdefault((n, b), r)
tf = {e['name']: e for e in json.load(open(D + 'tcm-formula-textbook-functions.json'))['entries']}
H = {(h['name'], h['book']): h for h in json.load(open(W + 'harvest.json'))}
first = {}
for f in sorted(glob.glob('/var/tmp/r1057/recon/out/[rs]*.json')):
    b = os.path.basename(f)[:-5]; items = json.load(open(f'/var/tmp/r1057/recon/batches/{b}.json'))['items']
    for it, d in zip(items, json.load(open(f)).get('decisions') or []):
        first[it['catalog']['id']] = {'decision': d.get('decision'), 'category': d.get('category'), 'reason': d.get('reason'), 'batch': b}
ids = set(first) | {u['id'] for u in json.load(open(W + 'recon6.json'))['unresolved']}
items = []
for i in sorted(ids, key=lambda x: (new[x]['source'] or '', new[x]['name'])):
    e = new[i]
    if not common(e): continue
    book = merge_rows.canon_book(re.search(r'《([^》]+)》', e['source'] or '').group(1)) if re.search(r'《([^》]+)》', e['source'] or '') else ''
    row = rows.get((e['name'], book))
    if not row: continue
    it = {'name': e['name'], 'book': book,
          'catalog': {k: e.get(k) for k in ('id', 'sourceClass', 'source', 'ingredients')},
          'oldCatalog': old[i]['ingredients'],
          'row': {k: row.get(k) for k in ('name', 'book', 'variant', 'aliases', 'tier', 'status', 'ingredients', 'guideHerbs', 'evidence', 'note', 'review', 'alternates') if row.get(k) not in (None, '', [])},
          'extraInCatalog': [], 'missingInCatalog': [], 'firstRound': first.get(i)}
    if e['name'] in tf and tf[e['name']].get('composition'): it['fangjixue'] = {'source': tf[e['name']].get('source'), 'composition': tf[e['name']]['composition']}
    h = H.get((e['name'], re.search(r'《([^》]+)》', e['source'] or '').group(1) if re.search(r'《([^》]+)》', e['source'] or '') else ''))
    if h:
        app = [{'book': s['book'], 'line': s.get('line'), 'text': s['text'][0][:260]} for s in h['snippets'] if s['src'] == 'textbook_appendix'][:5]
        if app: it['textbookAppendix'] = app
    items.append(it)
n = 0; size = int(sys.argv[1]) if len(sys.argv) > 1 else 20
for f in glob.glob('/var/tmp/r1057/recon/batches/z*.json'): os.remove(f)
for k in range(0, len(items), size):
    n += 1
    json.dump({'batch': f'z{n:02d}', 'items': items[k:k + size]}, open(f'/var/tmp/r1057/recon/batches/z{n:02d}.json', 'w'), ensure_ascii=False, indent=1)
print('common-tier items', len(items), 'batches', n)
