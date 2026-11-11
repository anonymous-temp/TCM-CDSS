#!/usr/bin/env python3
"""
逐目标（方名, 出处书）从各来源收集原文片段并自动解析候选组成，与受治理目录比对后分流。
来源：jicheng.tw 全文缓存（/var/tmp/r1057/jc）、国家经典名方目录、《方剂学》【组成】、教材方剂索引、名录同名条目。
输出 work/harvest.json：每目标 {snippets[], auto{…}, triage}。
"""
import json, re, os, sys, collections, pickle
W = '/var/tmp/r1057/work/'; WT = '/var/tmp/r1057/wt'; D = WT + '/src/data/'; JC = '/var/tmp/r1057/jc/'
def J(p): return json.load(open(p, encoding='utf-8'))
T = J(W + 'targets.json'); BM = J(W + 'bookmap.json')
RI = J(D + 'tcm-herb-identity-catalog.json')['resolutionIndex']
FS = J(D + 'tcm-formula-sources.json'); OC = FS['officialClassicFormulas']; NAMES = FS['formulas']
TF = {e['name']: e for e in J(D + 'tcm-formula-textbook-functions.json')['entries']}
JB = J('/var/tmp/r1057/web/jicheng-books.json')
EDU = open(WT + '/中医补充数据/灵丹GitHub/TCM Educational Materials.txt', encoding='utf-8', errors='ignore').read().split('\n')
EXTRA_ALIAS = {'伤寒论': '伤寒论（宋本）', '外科证治全生集': '外科全生集', '十药神书': '增订十药神书', '医醇賸义': '校注医醇賸义', '医醇义': '校注医醇賸义', '霍乱论': '随息居重订霍乱论',
               '瘟疫论': '温疫论', '湿热病篇': '湿热病篇_1', '万氏妇人科': '万氏女科', '外科发挥': '立斋外科发挥', '南阳活人书': '类证活人书', '慎斋遗书': '周慎斋遗书', '痘疹世医心法': '痘疹心法',
               '金匮要略方论': '金匮要略方论', '中医内科杂病证治新义': None}
def jc_book(book):
    if not book: return None
    m = BM.get(book) or {}
    c = m.get('canon') or book
    if c in EXTRA_ALIAS: return EXTRA_ALIAS[c]
    if book in EXTRA_ALIAS: return EXTRA_ALIAS[book]
    return m.get('jicheng')
