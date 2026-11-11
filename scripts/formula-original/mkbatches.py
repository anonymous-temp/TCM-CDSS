#!/usr/bin/env python3
"""把待核目标按书分批：/var/tmp/r1057/batches/<wave><nn>.json"""
import json, sys, collections
W = '/var/tmp/r1057/work/'; H = json.load(open(W + 'harvest.json'))
wave = sys.argv[1]; size = int(sys.argv[2])
if wave == 'w1': pick = [h for h in H if h['p1'] and h['triage'] not in ('agree',)]
elif wave == 'w2': pick = [h for h in H if not h['p1'] and h['triage'] == 'diff']
elif wave == 'w3': pick = [h for h in H if not h['p1'] and h['triage'] not in ('agree', 'diff')]
pick.sort(key=lambda h: (h['book'] or 'zzz', h['name']))
def slim(h):
    sn = []
    for s in h['snippets'][:9]:
        s = dict(s)
        if 'text' in s:
            cap = 900 if s.get('sameBook') else 420
            t = [x[:cap] for x in s['text']]
            tot = 0; keep = []
            for x in t:
                if tot > cap * 1.6: break
                keep.append(x); tot += len(x)
            s['text'] = keep
        sn.append(s)
    cat = [{k: c[k] for k in ('id', 'sourceClass', 'source', 'ingredients', 'prescriptionOriginal')} for c in h['catalog']]
    auto = h['auto'] and {'fromSnippet': h['auto']['snippet'], 'parsed': [x['written'] + (f"（{x['note']}）" if x['note'] else '') for x in h['auto']['items']], 'guides': h['auto']['guides']}
    return {'name': h['name'], 'book': h['book'], 'jcBook': h['jcBook'], 'origins': h['origins'], 'triage': h['triage'], 'catalog': cat, 'autoParse': auto, 'snippets': sn}
n = 0
for i in range(0, len(pick), size):
    n += 1
    json.dump({'batch': f'{wave}{n:02d}', 'targets': [slim(h) for h in pick[i:i + size]]}, open(f'/var/tmp/r1057/batches/{wave}{n:02d}.json', 'w'), ensure_ascii=False, indent=1)
print(wave, 'targets', len(pick), 'batches', n)
