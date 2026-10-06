export const shouldShowSidebarCarouselControls = (
  itemCount: number,
): boolean => itemCount > 1;

export const resolveSidebarCarouselIndex = (
  itemKeys: string[],
  activeItemKey: string | null,
): number => {
  if (itemKeys.length === 0) return -1;
  const activeIndex = activeItemKey
    ? itemKeys.indexOf(activeItemKey)
    : -1;
  return activeIndex >= 0 ? activeIndex : 0;
};

export const getAdjacentSidebarCarouselKey = (
  itemKeys: string[],
  activeItemKey: string | null,
  offset: number,
): string | null => {
  const activeIndex = resolveSidebarCarouselIndex(itemKeys, activeItemKey);
  if (activeIndex < 0) return null;
  const nextIndex = (
    (activeIndex + offset) % itemKeys.length + itemKeys.length
  ) % itemKeys.length;
  return itemKeys[nextIndex];
};
