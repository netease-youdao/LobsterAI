#!/usr/bin/env python3
"""从实际读数生成分穴统计、多版本逐件判定和完整取样行；只用标准库。"""
from gfm_tables import normalize
import argparse
from itertools import combinations
import json
import sys
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from fractions import Fraction as F


def value(x):
    if x is None or isinstance(x,bool):
        raise ValueError('读数或界限缺失')
    try:
        d=Decimal(str(x))
    except InvalidOperation as e:
        raise ValueError('读数或界限无效') from e
    if not d.is_finite():
        raise ValueError('数值必须有限')
    return F(d)


def label(x):
    if not isinstance(x,str) or not x or any(c in x for c in '|\n\r'):
        raise ValueError('编号必须为非空单行文本且不含表格分隔符')
    return x


def display(x,places=4):
    d=(Decimal(x.numerator)/Decimal(x.denominator)).quantize(Decimal(1).scaleb(-places),rounding=ROUND_HALF_UP)
    return format(d,'f')


def statistic(x):
    shown=display(x)
    return {'exact':str(x),'display':shown,'relation':'=' if value(shown)==x else '≈'}


def solve(d):
    nominal,lower=value(d['nominal']),value(d['lower'])
    inclusive=d['inclusive']
    if not isinstance(inclusive,bool):
        raise ValueError('inclusive须为已确认布尔值，未知时先补边界规则')
    groups=d['groups'];versions=d['versions']
    if not groups or not versions:
        raise ValueError('至少需要一个穴组和一个规格来源版本')
    cavities=[label(g['cavity']) for g in groups]
    names=[label(v['id']) for v in versions]
    for v in versions:
        label(v['source'])
    if len(set(cavities))!=len(cavities) or len(set(names))!=len(names):
        raise ValueError('穴号和版本编号分别必须唯一')
    resolved=d.get('resolvedVersion')
    if resolved is not None and resolved not in names:
        raise ValueError('已确认版本不存在')
    limits={v['id']:value(v['upper']) for v in versions}
    if any(upper<lower for upper in limits.values()):
        raise ValueError('上限不能小于下限')
    def outside(x,upper):
        return x<lower or x>upper if inclusive else x<=lower or x>=upper
    allvalues=[];stats=[];readings=[]
    for g in groups:
        data=g['readings']
        if not data:
            raise ValueError(g['cavity']+'没有样本，先补读数或移入缺测清单')
        parsed=[value(x) for x in data];allvalues+=parsed;n=len(parsed)
        mean=sum(parsed,F(0))/n
        row={'cavity':g['cavity'],'n':n,'sum':statistic(sum(parsed,F(0))),
             'mean':statistic(mean),'offset':statistic(mean-nominal),
             'range':statistic(max(parsed)-min(parsed)),
             'outside':{name:sum(outside(x,limits[name]) for x in parsed) for name in names},
             'meanOutside':{name:outside(mean,limits[name]) for name in names}}
        stats.append(row)
        for ix,x in enumerate(parsed,1):
            readings.append({'sample':g['cavity']+'-'+str(ix).zfill(2),'cavity':g['cavity'],'reading':str(data[ix-1]),'outside':{name:outside(x,limits[name]) for name in names}})
    count=len(allvalues);total=sum(allvalues,F(0));means=[sum([value(x) for x in g['readings']],F(0))/len(g['readings']) for g in groups]
    fractions={name:F(sum(outside(x,limits[name]) for x in allvalues),count) for name in names}
    rounds=[label(x) for x in d['samplingPlan']['rounds']];per=d['samplingPlan']['perCavityPerRound']
    if len(set(rounds))!=len(rounds) or not rounds or not isinstance(per,int) or isinstance(per,bool) or not 1<=per<=1000:
        raise ValueError('取样轮次须非空且唯一，每穴每轮数为1至1000整数')
    plan=[{'round':r,'cavity':c,'sample':r+'-'+c+'-'+str(i).zfill(2),'reading':'待填','upperSource':'待确认：'+','.join(names) if resolved is None else resolved,'method':'待补','recorder':'待补'} for r in rounds for c in cavities for i in range(1,per+1)]
    comparisons=[]
    for left,right in combinations(names,2):
        changed=[x['sample'] for x in readings if x['outside'][left] != x['outside'][right]]
        comparisons.append({'fromVersion':left,'toVersion':right,'changedVerdictCount':len(changed),'changedIDs':changed})
    return {'versionComparisons':comparisons,'changedVerdictCount':comparisons[0]['changedVerdictCount'] if len(comparisons)==1 else None,'changedIDs':comparisons[0]['changedIDs'] if len(comparisons)==1 else [],'inputStatus':d['inputStatus'],'cavityCount':len(groups),'totalSamples':count,
            'countsByCavity':{g['cavity']:len(g['readings']) for g in groups},
            'nominal':str(d['nominal']),'lower':str(d['lower']),'inclusive':inclusive,
            'versions':[{'id':v['id'],'upper':str(v['upper']),'source':v['source']} for v in versions],
            'resolvedVersion':resolved,'statistics':stats,'readings':readings,
            'overallMean':statistic(total/count),'overallSum':statistic(total),
            'meanSpan':statistic(max(means)-min(means)),
            'outsideRatios':{name:{'count':sum(x['outside'][name] for x in stats),'exactFraction':str(fractions[name]),'percentageDisplay':display(fractions[name]*100,2)+'%','displayRule':'百分比四舍五入至小数2位；精确值另列，不写精确等号'} for name in names},
            'samplingRows':plan,'samplingRowCount':len(plan),
            'samplingByRound':dict(Counter(x['round'] for x in plan)),
            'samplingByCavity':dict(Counter(x['cavity'] for x in plan))}


