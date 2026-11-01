# 模型原始输出 → 交付内容逐处对比（第三十三轮）。配 capture-model-output.mjs（node --import，TRACE_DIR/TRACE_CASES）与 regress-customer-shape.mjs 用。
# 判分：① 每例事先写好的判据 ② 不依赖系统代码的独立读法（别名重复、条件与病历相反、残句）③ 原始 vs 交付的差异。
# 用法：python3 audit.py <name> <cases.json> ；读 /var/tmp/r1045/out/<name> 与 <name>.trace，写 /var/tmp/r1045/audit-<name>.json
import json, os, re, sys, glob, difflib, collections, datetime, statistics as st
NAME, CASES = sys.argv[1], sys.argv[2]
O = f"/var/tmp/r1045/out/{NAME}"; T = O + ".trace"
cases = {c["key"]: c for c in json.load(open(CASES))}

def ts(x):
    if isinstance(x, (int, float)): return x
    try: return datetime.datetime.fromisoformat(str(x).replace("Z", "+00:00")).timestamp() * 1000
    except Exception: return None

trace = collections.defaultdict(list)
for f in glob.glob(T + "/*.json"):
    try: d = json.load(open(f))
    except Exception: continue
    if d.get("key"): trace[d["key"]].append(d)
def loose(s):
    if not s: return None
    s = s.strip()
    s = re.sub(r"^```(?:json)?|```$", "", s).strip()
    try: return json.loads(s)
    except Exception: pass
    a, b = s.find("{"), s.rfind("}")
    if a >= 0 and b > a:
        try: return json.loads(s[a:b + 1])
        except Exception: return None
    return None

# 指纹没命中的（提示词里病历被脱敏或改写）按药味重合度与时间窗归到输出上。
_outs = []
for f in glob.glob(O + "/*.json"):
    try: d = json.load(open(f))
    except Exception: continue
    fm_ = ((d.get("prescribe") or {}).get("structured") or {}).get("formula") or {}
    _outs.append((d["key"], ts(d.get("startedAt")), ts(d.get("finishedAt")), {x.get("name") for x in ((fm_.get("candidates") or [{}])[0].get("herbs") or [])}))
for f in glob.glob(T + "/*.json"):
    try: d = json.load(open(f))
    except Exception: continue
    if d.get("key"): continue
    c_ = d.get("content") or ""
    if '"candidate"' not in c_[:600]: continue
    j = loose(c_)
    if not isinstance(j, dict) or not isinstance(j.get("candidate"), dict): continue
    hs = {h.get("name") for h in j["candidate"].get("herbs") or [] if isinstance(h, dict)}
    best, score = None, 0
    for k_, a_, b_, ds_ in _outs:
        if a_ and b_ and not (a_ - 1000 <= d["t"] <= b_ + 1000): continue
        sc_ = len(hs & ds_) / (len(hs | ds_) or 1)
        if sc_ > score: best, score = k_, sc_
    if best and score >= 0.4: d["key"] = best; trace[best].append(d)
for v in trace.values(): v.sort(key=lambda x: x["t"])

ALIAS = [["海螵蛸", "乌贼骨"], ["延胡索", "元胡", "玄胡", "延胡索（元胡）"], ["金银花", "银花", "二花", "双花", "忍冬花"], ["牡丹皮", "丹皮"], ["栀子", "山栀", "山栀子", "炒栀子"], ["首乌藤", "夜交藤"], ["酸枣仁", "枣仁", "炒酸枣仁"], ["地黄", "生地", "生地黄"], ["熟地黄", "熟地"], ["白芍", "芍药", "炒白芍", "白芍药"], ["苦杏仁", "杏仁", "炒苦杏仁"], ["紫苏子", "苏子", "炒紫苏子"], ["淡竹叶", "竹叶"], ["半夏", "法半夏", "清半夏", "姜半夏"], ["白术", "炒白术", "焦白术"], ["甘草", "炙甘草", "生甘草"], ["黄芪", "炙黄芪", "生黄芪"], ["党参", "潞党参"], ["六神曲", "神曲", "焦神曲", "焦六神曲"], ["麦芽", "炒麦芽", "焦麦芽"], ["山楂", "焦山楂", "炒山楂"], ["牡蛎", "煅牡蛎", "生牡蛎"], ["龙骨", "煅龙骨", "生龙骨"], ["石膏", "生石膏", "煅石膏"], ["大黄", "生大黄", "酒大黄", "制大黄"], ["益智", "益智仁"], ["广藿香", "藿香"], ["龙胆", "龙胆草"], ["墨旱莲", "旱莲草"], ["赭石", "代赭石"], ["蛤壳", "海蛤壳"], ["瓜蒌子", "瓜蒌仁"], ["龟甲", "龟板"], ["鳖甲", "炙鳖甲"], ["芥子", "白芥子"], ["淫羊藿", "仙灵脾"], ["续断", "川断"], ["茯苓", "云苓", "白茯苓"], ["陈皮", "橘皮", "广陈皮"], ["桑白皮", "桑皮", "炙桑白皮"], ["火麻仁", "麻子仁", "麻仁"], ["枳壳", "炒枳壳"], ["枳实", "炒枳实"], ["附子", "制附子", "附片", "熟附子", "黑顺片"], ["生姜", "鲜姜"], ["大枣", "红枣"]]
ALIAS_OF = {x: g[0] for g in ALIAS for x in g}
def ident(n): return ALIAS_OF.get(n, n)
SAME_SOURCE = [("生姜", "干姜"), ("人参", "党参"), ("太子参", "西洋参")]

