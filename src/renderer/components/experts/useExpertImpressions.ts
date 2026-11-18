import { catalogAnalyticsId, UsageEntry, UsageStage } from '@shared/analytics/usage';
import { type RefObject, useEffect, useRef } from 'react';

import { reportExpertJourney } from '../../services/usageAnalytics';

/** Visibility, not catalog membership, is the exposure denominator. */
export function useExpertImpressions(
  root: RefObject<HTMLElement>,
  journeyId: string,
  catalogVersion?: string,
  revision?: unknown,
): void {
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
          const node = entry.target as HTMLElement;
          const presetId = catalogAnalyticsId(node.dataset.expertId);
          const scenarioId = catalogAnalyticsId(node.dataset.expertScenario);
          const key = `${catalogVersion}:${presetId}:${scenarioId ?? ''}`;
          if (!presetId || seen.current.has(key)) continue;
          seen.current.add(key);
          reportExpertJourney(UsageStage.Impression, {
            journeyId,
            presetId,
            scenarioId,
            catalogVersion,
            entry: scenarioId ? UsageEntry.Featured : UsageEntry.Plaza,
          });
        }
      },
      { threshold: 0.5 },
    );
    root.current.querySelectorAll('[data-expert-id]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [root, journeyId, catalogVersion, revision]);
}
