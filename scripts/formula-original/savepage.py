#!/usr/bin/env python3
"""把一个网页抓下来存成简体纯文本，供 web 证据逐字核对。用法：savepage.py <url> <batch>  → 打印 saved 相对路径"""
import sys, re, os, html, hashlib, subprocess, zhconv
url, batch = sys.argv[1], sys.argv[2]
d = f'/var/tmp/r1057/webpages/{batch}'; os.makedirs(d, exist_ok=True)
raw = subprocess.run(['curl', '-sL', '-m', '40', '-A', 'Mozilla/5.0', url], capture_output=True).stdout
for enc in ('utf-8', 'gb18030', 'big5'):
    try: text = raw.decode(enc); break
    except UnicodeDecodeError: text = None
if text is None: text = raw.decode('utf-8', 'ignore')
text = re.sub(r'<(script|style)\b.*?</\1>', '', text, flags=re.S | re.I)
text = html.unescape(re.sub(r'<[^>]+>', '\n', text))
text = zhconv.convert(re.sub(r'[ \t\r　]+', ' ', text), 'zh-cn')
text = re.sub(r'\n\s*\n+', '\n', text)
if len(text) < 200: print('FETCH_FAILED_OR_EMPTY', len(text)); sys.exit(1)
name = hashlib.sha1(url.encode()).hexdigest()[:12] + '.txt'
open(f'{d}/{name}', 'w').write(url + '\n' + text)
print(f'{batch}/{name}', len(text))
