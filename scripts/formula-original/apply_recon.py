#!/usr/bin/env python3
"""
把对账裁决落到三处：
  · work/overlay.json            原方表行的修订（fix_row / drop_row / alternate），merge_rows.py 合并时应用
  · work/collate.json            要走订正通道改目录的条目（collate），由 apply_collation.py 写进仓库的 collation source
  · work/accepted.json           保留差异清单（accept），由 apply_collation.py 写进 reconciliation source
多轮裁决可重复运行（按键覆盖）。用法：apply_recon.py  （读 recon/out/*.json）
"""
import json, glob, os, sys
sys.path.insert(0, '/var/tmp/r1057/tools')
import check_recon, check_rows
from merge_rows import canon_book
W = '/var/tmp/r1057/work/'
def load(p, default):
    return json.load(open(p)) if os.path.exists(p) else default
overlay = {(o['name'], o['book'], o.get('variant', '')): o for o in load(W + 'overlay.json', [])}
collate = {c['catalogId']: c for c in load(W + 'collate.json', [])}
accepted = {a['catalogId']: a for a in load(W + 'accepted.json', [])}
unsure = []; stats = {}
for f in sorted(glob.glob('/var/tmp/r1057/recon/out/*.json')):
    batch = os.path.basename(f)[:-5]
    try: data = json.load(open(f))
    except Exception as e: print('BAD', f, e); continue
    items = json.load(open(f'/var/tmp/r1057/recon/batches/{batch}.json'))['items']
    for i, d in enumerate(data.get('decisions') or []):
        if i >= len(items) or not isinstance(d, dict): continue
        it = items[i]; dec = d.get('decision'); stats[dec] = stats.get(dec, 0) + 1
        cid = it['catalog']['id']; key = (it['row']['name'], it['row']['book'], it['row'].get('variant', ''))
        base = {'catalogId': cid, 'name': it['name'], 'book': it['book'], 'reason': d.get('reason', ''), 'batch': batch}
        collate.pop(cid, None); accepted.pop(cid, None)
        def do_accept(category):
            accepted[cid] = {**base, 'category': category}
        def do_alternate(alt, ev):
            o = overlay.setdefault(key, {'name': key[0], 'book': key[1], **({'variant': key[2]} if key[2] else {})})
            alts = [a for a in o.get('alternates', it['row'].get('alternates', [])) if a.get('basis') != alt['basis']]
            alts.append({'add': alt.get('add', []), 'remove': alt.get('remove', []), 'basis': alt['basis']})
            o['alternates'] = alts
        if dec == 'collate':
            collate[cid] = {**base, **({'ingredients': d['ingredients']} if d.get('ingredients') else {})}
            if isinstance(d.get('alternate'), dict) and d['alternate'].get('basis'): do_alternate(d['alternate'], d.get('evidence'))
        elif dec == 'accept' and d.get('category'):
            do_accept(d['category'])
        elif dec == 'alternate' and isinstance(d.get('alternate'), dict) and d['alternate'].get('basis'):
            do_alternate(d['alternate'], d.get('evidence'))
        elif dec == 'drop_row':
            overlay[key] = {'name': key[0], 'book': key[1], **({'variant': key[2]} if key[2] else {}), 'drop': True, 'dropReason': d.get('reason', '')}
        elif dec == 'fix_row' and isinstance(d.get('row'), dict) and not check_rows.check([d['row']]):
            r = d['row']
            new = {'name': key[0], 'book': canon_book(r.get('book') or key[1]), 'status': r['status'], 'tier': r['tier'],
                   'ingredients': [{k: v for k, v in x.items() if k in ('written', 'herb', 'preparation', 'preparationRaw', 'note', 'dose') and v not in (None, '')} for x in r['ingredients']],
                   'guideHerbs': [{'herb': g['herb'], 'written': g['written']} for g in (r.get('guideHerbs') or [])],
                   'evidence': [{k: v for k, v in e.items() if k in ('kind', 'book', 'url', 'file', 'line', 'saved', 'quote')} for e in r['evidence']],
                   'review': f'agent:{batch}'}
            for k in ('variant', 'volume', 'note'):
                if r.get(k): new[k] = r[k]
            al = sorted({a for a in (r.get('aliases') or []) + (it['row'].get('aliases') or []) + ([r['name']] if r.get('name') and r['name'] != key[0] else []) if a and a != key[0]})
            if al: new['aliases'] = al
            if it['row'].get('citedBooks'): new['citedBooks'] = it['row']['citedBooks']
            if new['book'] != key[1]:
                # 行换了书：旧键删掉，新键写入，并保留对旧书名的引用
                overlay[key] = {'name': key[0], 'book': key[1], 'drop': True, 'dropReason': '裁决改到 ' + new['book']}
                new['citedBooks'] = sorted(set(new.get('citedBooks', [])) | {key[1]})
                key2 = (new['name'], new['book'], new.get('variant', ''))
                overlay[key2] = new
            else:
                overlay[(new['name'], new['book'], new.get('variant', ''))] = new
                if new.get('variant', '') != key[2]: overlay[key] = {'name': key[0], 'book': key[1], **({'variant': key[2]} if key[2] else {}), 'drop': True}
            t = d.get('then')
            if t == 'collate': collate[cid] = {**base, **({'ingredients': d['ingredients']} if d.get('ingredients') else {})}
            elif t == 'accept' and d.get('category'): do_accept(d['category'])
            elif t == 'alternate' and isinstance(d.get('alternate'), dict) and d['alternate'].get('basis'):
                key = (new['name'], new['book'], new.get('variant', '')); do_alternate(d['alternate'], None)
        else:
            unsure.append({**base, 'decision': dec})
json.dump(list(overlay.values()), open(W + 'overlay.json', 'w'), ensure_ascii=False, indent=1)
json.dump(list(collate.values()), open(W + 'collate.json', 'w'), ensure_ascii=False, indent=1)
json.dump(list(accepted.values()), open(W + 'accepted.json', 'w'), ensure_ascii=False, indent=1)
json.dump(unsure, open(W + 'recon-unsure.json', 'w'), ensure_ascii=False, indent=1)
print('decisions', stats, '| overlay', len(overlay), 'collate', len(collate), 'accepted', len(accepted), 'unsure', len(unsure))
