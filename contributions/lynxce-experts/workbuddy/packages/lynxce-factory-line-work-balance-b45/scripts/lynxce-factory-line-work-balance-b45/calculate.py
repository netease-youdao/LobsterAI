#!/usr/bin/env python3
"""不可拆动作的工位分配；精确有理数计算，枚举范围和未分配新增时间显式返回。"""
import argparse
import json
import sys
from fractions import Fraction as F
from decimal import Decimal, ROUND_HALF_UP
from itertools import product
from math import ceil


def number(v):
    if isinstance(v,bool) or v is None:
        raise ValueError('秒数缺失或类型错误')
    try:
        x=F(str(v))
    except (ValueError,ZeroDivisionError) as e:
        raise ValueError('秒数无效') from e
    if x<0:
        raise ValueError('秒数不能为负')
    return x


def text(x):
    return str(x.numerator) if x.denominator==1 else str(x)


def solve(d):
    actions=d['actions'];ids=[a['id'] for a in actions]
    if not ids or len(set(ids))!=len(ids):
        raise ValueError('动作编号必须唯一且非空')
    if any(a.get('indivisible') is not True for a in actions):
        raise ValueError('仅接收已定义不可拆的动作；可拆动作须先由用户批准拆成独立编号')
    seconds={a['id']:number(a['seconds']) for a in actions};original=dict(seconds)
    deps=d['dependencies']
    if any(len(e)!=2 or e[0] not in seconds or e[1] not in seconds for e in deps):
        raise ValueError('前置关系编号无效')
    todo=set(ids);ordered=[]
    while todo:
        ready=sorted(i for i in todo if all(p in ordered for p,s in deps if s==i))
        if not ready:
            raise ValueError('前置关系成环')
        ordered.extend(ready);todo.difference_update(ready)
    if 'targetSeconds' in d:
        target=number(d['targetSeconds'])
    else:
        available,demand=number(d['availableSeconds']),number(d['demand'])
        if demand==0:
            raise ValueError('需求为0，需求节拍待定义')
        target=available/demand
    if target<=0:
        raise ValueError('目标周期必须大于0')
    total0=sum(seconds.values(),F(0));extra=F(0);unallocated=[]
    for c in d.get('changes',[]):
        delta=number(c['addedSeconds']);extra+=delta
        if c.get('action') in seconds:
            seconds[c['action']]+=delta
        elif c.get('action') is None:
            unallocated.append({'station':c.get('station'),'addedSeconds':text(delta),'reason':'未明确新增时间属于哪个动作或占用何资源'})
        else:
            raise ValueError('新增时间引用不存在的动作')
    total=total0+extra
    result={'inputStatus':d['inputStatus'],'condition':d['condition'],'target':text(target),
            'originalTotal':text(total0),'addedSeconds':text(extra),'total':text(total),
            'actions':[{'id':i,'originalSeconds':text(original[i]),'seconds':text(seconds[i])} for i in ordered],
            'lowerBound':ceil(total/target),'status':'待求解','counts':[],'solutions':[]}
    if unallocated:
        result.update(status='新增时间待归属，不生成重排',unallocated=unallocated,accountedTotal=text(sum(seconds.values(),F(0))),unallocatedSeconds=text(sum((number(x['addedSeconds']) for x in unallocated),F(0))))
        return result
    assert sum(seconds.values(),F(0))==total
    blockers=[i for i in ids if seconds[i]>target]
    if blockers:
        result.update(status='无满足节拍的分配',blockers=[{'action':i,'seconds':text(seconds[i]),'over':text(seconds[i]-target)} for i in blockers],reason='不可拆单动作超过目标周期；仅增加工位不能消除超限')
        return result
    if d.get('unmodeledConstraints'):
        result.update(status='共享资源或其他限制待建模，不生成可行方案',pending=d['unmodeledConstraints'])
        return result
    old={a['id']:a.get('originalStation') for a in actions}
    allowed={a['id']:a.get('allowedStations') for a in actions}
    if any(v is None for v in allowed.values()) and d.get('allStationsAllowed') is not True:
        result.update(status='可移动许可待确认，不生成可行方案',pending=['逐动作allowedStations或用户明确allStationsAllowed:true'])
        return result
    maximum=d.get('maxStations',len(ids));budget=d.get('maxStates',200000)
    if not isinstance(maximum,int) or not 1<=maximum<=12 or not isinstance(budget,int) or budget<1:
        raise ValueError('枚举范围无效')
    if any(v is not None and (not isinstance(v,list) or not v or any(not isinstance(s,int) or isinstance(s,bool) or s<1 for s in v)) for v in allowed.values()):
        raise ValueError('允许工位须为正整数编号列表')
    usedStates=0;best=None
    for k in range(max(1,ceil(total/target)),maximum+1):
        states=k**len(ids)
        if usedStates+states>budget:
            result.update(searchComplete=False,status='枚举上限已达，未证明不可行或最少站数',enumeratedStates=usedStates)
            return result
        usedStates+=states;valid=[]
        for assignment in product(range(1,k+1),repeat=len(ids)):
            if set(assignment)!=set(range(1,k+1)):
                continue
            station=dict(zip(ids,assignment))
            if any(allowed[i] is not None and station[i] not in allowed[i] for i in ids):
                continue
            if any(station[p]>station[s] for p,s in deps):
                continue
            loads=[sum((seconds[i] for i in ids if station[i]==j),F(0)) for j in range(1,k+1)]
            if max(loads)>target:
                continue
            moves=[i for i in ids if old[i] is not None and old[i]!=station[i]]
            valid.append((max(loads),len(moves),assignment,station,loads,moves))
        result['counts'].append({'nonemptyStations':k,'assignmentsExamined':states,'feasible':len(valid)})
        if valid and best is None:
            best=min(valid,key=lambda v:v[:3]);peak,_,_,station,loads,moves=best
            def percent(ratio):
                return format((Decimal(ratio.numerator)/Decimal(ratio.denominator)*100).quantize(Decimal('0.01'),rounding=ROUND_HALF_UP),'f')
            result.update(status='已给范围内纸面可行',minimumStations=k,targetUtilizationPercent=percent(total/(k*target)),targetUtilizationDenominator=text(k*target),balanceEfficiencyPercent=percent(total/(k*peak)) if peak else None,balanceEfficiencyDenominator=text(k*peak),idle=text(k*target-total),maximumLoad=text(peak),movedActions=moves)
            result['solutions']=[{'station':j,'actions':[i for i in ordered if station[i]==j],'load':text(loads[j-1]),'margin':text(target-loads[j-1])} for j in range(1,k+1)]
            assert sum(loads,F(0))==total
            assert sorted(i for row in result['solutions'] for i in row['actions'])==sorted(ids)
            # 已证明最少站数后，无需遍历所有更大站数；不声称列全所有方案。
            result.update(searchComplete=True,enumeratedStates=usedStates)
            return result
    result.update(searchComplete=True,enumeratedStates=usedStates,status='给定工位范围内无解',reason='仅在maxStations及已给工位限制内完整枚举；不扩大为所有条件下无解')
    return result


