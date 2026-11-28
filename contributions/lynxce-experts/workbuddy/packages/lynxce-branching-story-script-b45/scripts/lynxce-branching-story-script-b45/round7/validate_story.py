#!/usr/bin/env python3
"""Validate graph structure AND nonempty quoted clue requirements on every path."""
import argparse,json
from pathlib import Path
from gfm_tables import normalize


def strings(value,label):
    if not isinstance(value,list) or any(not isinstance(x,str)or not x for x in value)or len(set(value))!=len(value):raise ValueError(label+'须唯一非空文字列表')
    return value


def checkbindings(required,bindings,context,definitions,label):
    strings(required,label)
    if not isinstance(bindings,list)or {x.get('clue')for x in bindings if isinstance(x,dict)}!=set(required)or len(bindings)!=len(required):raise ValueError(label+'每条线索须一条真实引句绑定')
    for x in bindings:
        if x['clue']not in definitions or not isinstance(x.get('quote'),str)or not x['quote']or x['quote']not in context:raise ValueError(label+'线索未定义或引句不在实际正文/动作中')


def calculate(data):
    if not isinstance(data,dict):raise ValueError('根须对象')
    definitions=data.get('clues');plans=data.get('plans')
    if not isinstance(definitions,dict)or not definitions or any(not isinstance(k,str)or any(c in k for c in '|\n\r')or not isinstance(v,str)or not v for k,v in definitions.items()):raise ValueError('clues须为非空定义表')
    if not isinstance(plans,list)or not plans:raise ValueError('须交完整计划列表')
    results=[];planids=set()
    for plan in plans:
        pid=plan.get('id');nodes=plan.get('nodes');initial=strings(plan.get('initialClues'),'初始线索')
        if not isinstance(pid,str)or not pid or pid in planids:raise ValueError('方案id须唯一')
        planids.add(pid)
        if not isinstance(nodes,list)or not 1<=len(nodes)<=64:raise ValueError('完整节点须1至64项')
        by={n.get('id'):n for n in nodes if isinstance(n,dict)}
        if len(by)!=len(nodes)or any(not isinstance(k,str)or not k or any(c in k for c in '|\n\r')for k in by):raise ValueError('节点id须唯一单行')
        entry=plan.get('entry');per=plan.get('buttonsPerScene',2)
        if entry not in by or type(per)is not int or not 1<=per<=3:raise ValueError('入口或按钮数无效')
        checkbindings(initial,plan.get('initialBindings'),by[entry]['text'],definitions,'初始线索')
        for n in nodes:
            if n.get('kind')not in('scene','ending')or not isinstance(n.get('text'),str)or not n['text'].strip()or not isinstance(n.get('title'),str):raise ValueError('每节点须实际正文/标题/种类')
            checkbindings(n.get('requiredClues'),n.get('requiredBindings'),n['text'],definitions,'节点前置')
            checkbindings(n.get('providedClues'),n.get('providedBindings'),n['text'],definitions,'节点提供')
            buttons=n.get('buttons')
            if not isinstance(buttons,list)or (n['kind']=='ending'and buttons)or(n['kind']=='scene'and len(buttons)!=per):raise ValueError('场景按钮数或独立结局节点无效')
            for b in buttons:
                if b.get('target')not in by or not isinstance(b.get('text'),str)or not b['text'].strip()or not isinstance(b.get('outcome'),str):raise ValueError('按钮须实际文案/结果/已存在目标')
                if not b.get('requiredClues'):raise ValueError('每个可选动作必须有非空可见线索前置，不能清空检查字段')
                context=b['text']+'\n'+b['outcome'];checkbindings(b['requiredClues'],b.get('requiredBindings'),context,definitions,'按钮动作前置');checkbindings(b.get('providedClues'),b.get('providedBindings'),context,definitions,'动作后线索')
        paths=[];issues=[];seen=set();checks=[]
        def walk(ident,path,facts):
            if len(paths)>4096:raise ValueError('路径超过4096，请缩小图')
            if ident in path:issues.append({'kind':'cycle','path':path+[ident]});return
            n=by[ident];seen.add(ident);missing=sorted(set(n['requiredClues'])-facts);checks.append({'path':path+[ident],'object':'node','required':n['requiredClues'],'availableBefore':sorted(facts),'missing':missing})
            if missing:issues.append({'kind':'missingNodeClue','path':path+[ident],'missingClues':missing})
            known=facts|set(n['providedClues'])
            if n['kind']=='ending':paths.append({'nodes':path+[ident],'choiceCount':len(path),'ending':ident,'knownCluesAtEnd':sorted(known)});return
            for b in n['buttons']:
                missing=sorted(set(b['requiredClues'])-known);checks.append({'path':path+[ident],'object':'button','text':b['text'],'required':b['requiredClues'],'availableBefore':sorted(known),'missing':missing})
                if missing:issues.append({'kind':'missingActionClue','path':path+[ident,b['target']],'button':b['text'],'missingClues':missing})
                walk(b['target'],path+[ident],known|set(b['providedClues']))
        walk(entry,[],set(initial));endings=[n['id']for n in nodes if n['kind']=='ending'];scene_count=len(nodes)-len(endings)
        if set(by)-seen:issues.append({'kind':'unreachableNodes','nodes':sorted(set(by)-seen)})
        if plan.get('nodeBudget')!=len(nodes)or plan.get('endingBudget')!=len(endings):issues.append({'kind':'budgetMismatch','actualNodes':len(nodes),'actualEndings':len(endings)})
        if not paths:issues.append({'kind':'noCompletePath'})
        results.append({'id':pid,'condition':plan.get('condition','待用户选择；不得说已经采用'),'entry':entry,'nodes':nodes,'totalNodes':len(nodes),'sceneCount':scene_count,'endingCount':len(endings),'edges':sum(len(n['buttons'])for n in nodes),'paths':paths,'minChoices':min((p['choiceCount']for p in paths),default=None),'maxChoices':max((p['choiceCount']for p in paths),default=None),'clueChecks':checks,'requiredCheckCount':sum(bool(x['required'])for x in checks),'issues':issues,'passed':not issues})
    request=data.get('requestConstraints');diagnosis=None
    if request:
        total=request['nodes'];ends=request['endings'];k=request.get('buttonsPerScene',2)
        if type(total)is not int or type(ends)is not int or type(k)is not int or total<1 or ends<1 or k<2:raise ValueError('请求约束须正整数，按钮至少2')
        minscene=(ends-1+k-2)//(k-1);minimum=minscene+ends;diagnosis={'requestedNodes':total,'requestedEndings':ends,'independentEndingsRequireAtLeast':ends,'branchingMinimumSceneNodes':minscene,'minimumTotalNodes':minimum,'requestPossibleUnderGivenBudgets':total>=minimum,'reason':'每个独立结局占一节点；还须保留使全部节点可达的非结局分支。替代方案不冒称满足原冲突约束。'}
    return {'clueDefinitions':definitions,'valid':all(p['passed']for p in results),'requestDiagnosis':diagnosis,'plans':results,'questions':data.get('questions',[]),'scope':'纸面原创设计；校验元数据不属于游戏数值状态变量。图结构与线索可用性分开验证；引句存在仍需人工核语义，不代表实际试玩/接入/玩家反馈。'}


