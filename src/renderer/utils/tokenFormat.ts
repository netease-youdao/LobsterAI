const isValidDate = (date: Date): boolean => Number.isFinite(date.getTime());

export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!isValidDate(date)) return '';

  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return time;

  const isThisYear = date.getFullYear() === now.getFullYear();
  if (isThisYear) {
    return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${time}`;
  }

  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${time}`;
}

export function formatMessageDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!isValidDate(date)) return '';

  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(tokens);
}