def markdown(r):
    lines=[f"资料性质：{r['inputStatus']}；条件：{r['condition']}。",f"目标{r['target']}秒；原总量{r['originalTotal']}+新增{r['addedSeconds']}=本轮{r['total']}秒；{r['status']}。"]
    if r.get('unallocated'):
        lines.append(f"已归属动作合计{r['accountedTotal']}秒；未归属新增{r['unallocatedSeconds']}秒；待补动作归属和资源占用，不给可行替代。")
    if r.get('blockers'):
        lines.append('阻塞动作：'+json.dumps(r['blockers'],ensure_ascii=False)+'。仅增站无法解决不可拆动作超节拍。')
    if r['solutions']:
        lines+=['|工位|动作拓扑顺序|负荷秒|目标内余量秒|','|---|---|---:|---:|']
        for row in r['solutions']:
            lines.append(f"|{row['station']}|{'→'.join(row['actions'])}|{row['load']}|{row['margin']}|")
        lines.append(f"最少{r['minimumStations']}个非空站（限已给约束）；最高负荷{r['maximumLoad']}秒；按目标节拍的工时利用率{r['targetUtilizationPercent']}%（总工时/{r['targetUtilizationDenominator']}）；平衡效率{r['balanceEfficiencyPercent'] or '未定义'}%（总工时/{r['balanceEfficiencyDenominator']}，工位数×最高负荷）；目标下空闲{r['idle']}秒；实际换站动作：{','.join(r['movedActions']) or '无'}。")
    lines.append('可复制结论：'+r['condition']+'前提下，'+r['status']+'；以上为资料方案，工艺与人员调整待人工评审。')
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input',nargs='?',default='-');p.add_argument('--format',choices=('json','markdown'),default='json');a=p.parse_args()
    try:
        d=json.load(sys.stdin) if a.input=='-' else json.loads(open(a.input,encoding='utf-8').read());r=solve(d)
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,ArithmeticError,OSError) as e:
        print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False));return 2
    print(markdown(r) if a.format=='markdown' else json.dumps(r,ensure_ascii=False,indent=2));return 0


if __name__=='__main__':
    raise SystemExit(main())