# ---------- 药名身份 ----------
SYN = {'桂心': '肉桂', '官桂': '肉桂', '桂': '肉桂', '生决明': '石决明', '芍药': '白芍', '黄耆': '黄芪', '黄蓍': '黄芪', '枣子': '大枣', '枣': '大枣', '姜': '生姜', '夜交藤': '首乌藤',
       '干地黄': '地黄', '生地黄': '地黄', '生地': '地黄', '熟地': '熟地黄', '归身': '当归', '当归身': '当归', '麦门冬': '麦冬', '天门冬': '天冬', '芎藭': '川芎', '芎': '川芎', '橘皮': '陈皮', '橘红': '橘红',
       '山栀': '栀子', '山栀子': '栀子', '栀子仁': '栀子', '山栀仁': '栀子', '杏仁': '苦杏仁', '贝母': '贝母', '竹叶': '淡竹叶', '白茯苓': '茯苓', '赤茯苓': '茯苓', '甘草梢': '甘草', '牡丹皮': '牡丹皮', '丹皮': '牡丹皮',
       '浓朴': '厚朴', '薯蓣': '山药', '山芋': '山药', '干山药': '山药', '怀山药': '山药', '栝蒌根': '天花粉', '栝楼根': '天花粉', '瓜蒌根': '天花粉', '花粉': '天花粉', '牛子': '牛蒡子', '鼠粘子': '牛蒡子', '大力子': '牛蒡子',
       '元参': '玄参', '黑参': '玄参', '元胡': '延胡索', '玄胡索': '延胡索', '延胡': '延胡索', '白芷': '白芷', '蜀椒': '花椒', '川椒': '花椒', '真阿胶': '阿胶', '苡仁': '薏苡仁', '薏仁': '薏苡仁', '米仁': '薏苡仁', '苡米': '薏苡仁',
       '香白芷': '白芷', '缩砂仁': '砂仁', '缩砂': '砂仁', '缩砂蜜': '砂仁', '木香': '木香', '南木香': '木香', '广木香': '木香', '枳壳': '枳壳', '炙草': '甘草', '国老': '甘草', '粉草': '甘草', '生草': '甘草',
       '葛': '葛根', '干葛': '葛根', '粉葛': '葛根', '乌梅肉': '乌梅', '诃子肉': '诃子', '诃黎勒': '诃子', '莲肉': '莲子', '莲子肉': '莲子', '石莲肉': '莲子', '远志肉': '远志', '枣仁': '酸枣仁', '柏仁': '柏子仁',
       '辰砂': '朱砂', '丹砂': '朱砂', '川连': '黄连', '条芩': '黄芩', '子芩': '黄芩', '淡芩': '黄芩', '片芩': '黄芩', '川柏': '黄柏', '黄檗': '黄柏', '蘖皮': '黄柏', '知母': '知母', '肥知母': '知母',
       '半夏曲': '半夏曲', '神曲': '六神曲', '六曲': '六神曲', '曲': '六神曲', '麦蘖': '麦芽', '大麦蘖': '麦芽', '谷蘖': '谷芽', '山查': '山楂', '查肉': '山楂', '楂肉': '山楂', '棠球': '山楂',
       '萝卜子': '莱菔子', '卜子': '莱菔子', '芥子': '芥子', '白芥子': '芥子', '苏子': '紫苏子', '苏叶': '紫苏叶', '紫苏': '紫苏叶', '苏梗': '紫苏梗', '薄荷叶': '薄荷', '鸡苏': '薄荷', '荆芥穗': '荆芥穗',
       '羌活': '羌活', '川羌': '羌活', '独活': '独活', '北柴胡': '柴胡', '软柴胡': '柴胡', '前胡': '前胡', '川芎': '川芎', '抚芎': '川芎', '真川芎': '川芎', '北细辛': '细辛', '辽细辛': '细辛', '细辛': '细辛',
       '人参': '人参', '吉林参': '人参', '白术': '白术', '于术': '白术', '冬术': '白术', '苍术': '苍术', '茅术': '苍术', '茯神': '茯神', '抱木茯神': '茯神', '附子': '附子', '大附子': '附子', '熟附子': '附子', '黑附子': '附子', '炮附子': '附子', '附片': '附子',
       '川乌': '川乌', '乌头': '川乌', '川乌头': '川乌', '草乌头': '草乌', '干姜': '干姜', '炮姜': '炮姜', '黑姜': '炮姜', '生姜': '生姜', '大枣': '大枣', '红枣': '大枣', '肥枣': '大枣', '大黄': '大黄', '川军': '大黄', '锦纹': '大黄', '将军': '大黄',
       '芒硝': '芒硝', '朴硝': '芒硝', '硝': '芒硝', '元明粉': '玄明粉', '枳实': '枳实', '浓朴': '厚朴', '川朴': '厚朴', '桃仁泥': '桃仁', '红蓝花': '红花', '牛膝': '牛膝', '怀牛膝': '牛膝', '川牛膝': '川牛膝',
       '龟板': '龟甲', '败龟板': '龟甲', '龟版': '龟甲', '鳖甲': '鳖甲', '牡蛎': '牡蛎', '龙骨': '龙骨', '犀角': '水牛角', '羚羊角': '羚羊角', '羚角': '羚羊角', '山茱萸肉': '山茱萸', '山萸肉': '山茱萸', '萸肉': '山茱萸', '枣皮': '山茱萸',
       '破故纸': '补骨脂', '故纸': '补骨脂', '仙灵脾': '淫羊藿', '菟丝': '菟丝子', '枸杞': '枸杞子', '甘枸杞': '枸杞子', '杞子': '枸杞子', '女贞': '女贞子', '旱莲草': '墨旱莲', '益母': '益母草', '茺蔚': '益母草',
       '金银花': '金银花', '银花': '金银花', '忍冬': '金银花', '双花': '金银花', '连轺': '连翘', '翘': '连翘', '公英': '蒲公英', '地丁': '紫花地丁', '大青': '大青叶', '豆豉': '淡豆豉', '香豉': '淡豆豉', '豉': '淡豆豉',
       '苇根': '芦根', '苇茎': '芦根', '芦苇根': '芦根', '茅根': '白茅根', '车前': '车前子', '滑石': '滑石', '飞滑石': '滑石', '通草': '通草', '木通': '木通', '瞿麦穗': '瞿麦', '灯心': '灯心草', '灯草': '灯心草',
       '丹参': '丹参', '紫丹参': '丹参', '赤芍药': '赤芍', '白芍药': '白芍', '杭芍': '白芍', '生白芍': '白芍', '全当归': '当归', '归尾': '当归', '当归尾': '当归', '秦归': '当归', '阿胶珠': '阿胶', '驴皮胶': '阿胶',
       '首乌': '何首乌', '制首乌': '何首乌', '生首乌': '何首乌', '天麻': '天麻', '明天麻': '天麻', '钩藤钩': '钩藤', '双钩': '钩藤', '嫩钩藤': '钩藤', '钩钩': '钩藤', '石决': '石决明', '草决明': '决明子', '白蒺藜': '蒺藜', '刺蒺藜': '蒺藜',
       '僵蚕': '僵蚕', '白僵蚕': '僵蚕', '天虫': '僵蚕', '全虫': '全蝎', '蝎尾': '全蝎', '全蝎': '全蝎', '蜈蚣': '蜈蚣', '地龙': '地龙', '蚯蚓': '地龙', '广地龙': '地龙', '蝉衣': '蝉蜕', '蝉退': '蝉蜕', '蝉壳': '蝉蜕',
       '胆星': '胆南星', '南星': '天南星', '陈胆星': '胆南星', '半夏': '半夏', '法夏': '半夏', '姜夏': '半夏', '清夏': '半夏', '制半夏': '半夏', '姜半夏': '半夏', '法半夏': '半夏', '清半夏': '半夏', '陈皮': '陈皮', '广皮': '陈皮', '新会皮': '陈皮', '橘络': '橘络',
       '青皮': '青皮', '香附子': '香附', '香附米': '香附', '莎草根': '香附', '乌药': '乌药', '台乌': '乌药', '天台乌药': '乌药', '郁金': '郁金', '广郁金': '郁金', '川郁金': '郁金', '莪术': '莪术', '蓬术': '莪术', '蓬莪术': '莪术', '京三棱': '三棱',
       '五灵脂': '五灵脂', '灵脂': '五灵脂', '蒲黄': '蒲黄', '生蒲黄': '蒲黄', '乳香': '乳香', '没药': '没药', '血竭': '血竭', '麒麟竭': '血竭', '黄芪': '黄芪', '绵黄芪': '黄芪', '绵芪': '黄芪', '北芪': '黄芪', '生黄芪': '黄芪', '炙黄芪': '黄芪',
       '甘草': '甘草', '炙甘草': '甘草', '生甘草': '甘草', '淮小麦': '小麦', '浮小麦': '浮小麦', '粳米': '粳米', '白米': '粳米', '糯米': '糯米', '饴糖': '饴糖', '胶饴': '饴糖', '蜂蜜': '蜂蜜', '白蜜': '蜂蜜', '蜜': '蜂蜜',
       '石膏': '石膏', '生石膏': '石膏', '寒水石': '寒水石', '代赭': '赭石', '代赭石': '赭石', '赭石': '赭石', '旋复花': '旋覆花', '旋覆': '旋覆花', '金沸草': '旋覆花', '桑皮': '桑白皮', '桑根白皮': '桑白皮', '地骨': '地骨皮',
       '葶苈': '葶苈子', '甜葶苈': '葶苈子', '苦葶苈': '葶苈子', '紫菀茸': '紫菀', '款冬': '款冬花', '冬花': '款冬花', '百部': '百部', '马兜铃': '马兜铃', '兜铃': '马兜铃', '枇杷叶': '枇杷叶', '杷叶': '枇杷叶',
       '麻黄': '麻黄', '桂枝': '桂枝', '嫩桂枝': '桂枝', '川桂枝': '桂枝', '肉桂': '肉桂', '紫油桂': '肉桂', '油桂': '肉桂', '上肉桂': '肉桂', '吴萸': '吴茱萸', '吴茱萸': '吴茱萸', '淡吴萸': '吴茱萸', '荜拨': '荜茇', '良姜': '高良姜',
       '丁香': '丁香', '公丁香': '丁香', '茴香': '小茴香', '舶上茴香': '小茴香', '小茴': '小茴香', '大茴香': '八角茴香', '川楝': '川楝子', '金铃子': '川楝子', '楝实': '川楝子', '苦楝子': '川楝子', '荔核': '荔枝核', '橘核': '橘核',
       '泽泻': '泽泻', '建泽泻': '泽泻', '猪苓': '猪苓', '防己': '防己', '汉防己': '防己', '木防己': '防己', '粉防己': '防己', '萆薢': '萆薢', '川萆薢': '萆薢', '粉萆薢': '萆薢', '薏苡仁': '薏苡仁', '苡仁米': '薏苡仁', '赤小豆': '赤小豆', '赤豆': '赤小豆',
       '熟地黄': '熟地黄', '大熟地': '熟地黄', '怀熟地': '熟地黄', '熟干地黄': '熟地黄', '生干地黄': '地黄', '大生地': '地黄', '细生地': '地黄', '鲜生地': '地黄', '鲜地黄': '地黄', '怀生地': '地黄', '地黄': '地黄',
       '玄参': '玄参', '麦冬': '麦冬', '寸冬': '麦冬', '天冬': '天冬', '石斛': '石斛', '金钗石斛': '石斛', '川石斛': '石斛', '鲜石斛': '石斛', '玉竹': '玉竹', '葳蕤': '玉竹', '萎蕤': '玉竹', '沙参': '北沙参', '北沙参': '北沙参', '南沙参': '南沙参',
       '五味': '五味子', '北五味': '五味子', '北五味子': '五味子', '辽五味': '五味子', '五味子': '五味子', '山药': '山药', '淮山药': '山药', '淮山': '山药', '芡实': '芡实', '鸡头实': '芡实', '金樱': '金樱子', '桑螵蛸': '桑螵蛸', '覆盆': '覆盆子',
       '酸枣仁': '酸枣仁', '柏子仁': '柏子仁', '远志': '远志', '菖蒲': '石菖蒲', '石菖蒲': '石菖蒲', '九节菖蒲': '石菖蒲', '龙齿': '龙齿', '琥珀': '琥珀', '朱砂': '朱砂', '磁石': '磁石', '灵磁石': '磁石', '珍珠母': '珍珠母',
       '杜仲': '杜仲', '川断': '续断', '川续断': '续断', '续断': '续断', '寄生': '桑寄生', '桑寄生': '桑寄生', '狗脊': '狗脊', '金毛狗脊': '狗脊', '骨碎补': '骨碎补', '巴戟': '巴戟天', '巴戟肉': '巴戟天', '苁蓉': '肉苁蓉', '淡苁蓉': '肉苁蓉', '锁阳': '锁阳',
       '鹿角胶': '鹿角胶', '鹿胶': '鹿角胶', '龟胶': '龟甲胶', '龟板胶': '龟甲胶', '龟甲胶': '龟甲胶', '紫河车': '紫河车', '胡桃肉': '核桃仁', '胡桃': '核桃仁', '核桃肉': '核桃仁', '蛤蚧': '蛤蚧', '冬虫夏草': '冬虫夏草',
       '黄连': '黄连', '雅连': '黄连', '黄芩': '黄芩', '黄柏': '黄柏', '栀子': '栀子', '龙胆草': '龙胆', '胆草': '龙胆', '龙胆': '龙胆', '苦参': '苦参', '秦皮': '秦皮', '白头翁': '白头翁', '马齿苋': '马齿苋',
       '柴胡': '柴胡', '升麻': '升麻', '绿升麻': '升麻', '葛根': '葛根', '防风': '防风', '荆芥': '荆芥', '藁本': '藁本', '蔓荆子': '蔓荆子', '蔓荆': '蔓荆子', '菊花': '菊花', '甘菊': '菊花', '甘菊花': '菊花', '杭菊': '菊花', '黄菊花': '菊花', '白菊花': '菊花', '桑叶': '桑叶', '霜桑叶': '桑叶', '冬桑叶': '桑叶',
       '桔梗': '桔梗', '苦桔梗': '桔梗', '苦梗': '桔梗', '前胡': '前胡', '牛蒡子': '牛蒡子', '射干': '射干', '山豆根': '山豆根', '马勃': '马勃', '板蓝根': '板蓝根', '蓝根': '板蓝根', '天花粉': '天花粉',
       '白扁豆': '白扁豆', '扁豆': '白扁豆', '藿香': '广藿香', '藿香叶': '广藿香', '广藿香': '广藿香', '佩兰': '佩兰', '草果': '草果', '草果仁': '草果', '草豆蔻': '草豆蔻', '白豆蔻': '豆蔻', '白蔻仁': '豆蔻', '蔻仁': '豆蔻', '白蔻': '豆蔻', '肉豆蔻': '肉豆蔻', '肉果': '肉豆蔻',
       '槟榔': '槟榔', '大腹子': '槟榔', '大腹皮': '大腹皮', '腹皮': '大腹皮', '木瓜': '木瓜', '宣木瓜': '木瓜', '威灵仙': '威灵仙', '灵仙': '威灵仙', '秦艽': '秦艽', '豨莶': '豨莶草', '海桐皮': '海桐皮', '五加皮': '五加皮',
       '白及': '白及', '白芨': '白及', '三七': '三七', '参三七': '三七', '田七': '三七', '茜根': '茜草', '茜草根': '茜草', '侧柏': '侧柏叶', '柏叶': '侧柏叶', '艾叶': '艾叶', '蕲艾': '艾叶', '熟艾': '艾叶', '地榆': '地榆', '槐花': '槐花', '槐角': '槐角', '棕榈皮': '棕榈', '棕皮': '棕榈'}
