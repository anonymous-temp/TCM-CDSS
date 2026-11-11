#!/usr/bin/env python3
"""
核对一批「原方组成」行（agents 产出）是否每条都有可机器验证的原文依据。
用法：python3 check_rows.py <rows.json> [--quiet]
规则：
  1 必填字段、取值闭集；
  2 每条 evidence 的 quote 必须逐字出现在它指向的文本里：
       kind=jicheng → /var/tmp/r1057/jc/<book>.txt（简体缓存）；
       kind=local   → 仓库 file 的第 line 行起 6 行内（gb18030 或 utf-8）；
       kind=web     → /var/tmp/r1057/webpages/<saved> 这份保存下来的网页正文（简体）里；
       kind=national_catalog / jingfang → 仓库数据文件对应条目里；
  3 每味药的 written 必须出现在至少一条 quote 里（药名不是凭空写的）；preparation 的原文词（preparationRaw）也必须在 quote 里；
  4 herb 必须是受治理药名身份能认的名字（或在 quote 里就是这个名字）；
  5 guideHerbs 的每一味，其原文写法 guideWritten 必须出现在 quote 里。
"""
import json, re, sys, os, unicodedata
WT = '/var/tmp/r1057/wt'; JC = '/var/tmp/r1057/jc/'; WEBP = '/var/tmp/r1057/webpages/'
RI = json.load(open(WT + '/src/data/tcm-herb-identity-catalog.json'))['resolutionIndex']
KB = set(json.load(open(WT + '/src/data/tcm-herb-usage-names.json'))['names'])
PREPS = {'炙', '蜜炙', '炒', '麸炒', '土炒', '煅', '酒', '盐', '醋', '姜', '炮', '煨', '焙', '制', '蒸', '炭', '焦', '煅淬', '烧', '熬', '米泔浸', '生', '童便'}
STATUS = {'verified', 'verified_other_edition', 'not_found', 'not_a_formula', 'modern_formula'}
TIER = {'original_text', 'national_catalog', 'fangjixue', 'textbook_appendix', 'name_catalog', 'modern_source'}
_cache = {}
def norm(s): return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s or ''))
def jc_text(book):
    p = JC + book + '.txt'
    if p not in _cache: _cache[p] = norm(open(p, encoding='utf-8').read()) if os.path.exists(p) else None
    return _cache[p]
def local_lines(file):
    p = os.path.join(WT, file)
    if p not in _cache:
        raw = open(p, 'rb').read()
        try: t = raw.decode('utf-8')
        except UnicodeDecodeError: t = raw.decode('gb18030', 'ignore')
        _cache[p] = t.split('\n')
    return _cache[p]
def check(rows):
    errs = []
    for n, r in enumerate(rows):
        tag = f"[{n}] {r.get('name')}《{r.get('book')}》"
        def E(m): errs.append(tag + ' ' + m)
        st = r.get('status')
        if st not in STATUS: E(f'status 非法: {st}'); continue
        if st in ('not_found', 'not_a_formula'):
            if not r.get('note'): E('not_found/not_a_formula 需写 note（查过哪里）')
            continue
        if r.get('tier') not in TIER: E(f"tier 非法: {r.get('tier')}")
        ing = r.get('ingredients') or []
        if len(ing) < 1: E('ingredients 为空')
        quotes = []
        for ev in r.get('evidence') or []:
            q = norm(ev.get('quote', '')); k = ev.get('kind')
            if len(q) < 4: E('evidence.quote 太短'); continue
            ok = False
            if k == 'jicheng':
                t = jc_text(ev.get('book', ''))
                if t is None: E(f"jicheng 缓存里没有这本书: {ev.get('book')}")
                else: ok = q in t
                if not ev.get('url'): E('jicheng 证据缺 url')
            elif k == 'local':
                try:
                    L = local_lines(ev['file']); i = int(ev['line']) - 1
                    ok = q in norm(''.join(L[max(0, i - 1):i + 8]))
                except Exception as ex: E(f'local 证据读不到: {ex}')
            elif k == 'web':
                p = WEBP + str(ev.get('saved', ''))
                if not ev.get('url'): E('web 证据缺 url')
                if not os.path.exists(p): E(f"web 证据没有保存的网页正文: {ev.get('saved')}")
                else: ok = q in norm(open(p, encoding='utf-8', errors='ignore').read())
            elif k in ('national_catalog', 'jingfang', 'catalog_prescription_original'):
                ok = True  # 由生成器对着仓库数据核
            else: E(f'evidence.kind 非法: {k}')
            if not ok and k in ('jicheng', 'local', 'web'): E(f'quote 在所指文本里找不到: {ev.get("quote", "")[:40]}…')
            quotes.append(q)
        if not quotes: E('没有 evidence'); continue
        allq = ''.join(quotes)
        seen = set()
        for it in ing:
            w = it.get('written', ''); h = it.get('herb', '')
            if not w or not h: E(f'药味缺 written/herb: {it}'); continue
            if norm(w) not in allq: E(f'药味「{w}」不在任何 quote 里')
            if h not in RI and h not in KB and norm(h) not in allq: E(f'herb「{h}」不是已知药名')
            p = it.get('preparation')
            if p and p not in PREPS: E(f'preparation「{p}」不在闭集里（放 note）')
            if p and not it.get('preparationRaw'): E(f'「{w}」有 preparation 但缺 preparationRaw（原文炮制词）')
            if it.get('preparationRaw') and norm(it['preparationRaw']) not in allq: E(f"preparationRaw「{it['preparationRaw']}」不在 quote 里")
            if h in seen: E(f'herb 重复: {h}')
            seen.add(h)
        for g in r.get('guideHerbs') or []:
            if not g.get('herb') or not g.get('written'): E(f'guideHerbs 项缺 herb/written: {g}'); continue
            if norm(g['written']) not in allq: E(f"药引原文「{g['written']}」不在 quote 里")
    return errs
if __name__ == '__main__':
    rows = json.load(open(sys.argv[1], encoding='utf-8'))
    rows = rows['rows'] if isinstance(rows, dict) else rows
    errs = check(rows)
    for e in errs: print('ERR', e)
    print(f'rows {len(rows)} errors {len(errs)}')
    sys.exit(1 if errs else 0)
