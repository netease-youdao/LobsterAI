import { useLayoutEffect, useRef, useState } from 'react';

// Observe both the viewport and its content: the gallery can load or collapse,
// and a prompt can change without resizing the textarea itself.
export function useScrollAffordance<T extends HTMLElement>(contentVersion: string | boolean) {
  const scrollRef = useRef<T>(null);
  const [edges, setEdges] = useState({ above: false, below: false });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const above = element.scrollTop > 2;
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 2;
      setEdges(previous => previous.above === above && previous.below === below
        ? previous : { above, below });
    };
    const onScroll = () => {
      measure();
      element.dataset.scrolling = 'true';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { delete element.dataset.scrolling; }, 900);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', onScroll);
      clearTimeout(idleTimer);
      delete element.dataset.scrolling;
    };
  }, [contentVersion]);

  const scrollNext = () => {
    const element = scrollRef.current;
    element?.scrollBy({
      top: element.clientHeight * 0.7,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  };

  return { scrollRef, canScrollUp: edges.above, canScrollDown: edges.below, scrollNext };
}
