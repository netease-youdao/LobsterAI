#!/usr/bin/env python3
"""Only proposed whole-group seating, never infers actual seating from silence."""
import argparse
import json
import sys
from pathlib import Path
from datetime import date


def minute(v):
    if not isinstance(v, str) or len(v)!=5 or v[2]!=':':
        raise ValueError('时刻须HH:MM；同日演算，跨日须另给日期窗口')
    try:
        h,m=map(int,v.split(':'))
    except ValueError:
        raise ValueError('时刻须HH:MM') from None
    if not 0<=h<24 or not 0<=m<60:
        raise ValueError('时刻越界')
    return h*60+m


def hh(v):
    return f'{v//60:02}:{v%60:02}'


def count(v,field):
    if isinstance(v,bool) or not isinstance(v,int) or v<=0:
        raise ValueError(field+'须正整数；零人组先确认取消，不占桌')
    return v


def calculate(data):
    if not isinstance(data,dict):
        raise ValueError('根须对象')
    if data.get('date') is not None:
        if not isinstance(data['date'],str):raise ValueError('date须YYYY-MM-DD字符串或null')
        date.fromisoformat(data['date'])
    cutoff=minute(data.get('cutoff'));groups=data.get('groups');scenes=data.get('scenarios')
    if not isinstance(groups,list) or not groups or not isinstance(scenes,list) or not scenes:
        raise ValueError('groups/scenarios须非空；未知人数或桌况先补，不套样例')
    if data.get('allowSplitting') is not False or data.get('allowSharing') is not False:
        raise ValueError('本计算器只处理整组、不拆组、不拼桌；其他规则须另建用户确认方案')
    parsed=[];seen=set()
    for g in groups:
        if not isinstance(g.get('id'),str) or not g['id'] or g['id'] in seen:
            raise ValueError('客组代号须唯一')
        seen.add(g['id']);arr=minute(g.get('arrival'));n=count(g.get('people'),g['id']+'.people')
        if g.get('actualFeedback') is not None:
            raise ValueError(g['id']+'已有执行反馈，须先按原回执锁定实际桌位并从待排队列移除；不得重复分配')
        if arr>cutoff:
            raise ValueError(g['id']+'晚于截点，须另列未来到店，不算已等位')
        allowed=g.get('allowedTables')
        forbidden=g.get('forbiddenTables',[])
        if allowed is not None and (not isinstance(allowed,list) or any(not isinstance(x,str) for x in allowed)):
            raise ValueError('allowedTables须明确桌号列表或null；空列表表示无接受桌')
        if not isinstance(forbidden,list) or any(not isinstance(x,str) for x in forbidden):
            raise ValueError('forbiddenTables须桌号列表')
        parsed.append(dict(id=g['id'],people=n,arrival=arr,actualFeedback=g.get('actualFeedback'),allowedTables=allowed,forbiddenTables=forbidden))
    result=[]
    for s in scenes:
        tables=s.get('tables')
        if not isinstance(tables,list):
            raise ValueError('须明确桌位列表，未知不当空桌')
        ts={}
        for t in tables:
            ident=t.get('id')
            if not isinstance(ident,str) or not ident or ident in ts:
                raise ValueError('桌号须唯一')
            cap=count(t.get('seats'),ident+'.seats')
            ready=minute(t.get('release'))
            if t.get('releaseKind') not in ['已确认空','预计'] or not isinstance(t.get('blocked'),bool):
                raise ValueError('每桌须明确释放确定性与预订/不可用blocked')
            ts[ident]=dict(capacity=cap,ready=ready,kind=t['releaseKind'],blocked=t['blocked'])
        rows=[];used=set()
        for g in sorted(parsed,key=lambda g:(g['arrival'],g['id'])):
            candidates=sorted([(t['capacity'],max(cutoff,g['arrival'],t['ready']),ident) for ident,t in ts.items() if t['capacity']>=g['people'] and not t['blocked'] and (g['allowedTables'] is None or ident in g['allowedTables']) and ident not in g['forbiddenTables']])
            available=[x for x in candidates if x[2] not in used]
            row=dict(id=g['id'],people=g['people'],arrival=hh(g['arrival']),candidateTables=[x[2] for x in candidates],actualFeedback=g['actualFeedback'] if g['actualFeedback'] is not None else '待反馈；未知不等于无人入座',table=None,start=None,waitingMinutes=None,spareSeats=None,state='当前无可行桌；可等待或取消，具体选择待客组确认')
            if available:
                cap,start,ident=min(available,key=lambda x:(x[1],x[0],x[2]));used.add(ident);t=ts[ident]
                # A table is used once: no invented meal length or second turnover.
                state='现场可安排草案' if t['kind']=='已确认空' and t['ready']<=cutoff else '未来预计安排'
                row.update(table=ident,start=hh(start),startMinute=start,waitingMinutes=start-g['arrival'],spareSeats=cap-g['people'],state=state,capacity=cap)
            rows.append(row)
        current=[r for r in rows if r['state']=='现场可安排草案'];future=[r for r in rows if r['state']=='未来预计安排'];assigned=[r for r in rows if r['table'] is not None]
        assert len({r['table'] for r in assigned})==len(assigned)
        assert all(r['people']<=r['capacity'] and r['waitingMinutes']>=0 for r in assigned)
        summary=dict(currentProposedGroups=len(current),currentProposedPeople=sum(r['people'] for r in current),futureProposedGroups=len(future),futureProposedPeople=sum(r['people'] for r in future),unassignedGroups=len(rows)-len(assigned),currentSpareSeats=sum(r['spareSeats'] for r in current),futureSpareSeats=sum(r['spareSeats'] for r in future),currentProposedWait=sum(r['waitingMinutes'] for r in current),futureEstimatedWait=sum(r['waitingMinutes'] for r in future),totalWaitIncludingEstimated=sum(r['waitingMinutes'] for r in assigned),actualSeatedGroups=None,actualWait=None)
        notices=[]
        for r in rows:
            if r['table'] is not None:
                qualifier='预计' if r['state']=='未来预计安排' else '按已空桌可安排的草案'
                text=f"{r['id']}组{r['people']}位：建议{r['table']}，{qualifier}{r['start']}，按到店{r['arrival']}测算等待{r['waitingMinutes']}分钟。尚需现场确认，未代表已入座；您可以保留等位或取消。"
            else:
                text=f"{r['id']}组{r['people']}位：现有桌位无可行整组安排，不拆组、不拼桌；下一张可用桌时刻待确认。请确认继续等位或取消。"
            notices.append(dict(id=r['id'],text=text,characters=len(text)))
        result.append(dict(label=s.get('label','未命名'),source=s.get('source','来源待补'),rows=rows,summary=summary,notices=notices))
    differences=[]
    if len(result)>1:
        base={r['id']:r for r in result[0]['rows']}
        for s in result[1:]:
            differences.append(dict(label=s['label'],perGroupWaitChange={r['id']:(r['waitingMinutes']-base[r['id']]['waitingMinutes'] if r['waitingMinutes'] is not None and base[r['id']]['waitingMinutes'] is not None else None) for r in s['rows']},totalWaitChange=s['summary']['totalWaitIncludingEstimated']-result[0]['summary']['totalWaitIncludingEstimated']))
    return dict(date=data.get('date') or '日期待补；仅同日分钟演算',cutoff=hh(cutoff),status='排桌草案；用户反馈与现场执行状态独立，未知不置零；每桌本轮一次',scenarios=result,differences=differences)