def clauses(t): return [c for c in re.split(r"[，,。；;：:\n]", t or "") if c.strip()]

# 独立读法：只读病历的舌、脉、寒热、二便、渴、汗、痰，与加减条件比。
def record_text(cs):
    s = cs.get("symptoms") or {}
    parts = [str(s.get("现病史", "")), f"舌象 {cs.get('tongue','')}", f"脉象 {cs.get('pulse','')}"]
    for m in cs.get("conversation") or []:
        if m.get("role") == "user": parts.append(str(m.get("content", "")))
    return "。".join(parts)
def dims(text, is_condition=False):
    t = text; d = {}
    def pos(p): return re.search(p, t) is not None
    def aff(p):
        for m in re.finditer(p, t):
            pre = t[max(0, m.start() - 3):m.start()]
            if not re.search(r"[无不未没否]", pre): return True
        return False
    if aff(r"舌(?:质|体)?(?:偏|尖边?)?红|舌绛"): d["舌色"] = "红"
    elif aff(r"舌(?:质|体)?(?:偏)?淡(?!红)"): d["舌色"] = "淡"
    if aff(r"苔[^，。；]{0,3}黄"): d["苔色"] = "黄"
    elif aff(r"苔[^，。；]{0,3}白"): d["苔色"] = "白"
    if aff(r"少苔|苔少|无苔|剥苔"): d["苔量"] = "少"
    if aff(r"脉[^，。；]{0,3}数"): d["脉率"] = "数"
    elif aff(r"脉[^，。；]{0,3}[迟缓]"): d["脉率"] = "迟"
    if aff(r"便溏|大便稀|大便溏|泄泻|腹泻|完谷不化|五更泻|下利"): d["便"] = "溏"
    elif aff(r"便秘|大便干|便干|大便秘结|大便燥结|便闭|腑实"): d["便"] = "干"
    if aff(r"畏寒|肢冷|形寒|恶寒|怕冷|手足不温|手足欠温|手足冰冷|四肢不温|四肢厥冷"): d["寒"] = 1
    if aff(r"五心烦热|手足心热|潮热|烘热|高热|壮热|发热"): d["热"] = 1
    if re.search(r"口不渴|不欲饮|渴不多饮", t): d["渴"] = "否"
    elif aff(r"口渴|口干|大渴"): d["渴"] = "是"
    if re.search(r"无汗", t): d["汗"] = "无"
    elif aff(r"汗出|多汗|自汗|盗汗|汗多|大汗"): d["汗"] = "有"
    if aff(r"痰[^，。；]{0,4}黄|黄痰|咯黄"): d["痰"] = "黄"
    elif aff(r"痰[^，。；]{0,4}白|白痰|痰[^，。；]{0,4}稀"): d["痰"] = "白"
    return d
OPP = {"舌色", "苔色", "脉率", "便", "渴", "汗", "痰"}
def cond_conflict(cond, rec):
    c, r = dims(cond), dims(rec); out = []
    for k in OPP:
        if k in c and k in r and c[k] != r[k]: out.append(f"{k}:{c[k]}≠{r[k]}")
    if c.get("苔量") == "少" and r.get("苔色") and "苔量" not in r and "薄" not in rec: pass
    if "寒" in c and "热" in r and "寒" not in r: out.append("条件寒/病历热")
    if "热" in c and "寒" in r and "热" not in r: out.append("条件热/病历寒")
    return out

