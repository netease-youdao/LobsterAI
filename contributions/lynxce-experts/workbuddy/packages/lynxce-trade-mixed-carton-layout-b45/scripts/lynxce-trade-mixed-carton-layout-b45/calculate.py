#!/usr/bin/env python3
"""整数订单行余额、件数/重量双约束与已封箱锁定的装箱单草稿。"""
import argparse,json,sys,math,copy
from fractions import Fraction as F
from decimal import Decimal,localcontext
from pathlib import Path

def num(v,nullable=False):
    if v is None and nullable:return None
    if isinstance(v,bool) or not isinstance(v,(str,int,Decimal)):raise ValueError('重量须有限非负十进制数，未知null')
    try:d=Decimal(str(v))
    except Exception:raise ValueError('无效数值') from None
    if not d.is_finite() or d<0:raise ValueError('数值须非负有限')
    return F(d)
def integer(v):
    if isinstance(v,bool) or not isinstance(v,int) or v<0:raise ValueError('数量须非负整数，未知不得填0')
    return v
def txt(v):
    if not isinstance(v,str) or not v.strip():raise ValueError('代号/来源须非空字符串')
    return v
def ex(v):return None if v is None else str(v)
def show(v):
    if v is None:return '待补'
    with localcontext() as c:c.prec=40;s=format(Decimal(v.numerator)/Decimal(v.denominator),'.6f').rstrip('0').rstrip('.') or '0'
    return ('=' if F(Decimal(s))==v else '≈')+s

