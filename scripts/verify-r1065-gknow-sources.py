#!/usr/bin/env python3
"""逐字/逐行核对 G3 引文；无网络、无密钥。网页文本再与保存的 HTML 可见段落独立比对。"""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class VisibleParagraphs(HTMLParser):
    def __init__(self, hidden):
        super().__init__(convert_charrefs=True)
        self.hidden = hidden
        self.stack = []
        self.paragraph = None
        self.paragraphs = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        hide = any(self.stack) or bool(set(attrs.get('class', '').split()) & self.hidden)
        self.stack.append(hide)
        if tag == 'p':
            self.paragraph = []

    def handle_endtag(self, tag):
        if tag == 'p' and self.paragraph is not None:
            self.paragraphs.append(''.join(self.paragraph).strip())
            self.paragraph = None
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self.paragraph is not None and not any(self.stack):
            self.paragraph.append(data)


def verify_sources():
    count = 0
    for name in ['erzhang', 'houyin']:
        base = ROOT / 'scripts/fixtures/r1065-gknow-sources' / name
        html = base.with_suffix('.html').read_text()
        hidden = set()
        for selectors, style in re.findall(r'([^{}]+)\{([^{}]+)\}', html):
            if re.search(r'display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0', style):
                hidden.update(re.findall(r'\.([A-Za-z0-9_-]+)', selectors))
        parser = VisibleParagraphs(hidden)
        parser.feed(html)
        paragraphs = set(parser.paragraphs)
        for line in base.with_suffix('.txt').read_text().splitlines():
            # Heading labels are h2 text; all actual clinical paragraphs must be verbatim.
            if line in ['诊断要点', '鉴别诊断', '内治法']:
                assert line in html
            elif line:
                assert line in paragraphs, f'{name}: saved text is not visible HTML: {line[:30]}'

    def evidence(entry):
        nonlocal count
        assert entry.get('book'), 'source title/book missing'
        assert entry.get('quote'), 'empty quote'
        source = ROOT / entry['path']
        text = source.read_text()
        if entry['kind'] == 'local':
            start = entry['line']
            end = entry.get('endLine', start)
            assert entry['quote'] in '\n'.join(text.splitlines()[start - 1:end]), f'line mismatch {source}:{start}'
        else:
            assert entry['url'].startswith('https://')
            assert entry['quote'] in text, f'web quote mismatch: {source}'
        count += 1

    supplement = json.loads((ROOT / 'src/data/tcm-textbook-syndrome-supplement.source.json').read_text())
    originals = json.loads((ROOT / 'src/data/tcm-formula-original-compositions.json').read_text())['entries']
    for row in supplement['rows']:
        if not row.get('gknow'):
            continue
        assert row.get('evidence'), row['id']
        for entry in row['evidence']:
            evidence(entry)
        quotes = '\n'.join(x['quote'] for x in row['evidence'])
        for field in ['manifestations', 'therapy']:
            assert row[field].rstrip('。') in quotes, f'{row["id"]}: {field} not verbatim'
        expected = []
        for formula in row['formulas']:
            book = row['formulaBooks'][formula]
            entry = next((x for x in originals if x['name'] == formula and x['book'] == book), None)
            assert entry, f'{formula}/{book}: no original composition'
            expected.extend([h['herb'] for h in entry['herbs']] + entry['guides'])
        assert row['composition'] == list(dict.fromkeys(expected)), row['id']
    for disease in supplement['diseases']:
        for entry in disease.get('gknowEvidence', []) + (disease.get('evidence', []) if disease.get('gknow') else []):
            evidence(entry)
    for filename, key in [('tcm-knowledge-gap-retrieval.source.json', 'rules'), ('tcm-textbook-disease-subtypes.source.json', 'gknowEvidence')]:
        data = json.loads((ROOT / 'src/data' / filename).read_text())
        for item in data[key]:
            if key == 'rules':
                for entry in item['evidence']:
                    evidence(entry)
            else:
                evidence(item)
    return count


if __name__ == '__main__':
    print(json.dumps({'quotesVerified': verify_sources()}, ensure_ascii=False))