FRAG = [
    (r"(?:^|[。；])\s*，?为(?:君|臣|佐|使)", "缺主语：为君/臣"),
    (r"(?:^|[。；])\s*与[^，。；]{1,6}(?:合用|相配|配伍)", "缺主语：与X合用"),
    (r"(?:佐以|臣以|君以|使以)(?:助|增|加强|以)", "佐以后缺药名"),
    (r"(?:佐以|臣以|君以|使以)[，。；]", "佐以后缺药名"),
    (r"以[^，。；]{1,4}易之", "以X易之"),
    (r"[（(]\s*[)）]|[（(]代[)）]", "空括号"),
    (r"活经|活络(?=[，。；]$)|和经|通经活(?=[，。；])", "疑似字被删"),
    (r"[，；]{2,}|；，|，；|。，", "标点残留"),
]

def row(d):
    rd = (d.get("diagnose") or {}).get("structured") or {}
    rp = (d.get("prescribe") or {}).get("structured") or {}
    ov = rd.get("overview") or {}
    fm = rp.get("formula") or {}; cand = (fm.get("candidates") or [{}])[0]
    th = rd.get("therapy") or {}
    return rd, rp, ov, fm, cand, th

results = []; tot = collections.Counter(); oracle_fail = collections.defaultdict(list); gen_hits = collections.defaultdict(list)
damage = []
for f in sorted(glob.glob(O + "/*.json")):
    d = json.load(open(f)); key = d["key"]; c = cases.get(key)
    if not c: continue
    cs = c["caseState"]; or_ = c.get("oracle") or {}
    rd, rp, ov, fm, cand, th = row(d)
    stages = {k: (d.get(k) or {}).get("status") for k in ("question", "redFlags", "diagnose", "prescribe", "assess")}
    disease, primary = ov.get("tcmDiseaseName"), ov.get("primarySyndrome")
    method = th.get("overallMethod") or th.get("overallTherapy") or ""
    secs = ov.get("secondarySyndromes") or []
    western = (((rd.get("westernDiagnosis") or {}).get("primary") or {}).get("name")) or ""
    herbs = [h.get("name") for h in cand.get("herbs") or []]
    dosed = any(h.get("dose") for h in cand.get("herbs") or [])
    mods = fm.get("modifications") or []
    analysis = cand.get("formulaAnalysis") or ""
    rationale = ov.get("tcmDiagnosticRationale") or ""
    lin = rd.get("lineageAdaptation") or {}
    lens = rationale + " " + json.dumps(lin, ensure_ascii=False) if lin else rationale
    tag = f"{key}.r{d.get('run')}"
    tot["n"] += 1; tot["dosed"] += dosed; tot["limited"] += ("limited" in json.dumps(rd.get("clinicalReview") or {}) and not primary)
    # ① 判据
    O1 = []
    for p in or_.get("methodMust", []):
        tot["methodMust_all"] += 1
        if not re.search(p, method): O1.append(("method", p, method))
    for h in or_.get("modBad", []):
        tot["modBad_all"] += 1
        hit = [m for m in mods if h in str(m.get("herbName"))]
        if hit: O1.append(("modBad", h, hit[0].get("trigger")))
    if or_.get("condBad"):
        tot["condBad_all"] += 1
        hit = [m for m in mods if re.search(or_["condBad"], str(m.get("trigger"))) and "本例已见" not in str(m.get("trigger"))]
        if hit: O1.append(("condBad", or_["condBad"], [m.get("trigger") + "→" + str(m.get("herbName")) for m in hit]))
    for h in or_.get("herbBad", []):
        tot["herbBad_all"] += 1
        if any(h in str(x) for x in herbs): O1.append(("herbBad", h, herbs))
    for p in or_.get("herbMust", []):
        tot["herbMust_all"] += 1
        if not any(re.search(p, str(x)) for x in herbs): O1.append(("herbMust", p, herbs))
    if or_.get("westernMust"):
        tot["westernMust_all"] += 1
        if not re.search(or_["westernMust"], western): O1.append(("western", or_["westernMust"], western))
    if or_.get("lensBad"):
        tot["lensBad_all"] += 1
        m = re.search(or_["lensBad"], lens)
        if m: O1.append(("lensBad", m.group(0), rationale[-120:]))
    for x in O1: oracle_fail[x[0]].append((tag, c.get("title"), x[1], x[2]))
    # ② 独立读法
    G = []
    if dosed and len(mods) < 2: G.append(("mods_lt2", len(mods), f"{disease}·{primary}·{cand.get('name')}"))
    ids = collections.defaultdict(list)
    for h in herbs: ids[ident(h)].append(h)
    for k, v in ids.items():
        if len(v) > 1 and k not in ("甘草",): G.append(("herb_alias_dup", v, ""))
    table = {ident(h) for h in herbs}
    for m in mods:
        hn = str(m.get("herbName") or "")
        if str(m.get("action")) == "加" and ident(hn) in table: G.append(("mod_adds_own_herb", hn, m.get("trigger")))
    for a, b in SAME_SOURCE:
        all_h = set(herbs) | {str(m.get("herbName")) for m in mods if m.get("action") == "加"}
        if a in all_h and b in all_h: G.append(("same_source", (a, b), ""))
    rec = record_text(cs)
    for m in mods:
        tr = str(m.get("trigger") or "")
        if "本例已见" in tr: continue
        cf = cond_conflict(tr, rec)
        if cf: G.append(("cond_conflict", cf, tr + "→" + str(m.get("herbName"))))
    for m in mods:
        src = str((m.get("evidence") or {}).get("source") or "")
        mm = re.match(r"《[^》]+》([^·]+)·([^：加]+)", src)
        if mm and disease and mm.group(1) != disease and mm.group(1) not in disease and disease not in mm.group(1):
            G.append(("mod_from_other_disease", f"{mm.group(1)}·{mm.group(2)}", f"本例{disease}·{primary}：{m.get('trigger')}→{m.get('herbName')}"))
    for pat, lab in FRAG:
        for mm in re.finditer(pat, analysis):
            G.append(("analysis_fragment", lab, analysis[max(0, mm.start() - 18):mm.end() + 18]))
    miss = [h for h in herbs if h and h not in analysis and ident(h) not in {ident(x) for x in re.findall(r"[一-龥]{2,5}", analysis)}]
    if dosed and miss: G.append(("herb_unexplained", miss, ""))
    for g in G: gen_hits[g[0]].append((tag, c.get("title"), g[1], g[2]))
    # ③ 原始 vs 交付
    start, end = ts(d.get("startedAt")), ts(d.get("finishedAt"))
    tr = [x for x in trace.get(key, []) if (not start or x["t"] >= start - 1000) and (not end or x["t"] <= end + 1000)]
    raw_m04s, raw_m03s, raw_wst = [], [], []
    for x in tr:
        j = loose(x.get("content"))
        if not isinstance(j, dict): continue
        if isinstance(j.get("candidate"), dict) and j["candidate"].get("herbs") is not None: raw_m04s.append(j)
        elif isinstance(j.get("overview"), dict) and ("tcmDiseaseName" in j["overview"] or "primarySyndrome" in j["overview"]): raw_m03s.append(j)
        elif isinstance(j.get("westernDiagnosis"), dict): raw_wst.append(j)
    item = {"tag": tag, "key": key, "title": c.get("title"), "cls": c.get("cls"), "repairs": max(0, len(raw_m04s) - 1), "m03redraw": max(0, len(raw_m03s) - 1), "changes": []}
    def ch(field, a, b):
        if (a or "") != (b or ""): item["changes"].append({"field": field, "raw": a, "delivered": b})
    if raw_m03s:
        def m03_score(j):
            o = j.get("overview") or {}; t = j.get("therapy") or {}
            a = str(o.get("tcmDiagnosticRationale") or ""); r_ = difflib.SequenceMatcher(None, a[:300], rationale[:300]).ratio()
            return (o.get("primarySyndrome") == primary) + (o.get("tcmDiseaseName") == disease) + r_
        r0 = max(raw_m03s, key=m03_score); ro = r0.get("overview") or {}; rt = r0.get("therapy") or {}
        ch("病名", ro.get("tcmDiseaseName"), disease); ch("主证", ro.get("primarySyndrome"), primary)
        ch("兼证", "、".join(ro.get("secondarySyndromes") or []) if isinstance(ro.get("secondarySyndromes"), list) else ro.get("secondarySyndromes"), "、".join(secs) if isinstance(secs, list) else secs)
        ch("治法", rt.get("overallMethod"), method)
        ch("辨证依据", ro.get("tcmDiagnosticRationale"), rationale)
        ch("辨病依据", ro.get("tcmDiseaseRationale"), ov.get("tcmDiseaseRationale"))
    if raw_wst:
        wj = max(raw_wst, key=lambda j: difflib.SequenceMatcher(None, str(((j.get("westernDiagnosis") or {}).get("primary") or {}).get("name") or ""), western).ratio())
        rw = ((wj.get("westernDiagnosis") or {}).get("primary") or {}).get("name")
        ch("西医主诊断", rw, western)
    if raw_m04s:
        def m04_score(j):
            hs = {ident(h.get("name")) for h in (j.get("candidate") or {}).get("herbs") or [] if isinstance(h, dict)}; ds = {ident(x) for x in herbs}
            return len(hs & ds) / (len(hs | ds) or 1) + difflib.SequenceMatcher(None, str((j.get("candidate") or {}).get("formulaAnalysis") or "")[:200], analysis[:200]).ratio()
        r = max(raw_m04s, key=m04_score); rc = r.get("candidate") or {}
        ch("方名", rc.get("name") or rc.get("formulaName"), cand.get("name"))
        rh = [h.get("name") for h in rc.get("herbs") or [] if isinstance(h, dict)]
        rid = {ident(x) for x in rh}; did = {ident(x) for x in herbs}
        if rid != did: item["changes"].append({"field": "药味", "raw_only": sorted(rid - did), "delivered_only": sorted(did - rid)})
        ch("方义", rc.get("formulaAnalysis"), analysis)
        rm = r.get("modifications") or rc.get("modifications") or []
        def mk(m): return f"{m.get('trigger')}→{m.get('herbName') or m.get('herb')}"
        ra = [mk(m) for m in rm if isinstance(m, dict)]; da = [mk(m) for m in mods]
        drop = [x for x in ra if x.split("→")[-1] not in {y.split("→")[-1] for y in da}]
        add = [x for x in da if x.split("→")[-1] not in {y.split("→")[-1] for y in ra}]
        tot["rawMods"] += len(ra); tot["delMods"] += len(da); tot["modsDropped"] += len(drop); tot["modsAdded"] += len(add)
        if drop or add: item["changes"].append({"field": "加减", "dropped": drop, "added": add, "kept": [x for x in da if x not in add]})
    if item["changes"]: damage.append(item)
    results.append({"tag": tag, "key": key, "cls": c.get("cls"), "stages": stages, "disease": disease, "primary": primary, "secondary": secs, "method": method, "western": western, "formula": cand.get("name"), "herbs": herbs, "dosed": dosed, "mods": [str(m.get("trigger")) + "→" + str(m.get("herbName")) for m in mods], "modSource": [(m.get("evidence") or {}).get("evidenceLevel") for m in mods], "gate": (d.get("redFlags") or {}).get("gate"), "gold": or_.get("gold"), "oracle": O1, "generic": G, "ms": {k: (d.get(k) or {}).get("ms") for k in ("question", "diagnose", "prescribe")}})

