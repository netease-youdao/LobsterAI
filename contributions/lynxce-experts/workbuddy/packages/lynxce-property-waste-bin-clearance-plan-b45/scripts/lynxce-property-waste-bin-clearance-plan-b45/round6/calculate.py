#!/usr/bin/env python3
"""Finite single-point full-clear plans; exact liters and no invented inflow split."""
import argparse
import itertools
import json
import sys
from datetime import date
from decimal import Decimal,InvalidOperation
from fractions import Fraction
from pathlib import Path


def number(v,field):
    if isinstance(v,bool) or not isinstance(v,(int,str,Decimal)):
        raise ValueError(field+'须非负数，未知不得填0')
    try:d=Decimal(str(v))
    except InvalidOperation:raise ValueError(field+'无效') from None
    if not d.is_finite() or d<0:raise ValueError(field+'须非负有限数')
    return Fraction(d)


def metric(v):
    return str(v.numerator) if v.denominator==1 else str(v)


def minute(v):
    if not isinstance(v,str) or len(v)!=5 or v[2]!=':':raise ValueError('时刻须同日HH:MM')
    h,m=map(int,v.split(':'))
    if not 0<=h<24 or not 0<=m<60:raise ValueError('时刻越界')
    return h*60+m


def hh(v):return f'{v//60:02}:{v%60:02}'


def fieldtext(v,default):
    if v is None:return default
    if not isinstance(v,str):raise ValueError('来源、标签、类别与执行回执须文字或null')
    return v or default


