#!/usr/bin/env python3
"""Exact arithmetic/formatting and claim checks; not an automatic grading system."""
from gfm_tables import normalize, cell
import argparse
import json
import sys
import re
from decimal import Decimal, localcontext
from fractions import Fraction as F
from pathlib import Path


def literal(v):
    if v is None:return None
    if isinstance(v,bool):raise ValueError('布尔值不是数值')
    text=str(v).strip();percent=text.endswith('%')
    if percent:text=text[:-1]
    try:x=F(text)
    except (ValueError,ZeroDivisionError):raise ValueError('须为有限十进制或分数，百分数需带%') from None
    return x/100 if percent else x


def metric(value, precision, percent=False):
    if value is None:return None
    shownvalue=value*100 if percent else value;suffix='%' if percent else ''
    with localcontext() as ctx:
        ctx.prec=max(50,len(str(abs(shownvalue.numerator)))+len(str(shownvalue.denominator))+precision+8)
        display=format(Decimal(shownvalue.numerator)/Decimal(shownvalue.denominator),'.'+str(precision)+'f').rstrip('0').rstrip('.') if precision else format(Decimal(shownvalue.numerator)/Decimal(shownvalue.denominator),'.0f')
    approx=F(display)!=shownvalue;exact=str(shownvalue)
    text=exact+suffix if exact==display else exact+suffix+(' ≈ ' if approx else ' = ')+display+suffix
    return {'exactBaseValue':str(value),'exactInDisplayUnit':exact,'display':display,'unit':suffix,'approximate':approx,'text':text}


