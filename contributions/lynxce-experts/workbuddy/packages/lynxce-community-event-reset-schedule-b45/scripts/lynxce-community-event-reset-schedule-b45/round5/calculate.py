#!/usr/bin/env python3
"""Non-preemptive whole-team tasks with explicit dependencies and resource locks."""
import argparse
import json
import sys
from datetime import date
from pathlib import Path


def minute(v):
    if not isinstance(v,str) or len(v)!=5 or v[2]!=':':raise ValueError('时刻须同日HH:MM')
    h,m=map(int,v.split(':'))
    if not 0<=h<24 or not 0<=m<60:raise ValueError('时刻越界')
    return h*60+m


def hh(v):return f'{v//60:02}:{v%60:02}'


def positive(v,field):
    if isinstance(v,bool) or not isinstance(v,int) or v<=0:raise ValueError(field+'须正整数或明确待补，不能偷置0')
    return v


def word(v,default):
    if v is None:return default
    if not isinstance(v,str):raise ValueError('名称、来源与执行反馈须文字或null')
    return v or default


def intervals(value):
    if not isinstance(value,list):raise ValueError('可用/已有占用须明确区间列表')
    result=[]
    for x in value:
        a,b=minute(x.get('start')),minute(x.get('end'))
        if a>=b:raise ValueError('区间结束须晚于开始')
        result.append((a,b))
    return result


def conflict(a,b,c,d):return a<d and c<b


