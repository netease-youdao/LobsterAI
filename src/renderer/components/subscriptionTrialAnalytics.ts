import { LogReporterAction, reportYdAnalyzer } from '../services/logReporter';

export function reportSubscriptionTrialUnlockClick(campaignCode: string, isLoggedIn: boolean): void {
  // Capture the click before checking eligibility or opening the browser, so failed
  // redirects are still counted and a later login cannot change the attribution.
  void reportYdAnalyzer({
    action: LogReporterAction.SubscriptionTrialUnlockClick,
    campaignCode,
    source: 'trial_popup',
    isLoggedIn,
  });
}
