#!/usr/bin/env python3
"""
把 work/collate.json（裁决为「目录改成原方」的条目）写进仓库的订正通道 src/data/tcm-formula-catalog-collation.source.json，
批次号 ADJ-ORIG-20261110；可重复运行（先删掉本批次旧行再写）。
用法：apply_collation.py            写订正行
      apply_collation.py --accepted <recon.json>   按最新对账结果把 work/accepted.json 写进 reconciliation source
"""
import json, re, sys, os
WT = '/var/tmp/r1057/wt'; D = WT + '/src/data/'; W = '/var/tmp/r1057/work/'
REF = 'ADJ-ORIG-20261110'
CONVENTIONAL = {('甘草', '炙'): '炙甘草', ('甘草', '蜜炙'): '炙甘草', ('黄芪', '炙'): '炙黄芪', ('黄芪', '蜜炙'): '炙黄芪', ('酸枣仁', '炒'): '炒酸枣仁'}
src = json.load(open(D + 'tcm-formula-original-compositions.source.json'))
SUBST = {s['original']: s['substitutes'][0] for s in src.get('substitutions', [])}
TOXIC_DEFAULT = {'半夏': '法半夏', '附子': '附片', '川乌': '制川乌', '草乌': '制草乌', '天南星': '制天南星', '白附子': '制白附子'}
HEAD = {e['id']: e for e in json.load(open(W + 'catalog-head.json'))['entries']}
ADJ = {(a['formulaName'], a['rawIngredient']): a['resolvedIngredient'] for a in json.load(open(D + 'tcm-formula-ingredient-identity-adjudications.source.json'))['entries']}
rows = {}
for r in src['rows']:
    for b in [r['book']] + r.get('citedBooks', []):
        rows.setdefault((r['name'], b), r)
        for a in r.get('aliases', []): rows.setdefault((a, b), r)