def markdown(r):
    out=['# 分支故事完整稿与双重校验','',r['scope']]
    if r['requestDiagnosis']:out+=['','## 原请求冲突与条件选择','',json.dumps(r['requestDiagnosis'],ensure_ascii=False)]
    for p in r['plans']:
        out+=['','## '+p['id'],'',p['condition']]
        for n in p['nodes']:
            out+=['','### '+n['id']+' '+n['title'],'',n['text']]
            for i,b in enumerate(n['buttons'],1):out+=['','- 按钮'+str(i)+'：'+b['text']+' → '+b['target'],'  选择后正文：'+b['outcome']]
        out+=['','### 节点索引','','|节点|种类|正文提供线索|进入需要线索|按钮目标|','|---|---|---|---|---|']
        out+=['|'+n['id']+'|'+n['kind']+'|'+'；'.join(r['clueDefinitions'][c]for c in n['providedClues'])+'|'+'；'.join(r['clueDefinitions'][c]for c in n['requiredClues'])+'|'+','.join(b['target']for b in n['buttons'])+'|'for n in p['nodes']]
        out+=['','### 全部路径','','|完整路径|单次选择次数|结局|','|---|---:|---|']+['|'+' → '.join(x['nodes'])+'|'+str(x['choiceCount'])+'|'+x['ending']+'|'for x in p['paths']]
        out+=['','总节点'+str(p['totalNodes'])+'；选择节点'+str(p['sceneCount'])+'；独立结局'+str(p['endingCount'])+'；出边'+str(p['edges'])+'；完整路径'+str(len(p['paths']))+'；单次选择'+str(p['minChoices'])+'—'+str(p['maxChoices'])+'次。','图结构及逐路径线索检查：'+str(p['passed'])+'；非空要求检查'+str(p['requiredCheckCount'])+'次；具体问题：'+json.dumps(p['issues'],ensure_ascii=False)]
    out+=['','## 使用与待确认','按节点编号阅读。重新开始属于新一轮，不是图内循环；未实际试玩。改变上游线索、节点预算、按钮或合流后完整重算图与每路径线索。']+r['questions'];return normalize('\n'.join(out)+'\n')


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('input');ap.add_argument('--format',choices=['json','markdown'],default='json');args=ap.parse_args()
    try:r=calculate(json.loads(Path(args.input).read_text()));print(markdown(r)if args.format=='markdown'else json.dumps(r,ensure_ascii=False,indent=2));return 0 if r['valid']else 2
    except(ValueError,TypeError,KeyError,AttributeError,OSError)as e:print(json.dumps({'valid':False,'error':str(e),'scope':'没有得到完整有效故事校验'},ensure_ascii=False));return 2
if __name__=='__main__':raise SystemExit(main())
