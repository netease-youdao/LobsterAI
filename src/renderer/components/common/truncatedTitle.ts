export interface TruncatedTitleState {
  displayTitle: string;
  tooltipContent: string | null;
}

export const getTruncatedTitleState = (
  title: string | null | undefined,
  fallbackTitle: string,
): TruncatedTitleState => {
  const trimmedTitle = title?.trim() ?? '';

  if (!trimmedTitle) {
    return {
      displayTitle: fallbackTitle,
      tooltipContent: null,
    };
  }

  return {
    displayTitle: trimmedTitle,
    tooltipContent: trimmedTitle,
  };
};
