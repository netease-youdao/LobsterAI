#!/usr/bin/env python3
"""Offline, proposed dock appointments; one result feeds JSON and Markdown."""
import argparse
import json
import sys
from pathlib import Path
from datetime import date


def integer(v, field, low=0):
    if isinstance(v, bool) or not isinstance(v, int) or v < low:
        raise ValueError(field + ': 必须为不小于' + str(low) + '的整数')
    return v


def minute(v):
    if not isinstance(v, str) or len(v) != 5 or v[2] != ':':
        raise ValueError('时刻须为同日HH:MM；跨日须另拆日期窗口')
    try:
        h, m = map(int, v.split(':'))
    except ValueError:
        raise ValueError('时刻须为HH:MM') from None
    if not 0 <= h < 24 or not 0 <= m < 60:
        raise ValueError('时刻越界')
    return h * 60 + m


def hh(v):
    if v is None:
        return '待补'
    if not 0 <= v < 1440:
        raise ValueError('方案跨日，须补日期及次日窗口')
    return f'{v // 60:02}:{v % 60:02}'


def overlap(a, b, x, y):
    return a < y and x < b


def calculate(data):
    if not isinstance(data, dict):
        raise ValueError('根必须为对象')
    if data.get('date') is not None:
        if not isinstance(data['date'],str):
            raise ValueError('date须YYYY-MM-DD字符串或null')
        date.fromisoformat(data['date'])
    scenarios, jobs = data.get('scenarios'), data.get('shipments')
    if not isinstance(scenarios, list) or not scenarios or not isinstance(jobs, list) or not jobs:
        raise ValueError('scenarios和shipments须非空列表；缺资料先交待补表，不能补造数字')
    crew = data.get('sharedCrew')
    if not isinstance(crew, bool):
        raise ValueError('sharedCrew须明确true/false，未知资源不能猜无共享')
    group_status = data.get('actualArrivalStatus')
    if group_status is not None and not isinstance(group_status, dict):
        raise ValueError('actualArrivalStatus须来源已确认的对象或null')
    if group_status is not None and any(v is not None and not isinstance(v,str) for v in group_status.values()):
        raise ValueError('到场回执须来源文字或null，不能用数值推状态')
    parsed = []
    seen = set()
    for j in jobs:
        ident = j.get('id')
        if not isinstance(ident, str) or not ident or ident in seen:
            raise ValueError('shipment id须非空且唯一')
        seen.add(ident)
        dur = integer(j.get('durationMinutes'), ident + '.durationMinutes', 1)
        arr, deadline = minute(j.get('arrival')), minute(j.get('deadline'))
        if arr > deadline:
            raise ValueError(ident + ':到达晚于原截止，先纠正输入')
        allowed = j.get('allowedDocks')
        if not isinstance(allowed, list) or not allowed or any(not isinstance(x, str) for x in allowed):
            raise ValueError(ident + ':须给适配月台列表')
        parsed.append(dict(id=ident, arrival=arr, duration=dur, deadline=deadline, allowed=allowed))
    results = []
    for scene in scenarios:
        docks = scene.get('docks')
        if not isinstance(docks, dict) or not docks:
            raise ValueError('每情境须单独给月台开放时刻与来源')
        opens, closes, busy = {}, {}, {}
        constraints_pending=[]
        def intervals(items, field):
            if items is None:
                constraints_pending.append(field+'未给；本轮只按其余已给条件演算，不代表确认无占用')
                return []
            if not isinstance(items,list):
                raise ValueError(field+'须区间列表或null')
            result=[]
            for block in items:
                a,b=minute(block.get('start')),minute(block.get('end'))
                if a>=b or not isinstance(block.get('source'),str) or not block['source']:
                    raise ValueError(field+'须开始早于结束且有来源')
                result.append((a,b))
            merged=[]
            for a,b in sorted(result):
                if merged and a<=merged[-1][1]:merged[-1]=(merged[-1][0],max(merged[-1][1],b))
                else:merged.append((a,b))
            return merged
        for name, window in docks.items():
            opens[name] = minute(window.get('open'))
            closes[name] = minute(window['close']) if window.get('close') is not None else None
            if closes[name] is not None and closes[name] <= opens[name]:
                raise ValueError('开放窗口须同日且关闭晚于开放')
            busy[name]=intervals(window.get('blockedIntervals'),name+'.blockedIntervals')
        crew_busy=intervals(scene.get('sharedCrewIntervals'),'sharedCrewIntervals') if crew else []
        locked=scene.get('existingReservations')
        if locked is None:
            constraints_pending.append('既有/冻结预约未给；不得声称已核全部既有预约')
            locked=[]
        if not isinstance(locked,list):
            raise ValueError('existingReservations须列表或null')
        for record in locked:
            dock=record.get('dock');start,end=minute(record.get('start')),minute(record.get('end'))
            if dock not in opens or start>=end or not record.get('source'):
                raise ValueError('既有/冻结预约须适配月台、有效区间与来源')
            if record.get('id') in seen:
                raise ValueError('冻结预约不能再次放入待排车辆，先从shipments移除')
            if start<opens[dock] or (closes[dock] is not None and end>closes[dock]) or any(overlap(start,end,a,b) for a,b in busy[dock]):
                raise ValueError('冻结预约与开放/停用/既有预约冲突，须人工裁定原值，不静默移动')
            busy[dock].append((start,end))
            if crew:
                if any(overlap(start,end,a,b) for a,b in crew_busy):
                    raise ValueError('冻结预约与共享班组已有占用冲突，须先裁定')
                crew_busy.append((start,end))
        rows = []
        deadlines = scene.get('deadlineOverrides', {})
        order = sorted(parsed, key=lambda j: (minute(deadlines[j['id']]) if j['id'] in deadlines else j['deadline'], j['arrival'], j['id']))
        for j in order:
            deadline = minute(deadlines[j['id']]) if j['id'] in deadlines else j['deadline']
            choices = []
            lower = []
            for dock in j['allowed']:
                if dock not in opens:
                    continue
                start = max(opens[dock], j['arrival'])
                lower.append(start + j['duration'])
                intervals = busy[dock] + (crew_busy if crew else [])
                while True:
                    end = start + j['duration']
                    hits = [b for a, b in intervals if overlap(start, end, a, b)]
                    if not hits:
                        break
                    start = max(hits)
                end = start + j['duration']
                if end <= deadline and (closes[dock] is None or end <= closes[dock]):
                    choices.append((start, end, dock))
            row = dict(id=j['id'], arrival=hh(j['arrival']), deadline=hh(deadline), durationMinutes=j['duration'], actualArrivalStatus=(group_status or {}).get(j['id']) or '待反馈；未提供回执不代表未到场')
            if not choices:
                earliest = min(lower) if lower else None
                row.update(dock=None, start=None, end=None, waitingMinutes=None, feasible=False, earliestFinishIgnoringOtherJobs=hh(earliest) if earliest is not None else None, unavoidableDeadlineMissMinutes=max(earliest-deadline, 0) if earliest is not None else None, reason='当前排序/适配/截止与资源条件下无可排档；不是全局不可行证明')
                if earliest is not None and earliest > deadline:
                    row['reason'] = '即使独占适配月台也晚于截止，原约束不可行；调整优先级不能修复'
            else:
                start, end, dock = min(choices)
                busy[dock].append((start, end))
                if crew:
                    crew_busy.append((start, end))
                row.update(dock=dock, start=hh(start), end=hh(end), startMinute=start, endMinute=end, waitingMinutes=start-j['arrival'], feasible=True, condition='方案待确认；开放结束未给时须确认覆盖本时段' if closes[dock] is None else '方案待确认')
            rows.append(row)
        # Stop intervals may overlap one another, but no newly scheduled job may
        # overlap any prior block; each insertion checked against the whole list.
        if crew:
            seq = sorted(crew_busy)
            assert all(seq[i][1] <= seq[i+1][0] for i in range(len(seq)-1))
        notices = []
        for r in rows:
            if r['feasible']:
                text = f"{r['id']}到货预约草案：建议{r['start']}到{r['dock']}月台，预计占用至{r['end']}；按原可到{r['arrival']}测算等待{r['waitingMinutes']}分钟。请确认新到达时刻与开放窗口；尚未预约或发送。"
            else:
                text = f"{r['id']}原截止{r['deadline']}下未排成；{r['reason']}。请确认是否调整截止或改日预约；本稿未取消原约、未发送。"
            notices.append(dict(id=r['id'], text=text, characters=len(text)))
        gaps = []
        for dock, intervals in busy.items():
            cursor = opens[dock]
            for a, b in sorted(intervals):
                a=max(a,opens[dock])
                if closes[dock] is not None:b=min(b,closes[dock])
                if a>=b:continue
                if cursor < a:
                    gaps.append(dict(dock=dock, start=hh(cursor), end=hh(a), minutes=a-cursor))
                cursor = max(cursor,b)
            if closes[dock] is not None and cursor < closes[dock]:
                gaps.append(dict(dock=dock, start=hh(cursor), end=hh(closes[dock]), minutes=closes[dock]-cursor))
        occupied = sum(r['durationMinutes'] for r in rows if r['feasible'])
        results.append(dict(label=scene.get('label', '未命名情境'), source=scene.get('source', '待补来源'), deadlineOverrides=deadlines, rows=rows, occupiedDockMinutes=occupied, unoccupiedGaps=gaps, notices=notices, overallFeasible=all(r['feasible'] for r in rows),constraintsPending=constraints_pending,existingReservationCount=len(locked)))
    return dict(status='条件预约草案；实际到场、预约与作业状态仅按用户回执', date=data.get('date') or '日期待补；仅按同日分钟演算', sharedCrew=crew, scenarios=results)


