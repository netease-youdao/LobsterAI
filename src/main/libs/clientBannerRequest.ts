export const appendClientBannerVersion = (
  url: string,
  clientVersion: string,
): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('clientVersion', clientVersion);
  return parsed.toString();
};