def calculate(data):
    if not isinstance(data,dict):raise ValueError('根须对象')
    if not isinstance(data.get('point'),str) or not data['point']:raise ValueError('point须非空代号')
    if data.get('date') is not None:
        if not isinstance(data['date'],str) or len(data['date'])!=10:raise ValueError('date须YYYY-MM-DD字符串或null')
        date.fromisoformat(data['date'])
    initial=number(data.get('initialL'),'initialL');segs=data.get('segments');scenes=data.get('scenarios')
    if not isinstance(segs,list) or not segs or not isinstance(scenes,list) or not scenes:raise ValueError('分段与容量情境须非空')
    parsed=[]
    for seg in segs:
        a,b=minute(seg.get('start')),minute(seg.get('end'));q=number(seg.get('addedL'),'addedL')
        if a>=b or (parsed and a!=parsed[-1][1]):raise ValueError('分段须同日首尾相接且结束晚于开始')
        parsed.append((a,b,q))
    windows=data.get('clearWindows')
    if not isinstance(windows,list) or len(windows)>12:raise ValueError('clearWindows须明确列表，最多12个；未知不能猜清运')
    ends={b for a,b,q in parsed};win=sorted(set(minute(w) for w in windows))
    if any(w not in ends for w in win):raise ValueError('清运窗口位于段中须先按原始新增量细分，不平均分摊')
    required=data.get('closingClearRequired')
    if not isinstance(required,bool):raise ValueError('closingClearRequired须明确true/false')
    duration=data.get('clearDurationMinutes');availability=data.get('crewAvailableWindows');crew_busy=data.get('crewBusyIntervals')
    staffing_known=duration is not None and availability is not None and crew_busy is not None
    if duration is not None and (isinstance(duration,bool) or not isinstance(duration,int) or duration<=0):raise ValueError('作业分钟须正整数或null')
    def ivs(value):
        if not isinstance(value,list):raise ValueError('班组窗口须列表')
        result=[]
        for x in value:
            a,b=minute(x.get('start')),minute(x.get('end'))
            if a>=b:raise ValueError('班组区间无效')
            result.append((a,b))
        return result
    available=ivs(availability) if availability is not None else []
    occupied=ivs(crew_busy) if crew_busy is not None else []
    plans=[set(c) for n in range(len(win)+1) for c in itertools.combinations(win,n)]
    def assess(bins,clear):
        balance=initial;rows=[];removed=Fraction(0);safe=True
        for start,end,add in parsed:
            before=balance+add
            cap_start=sum((v for at,v in bins if at<=start),Fraction(0))
            cap_end=sum((v for at,v in bins if at<=end),Fraction(0))
            changes=any(start<at<=end for at,v in bins)
            status=False if balance>cap_start else True if before<=cap_start else None if changes and before<=cap_end else False
            if status is False:safe=False
            elif status is None and safe is True:safe=None
            # Necessary lower bound on extra removals BEFORE the segment-end clear.
            # Later capacity can lower the unavoidable end excess, but does not prove
            # that an earlier overflow was avoided without an observed inflow split.
            opening_excess=max(balance-cap_start,Fraction(0))
            end_excess=max(before-cap_end,Fraction(0))
            lower_bound=max(opening_excess,end_excess)
            take=before if end in clear else Fraction(0);after=before-take
            rows.append(dict(start=hh(start),end=hh(end),openingL=metric(balance),addedL=metric(add),beforeL=metric(before),capacityBeforeNewBinsL=metric(cap_start),capacityAtEndL=metric(cap_end),capacityChangeInsideSegment=changes,capacityFeasible=status,openingExcessL=metric(opening_excess),segmentEndExcessL=metric(end_excess),necessaryExtraRemovalL=metric(lower_bound),necessaryAdditionalRemovalLowerBoundL=metric(lower_bound),clearL=metric(take),afterL=metric(after)))
            removed+=take;balance=after
        if required and (parsed[-1][1] not in clear or balance!=0):safe=False
        staffing=True if staffing_known else None
        job_intervals=[]
        if staffing_known:
            for end in sorted(clear):
                start=end-duration
                fit=any(a<=start and end<=b for a,b in available) and not any(start<b and a<end for a,b in occupied+job_intervals)
                if not fit:staffing=False
                job_intervals.append((start,end))
        assert initial+sum((q for a,b,q in parsed),Fraction(0))-removed==balance
        return dict(clearTimes=[hh(x) for x in sorted(clear)],clearCount=len(clear),capacityFeasible=safe,staffingFeasible=staffing,rows=rows,peakL=metric(max(Fraction(r['beforeL']) for r in rows)),totalAddedL=metric(sum((q for a,b,q in parsed),Fraction(0))),totalClearedL=metric(removed),endingL=metric(balance),crewJobs=[{'start':hh(a),'end':hh(b)} for a,b in job_intervals])
    results=[]
    for scene in scenes:
        bins=scene.get('bins')
        if not isinstance(bins,list):raise ValueError('bins须明确列表，零桶用[]，未知不能伪造')
        parsed_bins=[];seen=set()
        for b in bins:
            ident=b.get('id')
            if not isinstance(ident,str) or not ident or ident in seen:raise ValueError('桶代号须唯一')
            seen.add(ident);nominal=number(b.get('nominalL'),'nominalL');ratio=number(b.get('usableRatio'),'usableRatio')
            if ratio<=0 or ratio>1:raise ValueError('usableRatio须大于0且不大于1；零桶用空列表，不以0比例遮盖输入错误')
            parsed_bins.append((minute(b.get('activeFrom')),nominal*ratio))
        alternatives=[assess(parsed_bins,c) for c in plans]
        feasible=[x for x in alternatives if x['capacityFeasible'] is True and x['staffingFeasible'] is not False]
        # Explicit draft tie rule: least trips, then least end residue, then time.
        selected=min(feasible,key=lambda p:(p['clearCount'],Fraction(p['endingL']),p['clearTimes'])) if feasible else None
        diagnostic=assess(parsed_bins,set(win))
        necessary=[]
        for row in diagnostic['rows']:
            bound=Fraction(row['necessaryAdditionalRemovalLowerBoundL'])
            if bound<=0:continue
            end_clear=row['end'] in diagnostic['clearTimes']
            timing=('若保留'+row['end']+'全清，额外清除必须在该次全清之前完成；' if end_clear else '额外清除必须在该受限段结束前完成；')
            explanation=(row['start']+'—'+row['end']+'受限段：清前'+row['openingL']+'+'+row['addedL']+'='+row['beforeL']+'升；'
                +'段初/段末容量'+row['capacityBeforeNewBinsL']+'/'+row['capacityAtEndL']+'升；'
                +'段初超额max('+row['openingL']+'−'+row['capacityBeforeNewBinsL']+',0)='+row['openingExcessL']+'升，'
                +'段末超额max('+row['beforeL']+'−'+row['capacityAtEndL']+',0)='+row['segmentEndExcessL']+'升；'
                +'额外清除累计C的必要下界C≥'+str(bound)+'升，回代max('+row['openingExcessL']+','+row['segmentEndExcessL']+')='+str(bound)+'升。'+timing
                +'这仅是必要条件，不保证充分或存在可行全清时点。单次只许全清时，C须来自该实际时点已有量；段内新增分布未知，不能任取最小升数或杜撰时刻。'
                +('期初已超容，必须先处理当前异常，未来动作不能补成此前未超。' if Fraction(row['openingExcessL'])>0 else '')
                +('段中增桶生效前后的分布未知，不能用段末容量追溯覆盖此前。' if row['capacityChangeInsideSegment'] else ''))
            necessary.append(dict(start=row['start'],end=row['end'],openingL=row['openingL'],addedL=row['addedL'],beforeL=row['beforeL'],capacityAtStartL=row['capacityBeforeNewBinsL'],capacityAtEndL=row['capacityAtEndL'],openingExcessL=row['openingExcessL'],segmentEndExcessL=row['segmentEndExcessL'],necessaryAdditionalRemovalLowerBoundL=str(bound),preservedEndClear=row['end'] if end_clear else None,basisClearTimes=diagnostic['clearTimes'],necessaryOnly=True,sufficient=False,text=explanation))
        notices=[]
        if selected:
            for row in selected['rows']:
                if row['end'] in selected['clearTimes']:
                    text=f"{data['point']}点清运草案：拟{row['end']}完成本次全清，清前预计{row['beforeL']}升、清后目标{row['afterL']}升；请回报{row['end']}清前实测升数。班组时段及桶型须确认后采用，实际清运状态待反馈。"
                    notices.append(dict(text=text,characters=len(text)))
        else:
            text=f"{data['point']}点当前没有经容量条件核验的完整清运方案；请确认桶型、段内新增分布及新增窗口或容器，勿采用任一未定分支的完整排程。请回报首个受限段清前实测升数；实际执行状态待反馈。"
            if necessary:text+=' '+necessary[0]['text']+' 各来源未裁定，不得采用任一未定大容量分支。'
            notices.append(dict(text=text,characters=len(text)))
        results.append(dict(label=fieldtext(scene.get('label'),'来源情境待补'),source=fieldtext(scene.get('source'),'来源待补'),selected=selected,diagnosticAllAllowedClears=diagnostic,necessaryRemovalConditions=necessary,notices=notices,alternatives=alternatives))
    joint=[]
    for i,plan in enumerate(plans):
        if all(s['alternatives'][i]['capacityFeasible'] is True and s['alternatives'][i]['staffingFeasible'] is not False for s in results):joint.append([hh(w) for w in sorted(plan)])
    return dict(point=data['point'],date=data.get('date') or '日期待补；仅同日演算',categoryConfirmation=fieldtext(data.get('categoryConfirmation'),'类别确认记录未提供；只作给定体积容量草案，不代判类别'),actualExecutionStatus=fieldtext(data.get('actualExecutionStatus'),'待反馈，缺回执不代表未开始或已完成'),staffingInputsComplete=staffing_known,scenarios=results,jointCompletePlans=joint,adoption='各来源未裁定前不自动采用共同部分；下列全案仍须用户确认，joint列表仅是共同容量约束的数学结果')


