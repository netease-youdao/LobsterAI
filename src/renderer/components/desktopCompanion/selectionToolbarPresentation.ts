import {
  Bars3BottomLeftIcon,
  BookOpenIcon,
  ChatBubbleLeftEllipsisIcon,
  LanguageIcon,
  PencilSquareIcon,
  SpeakerWaveIcon,
  Square2StackIcon,
} from '@heroicons/react/24/outline';

import { CompanionToolbarItem } from '../../../shared/desktopCompanion/selectionToolbar';
import type { SelectionIcon } from './SelectionCard';

export const COMPANION_TOOLBAR_PRESENTATION: Record<CompanionToolbarItem, { icon: SelectionIcon; labelKey: string }> = {
  [CompanionToolbarItem.Translate]: { icon: LanguageIcon, labelKey: 'desktopCompanionActionTranslate' },
  [CompanionToolbarItem.Copy]: { icon: Square2StackIcon, labelKey: 'desktopCompanionSelectionCopy' },
  [CompanionToolbarItem.ReadAloud]: { icon: SpeakerWaveIcon, labelKey: 'desktopToolsReadAloud' },
  [CompanionToolbarItem.Summarize]: { icon: Bars3BottomLeftIcon, labelKey: 'desktopCompanionActionSummarize' },
  [CompanionToolbarItem.Explain]: { icon: BookOpenIcon, labelKey: 'desktopCompanionActionExplain' },
  [CompanionToolbarItem.Polish]: { icon: PencilSquareIcon, labelKey: 'desktopCompanionActionPolish' },
  [CompanionToolbarItem.Ask]: { icon: ChatBubbleLeftEllipsisIcon, labelKey: 'desktopCompanionActionAsk' },
};
