#!/usr/bin/env python3
"""Render one project pack and validate its schedule/resources/action change ledger."""
from gfm_tables import normalize, cell
import copy,re
import argparse
import json
import sys
from fractions import Fraction as F
from pathlib import Path


def q(x, field):
    if x is None or isinstance(x,bool):raise ValueError(field+': 缺失或类型无效')
    try:v=F(str(x))
    except (ValueError,ZeroDivisionError):raise ValueError(field+': 须为有限数值') from None
    if v<0:raise ValueError(field+': 不得负')
    return v


def label(x, field):
    if not isinstance(x,str) or not x.strip() or any(c in x for c in '|\n\r'):raise ValueError(field+': 须为非空单行文本且不含表格分隔符')
    return x


def base_calculate(data):
    if not isinstance(data,dict):raise ValueError('根输入须为对象')
    actors=data.get('actors');plans=data.get('plans')
    if not isinstance(actors,list) or not actors or len(set(actors))!=len(actors):raise ValueError('actors须为唯一资源ID列表')
    for a in actors:label(a,'actor')
    if not isinstance(plans,list) or not plans:raise ValueError('plans须为非空列表')
    participants=data.get('participantIds',[]);groups=data.get('groups',{})
    if not isinstance(participants,list) or len(set(participants))!=len(participants) or set(participants)-set(actors):raise ValueError('participantIds须为已定义不重复学生资源')
    if not isinstance(groups,dict):raise ValueError('groups须为组ID到学生ID的对象')
    grouped=[]
    for group,who in groups.items():
        label(group,'组id')
        if not isinstance(who,list) or not who or len(set(who))!=len(who) or set(who)-set(participants):raise ValueError('组成员无效')
        grouped+=who
    if groups and (len(set(grouped))!=len(grouped) or set(grouped)!=set(participants)):raise ValueError('组应完整且不重复覆盖本轮学生')
    allresults=[];plannames=set()
    for plan in plans:
        pid=label(plan.get('id'),'方案id')
        if pid in plannames:raise ValueError('方案id重复')
        plannames.add(pid);lessons=plan.get('lessons')
        if not isinstance(lessons,list):raise ValueError('lessons须为列表')
        ids=set();lessonids=set();lessons_out=[];totals={};locs={};violations=[];plan_budget=F(0);allbudgets=True
        for lesson in lessons:
            lid=label(lesson.get('id'),'课次id')
            if lid in lessonids:raise ValueError('课次id重复')
            lessonids.add(lid);budget=None if lesson.get('budgetMinutes') is None else q(lesson['budgetMinutes'],'课时预算');activities=lesson.get('activities')
            if not isinstance(activities,list):raise ValueError('activities须为列表')
            if budget is None:allbudgets=False
            else:plan_budget+=budget
            output=[];intervals={a:[] for a in actors};events=[];latest=F(0)
            for activity in activities:
                ident=label(activity.get('id'),'活动唯一id');action=label(activity.get('actionId'),'动作id')
                if ident in ids:raise ValueError('活动id重复，同一时间不得归属两处：'+ident)
                ids.add(ident);start=q(activity.get('start'),'开始分钟');duration=q(activity.get('minutes'),'动作分钟');end=start+duration;who=activity.get('actors')
                if not isinstance(who,list) or not who or len(set(who))!=len(who) or set(who)-set(actors):raise ValueError('活动资源须为已定义且不重复的具体人/教师ID')
                for actor in who:
                    for oldstart,oldend,oldid in intervals[actor]:
                        if start<oldend and oldstart<end and duration>0 and oldend>oldstart:violations.append({'kind':'resourceOverlap','lesson':lid,'actor':actor,'activities':[oldid,ident]})
                    intervals[actor].append((start,end,ident));totals.setdefault(action,{});totals[action][actor]=totals[action].get(actor,F(0))+duration
                locs.setdefault(action,[]).append({'lesson':lid,'activity':ident,'actors':who,'minutes':str(duration)})
                if budget is not None and end>budget:violations.append({'kind':'overBudget','lesson':lid,'activity':ident,'end':str(end),'budget':str(budget),'excess':str(end-budget)})
                latest=max(latest,end);events.append((start,end));output.append({'id':ident,'actionId':action,'name':label(activity.get('name',action),'动作名'),'start':str(start),'minutes':str(duration),'end':str(end),'actors':who,'actorCount':len(who),'actorMinutes':str(duration*len(who)),'product':activity.get('product','待补'),'condition':activity.get('condition','待确认；不表示现场已执行')})
            merged=[]
            for start,end in sorted(events):
                if merged and start<=merged[-1][1]:merged[-1][1]=max(merged[-1][1],end)
                else:merged.append([start,end])
            coverage=sum((b-a for a,b in merged),F(0));actor_idle={}
            for actor,slots in intervals.items():
                union=[]
                for aa,bb,_ in sorted(slots):
                    if budget is not None:
                        aa=max(F(0),aa);bb=min(budget,bb)
                        if bb<=aa:continue
                    if union and aa<=union[-1][1]:union[-1][1]=max(union[-1][1],bb)
                    else:union.append([aa,bb])
                covered=sum((bb-aa for aa,bb in union),F(0));actor_idle[actor]=None if budget is None else str(max(F(0),budget-covered))
            lessons_out.append({'id':lid,'actorUnassignedMinutes':actor_idle,'budgetMinutes':None if budget is None else str(budget),'activities':output,'latestEnd':str(latest),'unionCoveredMinutes':str(coverage),'unassignedClassMinutes':None if budget is None else str(max(F(0),budget-coverage)),'budgetCheckKnown':budget is not None})
        allresults.append({'id':pid,'lessons':lessons_out,'totalLessonBudgetMinutes':str(plan_budget) if allbudgets else None,'allLessonBudgetsKnown':allbudgets,'violations':violations,'feasibleUnderListedResources':not violations if allbudgets else None,'actionActorMinutes':{k:{a:str(v) for a,v in by.items()} for k,by in totals.items()},'actionLocations':locs,'condition':plan.get('condition','适用条件待确认'),'executionState':plan.get('executionState') if plan.get('executionState') is not None else '现场是否已执行待用户回执；此处仅为设计'})
    base=allresults[0];changes=[]
    for new in allresults[1:]:
        actions=sorted(set(base['actionActorMinutes'])|set(new['actionActorMinutes']));rows=[]
        for action in actions:
            old=base['actionActorMinutes'].get(action,{});now=new['actionActorMinutes'].get(action,{});people=sorted(set(old)|set(now));per=[]
            for actor in people:
                before=F(old.get(actor,'0'));after=F(now.get(actor,'0'));per.append({'actor':actor,'beforeMinutes':str(before),'afterMinutes':str(after),'reductionMinutes':str(before-after),'absenceMeaning':'缺动作表示该版本显式日程无此动作；不代表现场未发生'})
            rows.append({'actionId':action,'sameActorSet':set(old)==set(now),'perActor':per,'beforeActorMinutes':str(sum(map(F,old.values()),F(0))),'afterActorMinutes':str(sum(map(F,now.values()),F(0))),'reductionActorMinutes':str(sum(map(F,old.values()),F(0))-sum(map(F,now.values()),F(0))),'oldLocations':base['actionLocations'].get(action,[]),'newLocations':new['actionLocations'].get(action,[])})
        changes.append({'baseline':base['id'],'candidate':new['id'],'rows':rows,'rule':'同动作同参与者分钟比较；不同参与者集合须另看逐人行，不能把组分钟当全班耗时'})
    deliver=data.get('deliverables',{})
    if not isinstance(deliver,dict):raise ValueError('deliverables须为对象')
    cards=data.get('products',[])
    if not isinstance(cards,list):raise ValueError('products须为列表')
    products=[]
    for card in cards:
        if card.get('plan') is not None and card['plan'] not in plannames:raise ValueError('产物归属须为本轮已列方案ID')
        ids=card.get('actorIds');groups=card.get('groupIds')
        if ids is not None:
            if not isinstance(ids,list) or len(set(ids))!=len(ids) or set(ids)-set(actors):raise ValueError('个人卡actorIds无效或重复')
            qty=len(ids);basis='具体参与者ID'
        elif groups is not None:
            if not isinstance(groups,list) or len(set(groups))!=len(groups):raise ValueError('组记录groupIds无效或重复')
            qty=len(groups);basis='组ID，不当人数'
        else:qty=None;basis='数量依据待补'
        action=card.get('actionId');verified=None
        if card.get('allParticipants') and (not participants or ids is None or set(ids)!=set(participants)):raise ValueError('全员个人产物必须覆盖所有已给学生ID')
        if action is not None:
            if card.get('plan') is None:raise ValueError('产物活动绑定须给方案ID')
            selected=next(x for x in allresults if x['id']==card['plan']);occ=[x for lesson in selected['lessons'] for x in lesson['activities'] if x['actionId']==action]
            if ids is not None:
                if any(sum(actor in x['actors'] for x in occ)!=1 for actor in ids):raise ValueError('个人产物须有恰好一次对应动作：'+card['name'])
            elif groups is not None:
                definitions=data.get('groups',{})
                if set(groups)-set(definitions):raise ValueError('组产物含未定义组')
                if any(sum(set(x['actors'])&set(participants)==set(definitions[g]) for x in occ)!=1 for g in groups):raise ValueError('组产物须恰好对应一次该组动作')
            verified=True
        if card.get('actualReceived') is not None and (type(card['actualReceived']) is not int or card['actualReceived']<0):raise ValueError('实际回执数量须为非负整数或null')
        products.append({'actionBindingVerified':verified,'name':label(card.get('name'),'产物名'),'count':qty,'basis':basis,'plan':card.get('plan'),'actualReceived':card.get('actualReceived') if card.get('actualReceived') is not None else None})
    byplan={p['id']:p for p in allresults};claims=[]
    for claim in data.get('changeClaims',[]):
        old=byplan[claim['baseline']];new=byplan[claim['candidate']];actor=claim['actor'];actions=claim['actionIds']
        if actor not in actors or not isinstance(actions,list) or not actions or len(set(actions))!=len(actions):raise ValueError('变更断言须指定唯一动作集合与具体参与者')
        before=sum((F(old['actionActorMinutes'].get(k,{}).get(actor,'0')) for k in actions),F(0));after=sum((F(new['actionActorMinutes'].get(k,{}).get(actor,'0')) for k in actions),F(0));actual={'beforeMinutes':before,'afterMinutes':after,'reductionMinutes':before-after}
        checks={k:F(str(claim[k]))==v for k,v in actual.items() if k in claim};claims.append({'baseline':old['id'],'candidate':new['id'],'actor':actor,'actionIds':actions,**{k:str(v) for k,v in actual.items()},'passed':all(checks.values()),'checks':checks})
    requirement=data.get('requirement');req=None
    if requirement is not None:
        groups=q(requirement.get('groups'),'需求组数');each=q(requirement.get('minutesPerGroup'),'每组分钟');lecture=q(requirement.get('lectureMinutes'),'讲解分钟');budget=q(requirement.get('budgetMinutes'),'需求窗口')
        if groups.denominator!=1:raise ValueError('组数须整数')
        demand=groups*each+lecture;req={'serialDemandMinutes':str(demand),'budgetMinutes':str(budget),'excessMinutes':str(max(F(0),demand-budget)),'fits':demand<=budget,'scope':'原串行需求核算；不把超时需求当候选已执行'}
    valid=all(not p['violations'] for p in allresults) and all(c['passed'] for c in claims)
    return {'valid':valid,'changeClaims':claims,'requirement':req,'plans':allresults,'changes':changes,'deliverables':deliver,'products':products,'state':data.get('state') if data.get('state') is not None else '实际班级反馈、发放与执行回执待补','qualityBoundary':data.get('qualityBoundary','压缩只表示纸面时间减少，不保证学习质量不变；教师应确认简化的作品规格与反馈要求'),'scope':'课时并集分钟、逐人资源与同动作变更账分别核；工具未实施教学或回收卡片。'}


