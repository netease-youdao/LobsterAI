# 分穴尺寸统计与版本差异

仅标准库。使用本次输入运行 `python3 scripts/lynxce-quality-cavity-offset-compare-b45/round7/calculate.py input.json` 得JSON，`--format markdown` 得同源完整表与短报告。每个版本对按原始读数逐件比较outside布尔值，changedVerdictCount与changedIDs来自实际变化数组，D三件超限不代表三件判定变化。输入示例是假设，取样计划未执行。无效输入返回输入待核JSON与非零退出码。
