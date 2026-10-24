#!/usr/bin/env python3
"""标准库离线计算：JSON输入，JSON或可复制Markdown输出；不连接外部服务。"""
import argparse
import json
import sys
from decimal import Decimal, InvalidOperation


def dec(v):
    if isinstance(v, bool) or v is None:
        raise ValueError('数值缺失或类型错误')
    try:
        x = Decimal(str(v))
    except InvalidOperation as e:
        raise ValueError('数值无效') from e
    if not x.is_finite():
        raise ValueError('数值必须有限')
    return x


def integer(v):
    x = dec(v)
    if x != x.to_integral_value() or x < 0:
        raise ValueError('数量必须为非负整数')
    return int(x)


def num(x):
    return format(x, 'f') if isinstance(x, Decimal) else x


def solve(d):
    budget, fixed = dec(d['budget']), dec(d['fixedCost'])
    if budget < 0 or fixed < 0:
        raise ValueError('预算与固定费用不能为负')
    products = d['products']
    ids = [p['id'] for p in products]
    if len(set(ids)) != len(ids) or not ids:
        raise ValueError('款型编号必须唯一且非空')
    for p in products:
        if dec(p['price']) <= 0 or integer(p['moq']) < 1 or integer(p['increment']) < 1:
            raise ValueError('价格、起订量、增量必须为正')
    resolved = d.get('resolvedBranch')
    branches = d['branches']
    if not branches or not d['designs']:
        raise ValueError('至少需要一个分支和一个候选方案')
    if len({b['id'] for b in branches}) != len(branches):
        raise ValueError('分支编号重复')
    if resolved is not None and resolved not in {b['id'] for b in branches}:
        raise ValueError('已确认分支不存在')
    designs = d['designs']
    if len({a['id'] for a in designs}) != len(designs):
        raise ValueError('方案编号重复')
    result = {'inputStatus': d['inputStatus'], 'resolvedBranch': resolved,
              'budget': num(budget), 'fixedCost': num(fixed), 'branches': []}
    for branch in branches:
        supplies = branch['availability']
        if set(supplies) != set(ids):
            raise ValueError('每个分支必须逐款填写可供量，未知用null，充足用字符串充足')
        limits = {i: None if supplies[i] in (None, '充足') else integer(supplies[i]) for i in ids}
        unknown = [i for i in ids if supplies[i] is None]
        minimum = sum(dec(p['price']) * integer(p['moq']) for p in products)
        minok = minimum + fixed <= budget and all(limits[p['id']] is None or integer(p['moq']) <= limits[p['id']] for p in products)
        out = {'id': branch['id'], 'condition': branch['condition'],
               'state': '已确认口径下建议' if resolved == branch['id'] else '口径待确认的条件候选',
               'minimumGoods': num(minimum), 'minimumRemaining': num(budget-fixed-minimum),
               'minimumKnownConstraintsFeasible': minok, 'unknownAvailability': unknown, 'designs': []}
        for design in designs:
            if set(design['quantity']) != set(ids):
                raise ValueError('方案采购数量须逐款齐全')
            rows, errors, pending = [], [], list(unknown)
            for p in products:
                i = p['id']; requested = integer(design['quantity'][i]); q = requested
                moq, step = integer(p['moq']), integer(p['increment'])
                if design.get('capToAvailable') and limits[i] is not None and q > limits[i]:
                    cap = limits[i]
                    q = 0 if cap < moq else moq + ((cap-moq)//step)*step
                if q and (q < moq or (q-moq) % step):
                    errors.append(i+'不符合起订后增量')
                if limits[i] is not None and q > limits[i]:
                    errors.append(i+'超过可供量')
                if d.get('requireAllProducts', True) and not q:
                    errors.append(i+'未覆盖')
                allocation = design['allocation'][i]
                consumption = integer(allocation['consumed'])
                display = min(integer(allocation['displayTarget']), max(0, q-consumption))
                reserve = q-display-consumption
                if reserve < 0:
                    errors.append(i+'消耗超过采购')
                rows.append({'sku': i, 'requested': requested, 'quantity': q,
                             'amount': num(dec(p['price'])*q), 'display': display,
                             'reserve': reserve, 'consumed': consumption,
                             'allocationBasis': allocation['basis']})
            cost = sum(dec(row['amount']) for row in rows)
            remaining = budget-fixed-cost
            if remaining < 0:
                errors.append('超过预算')
            display = sum(row['display'] for row in rows)
            capacity = d.get('displayCapacity')
            if capacity is None:
                pending.append('实际陈列容量')
            elif display > integer(capacity):
                errors.append('超过陈列容量')
            for row in rows:
                row['amountSharePercent'] = num((dec(row['amount'])/cost*100).quantize(Decimal('0.01'))) if cost else None
            item = {'id': design['id'], 'parentId': design.get('parentId'),
                    'rows': rows, 'goods': num(cost), 'fixed': num(fixed),
                    'remaining': num(remaining), 'quantity': sum(x['quantity'] for x in rows),
                    'display': display, 'reserve': sum(x['reserve'] for x in rows),
                    'consumed': sum(x['consumed'] for x in rows),
                    'knownConstraintsFeasible': not errors, 'errors': errors,
                    'pending': pending, 'allocationConditional': any(x['allocationBasis'] != '用户确认' for x in rows)}
            item['conservation'] = item['display']+item['reserve']+item['consumed'] == item['quantity'] and all(x['display']+x['reserve']+x['consumed']==x['quantity'] for x in rows)
            out['designs'].append(item)
        lookup = {x['id']: x for x in out['designs']}
        for item in out['designs']:
            parent = item['parentId']
            if parent is not None:
                if parent not in lookup:
                    raise ValueError('对照方案编号不存在')
                old = lookup[parent]
                item['changeAgainst'] = parent
                item['changes'] = {k: num(dec(item[k])-dec(old[k])) for k in ('goods','remaining','quantity','display','reserve','consumed')}
                item['skuChanges'] = [{'sku': new['sku'], **{k:num(dec(new[k])-dec(prev[k])) for k in ('quantity','amount','display','reserve','consumed')}} for prev,new in zip(old['rows'],item['rows'])]
        feasible = [x for x in out['designs'] if x['knownConstraintsFeasible']]
        out['largestRemainingAmongListed'] = [x['id'] for x in feasible if dec(x['remaining']) == max(dec(y['remaining']) for y in feasible)] if feasible else []
        result['branches'].append(out)
    result['weekly'] = []
    for row in d.get('weekly', []):
        fields = ('opening','incoming','sold','given','damaged','transferOut')
        values = {k: row.get(k) for k in fields}
        missing = [k for k,v in values.items() if v is None]
        closing = None if missing else sum((1 if k in ('opening','incoming') else -1)*integer(v) for k,v in values.items())
        if closing is not None and closing < 0:
            raise ValueError('周末库存为负，需核对流水')
        result['weekly'].append({'sku':row['sku'],'basis':row['basis'],'closing':closing,'pending':missing})
    return result


def markdown(r):
    lines = [f"资料性质：{r['inputStatus']}；商品预算{r['budget']}元，固定支出{r['fixedCost']}元。"]
    for branch in r['branches']:
        lines += ['',f"条件：{branch['condition']}；{branch['state']}。",'|方案ID|采购件|商品元|未动用元|陈列/备用/消耗|已知约束|待补|','|---|---:|---:|---:|---|---|---|']
        for a in branch['designs']:
            lines.append(f"|{a['id']}|{a['quantity']}|{a['goods']}|{a['remaining']}|{a['display']}/{a['reserve']}/{a['consumed']}|{'符合' if a['knownConstraintsFeasible'] else '不符合：'+','.join(a['errors'])}|{','.join(a['pending']) or '无'}|")
            lines += ['',f"{a['id']}明细（分配依据逐款保留）：",'|款型|采购|金额元|陈列|备用|消耗|依据|','|---|---:|---:|---:|---:|---:|---|']
            for row in a['rows']:
                lines.append('|'+ '|'.join(str(row[k]) for k in ('sku','quantity','amount','display','reserve','consumed','allocationBasis'))+'|')
            if a.get('changeAgainst'):
                lines.append(f"精确对照{a['changeAgainst']}："+json.dumps(a['skuChanges'],ensure_ascii=False))
        lines.append('仅在以上已列可行候选中，未动用余额最大：'+','.join(branch['largestRemainingAmongListed'])+'；未证明全局最优。')
        lines.append(f"可复制通知：若{branch['condition']}确认有效，可评审采用上表对应方案；{r['inputStatus']}资料中的假设分配继续保留假设标记，未确认前不选择有效来源、不下单。")
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('input',nargs='?',default='-'); p.add_argument('--format',choices=('json','markdown'),default='json'); a=p.parse_args()
    try:
        d=json.load(sys.stdin) if a.input=='-' else json.loads(open(a.input,encoding='utf-8').read())
        r=solve(d)
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,ArithmeticError,OSError) as e:
        print(json.dumps({'status':'输入待核','reason':str(e)},ensure_ascii=False)); return 2
    print(markdown(r) if a.format=='markdown' else json.dumps(r,ensure_ascii=False,indent=2)); return 0


if __name__=='__main__':
    raise SystemExit(main())