def _pack(d):
    if not isinstance(d,dict):raise ValueError('根须对象')
    lines=d.get('lines');rules=d.get('rules')
    if not isinstance(lines,list) or not lines or not isinstance(rules,dict):raise ValueError('lines非空列表与rules对象必需')
    cap=integer(rules['maxPieces'])
    if not 1<=cap<=1000:raise ValueError('maxPieces须1至1000')
    weightcap=num(rules.get('maxNetKg'),True);tare=num(rules.get('tareKg'),True);mix=rules.get('allowMix')
    if not isinstance(mix,bool):raise ValueError('allowMix须用户明确true/false')
    unsupported=set(rules)-{'maxPieces','maxNetKg','tareKg','allowMix','dimensions','source'}
    if unsupported:raise ValueError('尚未结构化支持的箱规须待核：'+','.join(sorted(unsupported)))
    defs={};base={}
    for z in lines:
        i=txt(z['id'])
        if i in defs:raise ValueError('订单行代号重复，不能按型号合并')
        defs[i]={'id':i,'quantity':integer(z['quantity']),'unitNetKg':num(z.get('unitNetKg'),True),'mixGroup':i if not mix else txt(z['mixGroup']) if z.get('mixGroup') is not None else '用户允许混装组','source':txt(z['source']),'model':z.get('model'),'specification':z.get('specification')};base[i]=defs[i]['quantity']
    if sum(base.values())>3000:raise ValueError('本计算器单次上限3000件，须按独立混装组拆分，不能忽略超出部分')
    dims=rules.get('dimensions');vol=None
    if dims is not None:
        if not isinstance(dims,dict) or dims.get('unit') not in ['m','cm','mm']:raise ValueError('外尺寸须对象且单位m/cm/mm')
        scale={'m':F(1),'cm':F(1,100),'mm':F(1,1000)}[dims['unit']];vol=num(dims['length'])*num(dims['width'])*num(dims['height'])*scale**3
        if vol<=0:raise ValueError('外尺寸须正值')
    fixed=d.get('fixedBoxes',[]);previous=d.get('previousPlan');scenes=d.get('quantityScenarios',[])
    if not isinstance(fixed,list) or not isinstance(scenes,list):raise ValueError('fixedBoxes与quantityScenarios须列表')
    if previous is not None and (not isinstance(previous,dict) or not isinstance(previous.get('boxes'),list) or not previous.get('source')):raise ValueError('previousPlan须来源及boxes，不以旧方案推断现场已封箱')
    scenarios=[{'label':'订单基线','source':d.get('orderSource') or '本轮各订单行来源','quantities':base}]+scenes;out=[]
    def makebox(contents,ident=None,locked=False,source=None,actualGross=None):
        if not isinstance(contents,dict):raise ValueError('箱内构成须逐订单行数量对象')
        validated={i:integer(q) for i,q in contents.items()}
        contents={i:q for i,q in validated.items() if q!=0}
        if locked and not contents:raise ValueError('已封箱商品箱构成不得为空；空包材须另行记录，不充作商品箱')
        if any(i not in defs for i in contents):raise ValueError('箱内订单行不存在')
        pieces=sum(contents.values());known=all(defs[i]['unitNetKg'] is not None for i in contents);net=sum((defs[i]['unitNetKg']*q for i,q in contents.items()),F(0)) if known else None;gross=net+tare if net is not None and tare is not None else None
        groups={defs[i]['mixGroup'] for i in contents};valid=pieces<=cap and len(groups)<=1 and (weightcap is None or net is None or net<=weightcap)
        if locked and (not source or not valid):raise ValueError('已封箱须明确来源且箱容/混装约束成立；有冲突先人工裁定')
        return {'boxId':ident,'contents':contents,'pieces':pieces,'netExactKg':ex(net),'netDisplayKg':show(net),'tareExactKg':ex(tare),'grossExactKg':ex(gross),'grossDisplayKg':show(gross),'externalVolumeExactM3':ex(vol),'knownConstraintsSatisfied':valid,'weightVerified':net is not None and weightcap is not None,'recordedState':'按用户已封箱记录保留' if locked else '编排草稿；实际装箱状态待反馈','source':source,'actualGrossExactKg':ex(actualGross),'actualMinusTheoreticalGrossKg':ex(actualGross-gross) if actualGross is not None and gross is not None else None}
    def packgroup(ids,quantities):
        total=sum(quantities[i] for i in ids)
        if not total:return [],0
        mass=sum((defs[i]['unitNetKg']*quantities[i] for i in ids),F(0)) if all(defs[i]['unitNetKg'] is not None for i in ids) else None
        lower=max(math.ceil(total/cap),math.ceil(mass/weightcap) if mass is not None and weightcap and weightcap>0 else 0)
        for k in range(max(lower,1),total+1):
            boxes=[{} for _ in range(k)]
            for i in ids:
                q=quantities[i]//k
                for b in boxes:
                    if q:b[i]=q
            if any(not makebox(b)['knownConstraintsSatisfied'] for b in boxes):continue
            good=True
            for i in ids:
                for _ in range(quantities[i]%k):
                    candidates=[]
                    for j,b in enumerate(boxes):
                        c={**b,i:b.get(i,0)+1};z=makebox(c)
                        if z['knownConstraintsSatisfied']:
                            net=F(z['netExactKg']) if z['netExactKg'] is not None else F(z['pieces']);candidates.append((net,z['pieces'],j))
                    if not candidates:good=False;break
                    j=min(candidates)[2];boxes[j][i]=boxes[j].get(i,0)+1
                if not good:break
            if good:return [b for b in boxes if b],lower
        raise ValueError('没有满足已给件数/净重约束的整数分箱')
    labels=set()
    for sc in scenarios:
        label=txt(sc['label']);src=txt(sc['source'])
        if label in labels:raise ValueError('数量情景名称重复')
        labels.add(label);qty=sc.get('quantities')
        if not isinstance(qty,dict) or set(qty)!=set(defs):raise ValueError('每数量来源情景须完整逐行数量，不从冲突表相加')
        qty={i:integer(q) for i,q in qty.items()};remain=dict(qty);boxes=[];used=set();blocked=[];groups={}
        for z in fixed:
            ident=txt(z['id'])
            if ident in used:raise ValueError('固定箱号重复')
            used.add(ident)
            if z.get('status')!='sealed':raise ValueError('固定箱只接收用户明确sealed记录，其他状态先确认')
            b=makebox(z['contents'],ident,True,txt(z['source']),num(z.get('actualGrossKg'),True))
            for i,q in b['contents'].items():remain[i]-=q
            boxes.append(b)
        if any(q<0 for q in remain.values()):
            out.append({'label':label,'source':src,'quantities':qty,'status':'新订单数量低于已封箱记录，需决定拆箱；保留原记录，暂停本分支重编','boxes':boxes,'lineBalances':[{'id':i,'ordered':qty[i],'packed':qty[i]-remain[i],'remaining':remain[i]} for i in defs],'planComplete':False,'notice':None});continue
        for i,q in remain.items():
            w=defs[i]['unitNetKg']
            if q and weightcap is not None and w is not None and w>weightcap:blocked.append({'id':i,'quantity':q,'reason':'单件净重超过内装上限，禁止拆件；需确认新箱型'});continue
            groups.setdefault(defs[i]['mixGroup'],[]).append(i)
        lower=0
        for ids in groups.values():
            packed,lb=packgroup(ids,remain);lower+=lb
            for b in packed:
                seq=1
                while 'N'+str(seq) in used:seq+=1
                ident='N'+str(seq);used.add(ident);boxes.append(makebox(b,ident))
        packed={i:sum(b['contents'].get(i,0) for b in boxes) for i in defs};balances=[{'id':i,'ordered':qty[i],'packed':packed[i],'remaining':qty[i]-packed[i],'source':defs[i]['source']} for i in defs]
        assert all(z['remaining']>=0 for z in balances)
        for i,z in enumerate(boxes):assert z['knownConstraintsSatisfied']
        complete=all(z['remaining']==0 for z in balances);net=sum((F(b['netExactKg']) for b in boxes),F(0)) if all(b['netExactKg'] is not None for b in boxes) else None;gross=sum((F(b['grossExactKg']) for b in boxes),F(0)) if all(b['grossExactKg'] is not None for b in boxes) else None;totalTare=tare*len(boxes) if tare is not None else None
        if net is not None and gross is not None:assert net+totalTare==gross
        mapping=[]
        if previous:
            for old in previous['boxes']:
                if not isinstance(old.get('contents'),dict):raise ValueError('旧箱内容须逐行数量对象')
                mapping.append({'oldBox':old['id'],'oldContents':old['contents'],'newBoxesContainingSameLines':[b['boxId'] for b in boxes if set(b['contents'])&set(old['contents'])],'meaning':'仅共享订单行的关联索引，不声称实物一对一移动；已封箱仅按fixedBoxes记录保留'})
        notice='装箱单草稿：'+label+'（来源：'+src+'），编排'+str(len(boxes))+'箱、'+str(sum(b['pieces'] for b in boxes))+'件；逐订单行余额'+('归零' if complete else '仍有不可装/待决定项')+'。净重'+show(net)+'公斤、包材'+show(totalTare)+'公斤、理论毛重'+show(gross)+'公斤。请核实箱型实容与现场状态；未反馈不推断已装箱、封箱或发运，缺重量/尺寸保留待补。'
        out.append({'label':label,'source':src,'quantities':qty,'quantityDifferenceFromBase':{i:qty[i]-base[i] for i in defs},'status':'版本未裁定，条件方案不自动采用' if len(scenarios)>1 else '装箱单草稿待确认','boxes':boxes,'lineBalances':balances,'planComplete':complete,'blockedLines':blocked,'boxCount':len(boxes),'pieces':sum(b['pieces'] for b in boxes),'netExactKg':ex(net),'tareExactKg':ex(totalTare),'grossExactKg':ex(gross),'volumeExactM3':ex(vol*len(boxes)) if vol is not None else None,'unlockedBoxLowerBound':lower,'unlockedPlannedBoxCount':len(boxes)-len(fixed),'minimumProvedForKnownConstraints':complete and not fixed and len(boxes)==lower,'lowerBoundScope':'仅已给件数/净重和硬混装组；未证明几何可装，未达到下界不称最少','previousPlanMapping':mapping,'theoreticalTareChangeFromPrevious':ex(tare*(len(boxes)-len(previous['boxes']))) if previous and tare is not None else None,'notice':{'text':notice,'characters':len(notice)}})
    return {'rules':{'maxPieces':cap,'maxNetExactKg':ex(weightcap),'tareExactKg':ex(tare),'allowMix':mix},'scenarios':out,'unknowns':[s for s,v in [('单件净重',all(z['unitNetKg'] is not None for z in defs.values())),('内装净重上限',weightcap is not None),('包材重量',tare is not None),('外尺寸',vol is not None)] if not v],'adoption':'并列数量来源未裁定不合并、不相加、不自动替代；所有新箱是未执行的条件草稿','questions':['请确认数量来源是否替代原订单，以及混装组/整箱/同色规则的优先级；未支持约束须先明示。','请补单件净重、内装净重上限与包材重；缺项仅交数量草稿，不编重量。','请给已封箱明细及来源、必要外尺寸与实测称重；现场反馈和理论方案分列。']}