def render(r):
    out=[r['point']+'点容量/清运草案；'+r['date'],r['categoryConfirmation'],'实际执行：'+r['actualExecutionStatus'],r['adoption']]
    for s in r['scenarios']:
        p=s['selected'] or s['diagnosticAllAllowedClears'];out+=['\n情境：'+s['label']+'；来源：'+s['source'],'|时段|期初升|新增升|清前升|本段原容量升|段末容量升|容量可行|清走升|清后升|','|---|---:|---:|---:|---:|---:|---|---:|---:|']
        for row in p['rows']:
            out.append('|'+row['start']+'—'+row['end']+'|'+ '|'.join(str(row[k]) if row[k] is not None else '分布未知，不能保证' for k in ['openingL','addedL','beforeL','capacityBeforeNewBinsL','capacityAtEndL','capacityFeasible','clearL','afterL'])+'|')
        out.append('')
        out.append('容量候选：'+('、'.join(p['clearTimes'])+'；峰值'+p['peakL']+'升，末余'+p['endingL']+'升' if s['selected'] else '无完整可确认候选；表为全允许清运的诊断，不是执行计划'))
        out.append('守恒：期初＋新增'+p['totalAddedL']+'−清走'+p['totalClearedL']+'，结果末余'+p['endingL']+'升；作业人员可行性：'+str(p['staffingFeasible'] if p['staffingFeasible'] is not None else '资料待补，不能判可行'))
        for condition in s['necessaryRemovalConditions']:out.append('必要条件（非完整方案）：'+condition['text'])
        for n in s['notices']:out.append(n['text']+'\n全文字符数：'+str(n['characters']))
    out.append('共同完整容量方案：'+json.dumps(r['jointCompletePlans'],ensure_ascii=False)+'；即使列表非空也不代表已采用或执行。')
    return '\n'.join(out)


def main():
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:r=calculate(json.loads(Path(a.input).read_text(),parse_float=Decimal))
    except (ValueError,TypeError,KeyError,AttributeError,OSError) as e:print('输入待纠正：'+str(e),file=sys.stderr);return 2
    print(json.dumps(r,ensure_ascii=False,indent=2) if a.format=='json' else render(r));return 0


if __name__=='__main__':raise SystemExit(main())
