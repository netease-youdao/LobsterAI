interface LibraryDateGroupTitleOptions {
  locale: string;
  todayLabel: string;
  yesterdayLabel: string;
  now?: number;
}

export interface LibrarySessionBucket<T> {
  sessionKey: string;
  representativeTime: number;
  items: T[];
}

export interface LibraryDateSessionBucket<T> {
  dateKey: string;
  representativeTime: number;
  sessionBuckets: LibrarySessionBucket<T>[];
}

const padDatePart = (value: number): string => value.toString().padStart(2, '0');

export const getLibraryDateGroupKey = (value: number): string => {
  const date = new Date(value);
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-');
};

export const groupLibraryItemsByDateAndSession = <T>(
  items: readonly T[],
  getTimestamp: (item: T) => number,
  getSessionKey: (item: T) => string,
): LibraryDateSessionBucket<T>[] => {
  const sortedItems = [...items].sort((left, right) => (
    getTimestamp(right) - getTimestamp(left)
  ));
  const dateBuckets = new Map<string, LibraryDateSessionBucket<T>>();
  const sessionBucketsByDate = new Map<string, Map<string, LibrarySessionBucket<T>>>();

  for (const item of sortedItems) {
    const timestamp = getTimestamp(item);
    const dateKey = getLibraryDateGroupKey(timestamp);
    let dateBucket = dateBuckets.get(dateKey);
    if (!dateBucket) {
      dateBucket = {
        dateKey,
        representativeTime: timestamp,
        sessionBuckets: [],
      };
      dateBuckets.set(dateKey, dateBucket);
      sessionBucketsByDate.set(dateKey, new Map());
    }

    const sessionKey = getSessionKey(item);
    const sessionBuckets = sessionBucketsByDate.get(dateKey)!;
    let sessionBucket = sessionBuckets.get(sessionKey);
    if (!sessionBucket) {
      sessionBucket = {
        sessionKey,
        representativeTime: timestamp,
        items: [],
      };
      sessionBuckets.set(sessionKey, sessionBucket);
      dateBucket.sessionBuckets.push(sessionBucket);
    }
    sessionBucket.items.push(item);
  }

  return [...dateBuckets.values()];
};

export const formatLibraryDateGroupTitle = (
  value: number,
  {
    locale,
    todayLabel,
    yesterdayLabel,
    now = Date.now(),
  }: LibraryDateGroupTitleOptions,
): string => {
  const valueDate = new Date(value);
  const nowDate = new Date(now);
  const valueKey = getLibraryDateGroupKey(value);
  const todayKey = getLibraryDateGroupKey(now);
  if (valueKey === todayKey) return todayLabel;

  const yesterdayDate = new Date(nowDate);
  yesterdayDate.setHours(0, 0, 0, 0);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  if (valueKey === getLibraryDateGroupKey(yesterdayDate.getTime())) return yesterdayLabel;

  return new Intl.DateTimeFormat(locale, {
    ...(valueDate.getFullYear() === nowDate.getFullYear() ? {} : { year: 'numeric' }),
    month: 'long',
    day: 'numeric',
  }).format(valueDate);
};