PFX = re.compile(r'^(?:麸炒|土炒|蜜炙|酒炙|醋炙|盐炙|姜炙|酒炒|醋炒|盐炒|姜炒|炙|蜜|酒|醋|盐|炒|焦|煅|煨|燀|烫|生|朱|姜|法|清|制|炮|净|干|鲜|川|广|怀|杭|北|南|绵|真|大|小|白|赤|辽|明|嫩|陈|淡|细|肥|厚|好|上|新|老)')
def ident(h):
    h = re.sub(r'[（(][^）)]*[）)]', '', h).strip()
    if h in SYN: return SYN[h]
    for cand in (h, re.sub(r'(?:片|粉|末|肉|子肉|炭)$', '', h)):
        if cand in SYN: return SYN[cand]
        r = RI.get(cand)
        if r and r.get('canonicalName'): return SYN.get(r['canonicalName'], r['canonicalName'])
    x = h
    for _ in range(2):
        x2 = PFX.sub('', x)
        if x2 == x or len(x2) < 2: break
        x = x2
        if x in SYN: return SYN[x]
        r = RI.get(x)
        if r and r.get('canonicalName'): return SYN.get(r['canonicalName'], r['canonicalName'])
    return x
def known(h):
    b = re.sub(r'[（(][^）)]*[）)]', '', h).strip()
    if b in SYN or b in RI: return True
    x = PFX.sub('', b)
    return x in SYN or x in RI