def calculate(data):
    if not isinstance(data,dict):raise ValueError('根须对象')
    if data.get('date') is not None:
        if not isinstance(data['date'],str) or len(data['date'])!=10:raise ValueError('date须YYYY-MM-DD字符串或null')
        date.fromisoformat(data['date'])
    begin,deadline=minute(data.get('start')),minute(data.get('deadline'))
    if deadline<=begin:raise ValueError('本轮须同日截止晚于开始')
    ws=data.get('workers');raw=data.get('tasks')
    if not isinstance(ws,list) or not isinstance(raw,list) or not raw:raise ValueError('workers须明确列表，tasks须非空')
    workers={};source_busy={}
    for w in ws:
        ident=word(w.get('id'),'')
        if not ident or ident in workers:raise ValueError('人员代号须唯一')
        av,bu=intervals(w.get('available')),intervals(w.get('busy'))
        workers[ident]=dict(available=av,busy=list(bu));source_busy[ident]=bu
    resources={}
    for ident,r in data.get('resources',{}).items():
        resources[ident]=dict(available=intervals(r.get('available')),busy=intervals(r.get('busy')))
    tasks={}
    for t in raw:
        ident=word(t.get('id'),'')
        if not ident or ident in tasks:raise ValueError('任务代号须唯一')
        need=positive(t.get('people'),ident+'.people');dur=positive(t['durationMinutes'],ident+'.durationMinutes') if t.get('durationMinutes') is not None else None
        deps=t.get('predecessors');res=t.get('resources')
        if not isinstance(deps,list) or not isinstance(res,list):raise ValueError('前置和资源须明确列表；未知不能默认为无')
        if any(x not in resources for x in res):raise ValueError('引用未给资源窗口，先补来源')
        allowed=t.get('allowedWorkers')
        if allowed is not None and (not isinstance(allowed,list) or any(x not in workers for x in allowed)):raise ValueError('allowedWorkers须已给人员代号列表/null')
        tasks[ident]=dict(id=ident,name=word(t.get('name'),'任务'+ident+'（动作/物品对应待用户确认）'),people=need,duration=dur,predecessors=deps,resources=res,allowedWorkers=allowed,earliest=minute(t['earliestStart']) if t.get('earliestStart') else begin,due=minute(t['deadline']) if t.get('deadline') else deadline,actualStatus=word(t.get('actualStatus'),'待反馈；无回执不代表未开始或已完成'))
    if any(p not in tasks for t in tasks.values() for p in t['predecessors']):raise ValueError('引用未知前置任务')
    dest=data.get('destinationConflicts')
    if dest is None:dest=[]
    if not isinstance(dest,list):raise ValueError('destinationConflicts须列表/null')
    freeze={};mapping_pending=False
    for c in dest:
        values=c.get('values')
        if not isinstance(values,list) or len(values)<2 or any(not isinstance(x.get('source'),str) or not isinstance(x.get('destination'),str) for x in values):raise ValueError('去向冲突须至少两条来源及原值')
        linked=c.get('linkedTaskIds')
        if linked is None:mapping_pending=True
        elif not isinstance(linked,list) or any(x not in tasks for x in linked):raise ValueError('冲突linkedTaskIds须已有任务代号列表/null')
        else:
            for ident in linked:freeze[ident]='去向冲突未裁定，相关任务暂不排；不得擅改前置或拆分时长'
    memo={};visiting=set()
    def chain(ident):
        if ident in memo:return memo[ident]
        if ident in visiting:raise ValueError('前置依赖成环')
        visiting.add(ident);t=tasks[ident];prior=[chain(x) for x in t['predecessors']];visiting.remove(ident)
        memo[ident]=None if t['duration'] is None or any(x is None for x in prior) else t['duration']+max(prior+[0]);return memo[ident]
    for ident in tasks:chain(ident)
    rows={};fixed=data.get('fixedTasks') or []
    if not isinstance(fixed,list):raise ValueError('fixedTasks须列表/null')
    fixed_ids={x.get('id') for x in fixed if isinstance(x,dict)}
    for t in raw:
        if t.get('actualStatus') is not None and t['id'] not in fixed_ids:
            raise ValueError(t['id']+'已有现场反馈但未给结构化锁定时段/人员/来源，不能当作未做任务重新排；请先核反馈对应范围')
    def ready(resource,a,b):
        return any(x<=a and b<=y for x,y in resource['available']) and not any(conflict(a,b,x,y) for x,y in resource['busy'])
    def place(t,a,b,people,kind):
        if len(set(people))!=t['people'] or any(w not in workers or (t['allowedWorkers'] is not None and w not in t['allowedWorkers']) for w in people):raise ValueError('锁定任务人员不满足资格/人数')
        if t['duration'] is None or b-a!=t['duration'] or a<max(begin,t['earliest']) or b>min(deadline,t['due']):raise ValueError('锁定任务时长/窗口冲突')
        if any(not ready(workers[w],a,b) for w in people) or any(not ready(resources[r],a,b) for r in t['resources']):raise ValueError('锁定任务冲突，保留原值交人工，不静默移动')
        for w in people:workers[w]['busy'].append((a,b))
        for r in t['resources']:resources[r]['busy'].append((a,b))
        rows[t['id']]=dict(id=t['id'],name=t['name'],people=t['people'],durationMinutes=t['duration'],start=hh(a),end=hh(b),startMinute=a,endMinute=b,workers=people,resources=t['resources'],predecessors=t['predecessors'],status=kind,actualStatus=t['actualStatus'])
    for lock in fixed:
        ident=lock.get('id')
        if ident not in tasks or ident in rows or ident in freeze or not isinstance(lock.get('source'),str) or not lock['source'] or not isinstance(lock.get('workers'),list):raise ValueError('冻结任务须已知唯一代号、来源、人员列表且无未裁定去向')
        place(tasks[ident],minute(lock.get('start')),minute(lock.get('end')),lock.get('workers',[]),'用户确认锁定时段；不表示实际完成')
    remaining=set(tasks)-set(rows)
    while remaining:
        eligible=[x for x in remaining if all(p in rows for p in tasks[x]['predecessors'])]
        if not eligible:raise ValueError('前置链无法展开')
        ident=min(eligible,key=lambda x:(max([rows[p].get('endMinute',begin) for p in tasks[x]['predecessors']]+[begin]),x));t=tasks[ident];remaining.remove(ident)
        blocked=freeze.get(ident)
        if any('endMinute' not in rows[p] for p in t['predecessors']):blocked='前置任务未形成有效时段，后续不擅自改前置'
        if t['duration'] is None:blocked='任务分钟待补，不以0排程'
        choice=None
        if not blocked:
            start=max([begin,t['earliest']]+[rows[p]['endMinute'] for p in t['predecessors']])
            for a in range(start,min(deadline,t['due'])-t['duration']+1):
                b=a+t['duration'];free=[w for w in workers if (t['allowedWorkers'] is None or w in t['allowedWorkers']) and ready(workers[w],a,b)]
                if len(free)>=t['people'] and all(ready(resources[r],a,b) for r in t['resources']):choice=(a,b,free[:t['people']]);break
        if choice:place(t,*choice,'候选排程待确认')
        else:rows[ident]=dict(id=ident,name=t['name'],people=t['people'],durationMinutes=t['duration'],status=blocked or '当前顺序与连续人力/窗口条件下无可排段；不宣称全局无解',actualStatus=t['actualStatus'],predecessors=t['predecessors'],resources=t['resources'])
    for row in rows.values():
        if 'startMinute' in row:
            if any('endMinute' not in rows[p] or rows[p]['endMinute']>row['startMinute'] for p in row['predecessors']):raise ValueError('锁定/新排任务的前置约束冲突，须人工裁定')
    scheduled=[r for r in rows.values() if 'endMinute' in r];finish=max([r['endMinute'] for r in scheduled]+[begin]);all_scheduled=len(scheduled)==len(tasks)
    task_pm=sum(r['people']*r['durationMinutes'] for r in scheduled);cards={w:[dict(id=r['id'],start=r['start'],end=r['end']) for r in sorted(scheduled,key=lambda x:x['startMinute']) if w in r['workers']] for w in workers};person_pm=sum(r['durationMinutes'] for r in scheduled for w in r['workers']);assert task_pm==person_pm
    capacity=sum(1 for w in workers for m in range(begin,deadline) if any(a<=m<m+1<=b for a,b in workers[w]['available']) and not any(conflict(m,m+1,a,b) for a,b in source_busy[w]))
    probes=[]
    for probe in data.get('freeTeamProbes',[]):
        need=probe.get('people');dur=probe.get('durationMinutes');after=minute(probe.get('after'));earliest=None
        if need is not None and dur is not None:
            positive(need,'probe.people');positive(dur,'probe.durationMinutes')
            for a in range(max(begin,after),deadline-dur+1):
                free=[w for w in workers if ready(workers[w],a,a+dur)]
                if len(free)>=need:earliest=hh(a);break
        probes.append(dict(label=word(probe.get('label'),'资源查询'),people=need,durationMinutes=dur,earliestFreeStart=earliest,condition='仅本轮已排人员空档；接收窗口/任务前置/路程另核，未知输入不产精确开工承诺'))
    known_total=sum(t['people']*t['duration'] for t in tasks.values() if t['duration'] is not None)
    task_min_unknown=any(t['duration'] is None for t in tasks.values())
    text='撤场任务草案：'+'；'.join((r['id']+'按用户锁定记录保留'+r['start']+'—'+r['end']+'、人员'+'、'.join(r['workers']) if r['id'] in fixed_ids else r['id']+'拟'+r['start']+'—'+r['end']+'由'+'、'.join(r['workers'])+'处理') for r in sorted(scheduled,key=lambda x:(x['startMinute'],x['id'])))+'。实际状态以逐任务回执栏为准；未反馈项不从计划推断已撤收、未外送或场地已还。'
    if dest:text+='本轮争议物品去向保留来源，关联任务/人数/路程/接收窗口核清后重算；不承诺确认后固定分钟切换。'
    missing_action_ids=[t['id'] for t in raw if not isinstance(t.get('name'),str) or not t['name']]
    questions=[
        ('请确认任务代号'+ '、'.join(missing_action_ids)+'分别对应的本轮实际动作与物品；未给映射前只按代号演算，不从示例补动作。') if missing_action_ids else '请确认本轮已给任务动作与物品、数量、去向对应是否完整；未给关联继续待核。',
        '请裁定本轮去向冲突的生效来源及关联任务代号；如涉及运输或接收，另给实际窗口、人数和路程，未给不推断。' if dest else '请确认本轮是否还有未列的物品去向、运输或接收约束；如有，请给关联任务代号和来源，未给不从示例补入。',
        '请按本轮任务代号回传执行状态及来源；已发生动作须给实际时段、人员锁定记录，未反馈保持待核。'
    ]
    return dict(date=data.get('date') or '日期待补；仅同日演算',status='人员连续排程草案；抽象任务与物品对应不自动编造',rows=sorted(rows.values(),key=lambda r:(r.get('startMinute',1440),r['id'])),personCards=cards,scheduledPersonMinutes=task_pm,personSumMinutes=person_pm,knownRequiredPersonMinutes=known_total,unknownTaskMinutesPresent=task_min_unknown,availableNetPersonMinutes=capacity,allProvidedTasksScheduled=all_scheduled,providedTaskPlanFinish=hh(finish) if all_scheduled else None,remainingToDeadlineMinutes=deadline-finish if all_scheduled else None,dependencyChainLowerBoundMinutes=None if any(x is None for x in memo.values()) else max(memo.values()),workloadLowerBoundMinutes=(known_total+len(workers)-1)//len(workers) if workers else None,destinationConflicts=dest,destinationTaskMappingPending=mapping_pending,siteRestorationFinish=None,items=data.get('items') if data.get('items') is not None else '物品/数量/去向对应未给，不把示例任务动作当现场事实',freeTeamProbes=probes,notice=dict(text=text,characters=len(text)),questions=questions)


def mdcell(value):
    return str(value).replace('|','&#124;').replace('\r\n','<br>').replace('\n','<br>').replace('\r','<br>')


def render(r):
    out=[r['status'],'日期：'+r['date'],'|任务|动作对应|人数|连续分|开始|结束|人员|共享资源|前置|状态|','|---|---|---:|---:|---|---|---|---|---|---|']
    for row in r['rows']:
        out.append('|'+ '|'.join(mdcell(row.get(k) if row.get(k) is not None else '待补') for k in ['id','name','people','durationMinutes','start','end','workers','resources','predecessors','status'])+'|')
    out.append('')
    for row in r['rows']:out.append(row['id']+'实际状态：'+row['actualStatus'])
    out.append('逐人顺序卡：'+json.dumps(r['personCards'],ensure_ascii=False))
    out.append(f"已排逐任务人分钟{r['scheduledPersonMinutes']}，逐人合计{r['personSumMinutes']}；可用净人分钟{r['availableNetPersonMinutes']}。需求已知部分{r['knownRequiredPersonMinutes']}，未知任务分钟仍保留待补。")
    display=lambda v:'待补/未排全' if v is None else str(v)
    out.append('仅给定任务的计划结束：'+display(r['providedTaskPlanFinish'])+'；截止余量分钟：'+display(r['remainingToDeadlineMinutes'])+'；依赖链下界：'+display(r['dependencyChainLowerBoundMinutes'])+'；人分钟下界：'+display(r['workloadLowerBoundMinutes'])+'。下界不是完工承诺。')
    out.append('物品归位对应：'+json.dumps(r['items'],ensure_ascii=False)+'；现场整体还场完成时点待对应动作/去向确认和实际回执，不填具体时刻。')
    if r['destinationConflicts']:out.append('去向原值冲突：'+json.dumps(r['destinationConflicts'],ensure_ascii=False)+'；无任务关联时不能擅自拆分原任务、改动后续前置或借用示例时长。')
    if r['freeTeamProbes']:out.append('资源空档查询：'+json.dumps(r['freeTeamProbes'],ensure_ascii=False))
    out.append(r['notice']['text']+'\n全文字符数：'+str(r['notice']['characters']))
    out.append('本轮中性确认问题（逐字引用questions）：')
    out.extend(str(i+1)+'．'+q for i,q in enumerate(r['questions']))
    return '\n'.join(out)


def main():
    p=argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:r=calculate(json.loads(Path(a.input).read_text()))
    except (ValueError,TypeError,KeyError,AttributeError,OSError) as e:print('输入待纠正：'+str(e),file=sys.stderr);return 2
    print(json.dumps(r,ensure_ascii=False,indent=2) if a.format=='json' else render(r));return 0


if __name__=='__main__':raise SystemExit(main())
