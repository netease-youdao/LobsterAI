# 社区撤场复原第五轮
标准库连续多人任务排程，执行python3 calculate.py normal.json，加--format markdown直渲逐任务表、逐人卡、归位对应和交接全文len。任务id/人数/分钟/前置/资源明确；durationMinutes=null保留阻断，不用0排；workers每人给available与busy，allowedWorkers可限制合格人员；resources给门/场地等单容量互斥资源的窗口和已有占用。fixedTasks保留用户已确认时段/人员/来源，遇窗口/人数/资源/前置冲突报错，不偷偷移动；实际完成状态仅照actualStatus用户回执，未知默认待反馈。任务动作/物品映射没给就用任务A等，不把原文样例的展板/椅子/库房已开放当本轮事实。destinationConflicts保留至少两条来源/去向及sameBatchConfirmed、linkedTaskIds；关联未明不自行把B改B1/B2；明确关联才冻结相关任务与依赖链。freeTeamProbes仅查已排人员的连续空档，人数或时长未知不算起点；接收窗口/路程另核。providedTaskPlanFinish仅给定任务计划结束，不等于现场整体已还场；siteRestorationFinish固定待确认，需现场终态证据另处理。正常70人分钟、链30、余10；一人在场不把B/C两人任务偷改成一人双倍时长。
actualStatus非null须给同任务fixedTasks时段/人员/来源，否则受控拒绝，避免重派已有执行反馈任务。锁定记录在通知仅保留不拟重做。
第五轮连续表格及中性追问：表头/分隔线/全部任务数据连续，实际反馈移至整表后，人员、共享资源、前置、状态各列保留；列内竖线/换行转义。questions最多3条，从本轮实际任务名称是否给齐、去向来源和回执状态同源生成。最终只逐字引用questions，不自由另写把E视为送达等任务映射；未给name仅按原代号，涉及运输/接收仅条件询问，不默认为已有动作。通知和排程数值保持。
去向冲突通知只写“本轮争议物品”，不从本文展板假设回填；桌布等新对象沿用其本轮来源与未定关联，不能自动指定运输代号。
