# 交付结果类扫描（确定性）：对一批链路输出目录数每一类问题的份数，并给样例。
# 每轮改完都在甲方测过的全部病历上跑一遍，与上一轮的数对比；甲方点名过的类只许降不许升。
# 用法：python3 scripts/audit/customer-class-scan.py [--json] <outDir>…（outDir 里是 regress-customer-shape / delivery-chain 写出的 <key>.r1.json）
# 病历集与输出不进仓库；基线数字见 CLAUDE.md 第六十一、六十二轮。
import json, sys, re, glob, os, collections
args=[a for a in sys.argv[1:] if not a.startswith('--')]; AS_JSON='--json' in sys.argv
MIND=re.compile(r'心|神|寐|眠|悸|啼|多动|抽动|痴呆|癫|狂|痫')        # 现行判据另含「郁」
SLEEP=re.compile(r'眠|寐|夜啼|夜醒|易醒|早醒|多梦|睡|卧不安')
SED=re.compile(r'酸枣仁|首乌藤|夜交藤|合欢皮|合欢花|远志|柏子仁|龙骨|龙齿|牡蛎|珍珠母|磁石|琥珀|茯神|灵芝')
def walk(o,path=''):
    if isinstance(o,str): yield path,o
    elif isinstance(o,dict):
        for k,v in o.items():
            if k in ('contractSignature','terminologyMappings','coding','guidelineReferences','classicEvidence'): continue
            yield from walk(v,f'{path}.{k}')
    elif isinstance(o,list):
        for i,v in enumerate(o): yield from walk(v,f'{path}[{i}]')
def rec_text(d):
    i=d.get('input') or {}; parts=[str(i.get('chiefComplaint') or '')]
    for k,v in (i.get('symptoms') or {}).items(): parts.append(f'{k}：{v}')
    for k in ('tongue','pulse','faceNote'): 
        if i.get(k): parts.append(str(i[k]))
    for m in i.get('conversation') or []: parts.append(str(m.get('content')))
    return '\n'.join(parts)
