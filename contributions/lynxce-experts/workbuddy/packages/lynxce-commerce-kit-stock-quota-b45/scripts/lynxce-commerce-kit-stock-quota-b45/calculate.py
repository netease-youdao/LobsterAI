#!/usr/bin/env python3
"""共享组件配额、双层守恒与来源分支；标准库，无后台写入。"""
import argparse
import json
import sys
from itertools import combinations


def text(x):
    if not isinstance(x,str) or not x.strip() or any(c in x for c in '|\n\r'):
        raise ValueError('标签须为非空单行文本且不含表格分隔符')
    return x


def integer(x):
    if isinstance(x,bool) or not isinstance(x,int) or x<0:
        raise ValueError('数量须为明确的非负整数；未知保留null')
    return x


def table(headers,rows):
    return '\n'.join(['|'+'|'.join(headers)+'|','|'+'|'.join(['---']*len(headers))+'|']+['|'+'|'.join(map(str,row))+'|' for row in rows])


def shown(x):
    return '未知待补' if x is None else str(x)


def solve(d):
    status=text(d['inputStatus']); snapshot=text(d['snapshot'])
    skus=d['skus'];branches=d['branches']
    if not isinstance(skus,list) or not skus or not isinstance(branches,list) or not branches:
        raise ValueError('SKU与来源分支均须为非空列表')
    skuids=[text(s['id']) for s in skus]
    if len(set(skuids))!=len(skuids):raise ValueError('SKU编码重复')
    for s in skus:
        if not isinstance(s['usage'],dict) or not s['usage']:raise ValueError('SKU结构不得为空')
        amounts=[integer(v) for v in s['usage'].values()]
        if not any(v>0 for v in amounts):raise ValueError('SKU结构不得全零')
        if s.get('cap') is not None:integer(s['cap'])
    result=[];branchids=[];basecomponents=None
    for b in branches:
        bid=text(b['id']);branchids.append(bid);source=text(b['source'])
        rows=b['components']
        if not isinstance(rows,list) or not rows:raise ValueError('组件列表不得为空')
        ids=[text(x['id']) for x in rows]
        if len(set(ids))!=len(ids):raise ValueError('组件编码重复')
        if basecomponents is None:basecomponents=set(ids)
        if set(ids)!=basecomponents:raise ValueError('各来源分支组件集合须一致')
        if any(k not in ids for s in skus for k in s['usage']):raise ValueError('SKU引用未列组件')
        parsed=[];notes=[]
        for x in rows:
            text(x['source']); effective={};assumptions=x.get('assumptions',{})
            if not isinstance(assumptions,dict):raise ValueError('assumptions须为字典')
            if set(assumptions)-{'inventory','extraDeduction','reserve'}:raise ValueError('未知假设字段')
            for key in ('inventory','extraDeduction','reserve'):
                raw=x[key]
                if raw is not None:
                    effective[key]=integer(raw)
                    if key in assumptions:raise ValueError('确认值不得被假设覆盖')
                elif key in assumptions:
                    a=assumptions[key];note=text(a['condition']);effective[key]=integer(a['value']);notes.append(x['id']+'：'+note)
                else:effective[key]=None
            net=None if None in effective.values() else effective['inventory']-effective['extraDeduction']-effective['reserve']
            parsed.append({'id':x['id'],'source':x['source'],'original':{k:x[k] for k in ('inventory','extraDeduction','reserve')},'effective':effective,'assumptions':assumptions,'netBudget':net})
        remaining={x['id']:x['netBudget'] for x in parsed};quota={};caps={};blocked={}
        for s in skus:
            needed={c:v for c,v in s['usage'].items() if v>0}
            bad=[c for c in needed if remaining[c] is None or remaining[c]<0]
            caps[s['id']]=None if any(next(x['netBudget'] for x in parsed if x['id']==c) is None or next(x['netBudget'] for x in parsed if x['id']==c)<0 for c in needed) else min(next(x['netBudget'] for x in parsed if x['id']==c)//v for c,v in needed.items())
            if bad:quota[s['id']]=None;blocked[s['id']]=bad;continue
            q=min(remaining[c]//v for c,v in needed.items())
            if s.get('cap') is not None:q=min(q,s['cap'])
            quota[s['id']]=q
            for c,v in needed.items():remaining[c]-=q*v
        for x in parsed:
            c=x['id'];usage={s['id']:None if quota[s['id']] is None and s['usage'].get(c,0)>0 else (quota[s['id']] or 0)*s['usage'].get(c,0) for s in skus}
            x['skuUsage']=usage
            computable=x['netBudget'] is not None and x['netBudget']>=0 and all(v is not None for v in usage.values())
            x['allocatedUsage']=sum(usage.values()) if all(v is not None for v in usage.values()) else None
            x['remaining']=remaining[c] if computable else None
            x['conservation']=None
            if computable:
                u=list(usage.values());e=x['effective'];net=x['netBudget'];rem=x['remaining']
                assert sum(u)+rem==net
                assert sum(u)+rem+e['reserve']+e['extraDeduction']==e['inventory']
                x['conservation']={'netTerms':u+[rem],'netRhs':net,'stockTerms':u+[rem,e['reserve'],e['extraDeduction']],'stockRhs':e['inventory'],'netEquation':'+'.join(map(str,u+[rem]))+'='+str(net),'stockEquation':'+'.join(map(str,u+[rem,e['reserve'],e['extraDeduction']]))+'='+str(e['inventory'])}
        conditional=bool(notes);scope=('若'+'；且'.join(notes)+'，则' if notes else '')
        message=scope+'建议'+('、'.join(s['id']+str(quota[s['id']])+'套' for s in skus if quota[s['id']] is not None) or '相关配额待补资料')+'；'+('部分SKU因未知或不足暂停；' if blocked else '')+'方案待确认、人工待执行，后台实际额度未知。'
        result.append({'id':bid,'source':source,'conditional':conditional,'conditionLabel':scope or '按列明来源演算','components':parsed,'quota':quota,'independentCaps':caps,'blockedSKUs':blocked,'notice':'资料性质：'+status+'；'+message})
    if len(set(branchids))!=len(branchids):raise ValueError('分支编码重复')
    comparisons=[]
    for a,b in combinations(result,2):
        changes=[]
        for c in sorted(basecomponents):
            left=next(x for x in a['components'] if x['id']==c);right=next(x for x in b['components'] if x['id']==c)
            fields=[('原库存',left['original']['inventory'],right['original']['inventory']),('原始额外扣减',left['original']['extraDeduction'],right['original']['extraDeduction']),('原始保留',left['original']['reserve'],right['original']['reserve'])]+[(k,left['effective'][k],right['effective'][k]) for k in ('inventory','extraDeduction','reserve')]+[(k,left[k],right[k]) for k in ('netBudget','allocatedUsage','remaining')]+[('SKU占用:'+s,left['skuUsage'][s],right['skuUsage'][s]) for s in skuids]
            for field,l,r in fields:changes.append({'component':c,'field':field,'from':l,'to':r,'changed':l!=r})
        comparisons.append({'from':a['id'],'to':b['id'],'fields':changes,'quotaFields':[{'sku':s,'from':a['quota'][s],'to':b['quota'][s],'changed':a['quota'][s]!=b['quota'][s]} for s in skuids]})
    return {'inputStatus':status,'snapshot':snapshot,'planStatus':'方案待确认、人工待执行；实际后台额度未知','skuOrder':skuids,'branches':result,'comparisons':comparisons}


def markdown(r):
    lines=['资料性质：'+r['inputStatus']+'；库存时点：'+r['snapshot']+'；'+r['planStatus']+'。']
    for b in r['branches']:
        lines+=['','## '+b['id']+'｜'+b['source'],b['conditionLabel']+'。',table(['组件','原库存','额外扣减原值','保留原值','演算额外扣减','演算保留','净预算']+r['skuOrder']+['剩余','来源'],[[x['id'],shown(x['original']['inventory']),shown(x['original']['extraDeduction']),shown(x['original']['reserve']),shown(x['effective']['extraDeduction']),shown(x['effective']['reserve']),shown(x['netBudget'])]+[shown(x['skuUsage'][s]) for s in r['skuOrder']]+[shown(x['remaining']),x['source']] for x in b['components']]),'',table(['SKU','建议套数','独立上限仅参考','实际后台额度'],[[s,shown(b['quota'][s]),shown(b['independentCaps'][s]),'未知；未执行'] for s in r['skuOrder']]),'','双层守恒（各SKU占用顺序：'+','.join(r['skuOrder'])+'；原库存式末两项依次为保留、额外扣减）：']
        for x in b['components']:
            c=x['conservation']
            lines.append(x['id']+'：净预算 '+c['netEquation']+'；原库存 '+c['stockEquation']+'。' if c else x['id']+'：未知或不足，相关配额与守恒待核，未填零。')
        lines+=['','内部通知草稿：'+b['notice']]
    for c in r['comparisons']:
        lines+=['','## '+c['from']+' → '+c['to']+'逐字段影响（条件分别沿用以上分支）',table(['组件','字段','前来源','后来源','是否变化'],[[x['component'],x['field'],shown(x['from']),shown(x['to']),'变化' if x['changed'] else '相同'] for x in c['fields']]),table(['SKU','前配额','后配额','是否变化'],[[x['sku'],shown(x['from']),shown(x['to']),'变化' if x['changed'] else '相同'] for x in c['quotaFields']])]
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input',nargs='?',default='-');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:
        d=json.load(sys.stdin) if a.input=='-' else json.loads(open(a.input,encoding='utf-8').read());r=solve(d)
        print(markdown(r) if a.format=='markdown' else json.dumps(r,ensure_ascii=False,indent=2));return 0
    except (ValueError,TypeError,KeyError,AttributeError,IndexError,ArithmeticError,OSError) as e:
        print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False));return 2


if __name__=='__main__':raise SystemExit(main())