def mdcell(value):
    return str(value).replace('|','&#124;').replace('\r\n','<br>').replace('\n','<br>').replace('\r','<br>')


def render(result):
    out = [result['status'], '日期：'+result['date']]
    for s in result['scenarios']:
        out += ['\n情境：'+s['label']+'；来源：'+s['source'], '|车次|原可到|截止|建议月台|开始|结束|占台分|原到达口径等待分|状态|', '|---|---|---|---|---|---|---:|---:|---|']
        for r in s['rows']:
            out.append('|'+ '|'.join(mdcell(r.get(k) if r.get(k) is not None else '不可排/待补') for k in ['id','arrival','deadline','dock','start','end','durationMinutes','waitingMinutes'])+'|'+mdcell('草案待确认' if r['feasible'] else r['reason'])+'|')
        out.append('')
        for r in s['rows']:
            if not r['feasible'] and r.get('unavoidableDeadlineMissMinutes'):
                out.append(f"{r['id']}独占最早结束{r['earliestFinishIgnoringOtherJobs']}，比截止{r['deadline']}晚{r['unavoidableDeadlineMissMinutes']}分钟。")
            out.append('实际到场：'+r['actualArrivalStatus'])
        out.append('已排占台合计：'+str(s['occupiedDockMinutes'])+'分钟；不把空档与已占用混记。')
        if s['constraintsPending']:out.append('适用条件待确认：'+'；'.join(s['constraintsPending']))
        out.append('已核连续空档：'+(json.dumps(s['unoccupiedGaps'],ensure_ascii=False) if s['unoccupiedGaps'] else '本轮已知窗口中无可列空档；未知关闭时刻不推无限空档'))
        for n in s['notices']:
            out.append(n['text']+'\n全文字符数：'+str(n['characters']))
    return '\n'.join(out)


def main():
    p = argparse.ArgumentParser();p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');args=p.parse_args()
    try:
        result=calculate(json.loads(Path(args.input).read_text()))
    except (ValueError,TypeError,KeyError,AttributeError,OSError) as e:
        print('输入待纠正：'+str(e),file=sys.stderr);return 2
    print(json.dumps(result,ensure_ascii=False,indent=2) if args.format=='json' else render(result));return 0


if __name__=='__main__':
    raise SystemExit(main())
