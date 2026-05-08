import { i18nService } from '../services/i18n';

/**
 * Format a timestamp to a human-readable relative/absolute time string.
 * Uses the browser's local timezone for display.
 *
 * Rules:
 * - < 1 min: "刚刚" / "Just now"
 * - < 1 hour: "5 分钟前" / "5 minutes ago"
 * - today: "3 小时前" / "3 hours ago"
 * - yesterday: "昨天 14:30" / "Yesterday 14:30"
 * - this week: "周三 09:15" / "Wed 09:15"
 * - this year: "3月15日 10:00" / "Mar 15, 10:00"
 * - older: "2024/12/01"
 *
 * @param timestamp - Unix timestamp in milliseconds (as stored by the backend)
 * @param referenceNow - Optional reference "now" for computing relative time. Defaults to Date.now().
 * @returns Formatted time string
 */
export function formatRelativeTimeString(timestamp: number, referenceNow?: number): string {
  if (!Number.isFinite(timestamp) || isNaN(new Date(timestamp).getTime())) {
    return '-';
  }

  const now = referenceNow ?? Date.now();
  const diff = Math.max(0, now - timestamp); // treat future timestamps as "just now"
  const date = new Date(timestamp);
  const todayDate = new Date(now);
  todayDate.setHours(0, 0, 0, 0);
  const todayStart = todayDate.getTime();
  const yesterdayStart = todayStart - 86400000;
  const pad = (n: number) => String(n).padStart(2, '0');
  const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const lang = i18nService.getLanguage();

  if (diff < 60000) {
    return i18nService.t('justNow');
  } else if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes} ${i18nService.t('minutesAgo')}`;
  } else if (timestamp >= todayStart) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} ${i18nService.t('hoursAgo')}`;
  } else if (timestamp >= yesterdayStart) {
    return `${i18nService.t('yesterday')} ${timeStr}`;
  } else if (diff < 7 * 86400000) {
    const dayOfWeek = date.getDay();
    const dayName = getDayName(dayOfWeek, lang);
    return `${dayName} ${timeStr}`;
  } else if (date.getFullYear() === todayDate.getFullYear()) {
    return formatDateThisYear(date, timeStr, lang);
  } else {
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  }
}

/** Get localized short day-of-week name. */
function getDayName(dayOfWeek: number, lang: string): string {
  const zhDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const enDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return lang === 'zh' ? zhDays[dayOfWeek] : enDays[dayOfWeek];
}

/** Format a date within the current year. */
function formatDateThisYear(date: Date, timeStr: string, lang: string): string {
  if (lang === 'zh') {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  }
  const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthShort[date.getMonth()]} ${date.getDate()}, ${timeStr}`;
}