# ---------- jicheng 索引 ----------
IDX_P = W + 'jc-index.pkl'
LEAD = re.compile(r'^(?:#h\d )?[\s○●◎☉△▲\[［【〔（(]*(?:\d+[\.、]\s*)?([一-鿿]{2,14})')
def build_index():
    idx = collections.defaultdict(list)
    for f in sorted(os.listdir(JC)):
        if not f.endswith('.txt'): continue
        b = f[:-4]
        for i, line in enumerate(open(JC + f, encoding='utf-8')):
            m = LEAD.match(line)
            if not m: continue
            lead = m.group(1)
            rest = line[m.end():m.end() + 1]
            head = line.startswith('#h')
            # 方名独占一行、作标题、或后面紧跟空格/标点（「白术散 治妊娠…」「柴胡葛根汤（见…）」）
            if head or rest in ('', '\n', ' ', '：', ':', '（', '(', '】', '］', ']', '〕', '方', '，', '。'):
                if re.search(r'[汤散丸饮丹膏煎方子剂酒露锭片圆]$', lead) or head:
                    idx[lead].append((b, i))
                    if lead.endswith('方') and len(lead) > 3: idx[lead[:-1]].append((b, i))
    pickle.dump(dict(idx), open(IDX_P, 'wb'))
    return dict(idx)