ROLE_NAMES={'individual':'个人成品','feedback':'本方案个人反馈','reflection':'个人反思','groupRecord':'本方案组记录','peerFeedback':'保留的试读反馈','groupDraft':'保留的小组建议单'}
MANDATORY=('individual','feedback','reflection','groupRecord')
MATERIALS={'纸','笔','用户给定数字材料'}

def round8_calculate(data):
    if not isinstance(data,dict):raise ValueError('根须对象')
    if data.get('products') or 'requirements' in data:raise ValueError('固定交付不能用独立products/requirements声明降低；由每活动outputs真实生成')
    source=copy.deepcopy(data);context=source.get('context');participants=source.get('participantIds');groups=source.get('groups')
    if not isinstance(context,dict)or context.get('participantBasis')not in('design_assumption','user_given'):raise ValueError('须就地明确人数为设计假设或用户已给')
    if not isinstance(participants,list)or not participants or not isinstance(groups,dict)or not groups:raise ValueError('每方案完整交付须有具体学生与组定义')
    if set(context.get('materials',[]))!=MATERIALS:raise ValueError('本纸笔版本仅纸/笔/用户给定数字材料；不能引入未给照片或设备')
    teacher=context.get('teacherId')
    if teacher not in source.get('actors',[])or teacher in participants:raise ValueError('须有独立实际教师资源ID')
    sizes={g:len(who)for g,who in groups.items()};basis=('设计假设，尚待教师确认：'if context['participantBasis']=='design_assumption'else'用户给定分组：')+str(len(groups))+'组，共'+str(len(participants))+'人；各组人数'+json.dumps(sizes,ensure_ascii=False)+'。'
    materials='本版只用纸、笔与用户给定数字材料；不依赖照片、计算器、联网或实地任务。'
    rawplans=source.get('plans');coverage={};products=[];mode_meta={}
    if not isinstance(rawplans,list)or not rawplans:raise ValueError('须有完整计划')
    for plan in rawplans:
        if 'condition'in plan:raise ValueError('方案条件由当前presentation/课时字段生成，不接受复制旧condition')
        pid=plan['id'];presentation=plan.get('presentation')
        if not isinstance(presentation,dict)or presentation.get('mode')not in('baseline_single_demo','parallel','shortened','serial_extended'):raise ValueError('须明确本方案展示方式，不能自由复制时长条件')
        mode=presentation['mode'];occ={role:{key:[]for key in(groups if role=='groupRecord'else participants)}for role in MANDATORY};allcards=[];station=[]
        for lesson in plan['lessons']:
            for activity in lesson['activities']:
                if 'condition'in activity:raise ValueError('活动条件由本方案结构生成，禁止复制旧时长/总课时condition')
                if set(activity.get('materials',[]))-MATERIALS:raise ValueError('活动使用了未给材料')
                body=' '.join(str(activity.get(k,''))for k in('name','product','teacherTask','studentTask'))
                if any(w in body for w in('照片','手机','计算器','联网','实地')):raise ValueError('活动正文引入本纸笔版未给资源；请直接使用数字材料')
                if re.search(r'\d+(?:\.\d+)?\s*(?:分钟|课时|份|张|组|人)',body):raise ValueError('活动时长由start/minutes生成，正文不另复制数字条件')
                output=activity.get('outputs')
                if not isinstance(output,list):raise ValueError('活动须明确outputs列表，无产物写[]')
                for card in output:
                    role=card.get('role')
                    if role not in ROLE_NAMES:raise ValueError('产物role无效')
                    name=card.get('name');actual=card.get('actualReceived')
                    if not isinstance(name,str)or not name.strip():raise ValueError('实际产物须具体名称')
                    if re.search(r'\d+\s*(?:份|张|组|人)',name):raise ValueError('产物名不另写人数/份数；由实际ID列表生成')
                    if actual is not None and(type(actual)is not int or actual<0):raise ValueError('回执须非负整数或null')
                    keys=card.get('groupIds')if role in('groupRecord','groupDraft')else card.get('actorIds')
                    defined=groups if role in('groupRecord','groupDraft')else participants
                    if not isinstance(keys,list)or not keys or len(set(keys))!=len(keys)or set(keys)-set(defined):raise ValueError('产物须具体唯一学生/组ID')
                    students=set(activity['actors'])&set(participants)
                    for key in keys:
                        if role in('groupRecord','groupDraft'):
                            if not set(groups[key])<=students:raise ValueError('组记录对应活动未包含完整本组')
                        elif key not in students:raise ValueError('个人产物未绑定本人实际活动')
                        if F(str(activity['minutes']))<=0:raise ValueError('产物活动分钟须正，不得以0占位')
                        if role in MANDATORY:occ[role][key].append(activity['id'])
                    allcards.append({'name':ROLE_NAMES[role]+'：'+name,'role':role,'count':len(keys),'basis':'具体组ID'if role in('groupRecord','groupDraft')else'具体学生ID','plan':pid,'actualReceived':actual,'activity':activity['id'],'lesson':lesson['id'],'actorOrGroupIDs':keys,'actionBindingVerified':True})
                if activity.get('presentationGroup')is not None:
                    g=activity['presentationGroup']
                    if g not in groups or not set(groups[g])<=set(activity['actors']):raise ValueError('站展组实际活动人员不完整')
                    station.append({'group':g,'start':F(str(activity['start'])),'end':F(str(activity['start']))+F(str(activity['minutes'])),'minutes':F(str(activity['minutes'])),'actors':activity['actors'],'lesson':lesson['id'],'id':activity['id']})
        for role,by in occ.items():
            for key,actions in by.items():
                if len(actions)!=1:raise ValueError(pid+'固定产物'+ROLE_NAMES[role]+'须每个对象恰好一次；'+key+'实际'+str(len(actions))+'次，不能降为0或借用另一方案')
        if mode in('parallel','shortened','serial_extended')and({x['group']for x in station}!=set(groups)or len(station)!=len(groups)):raise ValueError('本方案须每组恰好一次站展，不用其他方案补数')
        if mode=='baseline_single_demo'and len(station)!=1:raise ValueError('正常基线仅一组示范须明确哪组')
        if mode in('shortened','serial_extended','baseline_single_demo')and any(teacher not in x['actors']for x in station):raise ValueError('串行/单组全程听评须占实际教师资源')
        durations=[str(x['minutes'])for x in station];budget=sum(F(str(l['budgetMinutes']))for l in plan['lessons'])if all(l.get('budgetMinutes')is not None for l in plan['lessons'])else None
        if mode=='parallel':
            if presentation.get('evaluation')not in('circulating','full_duration'):raise ValueError('并行须明确巡回或全程评分')
            if presentation['evaluation']=='full_duration'and any(teacher not in x['actors']for x in station):raise ValueError('全程评分须实际占教师资源，不能省掉教师避开冲突')
            if presentation['evaluation']=='circulating':
                patrol=[a for l in plan['lessons']for a in l['activities']if a['actionId']=='巡回观察'and teacher in a['actors']]
                if not patrol or any(not any(l['id']==x['lesson']and a in l['activities']and F(str(a['start']))<=x['start']and F(str(a['start']))+F(str(a['minutes']))>=x['end']for l in plan['lessons']for a in patrol)for x in station):raise ValueError('巡回教师覆盖区间不足')
            flags={k:presentation.get(k)for k in('spaceConfirmed','stationsConfirmed','evaluationConfirmed')}
            if any(v is not None and type(v)is not bool for v in flags.values()):raise ValueError('并行条件仅bool/null')
            condition='仅在场地允许并行、站位已确认且评价允许'+('巡回观察（不等于逐组全程评分）'if presentation['evaluation']=='circulating'else'逐组全程评分')+'时采用；当前确认'+json.dumps(flags,ensure_ascii=False)+'。未全部确认前只交条件草案，不标场地已就绪。'
        elif mode=='shortened':condition='已改变原每组展示规格；本方案每组实际展示分钟'+json.dumps(durations,ensure_ascii=False)+'；串行逐组使用教师，反馈/反思更短，须教师确认学习质量边界。'
        elif mode=='serial_extended':condition='串行完整展示需按本方案实际课次预算确认额外课时，不把原窗口默认加长。'
        else:condition='仅一组示范，其他组书面回应；不宣称每组都完成同长展示。若原新请求要求全组展示，此项仅作旧基线比较。'
        role_counts={k:sum(c['count']for c in allcards if c['role']==k)for k in ROLE_NAMES};condition=basis+materials+'本方案课次预算合计'+('待补'if budget is None else str(budget))+'分钟，展示分钟'+json.dumps(durations,ensure_ascii=False)+'。'+condition+'固定个人成品/反馈/反思各'+str(len(participants))+'份、组记录'+str(len(groups))+'份，均为设计交付，实际回收待回执；保留试读反馈另'+str(role_counts['peerFeedback'])+'份、建议单另'+str(role_counts['groupDraft'])+'份。'
        plan['condition']=condition
        for lesson in plan['lessons']:
            for activity in lesson['activities']:
                activity['product']=activity.get('product','待补')+'；教师：'+activity.get('teacherTask','待补')+'；学生：'+activity.get('studentTask','待补')
                activity['condition']=condition+'本活动'+str(activity['start'])+'起、占'+str(activity['minutes'])+'分钟；现场执行待回执。'
        coverage[pid]={'fixedRequiredRoles':MANDATORY,'coverage':occ,'roleCounts':role_counts,'participantBasis':context['participantBasis'],'materials':sorted(MATERIALS)};products+=allcards;mode_meta[pid]={'mode':mode,'presentationDurations':durations,'condition':condition}
    source['products']=[]
    templates=source.get('deliverables')
    required={'学生任务书','角色卡','完整建议单样稿','教师说明'}
    if not isinstance(templates,dict)or not required<=set(templates):raise ValueError('完整任务书/角色卡/五栏样稿/教师说明不可删')
    for key,text in templates.items():
        if not isinstance(text,str)or not text.strip():raise ValueError('正文不得空')
        if re.search(r'\d+(?:\.\d+)?\s*(?:课时|组|人)|(?:末节|全程|总课时|展示|第\d+节)[^。；\n]{0,24}\d+(?:\.\d+)?\s*分钟',text):raise ValueError('正文人数/课时须引用结构化占位，不复制旧数字条件')
    if '{{group_basis}}'not in templates['学生任务书']or'{{materials}}'not in templates['学生任务书']:raise ValueError('学生任务书须就地引用人数假设与材料条件')
    result=base_calculate(source);result['products']=products;result['productCoverage']=coverage;result['contextSummary']=basis+materials;result['presentationMetadata']=mode_meta
    summary='\n\n'.join('方案'+p['id']+'：'+p['condition']for p in result['plans']);tokens={'group_basis':basis,'materials':materials,'plan_summaries':summary,'request_diagnosis':json.dumps(result['requirement'],ensure_ascii=False)if result['requirement']else'本轮未增加站展强制要求；按正常单组示范方案。'}
    result['deliverables']={k:re.sub(r'\{\{([^{}]+)\}\}',lambda m:tokens[m[1]]if m[1]in tokens else (_ for _ in()).throw(ValueError('未知正文占位')),v)for k,v in templates.items()}
    result['qualityBoundary']='被压缩/删除学习动作按同动作逐人变更账真实列出；减少表示纸面时间变化，不证明学习深度不变。反思与反馈时长更短须教师确认成品规格。每方案四类固定产物均已绑定本方案本人/本组活动；回执未知不补0。'
    return result


