import { ChevronLeftIcon, ChevronRightIcon, DocumentTextIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useState } from 'react';

import browser from '../../assets/login-showcase/browser.webp';
import commerce from '../../assets/login-showcase/commerce.webp';
import design from '../../assets/login-showcase/design.webp';
import finance from '../../assets/login-showcase/finance.webp';
import learning from '../../assets/login-showcase/learning.webp';
import marketing from '../../assets/login-showcase/marketing.webp';
import report from '../../assets/login-showcase/report.webp';
import research from '../../assets/login-showcase/research.webp';
import schedule from '../../assets/login-showcase/schedule.webp';
import tool from '../../assets/login-showcase/tool.webp';
import { i18nService } from '../../services/i18n';

const SLIDES = [
  { image: tool, key: 'loginShowcaseTool' },
  { image: browser, key: 'loginShowcaseBrowser' },
  { image: report, key: 'loginShowcaseReport' },
  { image: learning, key: 'loginShowcaseLearning' },
  { image: commerce, key: 'loginShowcaseCommerce' },
  { image: marketing, key: 'loginShowcaseMarketing' },
  { image: design, key: 'loginShowcaseDesign' },
  { image: finance, key: 'loginShowcaseFinance' },
  { image: research, key: 'loginShowcaseResearch' },
  { image: schedule, key: 'loginShowcaseSchedule' },
] as const;
const AUTOPLAY_INTERVAL_MS = 5_000;

const LoginShowcase: React.FC = () => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const panelId = useId();
  const slide = SLIDES[activeIndex];
  const isAutoPlaying = pageVisible && !pointerInside && !focusInside && !reducedMotion;
  const select = (index: number) => setActiveIndex((index + SLIDES.length) % SLIDES.length);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReducedMotion(preference.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateMotion();
    updateVisibility();
    preference.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      preference.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isAutoPlaying) return;
    const timer = window.setTimeout(() => {
      setActiveIndex((index) => (index + 1) % SLIDES.length);
    }, AUTOPLAY_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [activeIndex, isAutoPlaying]);

  return (
    <section
      className="login-showcase group relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-3xl bg-[#eff6fb] text-[#28271f]"
      aria-label={i18nService.t('loginShowcaseRegionLabel')}
      aria-roledescription={i18nService.t('loginShowcaseCarousel')}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse' || event.pointerType === 'pen') setPointerInside(true);
      }}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => setFocusInside(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusInside(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          select(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
        }
      }}
    >
      <div className="login-showcase-stage relative min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        {SLIDES.map((item, index) => (
          <img
            key={item.key}
            src={item.image}
            alt=""
            width={1120}
            height={840}
            hidden={index !== activeIndex}
            decoding="async"
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover object-center"
          />
        ))}
      </div>
      <div
        id={panelId}
        className="login-showcase-caption shrink-0 px-7 pb-3 pt-5"
        aria-live={isAutoPlaying ? 'off' : 'polite'}
        aria-atomic="true"
      >
        <h2 className="whitespace-pre-line font-normal leading-[1.24] tracking-[-0.8px]">
          {i18nService.t(`${slide.key}Title`)}
        </h2>
        <p className="mt-3.5 text-[13px] leading-[1.6] text-[#555348]">
          {i18nService.t(`${slide.key}Description`)}
        </p>
        <span className="mt-3.5 inline-flex max-w-full items-center gap-[7px] rounded-md border border-[#28271f]/15 px-2.5 py-1.5 text-[11px] leading-[1.4] text-[#454337]">
          <DocumentTextIcon className="h-[15px] w-[15px] shrink-0" aria-hidden="true" />
          <span className="sr-only">{i18nService.t('loginShowcaseResultLabel')}</span>
          <span className="truncate">{i18nService.t(`${slide.key}Result`)}</span>
        </span>
      </div>
      <button
        type="button"
        className="login-showcase-arrow left-4"
        aria-label={i18nService.t('loginShowcasePrevious')}
        aria-controls={panelId}
        onClick={() => select(activeIndex - 1)}
      >
        <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="login-showcase-arrow right-4"
        aria-label={i18nService.t('loginShowcaseNext')}
        aria-controls={panelId}
        onClick={() => select(activeIndex + 1)}
      >
        <ChevronRightIcon className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="flex min-h-[52px] shrink-0 items-center justify-center px-4 pb-3 pt-1">
        {SLIDES.map((item, index) => (
          <button
            key={item.key}
            type="button"
            className="grid h-9 w-6 place-items-center rounded-full transition-opacity hover:opacity-60 motion-reduce:transition-none"
            aria-label={i18nService.t('loginShowcaseGoTo').replace('{category}', i18nService.t(`${item.key}Category`))}
            title={i18nService.t(`${item.key}Category`)}
            aria-current={index === activeIndex ? 'true' : undefined}
            aria-controls={panelId}
            onClick={() => select(index)}
          >
            <span className={`h-[5px] rounded-full bg-current ${index === activeIndex ? 'w-[18px] opacity-[0.85]' : 'w-[5px] opacity-25'}`} />
          </button>
        ))}
      </div>
    </section>
  );
};

export default LoginShowcase;
