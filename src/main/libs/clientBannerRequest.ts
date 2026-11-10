export const appendClientBannerVersion = (
  url: string,
  clientVersion: string,
): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('clientVersion', clientVersion);
  return parsed.toString();
};

/** Content types this client can render; servers omit HTML banners for clients that do not declare it. */
export const CLIENT_BANNER_SUPPORTED_CONTENT_TYPES = 'image,html';

export const appendClientBannerContentTypes = (url: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('contentTypes', CLIENT_BANNER_SUPPORTED_CONTENT_TYPES);
  return parsed.toString();
};