print("输出", tot["n"], "有剂量", tot["dosed"], "原始加减行", tot["rawMods"], "交付加减行", tot["delMods"], "被丢", tot["modsDropped"], "被补", tot["modsAdded"])
print("状态非200:", sum(any(v not in (200, None) for v in r["stages"].values()) for r in results))
print("\n① 判据失败")
for k in ("method", "modBad", "condBad", "herbBad", "herbMust", "western", "lensBad"):
    all_k = {"method": "methodMust_all", "modBad": "modBad_all", "condBad": "condBad_all", "herbBad": "herbBad_all", "herbMust": "herbMust_all", "western": "westernMust_all", "lensBad": "lensBad_all"}[k]
    print(f"  {k}: {len(oracle_fail[k])}/{tot[all_k]}")
    for x in oracle_fail[k][:40]: print("     ", x[0], x[1], "|", x[2], "|", str(x[3])[:110])
print("\n② 独立读法命中")
for k, v in sorted(gen_hits.items(), key=lambda x: -len(x[1])):
    print(f"  {k}: {len(v)} 次 / {len({x[0] for x in v})} 份")
    for x in v[:int(os.environ.get('SHOW', '14'))]: print("     ", x[0], x[1], "|", str(x[2])[:60], "|", str(x[3])[:110])
fc = collections.Counter();
for it in damage:
    for ch_ in it["changes"]: fc[ch_["field"]] += 1
print("\n③ 原始→交付有变化的份数（共", tot["n"], "）", fc.most_common())
print("  M04 修复轮>0:", sum(i["repairs"] > 0 for i in damage), " M03 重画>0:", sum(i["m03redraw"] > 0 for i in damage))
for k in ("question", "diagnose", "prescribe"):
    v = [r["ms"][k] / 1000 for r in results if isinstance(r["ms"].get(k), (int, float))]
    if v: print(f"  {k} 中位 {st.median(v):.1f}s p90 {sorted(v)[int(len(v)*.9)-1]:.1f}s")
json.dump({"results": results, "damage": damage}, open(f"/var/tmp/r1045/audit-{NAME}.json", "w"), ensure_ascii=False, indent=0)