def mdcell(value):
    return str(value).replace('|','&#124;').replace('\r\n','<br>').replace('\n','<br>').replace('\r','<br>')


def render(result):
    out=[result['status'],'日期：'+result['date']+'；截点：'+result['cutoff']]
    for s in result['scenarios']:
        out+=['\n情境：'+s['label']+'；来源：'+s['source'],'|客组|人数|到店|候选桌|建议桌|建议时刻|等待分|余座|状态|','|---|---:|---|---|---|---|---:|---:|---|']
        for r in s['rows']:
            out.append('|'+ '|'.join(mdcell(r.get(k) if r.get(k) is not None else '待补') for k in ['id','people','arrival','candidateTables','table','start','waitingMinutes','spareSeats','state'])+'|')
        out.append('')
        for r in s['rows']:
            out.append(r['id']+'实际入座反馈：'+str(r['actualFeedback']))
        z=s['summary'];out.append(f"当前草案{z['currentProposedGroups']}组{z['currentProposedPeople']}人；未来预计{z['futureProposedGroups']}组{z['futureProposedPeople']}人；未排成{z['unassignedGroups']}组。实际已入座组数与实际等待待反馈，不能用草案代填。")
        out.append(f"当前草案等待{z['currentProposedWait']}分钟；未来预计等待合计{z['futureEstimatedWait']}分钟；含预计总等待{z['totalWaitIncludingEstimated']}分钟。当前草案余座{z['currentSpareSeats']}，未来候选余座{z['futureSpareSeats']}。")
        for n in s['notices']:out.append(n['text']+'\n全文字符数：'+str(n['characters']))
    if result['differences']:out.append('相对首情境差异：'+json.dumps(result['differences'],ensure_ascii=False))
    out.append('过号规则未提供时，仅供经理选定的草案：甲保留一次优先；乙重新取号。未有过号回执，不称某组已经过号；选定后另写对应解释。')
    return '\n'.join(out)


def main():
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:r=calculate(json.loads(Path(a.input).read_text()))
    except (ValueError,TypeError,KeyError,AttributeError,OSError) as e:print('输入待纠正：'+str(e),file=sys.stderr);return 2
    print(json.dumps(r,ensure_ascii=False,indent=2) if a.format=='json' else render(r));return 0


if __name__=='__main__':raise SystemExit(main())
