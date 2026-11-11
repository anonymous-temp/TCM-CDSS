#!/usr/bin/env python3
"""核对一批对账裁决的结构；fix_row 的行按 check_rows 的规则核证据。"""
import json, sys, os
sys.path.insert(0, '/var/tmp/r1057/tools')
import check_rows
DEC = {'collate', 'alternate', 'accept', 'fix_row', 'drop_row', 'unsure'}
CAT = {'original_herb_not_dispensed', 'vehicle_or_excipient', 'catalog_follows_modern_standard_substitution', 'row_low_tier', 'other'}
def check(path):
    data = json.load(open(path)); batch = data.get('batch') or os.path.basename(path)[:-5]
    src = json.load(open(f'/var/tmp/r1057/recon/batches/{batch}.json'))['items']
    decs = data.get('decisions') or []; errs = []
    if len(decs) != len(src): errs.append(f'条数不符：输入 {len(src)}，裁决 {len(decs)}')
    for i, d in enumerate(decs):
        tag = f"[{i}] {d.get('name')}《{d.get('book')}》"
        if i < len(src) and (d.get('name'), d.get('book')) != (src[i]['name'], src[i]['book']): errs.append(tag + ' 与输入顺序不一致')
        if d.get('decision') not in DEC: errs.append(tag + f" decision 非法：{d.get('decision')}"); continue
        if not d.get('reason'): errs.append(tag + ' 缺 reason')
        def need_alt(x):
            a = x.get('alternate') or {}
            if not isinstance(a.get('add'), list) or not isinstance(a.get('remove'), list) or not a.get('basis'): errs.append(tag + ' alternate 需 add/remove/basis')
            if not (a.get('add') or a.get('remove')): errs.append(tag + ' alternate 的 add/remove 不能都为空')
        if d['decision'] == 'alternate':
            need_alt(d)
            ev = d.get('evidence') or []
            if not ev: errs.append(tag + ' alternate 需 evidence')
            else:
                fake = {'status': 'verified', 'tier': 'original_text', 'name': d['name'], 'book': d['book'], 'ingredients': [{'written': w, 'herb': w} for w in []], 'evidence': ev}
                # 只核摘句存在
                for e in check_rows.check([{**fake, 'ingredients': [{'written': '', 'herb': ''}]}]):
                    if 'quote' in e or '证据' in e or '缓存' in e: errs.append(tag + ' ' + e.split('》', 1)[-1])
        if d['decision'] == 'accept' and d.get('category') not in CAT: errs.append(tag + f" accept 的 category 非法：{d.get('category')}")
        if d['decision'] == 'fix_row':
            row = d.get('row')
            if not isinstance(row, dict): errs.append(tag + ' fix_row 需给整行 row'); continue
            for e in check_rows.check([row]): errs.append(tag + ' row: ' + e.split('》', 1)[-1])
            t = d.get('then')
            if t and t not in ('collate', 'accept', 'alternate'): errs.append(tag + f' then 非法：{t}')
            if t == 'accept' and d.get('category') not in CAT: errs.append(tag + ' then=accept 需 category')
            if t == 'alternate': need_alt(d)
    return errs
if __name__ == '__main__':
    errs = check(sys.argv[1])
    for e in errs: print('ERR', e)
    print(f'errors {len(errs)}'); sys.exit(1 if errs else 0)
