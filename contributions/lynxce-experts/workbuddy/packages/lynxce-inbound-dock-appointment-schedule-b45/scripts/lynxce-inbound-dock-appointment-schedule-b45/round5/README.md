# 月台到货预约第五轮计算入口
只读本轮JSON并打印结果，不联网、不发消息、不改预约。执行 `python3 calculate.py normal.json`，加 `--format markdown` 输出同一结果渲染的逐车表、连续空档和完整通知。每个情境都给独立月台开放值及来源，来源冲突并列，不能自行采用。sharedCrew必须明确，true代表仅一个共享班组；false须有明确无共享约束依据。arrival是原可到时刻；等待只按建议开始减arrival，不是占台时长。actualArrivalStatus只能填写用户明确回执，null保留待反馈。日期缺省不创造日期。关闭时刻未知则方案以覆盖排程时段为待确认条件，不宣称全窗口已确认。deadlineOverrides仅额外条件候选，不是自动放宽原截止。每车notice.text全文以len统计字符，禁止用另一个短句长度替代。当前贪心顺序按截止、可到、代号；排不进一般不宣称全局无解，只有单车最早结束也晚于截止才给不可行证明。
blockedIntervals为每月台来源区间列表，existingReservations为每情境冻结车{id,dock,start,end,source}，sharedCrewIntervals为共享班组来源区间。null保留资料未知而非无占用；空列表须有用户明确无记录依据。blocked-and-frozen.json是独立常用约束样例。date仅YYYY-MM-DD字符串/null，回执值null归待反馈。
第五轮仅修文稿格式：每个情境表头、分隔线及全部数据行连续，现场反馈和不可排截止说明统一移至整表之后；数据列中的竖线转为HTML实体、换行转为表内换行，避免截断表体。计算结果JSON、数值、状态和通知全文不改。