SUPPORT_TEMPLATES={'巡读检查单': '学生独立按作品位置逐项检查：原数和单位是否写明，秒是否先换成分钟，乘法结果是否能复算，结论是否注明适用条件；把不明处写为具体问题留待展示组回应。',
 '反馈句式': '学生独立写：我在作品的某处看到某个计算或建议；根据已给的哪个数字或单位，我建议怎样修改。未解决的问题标待核，不把同伴意见当已获专业核验。',
 '反思提示': '学生独立保留自己的计算稿，写原想法、现在改变的一处、改变所依据的数据或单位，以及下一次要核查的地方；没有改变也说明仍需验证的依据。',
 '听众记录单': '学生独立听展示组说明，对照手中数字材料记录一个能复算的步骤和一个待核问题；不要求此时获得即时讲解或评分，疑问保留给后续确认。',
 '展示回应卡': '本组独立按原数据、单位转换、计算、建议、限制的顺序说明作品，依纸面材料回应同伴；无法确认的问题记入待核栏，不自行编答案或声称已被完整评分。'}

SELF_ACTIONS={'presentation': {'actionId': '站展',
                  'supportIds': ['展示回应卡'],
                  'product': '本组站展记录与待核问题，不标已获全程评分',
                  'studentTask': '本组独立按原数据、单位、计算、建议与限制说明作品，用给定材料回应同伴，未解决问题记待核'},
 'peer_read': {'actionId': '巡读提问',
               'supportIds': ['巡读检查单'],
               'product': '按作品位置记录原数、单位或计算的具体待核问题',
               'studentTask': '独立按预给检查单对照作品的原数、单位与计算，记录可指向作品位置的问题'},
 'feedback': {'actionId': '个人反馈',
              'supportIds': ['反馈句式'],
              'product': '带个人署名的具体反馈记录，未核问题单列待补',
              'studentTask': '独立写出指向作品位置的问题、给定材料依据与可执行修改建议，保留个人署名'},
 'reflection': {'actionId': '反思',
                'supportIds': ['反思提示'],
                'product': '带个人署名的反思卡，记录改变及依据或待核处',
                'studentTask': '独立写为何修改一处做法及其依据，保留自己的计算稿，不由组员代填'},
 'audience': {'actionId': '听众学习',
              'supportIds': ['听众记录单'],
              'product': '个人听众记录：可复算步骤与待核问题',
              'studentTask': '独立按预给记录单听说明并核对给定数字，记录可复算步骤和待核问题'}}

