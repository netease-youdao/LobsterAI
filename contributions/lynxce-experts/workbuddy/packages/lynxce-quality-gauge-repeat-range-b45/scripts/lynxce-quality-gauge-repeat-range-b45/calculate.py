#!/usr/bin/env python3
"""按条件、样件、实际重复次数计算描述统计；不生成校准或GRR结论。"""
import argparse,json,sys,hashlib,re
from fractions import Fraction as F
from decimal import Decimal,localcontext
from pathlib import Path

UNITS={'mm':F(1),'cm':F(10),'um':F(1,1000),'in':F(127,5)}
def num(v):
    if isinstance(v,bool) or not isinstance(v,(str,int,Decimal)):raise ValueError('读数须有限十进制数或null，不接受布尔值')
    try:d=Decimal(str(v))
    except Exception:raise ValueError('数值无效') from None
    if not d.is_finite():raise ValueError('数值须有限')
    return F(d)
def txt(v):
    if not isinstance(v,str) or not v.strip():raise ValueError('代号与来源须非空文字')
    return v
def value(v,unit):
    if v is None:return None
    if unit is None:return None
    if unit not in UNITS:raise ValueError('单位须mm/cm/um/in；未知行保留null读数')
    return num(v)*UNITS[unit]
def exact(v):return None if v is None else str(v)
def shown(v):
    if v is None:return '待补/不适用'
    with localcontext() as c:
        c.prec=40;s=format(Decimal(v.numerator)/Decimal(v.denominator),'.6f').rstrip('0').rstrip('.')
    s=s or '0';return ('=' if F(Decimal(s))==v else '≈')+s