def solve(d):
    # Core integer/Fraction packing is unchanged; constraint scopes and optional tare comparisons are independent.
    r=_pack(d)
    def constraints(result):
        rows=[]
        for scene in result['scenarios']:
            for box in scene['boxes']:
                net=F(box['netExactKg']) if box['netExactKg'] is not None else None
                limit=F(result['rules']['maxNetExactKg']) if result['rules']['maxNetExactKg'] is not None else None
                rows.append({'quantityScenario':scene['label'],'boxId':box['boxId'],'pieces':box['pieces'],'pieceLimit':result['rules']['maxPieces'],'pieceSlack':result['rules']['maxPieces']-box['pieces'],'netExactKg':box['netExactKg'],'maxNetExactKg':ex(limit),'netSlackExactKg':ex(limit-net) if limit is not None and net is not None else None,'netConstraintPassed':net<=limit if net is not None and limit is not None else None,'tareExactKg':box['tareExactKg'],'grossExactKg':box['grossExactKg'],'maxGrossExactKg':None,'grossConstraintPassed':None,'scope':'内装净重上限只比商品净重；毛重上限未提供，不能拿净重上限判毛重超限'})
        return rows
    r['constraintChecks']=constraints(r)
    r['constraintScope']={'net':'商品净重由箱内逐行数量乘单件净重求和；与maxNetKg比较','gross':'理论毛重=商品净重+包材；本接口不接受毛重上限，若有该限制须另行确认而不能套用净重上限','sensitivity':'仅允许引用本次结构化结果与明确比较情景；没有实算变更不写任何变化都会超限等全称结论'}
    comparisons=d.get('comparisonScenarios',[])
    if not isinstance(comparisons,list) or len(comparisons)>8:raise ValueError('comparisonScenarios须列表且最多8项')
    r['comparisons']=[];seen=set()
    for c in comparisons:
        if not isinstance(c,dict) or set(c)-{'label','source','overrides'}:raise ValueError('比较情景只接收label/source/overrides')
        label=txt(c['label']);source=txt(c['source']);overrides=c['overrides']
        if label in seen:raise ValueError('比较情景名称重复')
        seen.add(label)
        if not isinstance(overrides,dict) or set(overrides)!={'tareKg'}:raise ValueError('当前敏感性比较只支持显式仅改tareKg；其它变更须另建完整输入重新计算，不隐式套用')
        num(overrides['tareKg'],True)
        changed=copy.deepcopy(d);changed.pop('comparisonScenarios',None);changed['rules']['tareKg']=overrides['tareKg'];after=_pack(changed);rows=[]
        for beforeScene,afterScene in zip(r['scenarios'],after['scenarios']):
            assert beforeScene['quantities']==afterScene['quantities']
            assert [b['contents'] for b in beforeScene['boxes']]==[b['contents'] for b in afterScene['boxes']]
            for before,now in zip(beforeScene['boxes'],afterScene['boxes']):
                delta=F(now['grossExactKg'])-F(before['grossExactKg']) if now['grossExactKg'] is not None and before['grossExactKg'] is not None else None
                rows.append({'quantityScenario':beforeScene['label'],'boxId':before['boxId'],'contentsUnchanged':True,'netBeforeExactKg':before['netExactKg'],'netAfterExactKg':now['netExactKg'],'netDeltaExactKg':'0' if now['netExactKg'] is not None else None,'tareBeforeExactKg':before['tareExactKg'],'tareAfterExactKg':now['tareExactKg'],'grossBeforeExactKg':before['grossExactKg'],'grossAfterExactKg':now['grossExactKg'],'grossDeltaExactKg':ex(delta),'netConstraintBefore':next(x['netConstraintPassed'] for x in r['constraintChecks'] if x['quantityScenario']==beforeScene['label'] and x['boxId']==before['boxId']),'netConstraintAfter':next(x['netConstraintPassed'] for x in constraints(after) if x['quantityScenario']==afterScene['label'] and x['boxId']==now['boxId']),'grossConstraintAfter':None,'conclusion':'仅改包材不改变内装净重或净重约束；毛重另变或未知，未给毛重上限不判毛重超限'})
        r['comparisons'].append({'label':label,'source':source,'changedFields':['rules.tareKg'],'scope':'用户明确给定的单变量条件比较，未替代基线或执行','results':after,'constraintChecks':constraints(after),'boxComparisons':rows})
    return r