def calculate(data):
    if not isinstance(data,dict):raise ValueError('根须对象')
    source=copy.deepcopy(data);context=source.get('context');teacher=context.get('teacherId')if isinstance(context,dict)else None
    if 'supportLibrary'in source:raise ValueError('禁止自由支架文本supportLibrary；仅允许supportTemplateIds固定模板编号')
    selected=source.get('supportTemplateIds')
    if not isinstance(selected,list)or not selected or len(set(selected))!=len(selected)or set(selected)-set(SUPPORT_TEMPLATES):raise ValueError('须选择明确且唯一的固定纸面支架模板；未知不能假定已有')
    supports={ident:SUPPORT_TEMPLATES[ident]for ident in selected};checks=[]
    for plan in source.get('plans',[]):
        providers={};lessons=plan.get('lessons',[])
        for lesson_index,lesson in enumerate(lessons):
            for activity in lesson.get('activities',[]):
                if 'teacherTask'in activity:raise ValueError('禁止自由teacherTask；职责必须由teacherMode与实际教师资源生成')
                mode=activity.get('teacherMode');actors=activity.get('actors',[]);provides=activity.get('providesSupportIds');needs=activity.get('supportIds')
                if mode not in('synchronous','student_self'):raise ValueError('每活动须明确同步教师或独立学生自助，未知不能默认无教师')
                if not isinstance(provides,list)or len(set(provides))!=len(provides)or set(provides)-set(supports):raise ValueError('提供支架编号无效')
                if not isinstance(needs,list)or len(set(needs))!=len(needs)or set(needs)-set(supports):raise ValueError('所需支架编号无效')
                if mode=='synchronous':
                    if teacher not in actors:raise ValueError('同步教师职责必须实际占教师资源：'+activity['id'])
                    instruction=activity.get('teacherInstruction')
                    if not isinstance(instruction,str)or not instruction.strip():raise ValueError('同步教师须有实际指导/讲解/听评文字')
                    if 'selfActionId'in activity:raise ValueError('同步教师活动不能混用独立自助动作标记')
                    if provides and F(str(activity['minutes']))<=0:raise ValueError('预给支架须有正分钟的真实教师活动，不能零时长占位')
                    for ident in provides:
                        providers.setdefault(ident,[]).append({'lessonIndex':lesson_index,'end':F(str(activity['start']))+F(str(activity['minutes'])),'activity':activity['id'],'actors':actors})
                else:
                    if teacher in actors:raise ValueError('学生独立自助不应同时占教师；需要教师应改同步模式')
                    if any(key in activity for key in('teacherInstruction','product','studentTask','scaffold','scaffoldText','supportText'))or provides:raise ValueError('独立自助禁止自由动作/产物/教师或支架文字；仅由固定selfActionId模板渲染')
                    ident=activity.get('selfActionId')
                    if ident not in SELF_ACTIONS:raise ValueError('独立自助须明确受支持的任务模板，未知动作不能默认无教师')
                    template=SELF_ACTIONS[ident]
                    if activity.get('actionId')!=template['actionId']:raise ValueError('自助模板须与真实动作类别一致，不能以不同任务借支架')
                    if needs!=template['supportIds']:raise ValueError('自助动作须使用该固定任务配套纸面支架，不能用不相干卡片替代')
                    allowed={'id','actionId','name','start','minutes','actors','materials','outputs','teacherMode','selfActionId','supportIds','providesSupportIds','presentationGroup'}
                    if set(activity)-allowed:raise ValueError('自助模板不接受额外自由字段，不能把同步教师职责转移到旁栏')
                    if activity.get('name',template['actionId'])!=template['actionId']:raise ValueError('自助动作名称由固定模板生成，不能用名称夹带额外职责')
                    roles={'presentation':('groupRecord','带组员署名的站展记录'),'feedback':('feedback','带个人署名的反馈卡'),'reflection':('reflection','带个人署名的反思卡')}
                    for card in activity.get('outputs',[]):
                        if set(card)-{'role','actorIds','groupIds','actualReceived'}:raise ValueError('自助产物名称由模板生成，不接受自由说明字段')
                        expected=roles.get(ident)
                        if expected is None or card.get('role')!=expected[0]:raise ValueError('自助产物角色须与固定学习动作一致')
                        card['name']=expected[1]
                    activity['name']=template['actionId'];activity['product']=template['product'];activity['studentTask']=template['studentTask']
        for lesson_index,lesson in enumerate(lessons):
            for activity in lesson['activities']:
                mode=activity['teacherMode'];needs=activity['supportIds'];provides=activity['providesSupportIds'];matches={}
                for ident in needs:
                    earlier=[p for p in providers.get(ident,[])if p['lessonIndex']<lesson_index or(p['lessonIndex']==lesson_index and p['end']<=F(str(activity['start'])))]
                    if not earlier:raise ValueError('支架未在本方案更早的实际教师环节提供：'+activity['id']+'/'+ident)
                    eligible=[p for p in earlier if set(activity['actors'])-{teacher}<=set(p['actors'])]
                    if not eligible:raise ValueError('该自助组未包含在前置支架接收对象中')
                    matches[ident]=[p['activity']for p in eligible]
                if mode=='synchronous':
                    task='教师同步参与（资源'+str(teacher)+'已计入本活动）：'+activity['teacherInstruction']
                    if provides:task+='；本方案该环节拟提供以下纸面支架，实际是否已发放待回执：'+'；'.join(ident+'：'+supports[ident]for ident in provides)
                else:
                    task='本段为学生独立自助，不需同步教师检查、答疑或评分；使用本方案更早环节拟提供的纸面支架：'+'；'.join(ident+'：'+supports[ident]for ident in needs)+'。如临时需要教师，须先把教师计入该活动资源并整表重排，不能维持原全程听评承诺。'
                activity['teacherTask']=task
                checks.append({'plan':plan['id'],'lesson':lesson['id'],'activity':activity['id'],'teacherMode':mode,'selfActionId':activity.get('selfActionId'),'teacherActuallyInActors':teacher in activity['actors'],'supportProviders':matches,'providedSupportIds':provides,'sameSourceTask':task})
    result=round8_calculate(source);result['teacherParticipationChecks']=checks;result['supportLibrary']=supports;result['selfActionTemplates']=SELF_ACTIONS
    for plan in result['plans']:
        mode=result['presentationMetadata'][plan['id']]['mode']
        note=('本方案站展同步听评时，其他巡读/反馈/反思/听众活动为使用预给纸面支架的独立自助，无同时检查卡片的教师职责。'if mode=='shortened'else'本方案各活动教师职责均按实际资源行：同步参与必须占教师，自助活动不承诺教师即时反馈；巡回与全程听评分开。')
        previous=plan['condition'];final=previous+note;plan['condition']=final
        result['presentationMetadata'][plan['id']]['condition']=final
        for lesson in plan['lessons']:
            for activity in lesson['activities']:activity['condition']=activity['condition'].replace(previous,final)
        result['deliverables']={key:text.replace(previous,final)for key,text in result['deliverables'].items()}
    return result