BOOKLINES = {}
def lines_of(b):
    if b not in BOOKLINES:
        if len(BOOKLINES) > 12: BOOKLINES.clear()
        BOOKLINES[b] = open(JC + b + '.txt', encoding='utf-8').read().split('\n')
    return BOOKLINES[b]
FORMULA_LINE = re.compile(r'^(?:#h\d )?[一-鿿]{2,12}[汤散丸饮丹膏煎方子圆](?:方)?(?:$|[ （(：:])')
def snippet(b, i, name):
    L = lines_of(b); out = [L[i]]
    for j in range(i + 1, min(len(L), i + 14)):
        s = L[j]
        if s.startswith('#h'): break
        if FORMULA_LINE.match(s) and not s.startswith(name) and len(out) >= 2: break
        out.append(s)
        if sum(len(x) for x in out) > 1400: break
    return out
DOSE = r'(?:各)?(?:等分|[一二三四五六七八九十百千半\d\.]+[一二三四五六七八九十百千半两钱分厘斤升合枚个片粒铢字握茎条只挺具寸尺株把颗匕盏杯碗撮枝对张块节瓣叶\d\.]*)'
TOK = re.compile(r'^([一-鿿]{1,8}?)(?:' + DOSE + r')?((?:[（(][^）)]*[）)])*)(?:' + DOSE + r')?$')
STOP = re.compile(r'^(?:上|右|以上|已上|水|每服|右件|上件|上药|上为|上锉|上㕮咀|共为|共研|为末|为细末|用法|主治|功用|治|㕮咀|煎|服)')
def parse_ingredients(lines, name):
    """返回 (药味[{written,note}], 所在行下标, 煎服法文字)"""
    best = None
    for k, line in enumerate(lines[1:], 1):
        s = line.strip()
        if not s or s.startswith('#h'): continue
        body = s
        if STOP.match(body): 
            if best: break
            continue
        parts = [p for p in re.split(r'[ 　,，、；;。]+(?![^（(]*[）)])', body) if p]
        items = []; bad = 0
        for p in parts:
            p = p.strip()
            m = TOK.match(p)
            if m and known(m.group(1)):
                items.append({'written': m.group(1), 'note': re.sub(r'^[（(]|[）)]$', '', m.group(2) or '')})
            else:
                # 「甘草（炙）各等分」「当归川芎各一两」这类不强解，记坏
                bad += 1
        if len(items) >= 2 and len(items) >= 0.7 * (len(items) + bad):
            if best is None or len(items) > len(best[0]):
                method = ''
                for nxt in lines[k + 1:k + 4]:
                    if re.match(r'^(?:上|右|以上|已上|水|每服)', nxt.strip()): method = nxt.strip(); break
                best = (items, k, method, bad)
            if best and best[1] == k: 
                # 药味跨两行的接上
                pass
        elif best: break
    return best
