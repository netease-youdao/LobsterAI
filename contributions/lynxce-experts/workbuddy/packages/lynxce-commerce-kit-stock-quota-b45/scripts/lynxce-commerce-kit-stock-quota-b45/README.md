# 共享组件配额与双层守恒

仅标准库。按本轮用户原文生成输入：skus按已确认优先顺序，usage为完整组件矩阵，cap为当前SKU目标上限或null（尽量分配）；branches分别保存独立来源，components中inventory/extraDeduction/reserve原值未知必须null。显式条件演算只在assumptions内写value与condition，不能覆盖已知字段。实际扣减为0必须有明确来源。不能混合不同SKU版本或库存时点。

`python3 scripts/lynxce-commerce-kit-stock-quota-b45/calculate.py input.json` 产JSON；同输入加`--format markdown`生成可复制结果、双层守恒、分支逐字段影响及未执行通知。JSON中的original保留未知，effective为条件演算值。净预算不足保留负数并暂停相关SKU，不隐去缺口。未知依赖不填零，确定的其他SKU仍可交。示例为假设资料，不代表库存已更改。无效输入输出输入待核与非零退出码。