def tablecell(value):return cell(value)

def render(r):
    out=['# 项目学习完整任务包与时间变更账','',r['state']]
    for title,content in r['deliverables'].items():out+=['','## '+title,'',str(content)]
    for p in r['plans']:
        out+=['','## 方案：'+p['id'],'',p['condition']+'；'+p['executionState'],'总课时预算：'+('待补'if p['totalLessonBudgetMinutes']is None else str(p['totalLessonBudgetMinutes']))+'分钟；已列资源可行：'+('待核'if p['feasibleUnderListedResources']is None else str(p['feasibleUnderListedResources']))]
        for lesson in p['lessons']:
            out+=['','### '+lesson['id'],'','|唯一活动/动作|开始|分钟|结束|具体资源|产物/条件|','|---|---:|---:|---:|---|---|']
            out+=['|'+x['id']+'/'+x['actionId']+'|'+x['start']+'|'+x['minutes']+'|'+x['end']+'|'+','.join(x['actors'])+'|'+tablecell(x['product'])+'；'+tablecell(x['condition'])+'|' for x in lesson['activities']]
            out+=['课时'+('待补'if lesson['budgetMinutes']is None else str(lesson['budgetMinutes']))+'；已排时间并集'+lesson['unionCoveredMinutes']+'；未分配时间'+('待补'if lesson['unassignedClassMinutes']is None else str(lesson['unassignedClassMinutes']))+'分钟。']
        if p['violations']:out+=['不可作为可行方案：'+json.dumps(p['violations'],ensure_ascii=False)]
    if r['requirement']:out+=['','原串行需求：'+json.dumps(r['requirement'],ensure_ascii=False)]
    if r['changeClaims']:out+=['','同口径断言复核：'+json.dumps(r['changeClaims'],ensure_ascii=False)]
    for change in r['changes']:
        out+=['','## 同动作变更：'+change['baseline']+' → '+change['candidate'],'',change['rule'],'|动作|同一参与者集合|逐人旧→新（减少）分钟|旧总人分钟|新总人分钟|减少人分钟|','|---|---|---|---:|---:|---:|']
        for row in change['rows']:
            detail='；'.join(x['actor']+':'+x['beforeMinutes']+'→'+x['afterMinutes']+'（'+x['reductionMinutes']+'）' for x in row['perActor']);out+=['|'+row['actionId']+'|'+str(row['sameActorSet'])+'|'+detail+'|'+row['beforeActorMinutes']+'|'+row['afterActorMinutes']+'|'+row['reductionActorMinutes']+'|']
    out+=['','## 产物与实际回执','', '|产物|设计份数|计数基础|适用方案|实际回收|','|---|---:|---|---|---|']+['|'+x['name']+'|'+str(x['count'])+'|'+x['basis']+'|'+str(x['plan'])+'|'+str(x['actualReceived'] if x['actualReceived'] is not None else '待回执')+'|' for x in r['products']]
    out+=['','## 可复制给教师的方案说明','']
    for p in r['plans']:out+=['方案'+p['id']+'：列明课时预算'+('待补'if p['totalLessonBudgetMinutes']is None else str(p['totalLessonBudgetMinutes']))+'分钟，资源校验'+('待核'if p['feasibleUnderListedResources']is None else str(p['feasibleUnderListedResources']))+'；'+p['condition']+'；现场状态：'+p['executionState']+'。']
    out+=[r['qualityBoundary'],r['scope']]
    return normalize('\n'.join(out)+'\n')


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('input');p.add_argument('--format',choices=['json','markdown'],default='json');a=p.parse_args()
    try:
        result=calculate(json.loads(Path(a.input).read_text()));print(render(result) if a.format=='markdown' else json.dumps(result,ensure_ascii=False,indent=2));return 0 if result['valid'] else 2
    except (ValueError,TypeError,KeyError,AttributeError,ArithmeticError,OSError) as e:
        print(json.dumps({'valid':False,'error':str(e),'state':'输入待核，未判方案可行'},ensure_ascii=False));return 2

if __name__=='__main__':raise SystemExit(main())