hits=collections.defaultdict(list); N=0; stats=collections.Counter()
def hit(c,key,ev): hits[c].append((key,str(ev)[:110]))
for od in args:
  setn=os.path.basename(od.rstrip('/'))
  for f in sorted(glob.glob(od+'/*.json')):
    try: d=json.load(open(f,encoding='utf-8'))
    except Exception: continue
    key=f"{setn}/{d.get('key')}"; N+=1
    i=d.get('input') or {}; pat=i.get('patient') or {}; sex=pat.get('sex'); age=pat.get('age'); rt=rec_text(d)
    m3=(d.get('diagnose') or {}).get('structured') or {}; m4=(d.get('prescribe') or {}).get('structured') or {}
    for k in ('question','redFlags','diagnose','prescribe','assess'):
        if (d.get(k) or {}).get('status')!=200: hit('00_stage_not_200',key,f"{k}={(d.get(k) or {}).get('status')}")
    ov=m3.get('overview') or {}; th=m3.get('therapy') or {}; pg=m3.get('pathogenesis') or {}; wd=(m3.get('westernDiagnosis') or {}).get('primary') or {}
    synd=str(ov.get('primarySyndrome') or ''); sec=''.join(ov.get('secondarySyndromes') or []); dis=str(ov.get('tcmDiseaseName') or '')
    form=m4.get('formula') or {}; cands=form.get('candidates') or []; c0=cands[0] if cands else {}; herbs=c0.get('herbs') or []; mods=form.get('modifications') or []
    npx=m4.get('nonPharma') or {}; gate=(d.get('redFlags') or {}).get('gate'); mode=(d.get('redFlags') or {}).get('mode')
    stats['dosed']+= bool(herbs and all(h.get('dose') for h in herbs)); stats['redflag']+= gate=='red_flag'
    if not (herbs and all(h.get('dose') for h in herbs)): hit('01_no_dose_page',key,f"herbs={len(herbs)} name={c0.get('name')}")
    if not synd or '占位' in json.dumps(ov,ensure_ascii=False)[:400] or '未形成' in str(wd.get('name')): hit('02_limited_m03',key,synd or '(空)')
    # 顺带睡眠差加安神药（证名病名不涉心神，剔掉「郁」后）
    scope=synd+sec+dis
    for m in mods:
        if m.get('action') in ('加',None,'add') and SLEEP.search(str(m.get('trigger'))) and (SED.search(str(m.get('herbName'))) or re.search('安神|宁心|宁神',str(m.get('reason')))) and not MIND.search(scope):
            hit('10_incidental_sedative_mod',key,f"{scope}｜{m.get('trigger')}：加{m.get('herbName')}（{m.get('reason')}）{'【证名含郁】' if '郁' in scope else ''}")
    # 提示词/工程用语外泄
    allm=list(walk(m3,'m3'))+list(walk(m4,'m4'))+[('m5',re.sub(r'<!--[\s\S]*?-->','',str((d.get('assess') or {}).get('content') or '')))]
    for p,s in allm:
        for pat_,cls in ((r'补强治法第一项|治法第一项|主症补强|首项治法','11_prompt_wording'),(r'\[日期已泛化\]|\[已脱敏\]|\[姓名已脱敏\]','12_phi_placeholder'),
                         (r'候选方案|审方|复评|确定性校验|病历已记录[^，。]{1,8}阳性|病历尚未确认|可信度低|尚缺直接的病历依据|依据只有\d条|本例辨证组方|本方案','13_engineering_wording'),
                         (r'按[^，。｜]{2,10}取穴，针对本例|由医师复核|按证型二选一|仅由专业人员操作|按疼痛部位复核|现场定位|由面诊医生确定','14_card_template'),
                         (r'本例有[^，。；]{1,12}记录，使用前请医生确认','15_population_note'),
                         (r'对应病机：兼见|兼见见|若见见','16_garbled')):
            for mm in re.finditer(pat_,s):
                if cls=='13_engineering_wording' and p.startswith('m5') and mm.group(0) in ('复评',): pass
                hit(cls,key,f"{p.split('.')[-1][:18]}：…{s[max(0,mm.start()-18):mm.end()+22]}…")
    # 人群提示与人群不符
    for p,s in allm:
        for mm in re.finditer(r'本例有([^，。；]{1,12})记录',s):
            who=mm.group(1)
            if ('月经' in who and (sex=='男' or (isinstance(age,(int,float)) and (age<10 or age>=55)))) or ('儿童' in who and isinstance(age,(int,float)) and age>=18) or ('老年' in who and isinstance(age,(int,float)) and age<60) or ('孕' in who and sex=='男'):
                hit('17_population_note_wrong_person',key,f"{sex}{age}岁：{mm.group(0)}")
    if sex=='男' or (isinstance(age,(int,float)) and age<10):
        for p,s in allm:
            if p.split('.')[-1] in ('recordQuote',) : continue
            mm=re.search(r'怀孕|妊娠|哺乳|月经期|备孕|经期',s)
            if mm and not re.search(r'母|孕妇|妊娠期高血压',s[max(0,mm.start()-12):mm.end()+6]) and mm.group(0) not in rt: hit('18_female_text_for_male_or_child',key,f"{sex}{age}岁 {p.split('.')[-1][:16]}：…{s[max(0,mm.start()-16):mm.end()+16]}…")
    # 西医依据文字
    basis='；'.join(wd.get('supportingFacts') or []) or str(wd.get('clinicalRationale') or ''); wn=str(wd.get('name') or '')
    if not basis.strip(): hit('20_western_basis_empty',key,wn)
    if len(re.findall('或',re.search(r'尚缺[^。；]*',basis).group(0)) if re.search(r'尚缺[^。；]*',basis) else '')>=3: hit('21_western_or_list',key,re.search(r'尚缺[^。；]*',basis).group(0))
    for pat_,cls in ((r'待查(?:尚缺|诊断|的诊断|表现)|无其他阴性所见|故写症状名待查|暂以症状名待查','22_western_basis_wording'),(r'体格检查确立|查体(?:所见|示|发现)','23_western_basis_exam_claim')):
        mm=re.search(pat_,basis)
        if mm and not (cls.startswith('23') and re.search('查体|体格检查|体检',rt)): hit(cls,key,f"{wn}｜…{basis[max(0,mm.start()-20):mm.end()+20]}…")
    if '待查' in wn and re.search(r'诊断(?:已)?(?:确立|明确|成立)|可临床诊断|临床可诊断',basis) and not re.search(r'尚不|未能|不能|尚未|待',basis[max(0,basis.find('诊断')-6):basis.find('诊断')+14]): hit('24_western_pending_vs_established',key,f"{wn}｜{basis[-60:]}")
    if isinstance(age,(int,float)) and age>=18 and '反复上呼吸道感染' in (wn+basis): hit('25_adult_pediatric_name_in_text',key,f"{wn}｜…{(wn+basis)[max(0,(wn+basis).find('反复上呼吸道感染')-14):][:44]}…")
    if '慢性肾脏病' in basis and not re.search('肌酐|eGFR|尿蛋白|肾功能|肾病|蛋白尿|血尿|浮肿|水肿',rt): hit('26_western_ckd_from_tcm_kidney',key,f"{wn}｜…{basis[max(0,basis.find('慢性肾脏病')-16):][:40]}…")
    # 治法
    meth=str(th.get('overallMethod') or ''); items=[x for x in re.split('[，,、；;]',meth) if x]
    if len(items)>3: hit('30_method_over_3',key,meth)
    for x in items:
        if len(x)!=4: hit('31_method_item_not_4char',key,f"{x}｜{meth}")
    two=re.search(r'(肺脾|脾肺|心脾|肝肾|脾肾|心肾|肺肾|肝脾|肝胃|脾胃)',synd)
    if two:
        need={'肺':'肺|宣|固表|卫','脾':'脾|中|运|胃|土','心':'心|神|悸|脉','肝':'肝|风|筋|木','肾':'肾|精|腰|水|元','胃':'胃|中|脾|降'}
        for org in two.group(1):
            if not re.search(need[org],meth): hit('32_method_misses_organ',key,f"{synd}｜治法：{meth}｜缺{org}")
    prin=str(th.get('overallPrinciple') or ''); nat=pg.get('natureDifferentiation') or {}; root=nat.get('rootDeficiency') or nat.get('deficiencyRoot') or []; branch=nat.get('branchExcess') or nat.get('excessBranch') or []
    if prin in ('扶正祛邪','标本兼治') and not root and '虚' not in synd+sec: hit('33_principle_fuzheng_without_deficiency',key,f"{prin}｜{synd}{sec}｜本虚：{root}")
    if prin=='实则泻之' and root: hit('34_principle_excess_with_deficiency_root',key,f"{synd}｜本虚：{root}")
    if prin=='虚则补之' and branch and not root: hit('35_principle_deficiency_with_excess_only',key,f"{synd}｜标实：{branch}")
    # 鉴别
    dd=ov.get('tcmDiseaseDifferentials') or []
    if len(dd)<2: hit('40_tcm_differentials_lt2',key,f"{dis}｜{[x.get('name') for x in dd]}")
    for x in dd:
        if re.search(r'炎$|综合征|癌|瘤$|结核$|梗死|高血压|糖尿病|异位妊娠|盆腔炎',str(x.get('name'))): hit('41_tcm_differential_western_name',key,f"{dis}｜{x.get('name')}")
    # 加减
    conds=[]; 
    for m in mods:
        t=str(m.get('trigger') or ''); conds.append(re.sub('^本例已见','',t))
        if re.match(r'^(若|如)',t): hit('50_standby_modification',key,f"{t}：{m.get('action')}{m.get('herbName')}")
        if str(m.get('herbName')) in [h.get('name') for h in herbs] and m.get('action')=='加': hit('51_mod_adds_herb_in_formula',key,f"{t}：加{m.get('herbName')}")
    rs=[str(m.get('reason') or '') for m in mods]
    for a in range(len(rs)):
        for b in range(a+1,len(rs)):
            if len(rs[a])>=8 and rs[a][:8]==rs[b][:8]: hit('52_mod_reasons_same_prefix',key,f"{mods[a].get('herbName')}/{mods[b].get('herbName')}：{rs[a][:24]}")
    for m in mods:
        r=str(m.get('reason') or '')
        if items and any(len(x)==4 and x in r for x in items[:1]) and len(mods)>=2 and sum(1 for mm in mods if items[0] in str(mm.get('reason')))>=2: hit('53_mod_reason_copies_method',key,f"{m.get('herbName')}：{r[:30]}｜治法首项 {items[0]}"); break
    stats['mods_0']+= (len(set(conds))==0 and bool(herbs)); stats['mods_1']+= len(set(conds))==1; stats['mods_ge2']+= len(set(conds))>=2
    # 药味功效栏
    for h in herbs:
        fn=str(h.get('function') or ''); nm=str(h.get('name'))
        if re.search('调经|安胎|通乳|下乳|止带',fn) and (sex=='男' or not re.search('经|带下|胎|产|乳',rt)): hit('60_herb_function_gyn_out_of_context',key,f"{nm}[{fn}]｜{sex}{age}岁 {dis}")
        if '止泻' in fn and not re.search('泻|泄|溏|稀',rt): hit('61_herb_function_zhixie_no_diarrhea',key,f"{nm}[{fn}]｜{dis}·{synd}")
        if re.search('解表|发汗|透疹|退热',fn) and not re.search('感冒|表证|表|风|疹|热|咳',synd+dis+meth): hit('62_herb_function_exterior_out_of_context',key,f"{nm}[{fn}]｜{dis}·{synd}")
    names=[str(h.get('name')) for h in herbs]+[str(m.get('herbName')) for m in mods if m.get('action')=='加']
    for a,b in (('人参','党参'),('干姜','生姜'),('太子参','西洋参'),('芒硝','玄明粉')):
        if any(a in n and '苦参' not in n and '丹参' not in n and '玄参' not in n and '沙参' not in n for n in names) and any(b in n for n in names): hit('63_duplicate_like_herbs',key,f"{a}+{b}：{names}")
    fa=str(c0.get('formulaAnalysis') or ''); nm0=str(c0.get('name') or '')
    if '原方' in fa[:16] and nm0.endswith('加减'): hit('64_original_claim_vs_jiajian_name',key,f"{nm0}｜{fa[:24]}")
    if re.search(r'本方以自拟方|本方为自拟方',fa) and not re.search('自拟',nm0): hit('65_name_vs_analysis_selfdevised',key,f"{nm0}｜{fa[:26]}")
    miss=[n for n in [str(h.get('name')) for h in herbs] if re.sub(r'^(炒|炙|蜜|酒|醋|盐|姜|制|煅|焦|土炒|麸炒|法|清|生)','',n) not in fa and n not in fa]
    if herbs and len(miss)>=1: hit('66_analysis_misses_herb',key,f"{nm0}｜未解释：{miss}")
    src=str(c0.get('formulaSource') or '')
    if re.search(r'《中医[^》]*学》|《方剂学》|教材',src): hit('67_source_is_textbook',key,f"{nm0}｜{src}")
    # 注意事项/调护
    pre=npx.get('precautions') or []
    if len(pre)>6: hit('70_precautions_over_6',key,len(pre))
    for s in pre:
        if '雌激素' in s and '雌激素' not in rt: hit('71_care_sentence_irrelevant',key,s[:60])
        if re.search(r'年事已高|老年|高龄',s) and not (isinstance(age,(int,float)) and age>=60) : hit('72_elderly_line_wrong_age',key,f"{age}岁：{s[:40]}")
    miss_codes=(d.get('redFlags') or {}).get('missingItemCodes') or []
    if 'medication_details' in miss_codes and re.search(r'\d+\s*(?:mg|g|片|粒|ml|mL|袋|支|U|单位)',rt) and re.search(r'每[日天晚早]|[一二三1-3]次|bid|tid|qd|qn|/d',rt): hit('73_medication_details_but_recorded',key,re.search(r'[^。；\n]{0,18}\d+\s*(?:mg|g|片|粒|ml|mL|袋)[^。；\n]{0,18}',rt).group(0))
    if sum(1 for c in miss_codes if c in ('pregnancy_unknown','lactation_unknown','conception_unknown'))>=3 and re.search(r'末次月经|避孕|绝经|未婚|否认性生活|结扎',rt): hit('74_three_reproductive_items_despite_record',key,re.search(r'末次月经[^，。；]*|[^，。；]*避孕[^，。；]*|绝经[^，。；]*|未婚|否认性生活[^，。；]*|[^，。；]*结扎',rt).group(0)[:40])

    # —— 裁决后追加的类 ——
    conv=i.get('conversation') or []
    qa=[(str(conv[x].get('content')),str(conv[x+1].get('content'))) for x in range(len(conv)-1) if conv[x].get('role')=='assistant' and conv[x+1].get('role')=='user' and '未能确认' not in str(conv[x+1].get('content'))]
    q=d.get('question') or {}
    if qa:
        stats['answered_conv']+=1
        if q.get('decision')=='ask':
            stats['answered_conv_asked_again']+=1
            nq=str((q.get('questions') or [{}])[0].get('question') or ''); bg=lambda s:{s[k:k+2] for k in range(len(s)-1)}
            for oq,_ in qa:
                a,b=bg(re.sub(r'[？?，。、 ]','',oq)),bg(re.sub(r'[？?，。、 ]','',nq))
                if a and b and len(a&b)/min(len(a),len(b))>=0.45: hit('81_question_repeats_answered',key,f"旧问：{oq[:30]}｜新问：{nq[:30]}"); break
    for p,s in allm:
        if p.split('.')[-1] in ('tcmDiagnosticRationale','tcmDiseaseRationale','overallPathogenesis','reason','formulaAnalysis') or 'pathogenesis' in p:
            mm=re.search(r'[一-鿿](primary|secondary|bounded|resolved|unresolved|null|undefined|candidate|syndrome)[一-鿿]',s)
            if mm: hit('19_english_field_word_in_text',key,f"…{s[max(0,mm.start()-10):mm.end()+12]}…")
    for n in (pg.get('chain') or []):
        if not str(n.get('syndromeEvidence') or '').strip(): hit('36_chain_node_empty_evidence',key,str(n.get('pathogenesis') or n.get('patientFact'))[:40])
    if '待查' not in wn and re.search(r'尚不能确诊|诊断依据不足|暂拟待查|尚不能确立|不能确诊',basis): hit('27_western_definite_name_but_basis_unsure',key,f"{wn}｜…{basis[max(0,re.search(r'尚不能确诊|诊断依据不足|暂拟待查|尚不能确立|不能确诊',basis).start()-24):][:50]}…")
    if re.search(r'既往(?:曾|已)?(?:确诊|诊断)',basis) and re.search(r'尚不能确诊|诊断依据不足|暂拟待查|故.{0,6}待查',basis): hit('28_history_stated_dx_downgraded',key,f"{wn}｜…{basis[max(0,basis.find('既往')-4):][:60]}…")
    rootl=nat.get('deficiencyRoot') or nat.get('benXu') or []; brl=nat.get('excessBranch') or nat.get('biaoShi') or []
    natj=json.dumps(nat,ensure_ascii=False)
    mroot=re.search(r'"(?:rootDeficiency|deficiencyRoot)"\s*:\s*\[([^\]]*)\]',natj); mbr=re.search(r'"(?:branchExcess|excessBranch)"\s*:\s*\[([^\]]*)\]',natj)
    if mroot and mbr and re.search('阴虚',mroot.group(1)) and re.search('热|火',mbr.group(1)) and prin=='虚则补之': hit('37_deficiency_heat_listed_as_excess',key,f"{synd}｜本虚{mroot.group(1)}｜标实{mbr.group(1)}")
    if mroot and mbr and mroot.group(1).strip() and prin=='实则泻之': hit('34b_principle_excess_with_root',key,f"{synd}｜本虚{mroot.group(1)}｜{prin}")
    for s in pre:
        mm=re.search(r'您已自服([^，。；、]{2,14})',s)
        if mm and mm.group(1) not in rt: hit('75_selftaken_medicine_name_not_in_record',key,s[:40])
    dr=str(ov.get('tcmDiseaseRationale') or '')+str(ov.get('tcmDiagnosticRationale') or '')
    for term,need in (('喉核','喉核|扁桃体(?!炎史)|乳蛾'),('未闻及','听诊|啰音|呼吸音'),('触之','触诊|触之|按之|压痛|查体')):
        if term in dr and not re.search(need,rt): hit('38_rationale_exam_claim_not_in_record',key,f"…{dr[max(0,dr.find(term)-14):dr.find(term)+16]}…")
    # 随访模板
    a5=re.sub(r'<!--[\s\S]*?-->','',str((d.get('assess') or {}).get('content') or ''))
    if re.search('如出现皮疹、瘙痒',a5) and re.search('疹|瘙痒|风团|疱',str(i.get('chiefComplaint'))): hit('80_followup_rash_template_vs_skin_complaint',key,str(i.get('chiefComplaint'))[:30])
    # 红旗
    exp=d.get('expect') or {}
    if isinstance(exp,dict) and 'redFlag' in exp:
        if exp['redFlag'] and gate!='red_flag': hit('90_redflag_missed_vs_expect',key,str(i.get('chiefComplaint'))[:30])
        if exp['redFlag'] is False and gate=='red_flag': hit('91_redflag_overcall_vs_expect',key,f"{str(i.get('chiefComplaint'))[:24]}｜{((d.get('redFlags') or {}).get('redFlags') or [''])[0][:50]}")
    g=d.get('gold')
    if isinstance(g,str) and '/' in g:
        gd,gs=g.split('/',1)
        if gd and gd not in dis and dis not in gd: hit('95_disease_vs_gold',key,f"{dis}｜标准 {gd}")
        if gs and not (gs.replace('证','') in synd or synd.replace('证','') in gs or synd in ('阳盛血热证',) and '血热' in gs): hit('96_syndrome_vs_gold',key,f"{synd}{'+'+sec if sec else ''}｜标准 {gs}")
if AS_JSON: print(json.dumps({'n':N,'stats':stats,'hits':{k:v for k,v in sorted(hits.items())}},ensure_ascii=False,indent=0))
else:
    print(f"outputs={N} {dict(stats)}")
    for c in sorted(hits):
        ks=sorted(set(k for k,_ in hits[c])); print(f"{c}: {len(hits[c])} 处 / {len(ks)} 份"); 
        for k,e in hits[c][:int(os.environ.get('SHOW','4'))]: print(f"     {k}｜{e}")
