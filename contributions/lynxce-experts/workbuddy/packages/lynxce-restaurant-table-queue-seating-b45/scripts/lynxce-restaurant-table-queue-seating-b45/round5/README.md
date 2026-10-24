# 餐厅排队桌位第五轮
执行python3 calculate.py normal.json，增加--format markdown得到同一结果直渲的桌位表、状态分栏、逐组复制话术及其全文len。仅处理待排客组，整组、不拆组、不拼桌，每桌本轮最多一次。已有实际入座回执者先锁定实际桌并从待排队列移除，相应桌blocked=true；不得仍当待排组重复分配。actualFeedback缺失只能待反馈，不能声称无已入座客。所有释放冲突分别置scenarios，保持来源与预计标志，不计算平均。没有日期不制造日期，没有用餐时长不排第二轮。无可适配桌时交具体等待/取消话术；未来到店记录不算本截点已等位。
allowedTables/forbiddenTables可消费每组已确认桌型限制展开的桌号；blocked消费预订保护。date必须ISO字符串或null。preferences-and-reservation.json仅本地独立假设限制样例。
第五轮仅修文稿格式：每个情境表头、分隔线及全部数据行连续，现场反馈和不可排截止说明统一移至整表之后；数据列中的竖线转为HTML实体、换行转为表内换行，避免截断表体。计算结果JSON、数值、状态和通知全文不改。
