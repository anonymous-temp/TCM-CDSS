#!/usr/bin/env python3
"""把 jicheng.tw（中醫笈成）全部典籍抓到本机缓存并转成简体纯文本（标题行以 #hN 开头），断点续跑。"""
import json, os, re, sys, time, html, urllib.request, urllib.parse, zhconv, concurrent.futures as cf
WEB = '/var/tmp/r1057/web/'; RAW = WEB + 'raw/'; TXT = '/var/tmp/r1057/jc/'
os.makedirs(RAW, exist_ok=True); os.makedirs(TXT, exist_ok=True)
books = json.load(open(WEB + 'jicheng-books.json'))
def to_text(page):
    m = re.search(r'<main[^>]*>(.*)</main>', page, re.S)
    body = m.group(1) if m else page
    out = []
    for tag, attrs, inner in re.findall(r'<(h[1-6]|div|p|li|td)\b([^>]*)>(.*?)</\1>', body, re.S):
        text = re.sub(r'<rt>.*?</rt>', '', inner, flags=re.S)
        text = html.unescape(re.sub(r'<[^>]+>', '', text)).replace('　', ' ').strip()
        text = re.sub(r'[ \t\r\n]+', ' ', text)
        if not text: continue
        out.append((f'#{tag} ' if tag[0] == 'h' else '') + zhconv.convert(text, 'zh-cn'))
    return '\n'.join(out) + '\n'
def one(item):
    name, info = item
    raw = RAW + name + '.html'; txt = TXT + name + '.txt'
    if os.path.exists(txt) and os.path.getsize(txt) > 0: return name, 'cached'
    url = 'https://jicheng.tw/tcm/book/' + urllib.parse.quote(info['href'])
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            data = urllib.request.urlopen(req, timeout=60).read().decode('utf-8', 'ignore')
            open(txt + '.tmp', 'w').write(to_text(data)); os.replace(txt + '.tmp', txt)
            time.sleep(0.3)
            return name, 'ok'
        except Exception as e:
            err = str(e); time.sleep(2 + attempt * 3)
    return name, 'fail ' + err
only = set(sys.argv[1:])
items = [(k, v) for k, v in books.items() if (not only or k in only) and k not in ('中医笈成', '歌诀', '协助')]
n = 0
with cf.ThreadPoolExecutor(4) as ex:
    for name, st in ex.map(one, items):
        n += 1
        if st != 'cached': print(n, len(items), name, st, flush=True)
print('DONE', flush=True)
