#!/usr/bin/env node

/**
 * 日期时间与毫秒时间戳互转工具
 *
 * 用法：
 *   node date-convert.js "2026-04-10 18:00:00"        # 日期 → 时间戳(ms)
 *   node date-convert.js 1775815200000                 # 时间戳(ms) → 日期
 *   node date-convert.js "2026-04-10 18:00:00" +8      # 指定时区偏移
 *   node date-convert.js 1775815200000 +8              # 指定时区偏移
 */

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('用法:');
  console.log('  node date-convert.js "2026-04-10 18:00:00"   # 日期 → 时间戳(ms)');
  console.log('  node date-convert.js 1775815200000            # 时间戳(ms) → 日期');
  console.log('  node date-convert.js "2026-04-10 18:00:00" +8 # 指定时区偏移(默认+8)');
  process.exit(0);
}

const input = args[0];
const tzOffset = args[1] ? parseFloat(args[1]) : 8; // 默认 GMT+8

function formatDate(date, offset) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const local = new Date(utc + offset * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())} GMT${sign}${Math.abs(offset)}`;
}

// 判断输入是时间戳还是日期字符串
if (/^\d{10,13}$/.test(input)) {
  // 时间戳 → 日期
  let ts = parseInt(input, 10);
  if (input.length <= 10) ts *= 1000; // 支持秒级时间戳
  const date = new Date(ts);
  console.log(`${ts} => ${formatDate(date, tzOffset)}`);
} else {
  // 日期 → 时间戳
  // 将输入视为指定时区的时间
  const parts = input.replace(/[/\-T]/g, '-').replace(/\s+/, 'T').split('T');
  const dateParts = parts[0].split('-').map(Number);
  const timeParts = (parts[1] || '00:00:00').split(':').map(Number);

  const utcMs = Date.UTC(
    dateParts[0],
    dateParts[1] - 1,
    dateParts[2] || 1,
    (timeParts[0] || 0) - tzOffset,
    timeParts[1] || 0,
    timeParts[2] || 0
  );

  console.log(`${input} (GMT+${tzOffset}) => ${utcMs}`);
}