def table(headers,rows):
    if any(len(row)!=len(headers) for row in rows):
        raise ValueError('实际表格列数不一致')
    return ['|'+'|'.join(headers)+'|','|'+'|'.join('---' for _ in headers)+'|']+['|'+'|'.join(map(str,row))+'|' for row in rows]


def markdown(r):
    names=[v['id'] for v in r['versions']]
    countText='、'.join(k+str(n)+'件' for k,n in r['countsByCavity'].items())
    lines=[f"资料性质：{r['inputStatus']}。对象：{r['cavityCount']}穴共{r['totalSamples']}件（{countText}），单位毫米。",f"名义{r['nominal']}，下限{r['lower']}，边界{'含等于' if r['inclusive'] else '不含等于'}；有效版本：{r['resolvedVersion'] or '待确认，各来源条件并列'}。",'', '## 分穴统计']
    lines+=table(['穴号','n','均值显示','精确均值','极差显示','偏移显示']+[name+'超限件' for name in names],[[s['cavity'],s['n'],s['mean']['display'],s['mean']['exact'],s['range']['display'],s['offset']['display']]+[s['outside'][name] for name in names] for s in r['statistics']])
    lines+=['',f"整体均值：精确值{r['overallMean']['exact']}，显示{r['overallMean']['display']}；穴均值跨度：精确值{r['meanSpan']['exact']}，显示{r['meanSpan']['display']}。显示保留4位小数，四舍五入；不以显示值替代原始值作超限判定。",'', '## 版本与比例']
    lines+=table(['版本ID','上限毫米','来源','超限件/总件','精确比例','显示百分比（舍入）'],[[v['id'],v['upper'],v['source'],str(r['outsideRatios'][v['id']]['count'])+'/'+str(r['totalSamples']),r['outsideRatios'][v['id']]['exactFraction'],r['outsideRatios'][v['id']]['percentageDisplay']] for v in r['versions']])
    if r['versionComparisons']:
        lines+=['','## 逐件版本变化（程序逐字段比较）']
        lines+=table(['基准版本','对比版本','判定变化件数','判定变化样件号'],[[x['fromVersion'],x['toVersion'],x['changedVerdictCount'],'、'.join(x['changedIDs']) or '无'] for x in r['versionComparisons']])
    lines+=['','## 逐件判定']
    lines+=table(['样件号','穴号','原始读数毫米']+[name+'条件下' for name in names],[[x['sample'],x['cavity'],x['reading']]+['超限' if x['outside'][name] else '范围内' for name in names] for x in r['readings']])
    lines+=['','## 完整分穴取样表（下一轮方案，未执行）']
    rendered=table(['轮次','穴号','样件号','实测毫米','判定上限来源','方法版本','记录人'],[[x[k] for k in ('round','cavity','sample','reading','upperSource','method','recorder')] for x in r['samplingRows']])
    actual=len(rendered)-2
    assert actual==r['samplingRowCount']
    lines+=rendered
    lines += [f"本表实际数据行{actual}；按轮次计数："+json.dumps(r['samplingByRound'],ensure_ascii=False)+'；按穴号计数：'+json.dumps(r['samplingByCavity'],ensure_ascii=False)+'。','', '## 可复制报告']
    conclusions=[]
    for v in r['versions']:
        item=r['outsideRatios'][v['id']]
        conclusions.append(f"若{v['source']}的上限{v['upper']}适用，本组{r['totalSamples']}件中{item['count']}件超限，精确比例{item['exactFraction']}，显示为{item['percentageDisplay']}（舍入）")
    for x in r['versionComparisons']:
        conclusions.append(f"由{x['fromVersion']}对比{x['toVersion']}，逐件判定变化{x['changedVerdictCount']}件，编号：{'、'.join(x['changedIDs']) or '无'}；未变化样件不计入变化件数")
    lines+=['资料性质：'+str(r['inputStatus'])+'；'+'；'.join(conclusions)+'。上述为本轮读数描述，不外推整批，不据此判定修模或出货。有效来源未确认时仍保持条件句。取样表是后续安排，尚未执行。']
    return normalize('\n'.join(lines)+'\n')


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input',nargs='?',default='-');p.add_argument('--format',choices=('json','markdown'),default='json');a=p.parse_args()
    try:
        d=json.load(sys.stdin) if a.input=='-' else json.loads(open(a.input,encoding='utf-8').read());r=solve(d)
        print(markdown(r) if a.format=='markdown' else json.dumps(r,ensure_ascii=False,indent=2));return 0
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,ArithmeticError,OSError) as e:
        print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False));return 2


if __name__=='__main__':
    raise SystemExit(main())