def calculate(data):
    if not isinstance(data,dict):raise ValueError('根输入须为对象')
    precision=data.get('precision',2)
    if type(precision) is not int or not 0<=precision<=12:raise ValueError('precision须为0至12整数')
    entries=data.get('calculations')
    if not isinstance(entries,list):raise ValueError('calculations须为列表')
    results=[];mapping={};errors=[]
    for c in entries:
        if not isinstance(c,dict):raise ValueError('计算项须为对象')
        ident=c.get('id')
        if not isinstance(ident,str) or not ident or any(x in ident for x in '|\n\r') or ident in mapping:raise ValueError('id须为不含表格分隔符的唯一单行文本')
        op=c.get('operation');raw=c.get('values')
        if op not in ('sum','mean','difference','absoluteDifference','ratio','percent','constant'):raise ValueError('不支持的计算操作')
        if raw is not None and not isinstance(raw,list):raise ValueError('values须为列表或null')
        vals=None if raw is None else [literal(v) for v in raw];value=None;reason=None
        if vals is None or any(v is None for v in vals):reason='输入未知；不补0'
        elif op in ('ratio','percent','difference','absoluteDifference') and len(vals)!=2:raise ValueError(op+'须有两个操作数')
        elif op=='constant' and len(vals)!=1:raise ValueError('constant须有一个操作数')
        elif op=='mean' and not vals:reason='分母为0；不能计算均值'
        elif op in ('ratio','percent') and vals[1]==0:reason='分母为0；不能计算比例'
        elif op=='sum':value=sum(vals,F(0))
        elif op=='mean':value=sum(vals,F(0))/len(vals)
        elif op=='difference':value=vals[0]-vals[1]
        elif op=='absoluteDifference':value=abs(vals[0]-vals[1])
        elif op in ('ratio','percent'):value=vals[0]/vals[1]
        else:value=vals[0]
        row={'id':ident,'operation':op,'inputs':None if vals is None else [None if v is None else str(v) for v in vals],'result':metric(value,precision,op=='percent'),'reason':reason};results.append(row);mapping[ident]=(value,op)
    claims=[]
    for c in data.get('claims',[]):
        if not isinstance(c,dict) or c.get('calculationId') not in mapping:raise ValueError('断言须引用本轮计算id')
        value,op=mapping[c['calculationId']];claimed=literal(c.get('value'));relation=c.get('relation','=')
        if relation not in ('=','≈'):raise ValueError('断言关系只允许=或≈')
        if value is None or claimed is None:passed=None;why='数值未知/分母0，断言待核，不称通过'
        else:
            tolerance=F(1,2*10**precision)/(100 if op=='percent' else 1)
            passed=(value==claimed) if relation=='=' else abs(value-claimed)<=tolerance
            why='精确等式相等' if passed and relation=='=' else '近似值处于本次显示半单位误差内' if passed else '不等价或超出显示精度容差，拒绝断言；不能简单换≈掩盖真错'
            if not passed:errors.append(c['calculationId'])
        claims.append({'calculationId':c['calculationId'],'relation':relation,'claimedValue':None if claimed is None else str(claimed),'passed':passed,'reason':why})
    sections=data.get('sections',[]);required=data.get('requiredSections',[])
    if not isinstance(sections,list) or not isinstance(required,list):raise ValueError('sections与requiredSections须为列表')
    ids=set();rendered=[]
    for section in sections:
        if not isinstance(section,dict) or not isinstance(section.get('id'),str) or not section['id'] or section['id'] in ids:raise ValueError('正文section须有唯一id')
        ident=section['id'];ids.add(ident);title=section.get('title');text=section.get('text')
        if not isinstance(title,str) or not title.strip() or not isinstance(text,str) or not text.strip():raise ValueError('正文章节须有实际标题与完整文本，不能空占位')
        def replace(match):
            key=match.group(1)
            if key not in mapping:raise ValueError('正文引用未知计算id：'+key)
            row=next(r for r in results if r['id']==key)
            return row['result']['text'] if row['result'] is not None else '待补/不可计算'
        rendered.append({'id':ident,'title':title,'text':re.sub(r'\{\{([^{}]+)\}\}',replace,text)})
    if any(not isinstance(x,str) for x in required) or len(set(required))!=len(required):raise ValueError('requiredSections须为唯一章节id列表')
    if data.get('documentRequired') and (not sections or not required):raise ValueError('专家完整正文必需；仅数值页不能交付评分包')
    missing=sorted(set(required)-ids)
    if missing:raise ValueError('缺必需正文：'+','.join(missing))
    return {'documentSections':rendered,'requiredSections':required,'documentPresenceChecked':bool(sections) and not missing,'documentSemanticReview':'章节存在不等于内容达标，仍须独立审阅完整量规/锚例/议程','results':results,'claims':claims,'failedClaims':errors,'valid':not errors,'precision':precision,'scope':'仅已给输入的精确算术与显示复核；不裁定学生成绩，不证明现实成效。'}


def markdown(r):
    lines=['# 完整评分包' if r['documentSections'] else '# 仅数值附件（未提供专家完整正文）','']
    for section in r['documentSections']:lines+=['## '+section['title'],'',section['text'],'']
    lines+=['## 同次精确数值附件','','|本轮统计|精确基础值|可复制显示|状态|','|---|---:|---|---|']
    for row in r['results']:lines.append('|'+row['id']+'|'+(row['result']['exactBaseValue'] if row['result'] else '待补/不可算')+'|'+(row['result']['text'] if row['result'] else '待补/不可算')+'|'+(row['reason'] or '按原输入计算')+'|')
    lines+=['','|显示断言|关系|通过状态|原因|','|---|---|---|---|']
    lines+=['|'+x['calculationId']+'|'+x['relation']+'|'+str(x['passed'])+'|'+x['reason']+'|' for x in r['claims']]
    return normalize('\n'.join(lines)+'\n'+r['scope']+'\n')


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:
        result=calculate(json.loads(Path(a.input).read_text(),parse_float=Decimal));print(markdown(result) if a.format=='markdown' else json.dumps(result,ensure_ascii=False,indent=2));return 0 if result['valid'] else 2
    except (ValueError,TypeError,KeyError,AttributeError,ArithmeticError,OSError) as e:
        print(json.dumps({'valid':False,'error':str(e),'scope':'输入/断言待核，未得到有效统计结论'},ensure_ascii=False));return 2

if __name__=='__main__':raise SystemExit(main())