def cell(v):return ('待补' if v is None else str(v)).replace('|','&#124;').replace('\n','<br>').replace('\r','')
def table(headers,rows):return ['', '|'+'|'.join(headers)+'|','|'+'|'.join('---' for _ in headers)+'|']+['|'+'|'.join(cell(v) for v in z)+'|' for z in rows]+['']
def render_plan(r):
    out=['装箱单草稿；精确分数与显示近似分列；'+r['adoption'],'缺项：'+str(r['unknowns'])]
    for s in r['scenarios']:
        out+=['情景：'+s['label']+'；来源：'+s['source']+'；'+s['status']]
        out+=table(['箱号','逐行数量','件数','净重精确kg','净重显示kg','包材精确kg','毛重精确kg','毛重显示kg','单箱外体积m³','重量已核','状态','实测毛重kg','实测减理论kg'],[[z[k] for k in ['boxId','contents','pieces','netExactKg','netDisplayKg','tareExactKg','grossExactKg','grossDisplayKg','externalVolumeExactM3','weightVerified','recordedState','actualGrossExactKg','actualMinusTheoreticalGrossKg']] for z in s['boxes']])
        out+=table(['订单行','订单数量','本方案装箱数','余额'],[[z[k] for k in ['id','ordered','packed','remaining']] for z in s['lineBalances']])
        if s.get('boxCount') is not None:out+=['数量来源差异：'+json.dumps(s['quantityDifferenceFromBase'],ensure_ascii=False),'箱数'+str(s['boxCount'])+'；商品净重'+str(s['netExactKg'])+'kg；包材'+str(s['tareExactKg'])+'kg；理论毛重'+str(s['grossExactKg'])+'kg；总体积'+str(s['volumeExactM3'])+'m³（null为待补）','未锁定部分箱数下界'+str(s['unlockedBoxLowerBound'])+'；已编'+str(s['unlockedPlannedBoxCount'])+'；达到已知约束下界证明：'+str(s['minimumProvedForKnownConstraints'])+'；'+s['lowerBoundScope'],'不可装订单行：'+json.dumps(s['blockedLines'],ensure_ascii=False),'旧新版关联：'+json.dumps(s['previousPlanMapping'],ensure_ascii=False)+'；理论包材变化kg：'+str(s['theoreticalTareChangeFromPrevious'])]
        if s.get('notice'):out+=[s['notice']['text'],'全文字符数：'+str(s['notice']['characters'])]
    return '\n'.join(out)+'\n'