def _statistics(d):
    if not isinstance(d,dict):raise ValueError('根须对象')
    groups=d.get('groups')
    if not isinstance(groups,list) or not groups:raise ValueError('groups须非空列表')
    corrections=d.get('corrections',[])
    if not isinstance(corrections,list):raise ValueError('corrections须列表')
    tolerance=d.get('tolerance');width=None;twarn='公差尺度待补，比例不计算'
    if tolerance is not None:
        if not isinstance(tolerance,dict):raise ValueError('tolerance须对象或null')
        unit=tolerance.get('unit');w=value(tolerance.get('width'),unit);lo=value(tolerance.get('lower'),unit);hi=value(tolerance.get('upper'),unit)
        if lo is not None and hi is not None:
            derived=hi-lo
            if w is not None and w!=derived:twarn='公差宽与上下限冲突，比例暂停'
            else:w=derived;twarn=''
        else:twarn=''
        if not twarn and w is not None and w>0:width=w;twarn='仅用户给定公差尺度，不作接受判定；来源：'+str(tolerance.get('source') or '待补')
        elif not twarn:twarn='公差宽缺失、非正或上下限倒置，比例暂停'
    ref=d.get('references',[])
    if not isinstance(ref,list):raise ValueError('references须列表')
    reference={}
    for z in ref:
        key=txt(z['partId'])
        if key in reference:raise ValueError('参考值重复，须先裁定生效来源')
        reference[key]=value(z.get('value'),z.get('unit')) if z.get('traceable') is True and z.get('source') else None
    output=[];summaries=[];rawrows=[];conflicts=[];changes=[];retest=[];seen=set()
    for g in groups:
        gid=txt(g['id'])
        if gid in seen:raise ValueError('条件组代号重复')
        seen.add(gid)
        if g.get('conditionsComparable') is not None and not isinstance(g.get('conditionsComparable'),bool):raise ValueError('conditionsComparable须true/false/null')
        records=g.get('readings')
        if not isinstance(records,list):raise ValueError('readings须列表，缺读数可空列表')
        keyed={}
        for z in records:
            part=txt(z['partId']);trial=txt(z['trialId']);src=txt(z['source']);v=value(z.get('value'),z.get('unit'));key=(part,trial)
            keyed.setdefault(key,[]).append({'value':v,'source':src,'original':z.get('value'),'unit':z.get('unit')})
        for c in corrections:
            if c.get('groupId')!=gid:continue
            key=(txt(c['partId']),txt(c['trialId']))
            if c.get('confirmedReplacement') is not True or not c.get('source'):raise ValueError('修订须明确confirmedReplacement与新来源')
            if key not in keyed:raise ValueError('更正定位不存在，不得静默当新增读数')
            old=keyed[key];nv=value(c.get('value'),c.get('unit'));keyed[key]=[{'value':nv,'source':txt(c['source']),'original':c.get('value'),'unit':c.get('unit')}];changes.append({'group':gid,'part':key[0],'trial':key[1],'oldValues':[exact(v['value']) for v in old],'newValueMm':exact(nv),'source':c['source']})
        parts=sorted({k[0] for k in keyed});layer={}
        for part in parts:
            values=[];bad=False;missing=False
            for (pid,trial),versions in sorted(keyed.items()):
                if pid!=part:continue
                distinct={v['value'] for v in versions}
                for v in versions:rawrows.append({'group':gid,'part':part,'trial':trial,'original':v['original'],'unit':v['unit'],'mmExact':exact(v['value']),'source':v['source']})
                if len(distinct)>1:bad=True;conflicts.append({'group':gid,'part':part,'trial':trial,'versions':[{'valueMm':exact(v['value']),'source':v['source']} for v in versions]});continue
                v=versions[0]['value']
                if v is None:missing=True
                else:values.append(v)
            n=len(values);valid=not bad and not missing;mean=sum(values,F(0))/n if valid and n else None;rg=max(values)-min(values) if valid and n>=2 else None
            row={'group':gid,'part':part,'operator':g.get('operator'),'gauge':g.get('gauge'),'method':g.get('method'),'condition':g.get('condition'),'nRecorded':len([k for k in keyed if k[0]==part]),'nUsable':n,'minimumMm':exact(min(values)) if valid and n else None,'maximumMm':exact(max(values)) if valid and n else None,'meanExactMm':exact(mean),'meanDisplayMm':shown(mean),'rangeExactMm':exact(rg),'rangeDisplayMm':shown(rg),'rangeToleranceRatioExact':exact(rg/width) if rg is not None and width else None,'rangeTolerancePercentDisplay':shown(rg/width*100)+'%' if rg is not None and width else '待补/不适用','biasExactMm':exact(mean-reference[part]) if mean is not None and reference.get(part) is not None else None,'status':'原始冲突，整样件本条件组统计暂停' if bad else '读数缺失，本组统计待补' if missing else '仅一次，无重复性信息' if n==1 else '描述性统计'}
            output.append(row)
            if rg is not None and g.get('conditionsComparable') is True:layer.setdefault(n,[]).append(rg)
            count=d.get('plannedRepeatCount',3)
            if isinstance(count,bool) or not isinstance(count,int) or not 2<=count<=30:raise ValueError('plannedRepeatCount须2至30整数')
            for t in range(1,count+1):retest.append({'group':gid,'part':part,'plannedTrial':t,'operator':g.get('operator'),'gauge':g.get('gauge'),'method':g.get('method'),'reading':None,'note':'复测设计草案，次数'+('用户给定' if 'plannedRepeatCount' in d else '假设3次待批准')+'；按轮次交错样件顺序，未实施'})
        for n,rs in layer.items():
            avg=sum(rs,F(0))/len(rs);mx=max(rs);summaries.append({'group':gid,'repeatCount':n,'partCount':len(rs),'averageRangeExactMm':exact(avg),'averageRangeDisplayMm':shown(avg),'maximumRangeExactMm':exact(mx),'averageRangeRatioExact':exact(avg/width) if width else None,'averageRangePercentDisplay':shown(avg/width*100)+'%' if width else '待补','maximumRangePercentDisplay':shown(mx/width*100)+'%' if width else '待补'})
    for c in corrections:
        if c.get('groupId') not in seen:raise ValueError('更正条件组不存在')
    retest.sort(key=lambda x:(x['group'],x['plannedTrial'],x['part']))
    for i,z in enumerate(retest,1):z['proposedOrder']=i
    report='重复测量描述草稿：'+str(len(output))+'个样件条件组、'+str(len(conflicts))+'处原始记录冲突。逐件极差仅描述记录尺度波动，零极差不等于绝对无误差；不把样件间范围当重复性。公差比只作尺度比较，不输出GRR、校准、合格或设备补偿。复测表为待批准的设计，执行结果仅据用户新记录重算。'
    return {'conditionGroups':[{k:g.get(k) for k in ['id','operator','gauge','method','condition','conditionsComparable']} for g in groups],'unit':'mm','rows':output,'summaries':summaries,'rawReadings':rawrows,'conflicts':conflicts,'changes':changes,'toleranceWidthExactMm':exact(width),'toleranceStatus':twarn,'retestDraft':retest,'report':{'text':report,'characters':len(report)},'questions':['请补或确认每组同人、量具、方法与条件可比较性；不明时不合并平均极差。','如需公差尺度比，请给宽度或上下限及单位、来源；如需偏差，另给可追溯参考值。','请裁定冲突读数的生效来源，并确认复测次数、顺序与实际执行反馈。']}

