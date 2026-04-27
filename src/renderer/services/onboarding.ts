import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import './onboarding.css';
import { localStore } from './store';
import { i18nService } from './i18n';

const ONBOARDING_STORE_KEY = 'onboarding_state';

export interface OnboardingState {
  completedTours: string[];
  version: string;
}

const DEFAULT_STATE: OnboardingState = {
  completedTours: [],
  version: '1.0',
};

type TourId = 'welcome' | 'model-config';

class OnboardingService {
  private state: OnboardingState = { ...DEFAULT_STATE };
  private driverInstance: Driver | null = null;
  private loaded = false;

  async init(): Promise<void> {
    const saved = await localStore.getItem<OnboardingState>(ONBOARDING_STORE_KEY);
    if (saved) {
      this.state = saved;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await localStore.setItem(ONBOARDING_STORE_KEY, this.state);
  }

  isTourCompleted(tourId: TourId): boolean {
    return this.state.completedTours.includes(tourId);
  }

  async markTourCompleted(tourId: TourId): Promise<void> {
    if (!this.state.completedTours.includes(tourId)) {
      this.state.completedTours.push(tourId);
      await this.persist();
    }
  }

  async resetAllTours(): Promise<void> {
    this.state = { ...DEFAULT_STATE };
    await this.persist();
  }

  isReady(): boolean {
    return this.loaded;
  }

  /**
   * Start the welcome tour for first-time users.
   * Highlights: sidebar nav buttons, new chat, model selector, input area, settings.
   */
  startWelcomeTour(callbacks?: { onComplete?: () => void; onSkip?: () => void }): void {
    this.destroyExisting();

    const steps: DriveStep[] = [
      {
        element: '[data-onboarding="sidebar"]',
        popover: {
          title: i18nService.t('onboardingWelcomeTitle'),
          description: i18nService.t('onboardingWelcomeDesc'),
          side: 'right',
          align: 'center',
        },
      },
      {
        element: '[data-onboarding="new-chat"]',
        popover: {
          title: i18nService.t('onboardingNewChatTitle'),
          description: i18nService.t('onboardingNewChatDesc'),
          side: 'right',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="sidebar-nav"]',
        popover: {
          title: i18nService.t('onboardingSidebarNavTitle'),
          description: i18nService.t('onboardingSidebarNavDesc'),
          side: 'right',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="model-selector"]',
        popover: {
          title: i18nService.t('onboardingModelSelectorTitle'),
          description: i18nService.t('onboardingModelSelectorDesc'),
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="prompt-input"]',
        popover: {
          title: i18nService.t('onboardingPromptInputTitle'),
          description: i18nService.t('onboardingPromptInputDesc'),
          side: 'top',
          align: 'center',
        },
      },
      {
        element: '[data-onboarding="settings-btn"]',
        popover: {
          title: i18nService.t('onboardingSettingsTitle'),
          description: i18nService.t('onboardingSettingsDesc'),
          side: 'top',
          align: 'end',
        },
      },
    ];

    this.driverInstance = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      stagePadding: 8,
      stageRadius: 12,
      popoverClass: 'lobster-onboarding-popover',
      nextBtnText: i18nService.t('onboardingNext'),
      prevBtnText: i18nService.t('onboardingPrev'),
      doneBtnText: i18nService.t('onboardingDone'),
      progressText: `{{current}} / {{total}}`,
      steps,
      onDestroyStarted: () => {
        if (this.driverInstance && !this.driverInstance.hasNextStep()) {
          // Last step - mark as complete
          void this.markTourCompleted('welcome');
          this.driverInstance.destroy();
          callbacks?.onComplete?.();
        } else {
          // Skipped
          void this.markTourCompleted('welcome');
          this.driverInstance?.destroy();
          callbacks?.onSkip?.();
        }
      },
    });

    this.driverInstance.drive();
  }

  /**
   * Start the model configuration tour.
   * Should be triggered when user opens Settings with model tab.
   * Highlights: provider list, provider toggle, API key input, model list.
   */
  startModelConfigTour(callbacks?: { onComplete?: () => void; onSkip?: () => void }): void {
    this.destroyExisting();

    const steps: DriveStep[] = [
      {
        element: '[data-onboarding="settings-model-tab"]',
        popover: {
          title: i18nService.t('onboardingModelTabTitle'),
          description: i18nService.t('onboardingModelTabDesc'),
          side: 'right',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="provider-list"]',
        popover: {
          title: i18nService.t('onboardingProviderListTitle'),
          description: i18nService.t('onboardingProviderListDesc'),
          side: 'right',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="provider-settings"]',
        popover: {
          title: i18nService.t('onboardingProviderSettingsTitle'),
          description: i18nService.t('onboardingProviderSettingsDesc'),
          side: 'left',
          align: 'start',
        },
      },
      {
        element: '[data-onboarding="settings-save-btn"]',
        popover: {
          title: i18nService.t('onboardingSaveSettingsTitle'),
          description: i18nService.t('onboardingSaveSettingsDesc'),
          side: 'top',
          align: 'end',
        },
      },
    ];

    this.driverInstance = driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      stagePadding: 8,
      stageRadius: 12,
      popoverClass: 'lobster-onboarding-popover',
      nextBtnText: i18nService.t('onboardingNext'),
      prevBtnText: i18nService.t('onboardingPrev'),
      doneBtnText: i18nService.t('onboardingDone'),
      progressText: `{{current}} / {{total}}`,
      steps,
      onDestroyStarted: () => {
        if (this.driverInstance && !this.driverInstance.hasNextStep()) {
          void this.markTourCompleted('model-config');
          this.driverInstance.destroy();
          callbacks?.onComplete?.();
        } else {
          void this.markTourCompleted('model-config');
          this.driverInstance?.destroy();
          callbacks?.onSkip?.();
        }
      },
    });

    this.driverInstance.drive();
  }

  private destroyExisting(): void {
    if (this.driverInstance) {
      this.driverInstance.destroy();
      this.driverInstance = null;
    }
  }

  destroy(): void {
    this.destroyExisting();
  }
}

export const onboardingService = new OnboardingService();