def render(r):
    out=[render_plan(r),'## 件数、内装净重与毛重约束分开核验','']
    out+=table(['数量情景','箱号','件数','件数上限','件数余量','净重kg','净重上限kg','净重余量kg','净重约束','包材kg','理论毛重kg','毛重上限kg','毛重约束','口径'],[[z[k] for k in ['quantityScenario','boxId','pieces','pieceLimit','pieceSlack','netExactKg','maxNetExactKg','netSlackExactKg','netConstraintPassed','tareExactKg','grossExactKg','maxGrossExactKg','grossConstraintPassed','scope']] for z in r['constraintChecks']])
    out+=['敏感性结论范围：'+r['constraintScope']['sensitivity'],'净重口径：'+r['constraintScope']['net'],'毛重口径：'+r['constraintScope']['gross'],'']
    for c in r['comparisons']:
        out+=['## 包材单变量比较：'+c['label'],'来源：'+c['source']+'；'+c['scope'],'']
        out+=table(['数量情景','箱号','构成未变','旧净重kg','新净重kg','净重差kg','旧包材kg','新包材kg','旧毛重kg','新毛重kg','毛重差kg','旧净重约束','新净重约束','新毛重约束','本次比较结论'],[[z[k] for k in ['quantityScenario','boxId','contentsUnchanged','netBeforeExactKg','netAfterExactKg','netDeltaExactKg','tareBeforeExactKg','tareAfterExactKg','grossBeforeExactKg','grossAfterExactKg','grossDeltaExactKg','netConstraintBefore','netConstraintAfter','grossConstraintAfter','conclusion']] for z in c['boxComparisons']])
        out+=[render_plan(c['results'])]
    out+=r['questions']
    return '\n'.join(out)+'\n'
def main():
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:r=solve(json.loads(Path(a.input).read_text(),parse_float=Decimal));print(json.dumps(r,ensure_ascii=False,indent=2) if a.format=='json' else render(r));return 0
    except (ValueError,TypeError,KeyError,AttributeError,ArithmeticError,OSError) as e:print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':raise SystemExit(main())