def write_collation():
    cat = {e['id']: e for e in json.load(open(D + 'tcm-formula-governed-catalog.json'))['entries']}
    col = json.load(open(D + 'tcm-formula-catalog-collation.source.json'))
    col['entries'] = [e for e in col['entries'] if e.get('adjudicationRef') != REF]
    col['sourceRefs'] = [s for s in col['sourceRefs'] if s.get('ref') != REF]
    by_name = {e['name']: e for e in col['entries']}
    collate = json.load(open(W + 'collate.json'))
    done = 0; skipped = []
    skip = set(json.load(open(W + 'collate-skip.json'))) if os.path.exists(W + 'collate-skip.json') else set()
    RENAME = {'李根白皮': '甘李根皮'}  # 目录里《金匮》奔豚汤已用、并登记了医生定量政策的写法
    for c in sorted(collate, key=lambda x: (x['book'], x['name'])):
        if c['catalogId'] in skip: continue
        e = cat.get(c['catalogId']); row = rows.get((c['name'], c['book']))
        if not e or not row: skipped.append((c['name'], c['book'], 'no entry/row')); continue
        if c.get('ingredients'): ing = list(c['ingredients'])
        else:
            ing = []
            for it in row['ingredients']:
                h = it['herb']; n = CONVENTIONAL.get((h, it.get('preparation')), SUBST.get(h, h))
                ing.append(n)
        # 有毒药不写生品名：旧目录有同一味的炮制规格名（姜半夏、制川乌、炮附片）就沿用，没有则写通行的炮制规格。
        old_ing = HEAD.get(c['catalogId'], {}).get('ingredients', [])
        def toxic_form(n):
            base = TOXIC_DEFAULT.get(n)
            if not base: return n
            same = [o for o in old_ing if (n in o and not (n == '附子' and '白附' in o)) or (n == '附子' and o in ('附片', '炮附片', '黑顺片', '淡附片', '白附片'))]
            return same[0] if same else base
        ing = [RENAME.get(toxic_form(x), toxic_form(x)) for x in ing]
        # 原文只写「芍药」「皂角」「紫苏」「菖蒲」这类品种未分的古名、且逐方品种裁定表（tcm-formula-ingredient-identity-adjudications）
        # 对这首方有裁定的：目录保留原文写法，品种仍由裁定表按方解析（白芍/赤芍方向相反，不能在订正时顺手定成一种）。
        for (fname, raw), resolved in ADJ.items():
            if fname != e['name'] or raw in ing: continue
            hit = next((it for it in row['ingredients'] if it.get('written') == raw), None)
            if not hit: continue
            for cand in (hit['herb'], resolved):
                if cand in ing: ing[ing.index(cand)] = raw; break
        # 旧目录就是按原文写法收的、且药名身份已链到同一味药的（西黄→牛黄、真川贝→川贝母、官桂→肉桂）：沿用旧写法，
        # 不因订正换一个同药异名（既有的按名裁定、棘轮与历史断言都按旧写法定位）。单字残片不沿用。
        old_links = {l['rawName']: l.get('canonicalName') for l in HEAD.get(c['catalogId'], {}).get('ingredientLinks', []) or []}
        for it in row['ingredients']:
            w = it.get('written') or ''
            if len(w) >= 2 and w in old_ing and w not in ing and it['herb'] in ing and old_links.get(w) == it['herb']:
                ing[ing.index(it['herb'])] = w
        # 旧目录把原书的药引（生姜、大枣、薄荷…）列在组成里的，订正后照旧列在最后：目录组成是编译基准，药引仍要让开方模型看到；
        # 对账不计药引位置。
        for g in row.get('guideHerbs') or []:
            kept = next((o for o in old_ing if o == g['herb'] or (len(g['herb']) >= 2 and g['herb'] in o)), None)
            if kept and kept not in ing and g['herb'] not in ing: ing.append(kept)
        seen = []; [seen.append(x) for x in ing if x and x not in seen]; ing = seen
        if len(ing) < 1: skipped.append((c['name'], c['book'], 'empty')); continue
        ev = row['evidence'][0]
        url = ev.get('url') or (f"local:{ev.get('file')}:{ev.get('line')}" if ev.get('file') else '')
        if not url: skipped.append((c['name'], c['book'], 'no evidence url')); continue
        note = f"按原方组成表订正（{row['book']}原文：{ev['quote'][:80]}）。{c.get('reason', '')}"
        existing = by_name.get(e['name'])
        if existing:
            # 这条目录条目此前已有校勘行（新增或重录）：只换组成与原文，其余裁决字段不动。
            existing['ingredients'] = ing
            existing['recordedComposition'] = ev['quote'][:300]
            existing['collationNote'] = (existing.get('collationNote', '') + f"｜{REF}：{note}")[:900]
            existing['originalCompositionRef'] = REF
            done += 1; continue
        lockable = bool(e.get('identityLockEligible'))
        col['entries'].append({
            'action': 'rewrite', 'adjudicationRef': REF, 'name': e['name'], 'displayName': e.get('displayName') or e['name'],
            'source': e['source'], 'ingredients': ing, 'recordedComposition': ev['quote'][:300], 'sectionBoundary': e['source'],
            'dosageForm': e.get('dosageForm') or '', 'indications': e.get('adjudicatedIndications') or [],
            'properNameInSource': lockable, 'properNameNote': '是' if lockable else '此前不可锁定，订正组成不改变锁定资格',
            'administration': e.get('collationAdministration') or ('internal' if e.get('retrievalEligible', True) else 'historical_only'),
            'replacesEntry': '', 'replaceSourceOf': {'name': e['name'], 'source': e['source']}, 'peonyCollation': '不涉及',
            'collationNote': note[:600], 'evidenceUrl': url,
        })
        done += 1
    # 出处挂错书的条目（组成是另一本书的同名方）：只改出处，组成不动。work/manual-collation.json
    for m in (json.load(open(W + 'manual-collation.json')) if os.path.exists(W + 'manual-collation.json') else []):
        e = cat.get(m['catalogId']) or HEAD.get(m['catalogId']); row = rows.get((m['name'], m['newBook']))
        if not e or not row: skipped.append((m['name'], m['newBook'], 'manual: no entry/row')); continue
        old_source = HEAD[m['catalogId']]['source']; ev = row['evidence'][0]; lockable = bool(e.get('identityLockEligible'))
        col['entries'].append({
            'action': 'rewrite', 'adjudicationRef': REF, 'name': e['name'], 'displayName': e.get('displayName') or e['name'],
            'source': m['newSource'], 'ingredients': list(HEAD[m['catalogId']]['ingredients']), 'recordedComposition': ev['quote'][:300], 'sectionBoundary': m['newSource'],
            'dosageForm': e.get('dosageForm') or '', 'indications': e.get('adjudicatedIndications') or [],
            'properNameInSource': lockable, 'properNameNote': '是' if lockable else '此前不可锁定，订正出处不改变锁定资格',
            'administration': e.get('collationAdministration') or ('internal' if e.get('retrievalEligible', True) else 'historical_only'),
            'replacesEntry': '', 'replaceSourceOf': {'name': e['name'], 'source': old_source}, 'peonyCollation': '不涉及',
            'collationNote': ('出处订正：' + m['reason'])[:600], 'evidenceUrl': ev.get('url') or '',
        })
        done += 1
    col['sourceRefs'].append({'ref': REF, 'name': '目录组成按原方组成表订正（第四十二轮，根因一全表对账）', 'date': '2026-11-10',
        'detail': '受治理目录条目与原方组成表（方名+出处，逐字摘自原书）同名同书而药味不一致、裁决为目录有误的，组成改为原书组成；出处、主治不动。'
                  '逐条理由见各行 collationNote；原方表 src/data/tcm-formula-original-compositions.source.json 带原文摘句。'})
    json.dump(col, open(D + 'tcm-formula-catalog-collation.source.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('collation rows written', done, 'skipped', skipped[:20])
def write_accepted(recon_path):
    _r = json.load(open(recon_path)); diffs = {d['id']: d for d in (_r.get('differences') or _r['unresolved'])}
    acc = json.load(open(W + 'accepted.json'))
    manual = json.load(open(W + 'accepted-manual.json')) if os.path.exists(W + 'accepted-manual.json') else []
    acc = [a for a in acc if a['catalogId'] not in {m['catalogId'] for m in manual}] + manual
    p = D + 'tcm-formula-original-reconciliation.source.json'; data = json.load(open(p))
    out = []; stale = 0
    for a in sorted(acc, key=lambda x: (x['book'], x['name'])):
        d = diffs.get(a['catalogId'])
        if not d: stale += 1; continue
        out.append({'name': d['name'], 'book': d['book'], 'extraInCatalog': d['extraInCatalog'], 'missingInCatalog': d['missingInCatalog'], 'category': a['category'], 'reason': a['reason']})
    # 目录已按裁决改成原方、裁决员在药名清单里有意不列的药（今天不用的麝香、犀角、轻粉、金箔…）：保留差异，理由取裁决理由。
    col = {c['catalogId']: c for c in json.load(open(W + 'collate.json'))}
    done = {(o['name'], o['book']) for o in out}
    for i, d in sorted(diffs.items(), key=lambda kv: (kv[1]['book'], kv[1]['name'])):
        c = col.get(i)
        if c and c.get('ingredients') and not d['extraInCatalog'] and d['missingInCatalog'] and (d['name'], d['book']) not in done:
            out.append({'name': d['name'], 'book': d['book'], 'extraInCatalog': [], 'missingInCatalog': d['missingInCatalog'], 'category': 'original_herb_not_dispensed',
                        'reason': f"目录已按原方订正；原方另有{'、'.join(d['missingInCatalog'])}，订正时有意不列入目录。{c.get('reason', '')[:200]}"})
            acc.append({'catalogId': i})
    out.sort(key=lambda x: (x['book'], x['name']))
    data['accepted'] = out
    json.dump(data, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1); open(p, 'a').write('\n')
    print('accepted written', len(out), 'no longer different', stale, 'still unresolved', len([d for i, d in diffs.items() if i not in {a['catalogId'] for a in acc}]))
if '--accepted' in sys.argv: write_accepted(sys.argv[sys.argv.index('--accepted') + 1])
else: write_collation()
