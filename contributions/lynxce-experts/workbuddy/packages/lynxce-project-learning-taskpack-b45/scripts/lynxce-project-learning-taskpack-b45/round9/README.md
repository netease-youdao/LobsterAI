# 项目完整固定交付与结构化条件

本轮输入不是旧normal示例。按真实原文建actors/participantIds/groups/context；正常未给班级组数时participantBasis=design_assumption，并在学生任务书、各方案表及教师复制稿就地生成假设人数。材料固定纸/笔/用户给定数字材料。

plans仍使用唯一活动/动作/实际个人资源与课时，新增presentation.mode：baseline_single_demo单组示范基线、parallel条件并行、shortened缩时、serial_extended需确认增课。并行须evaluation circulating/full_duration及spaceConfirmed/stationsConfirmed/evaluationConfirmed；未知用null。教师不得用巡回冒充两场全程评分。

每活动必须outputs列表：固定individual/feedback/reflection覆盖每学生恰好一次，groupRecord覆盖每组恰好一次。角色不能由requirements改0；不能从其他候选借份数。每张卡须actorIds或groupIds且实际包含于本活动参与者，正分钟；actualReceived未知null。peerFeedback与groupDraft用来另存未变试读反馈及建议单，不能声称删掉或不存在。

拒绝独立products/requirements及自由condition。时长、总课时、展示分钟、并行条件、产物数由当前字段统一生成；deliverables使用{{group_basis}}/{{materials}}/{{plan_summaries}}/{{request_diagnosis}}，不得自由复制人数/分钟条件。四个实际正文为学生任务书、角色卡、完整五栏样稿、教师说明，不能只交日程。

python3 scripts/lynxce-project-learning-taskpack-b45/round9/schedule_ledger.py 本轮输入.json；同输入--format markdown直接生成完整任务包/全部议程/同动作变更/全部产物及教师复制稿。反思/反馈更短必须保留质量边界。正常160分钟；异常原需求60对窗口40、基线比较/条件并行/缩时三个方案分清。所有本地测试只是程序验证，不是原生真实模型通过。

## 第九轮封闭自助任务与教师真实资源

每活动显式teacherMode：synchronous或student_self，未知不默认为无教师。禁止自由teacherTask。同步模式必须把context.teacherId计入actors，并提供teacherInstruction；教师同步检查、答疑、指导、巡回、评分都按真实区间占资源，重叠则退出2，不删教师来规避。

独立模式仅允许selfActionId固定枚举：presentation（站展）、peer_read（巡读提问）、feedback（个人反馈）、reflection（反思）、audience（听众学习）。actual actionId须与模板动作一致；product、studentTask、teacherInstruction及自由scaffold/scaffoldText/supportText在独立活动中一律拒绝。完整学生动作、产物说明与无需同步教师的教师文字均由代码模板渲染，不接收自然语言同义词黑名单修补。自助学生若真需要自由教师指导，就改同步模式、计教师资源并整表重排，不能保留独立标记。

顶层supportTemplateIds只选择固定纸面支架编号：巡读检查单、反馈句式、反思提示、听众记录单、展示回应卡；supportLibrary自由文本不接受。完整可印支架由代码常量生成。每个selfActionId要求其对应的supportIds，不能错卡替代。providesSupportIds须由本方案更早正分钟的同步教师活动提供，实际包含教师和接收学生，结束不得晚于使用开始。缺、后给、错组、零分钟、未知模板或自由覆盖都拒绝；‘拟提供’不是发放回执。

异常讲解时段拟发配套纸面支架；缩时保留教师逐组全程听评，另16活动学生独立完成巡读、反馈、反思、听众记录。并行站展依纸面提示自主说明，单独T巡回不等于逐组全程评分。需要即时指导就按真实教师重排，不沿用旧可行结论。四类固定成果及保留的试读反馈/建议单、正分钟动作、同口径17→4少13/收齐10→1少9、未知预算/回执、材料和人数条件均保持。计划、活动条件、presentationMetadata及完整可复制教师稿来自同一最终结果。

本地程序双格式结果只证明本地验证；独立cross与新的原生真实盲测另行进行。正常/异常完整任务书、角色卡、五栏样稿、课表、变更账、产物与教师稿不能缩减为资源附件。

独立自助的name须等于模板动作名，outputs不允许自由name或额外文字；产物显示名由任务模板/role生成，角色也须与任务相符。其余未知活动字段拒绝，不能把教师动作换到helperInstruction旁栏。标识ID仅定位用途，不能用作替代教学说明。