def cell(v):return ('待补' if v is None else str(v)).replace('|','&#124;').replace('\r','').replace('\n','<br>')
def table(headers,rows):return ['|'+'|'.join(headers)+'|','|'+'|'.join('---' for _ in headers)+'|']+['|'+'|'.join(cell(v) for v in r)+'|' for r in rows]+['']
def render_statistics(r):
    out=['重复测量描述报告草案；单位毫米。精确分数与六位显示分列，≈不是精确等号。',r['toleranceStatus']]
    out+=table(['条件组','操作者','量具','方法','设置','已确认可比较'],[[g[k] for k in ['id','operator','gauge','method','condition','conditionsComparable']] for g in r['conditionGroups']])
    out+=table(['条件组','样件','实际有效次数','最小精确','最大精确','均值精确','均值显示','极差精确','极差显示','极差/公差显示','偏差精确','状态'],[[z[k] for k in ['group','part','nUsable','minimumMm','maximumMm','meanExactMm','meanDisplayMm','rangeExactMm','rangeDisplayMm','rangeTolerancePercentDisplay','biasExactMm','status']] for z in r['rows']])
    out+=table(['条件组','同件次数','样件数','平均极差精确','平均极差显示','最大极差精确','平均极差/公差显示','最大极差/公差显示'],[[z[k] for k in ['group','repeatCount','partCount','averageRangeExactMm','averageRangeDisplayMm','maximumRangeExactMm','averageRangePercentDisplay','maximumRangePercentDisplay']] for z in r['summaries']])
    out+=table(['条件组','样件','次序','原读数','原单位','毫米精确','来源'],[[z[k] for k in ['group','part','trial','original','unit','mmExact','source']] for z in r['rawReadings']])
    out+=['原始冲突并列：'+json.dumps(r['conflicts'],ensure_ascii=False),'用户确认修订：'+json.dumps(r['changes'],ensure_ascii=False),r['report']['text'],'全文字符数：'+str(r['report']['characters']),'复测记录设计（未实施）：']
    out+=table(['建议顺序','组','样件','计划次序','操作者','量具','方法','读数','状态'],[[z[k] for k in ['proposedOrder','group','part','plannedTrial','operator','gauge','method','reading','note']] for z in r['retestDraft']]);out+=r['questions'];return '\n'.join(out)+'\n'
def original_contexts(raw,quote):
    if raw is None or not isinstance(quote,str) or not quote.strip():return []
    norm=lambda v:''.join(v.split())
    src=norm(raw);needle=norm(quote);separators='。；;！？!?，,：:';out=[];start=0
    while True:
        pos=src.find(needle,start)
        if pos<0:break
        left=max([src.rfind(c,0,pos) for c in separators]+[-1])+1;ends=[src.find(c,pos+len(needle)) for c in separators];ends=[v for v in ends if v>=0];right=min(ends) if ends else len(src)
        out.append(src[left:right]);start=pos+1
    return out


