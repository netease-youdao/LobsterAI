# 离线结构化计算

读取动作/前置/新增秒数JSON，保持总量并验证不可拆动作、节拍和允许工位。只用Python标准库，无外部调用。

在插件根目录执行：

```sh
python3 scripts/lynxce-factory-line-work-balance-b45/calculate.py 本轮输入.json --format markdown
python3 scripts/lynxce-factory-line-work-balance-b45/calculate.py 本轮输入.json
```

normal.json为明确标记的假设输入样例。以本轮资料替换全部相应字段，不把样例零值、来源、库存或工时沿用成用户事实。JSON用于版本及精确对照，Markdown是可复制成品。缺少必要字段返回“输入待核”，退出码2；业务无解仍返回完整计算JSON，退出码0。

同目录结果Markdown与其他异常JSON是本地代码回归证据，不是模型实跑或现场执行证明。
