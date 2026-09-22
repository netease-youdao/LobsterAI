import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export const useLowCreditOfferExposure = (key: string, onExposure: () => void) => {
  const elementRef = useRef<HTMLDivElement>(null);
  const reportedKeyRef = useRef<string>();
  const onExposureRef = useRef(onExposure);

  useLayoutEffect(() => {
    onExposureRef.current = onExposure;
  }, [onExposure]);

  const ensureExposure = useCallback(() => {
    if (reportedKeyRef.current === key) return;
    reportedKeyRef.current = key;
    onExposureRef.current();
  }, [key]);

  useEffect(() => {
    if (reportedKeyRef.current === key) return undefined;
    const element = elementRef.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      ensureExposure();
      return undefined;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        ensureExposure();
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ensureExposure, key]);

  return { elementRef, ensureExposure };
};