def solve(d,source_text=None,source_file=None):
    result=_statistics(d)
    if source_text is not None and '## 本轮用户请求' in source_text:
        source_text=source_text.split('## 本轮用户请求',1)[1].split('## 本轮包与交付路径',1)[0]
    context=d.get('objectContext',{})
    if not isinstance(context,dict) or set(context)-{'objectType','measurementPosition','scenario','model'}:raise ValueError('objectContext仅支持对象/部位/场景/型号四字段')
    normalized=lambda x:''.join(x.split())
    actual=[];assumptions=[];rejected=[]
    for field,title in [('objectType','测量对象'),('measurementPosition','测量部位'),('scenario','使用场景'),('model','型号')]:
        claim=context.get(field);row={'field':field,'title':title,'value':None,'status':'未提供','quote':None}
        if claim is not None:
            if not isinstance(claim,dict) or not isinstance(claim.get('value'),str) or not claim['value'].strip():raise ValueError('对象声明须value/sourceKind/quote结构，缺项保持null')
            value=claim['value'];kind=claim.get('sourceKind');quote=claim.get('quote')
            if kind=='assumption':
                assumptions.append({'field':field,'title':title,'value':value,'status':'独立设计假设，非原文给定，不改变统计对象事实','reason':claim.get('reason') or '用途须用户确认'})
            elif kind=='original':
                ok=source_text is not None and isinstance(quote,str) and bool(quote.strip()) and normalized(quote) in normalized(source_text) and normalized(value) in normalized(quote)
                contexts=original_contexts(source_text,quote) if ok else []
                if ok and any(re.search(r'(不是|并非|不属于|未提供|没有|不为|不在|未在|无).{0,12}'+re.escape(normalized(value)),context) for context in contexts):ok=False
                if ok and any(any(w in context for w in ('是否','待确认','可能','据说','假定','假设','未确认','不确定','尚未确认')) for context in contexts):ok=False
                if ok:row.update(value=value,status='原请求文件原句及完整命中上下文支持；仅引用该字段，不推其它性质',quote='；'.join(contexts))
                else:rejected.append({'field':field,'claimedValue':value,'claimedQuote':quote,'status':'不采纳为原文事实，缺真实原请求原句或值不在原句中'})
            else:raise ValueError('sourceKind须original/assumption；其它来源不得标原文')
        actual.append(row)
    result['objectFacts']=actual;result['designAssumptions']=assumptions;result['rejectedObjectClaims']=rejected
    result['sourceBinding']={'sourceFile':source_file,'requestSectionSha256':hashlib.sha256(source_text.encode()).hexdigest() if source_text is not None else None,'status':'只据明确传入的原请求文件所含原句核字段；原文件真实性仍由本轮资料来源负责' if source_text is not None else '未接入原请求文件，任何原文对象声明均不确认为事实'}
    result['scope']='仅按本轮记录做重复测量描述统计；对象、部位、场景与型号只按objectFacts所列原句，未提供保持未提供。条件组标签是计算分组参数，不据行业猜填测量对象；不作校准、GRR、合格或实际执行认定。'
    result['ignoredFreeScope']=d.get('scope') is not None or d.get('sourceText') is not None
    return result


def render(r):
    out=['# 本轮对象与来源（缺项保持未提供）',r['scope'],'原请求绑定：'+json.dumps(r['sourceBinding'],ensure_ascii=False)]
    out+=table(['字段','本轮原文支持值','来源状态','可指回原句'],[[x['title'],x['value'] if x['value'] is not None else '未提供',x['status'],x['quote']] for x in r['objectFacts']])
    if r['rejectedObjectClaims']:out.append('对象来源核验未采用字段：'+','.join(x['field'] for x in r['rejectedObjectClaims'])+'；缺原句不能标原文给定，保留未提供。')
    if r['designAssumptions']:
        out+=['独立设计建议（不是原文对象事实，不与统计表合并）：']+table(['字段','设计假设','性质','用途'],[[x['title'],x['value'],x['status'],x['reason']] for x in r['designAssumptions']])
    out+=['以下操作者、量具、方法与条件文字按输入分组标签展示；若原请求未给具体身份/型号，仅属建模代号，不能据此补对象或场景。',render_statistics(r)]
    return '\n'.join(out)+'\n'


def main():
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');p.add_argument('--source-file',help='本轮真实原请求文件，优先实际blind.md；不得使用自建数据JSON冒充原文');a=p.parse_args()
    try:r=solve(json.loads(Path(a.input).read_text(),parse_float=Decimal),Path(a.source_file).read_text() if a.source_file else None,str(Path(a.source_file).resolve()) if a.source_file else None);print(json.dumps(r,ensure_ascii=False,indent=2) if a.format=='json' else render(r));return 0
    except (ValueError,TypeError,KeyError,AttributeError,ArithmeticError,OSError) as e:print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False));return 2
if __name__=='__main__':raise SystemExit(main())
