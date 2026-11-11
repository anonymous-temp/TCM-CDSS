#!/usr/bin/env python3
"""自动分流为 agree 的目标 → 表行（原书片段解析结果与目录条目按身份一致，两个独立来源互证）。输出 out/auto.json。"""
import json, re, sys
sys.path.insert(0, '/var/tmp/r1057/tools')
W = '/var/tmp/r1057/work/'
H = json.load(open(W + 'harvest.json'))
ns = {}
src = open('/var/tmp/r1057/tools/harvest.py').read().split('def main():')[0]
exec(src.replace("ALLJC = sorted", "ALLJC = sorted"), ns)
ident = ns['ident']
PREP = [(r'蜜炙|炙', '炙'), (r'麸炒', '麸炒'), (r'土炒', '土炒'), (r'煅', '煅'), (r'酒(?:洗|浸|蒸|炒|拌|制)', '酒'), (r'盐(?:水)?(?:炒|浸|拌)', '盐'), (r'醋(?:炒|炙|煮|浸|制)', '醋'),
        (r'姜(?:汁)?(?:制|炒|拌|炙)', '姜'), (r'炮', '炮'), (r'煨', '煨'), (r'炒', '炒'), (r'焙', '焙'), (r'烧', '烧'), (r'熬', '熬')]
WPREP = [(r'^炙', '炙'), (r'^炒', '炒'), (r'^煅', '煅'), (r'^炮', '炮'), (r'^煨', '煨'), (r'^焦', '焦')]
GW = [('生姜', re.compile(r'(?:生姜|姜)[^，。、；\s]{0,3}?[一二三四五六七八九十两半\d]+(?:片|块|钱|分|两)')), ('大枣', re.compile(r'(?:大枣|枣子|红枣|肥枣|枣)[^，。、；\s]{0,3}?[一二三四五六七八九十两半\d]+(?:枚|个|颗|粒)'))]
rows = []
for h in H:
    if h['triage'] != 'agree': continue
    a = h['auto']; s = h['snippets'][a['snippet']]
    line = s['text'][a['lineOffset']]
    ing = []; seen = set(); ok = True
    for it in a['items']:
        w = it['written']; hb = ident(w)
        if hb in seen: ok = False; break
        seen.add(hb)
        e = {'written': w, 'herb': hb}
        note = it['note']
        for pat, p in PREP:
            m = re.search(pat, note)
            if m: e['preparation'] = p; e['preparationRaw'] = m.group(0); break
        else:
            for pat, p in WPREP:
                if re.match(pat, w) and hb != w: e['preparation'] = p; e['preparationRaw'] = w[0]; break
        if note: e['note'] = note
        ing.append(e)
    if not ok: continue
    ev = [{'kind': 'jicheng', 'book': s['book'], 'url': s['url'], 'quote': line.strip()[:600]}]
    guides = []
    for g, pat in GW:
        if g in a['guides']:
            m = pat.search(a['method'])
            if m: guides.append({'herb': g, 'written': m.group(0)})
    if guides: ev.append({'kind': 'jicheng', 'book': s['book'], 'url': s['url'], 'quote': a['method'].strip()})
    rows.append({'target': {'name': h['name'], 'book': h['book']}, 'status': 'verified', 'name': h['name'], 'book': h.get('bookCanon') or h['book'], 'variant': '', 'aliases': [],
                 'tier': 'original_text', 'ingredients': ing, 'guideHerbs': guides, 'evidence': ev,
                 'catalogDiff': [{'id': c['id'], 'verdict': 'same'} for c in h['catalog']], 'note': '', 'review': 'auto_agree'})
json.dump({'batch': 'auto', 'rows': rows}, open('/var/tmp/r1057/out/auto.json', 'w'), ensure_ascii=False, indent=1)
print('auto rows', len(rows))
