const virtualSearchTextByElement = new WeakMap<HTMLElement, string>();

/**
 * Register searchable text whose visual renderer is virtualized. Consumers
 * can preserve occurrence ordering without copying the full text into a DOM
 * attribute or creating hidden text nodes.
 */
export const registerVirtualSearchText = (
  element: HTMLElement,
  text: string,
): (() => void) => {
  virtualSearchTextByElement.set(element, text);
  return () => virtualSearchTextByElement.delete(element);
};

export const getVirtualSearchText = (element: HTMLElement): string | null => (
  virtualSearchTextByElement.get(element) ?? null
);