GINGER = re.compile(r'(?:生姜|姜)[^，。、；\s]{0,3}?(?:[一二三四五六七八九十两半\d]+)(?:片|块|钱|分|两)|入生姜|加生姜|姜[、，]?枣|生姜煎|姜汤')
JUJUBE = re.compile(r'(?:大枣|枣子|红枣|肥枣|枣)[^，。、；\s]{0,3}?(?:[一二三四五六七八九十两半\d]+)(?:枚|个|颗|粒)|姜[、，]?枣|枣汤|枣肉')
def book_group(jb):
    if not jb: return []
    base = re.sub(r'_\d+$', '', jb)
    return [f[:-4] for f in ALLJC if f[:-4] == base or re.fullmatch(re.escape(base) + r'_\d+', f[:-4])]
ALLJC = sorted(f for f in os.listdir(JC) if f.endswith('.txt'))
JF = J(D + 'tcm-jingfang-canonical.source.json')['books']
def main():
    idx = pickle.load(open(IDX_P, 'rb')) if os.path.exists(IDX_P) and '--reindex' not in sys.argv else build_index()
    # 教材方剂索引行：行首「方名（《书》）」
    app = collections.defaultdict(list)
    APP = re.compile(r'^([一-鿿]{2,14})\s*[（(]\s*(《[^》]{1,30}》[^）)]{0,12}|[^）)《》]{0,12}(?:经验方|验方))\s*[）)]\s*[：:]?\s*(.*)$')
    for i, line in enumerate(EDU):
        m = APP.match(line.strip())
        if not m: continue
        body = m.group(3).strip(); extra = 0
        # OCR 硬换行：下一行不是另一条索引、也不是单个字母分节时接上
        while i + 1 + extra < len(EDU) and extra < 2:
            nxt = EDU[i + 1 + extra].strip()
            if not nxt or APP.match(nxt) or len(nxt) <= 3 or re.search(r'[。：:]|^[一二三四五六七八九十]+\s*画', nxt): break
            body += ' ' + nxt; extra += 1
        if body: app[m.group(1)].append({'line': i + 1, 'book': m.group(2), 'text': body[:300]})
    tfline = {}
    for i, line in enumerate(EDU):
        if line.startswith('【组成】'): tfline.setdefault(line.strip()[:60], i + 1)
    out = []; tri = collections.Counter()
    for t in sorted(T, key=lambda x: (x['book'], x['name'])):
        name, book = t['name'], t['book']
        nm = re.sub(r'方$', '', name) if len(name) > 3 else name
        snippets = []
        jb = jc_book(book)
        hits = idx.get(name, []) + ([] if nm == name else idx.get(nm, []))
        grp = book_group(jb)
        same = [(b, i) for b, i in hits if b in grp]
        seen_lines = {(b, i) for b, i in same}
        # 同书里方名不在行首的定义位置：「方用完带汤。」「辛凉平剂银翘散方」行尾，下一行起是药味
        if grp and len(same) < 4:
            tail = re.compile(re.escape(nm) + r'方?[：:。]?\s*$')
            for b in grp:
                L = lines_of(b)
                for i, line in enumerate(L):
                    if nm in line and (b, i) not in seen_lines and tail.search(line) and not re.search(r'(?:见|同|即|如|用|宜|与|合|或|及|服|投|进|主以|治以)' + re.escape(nm) + r'方?[：:。]?\s*$', line.replace('方用', '')):
                        same.append((b, i)); seen_lines.add((b, i))
                        if len(same) >= 6: break
        other = [(b, i) for b, i in hits if b not in grp]
        for b, i in same[:5]:
            sn = snippet(b, i, name)
            sn[0] = sn[0][-160:]
            snippets.append({'src': 'jicheng', 'book': b, 'sameBook': True, 'line': i + 1, 'url': 'https://jicheng.tw/tcm/book/' + JB[b]['href'], 'text': sn})
        seen = set()
        for b, i in other:
            if b in seen or len(seen) >= (4 if same else 8): continue
            seen.add(b)
            sn = snippet(b, i, name)
            snippets.append({'src': 'jicheng', 'book': b, 'sameBook': False, 'line': i + 1, 'url': 'https://jicheng.tw/tcm/book/' + JB[b]['href'], 'text': sn[:6]})
        for jbook, items in JF.items():
            for it in items:
                if name == it['name'] or name in (it.get('variants') or []):
                    snippets.append({'src': 'jingfang_canonical', 'book': jbook, 'canonicalName': it['name'], 'ingredients': it['ingredients'], 'tiaowen': it.get('tiaowen')})
        if name in OC:
            o = OC[name]; snippets.append({'src': 'national_catalog', 'book': o['source'], 'text': [o.get('prescription') or '', o.get('sourceOriginal') or ''], 'ingredients': o['ingredients']})
        if name in TF and TF[name].get('composition'):
            e = TF[name]; snippets.append({'src': 'fangjixue', 'book': e.get('source'), 'line': tfline.get(('【组成】' + e['composition'])[:60]) or tfline.get(('【组成】 ' + e['composition'])[:60]), 'text': [e['composition']]})
        for a in app.get(name, [])[:6]:
            snippets.append({'src': 'textbook_appendix', 'book': a['book'], 'line': a['line'], 'text': [a['text']]})
        for v in (NAMES.get(name) or [])[:12]:
            snippets.append({'src': 'name_catalog', 'book': v['source'], 'ingredients': v['ingredients']})
        # 自动解析：同书 jicheng 首个可解析片段
        auto = None
        for s in snippets:
            if s['src'] == 'jicheng' and s['sameBook']:
                p = parse_ingredients(s['text'], name)
                if p:
                    items, k, method, bad = p
                    ids = [ident(x['written']) for x in items]
                    guides = []
                    if '生姜' not in ids and GINGER.search(method): guides.append('生姜')
                    if '大枣' not in ids and JUJUBE.search(method): guides.append('大枣')
                    auto = {'snippet': snippets.index(s), 'items': items, 'ids': ids, 'method': method[:160], 'guides': guides, 'bad': bad, 'lineOffset': k}
                    break
        cat_ids = [sorted({ident(h) for h in c['ingredients']}) for c in t['catalog']]
        G = {'生姜', '大枣'}
        if auto and cat_ids:
            a = set(auto['ids']) - G
            tr = 'agree' if any(a == set(c) - G for c in cat_ids) else 'diff'
            if tr == 'agree' and auto['bad']: tr = 'agree_partial_parse'
        elif auto: tr = 'auto_only'
        elif any(s['src'] == 'jicheng' and s['sameBook'] for s in snippets): tr = 'unparsed'
        elif snippets: tr = 'other_sources'
        else: tr = 'nothing'
        tri[(t['p1'], tr)] += 1
        out.append({**t, 'jcBook': jb, 'snippets': snippets, 'auto': auto, 'triage': tr})
    json.dump(out, open(W + 'harvest.json', 'w'), ensure_ascii=False)
    for k in sorted(tri, key=str): print(k, tri[k])
main()
