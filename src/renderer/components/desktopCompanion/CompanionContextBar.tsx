import {
  ClipboardDocumentIcon,
  DocumentTextIcon,
  FolderIcon,
  PaperClipIcon,
  PhotoIcon,
  SparklesIcon,
  ViewfinderCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import {
  type CompanionContextAction,
  CompanionContextActionKind,
  CompanionContextClipboardKind,
  formatCompanionContextActionLabel,
} from '../../../shared/desktopCompanion/contextActions';
import { i18nService } from '../../services/i18n';

const t = (key: string) => i18nService.t(key);

function ActionIcon({ action }: { action: CompanionContextAction }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  switch (action.kind) {
    case CompanionContextActionKind.ActiveFile:
      return action.isDirectory
        ? <FolderIcon className={className} aria-hidden="true" />
        : <DocumentTextIcon className={className} aria-hidden="true" />;
    case CompanionContextActionKind.Clipboard:
      return action.clipboardKind === CompanionContextClipboardKind.Image
        ? <PhotoIcon className={className} aria-hidden="true" />
        : <ClipboardDocumentIcon className={className} aria-hidden="true" />;
    case CompanionContextActionKind.Screenshot:
      return <ViewfinderCircleIcon className={className} aria-hidden="true" />;
    case CompanionContextActionKind.PickFiles:
      return <PaperClipIcon className={className} aria-hidden="true" />;
    default:
      return <SparklesIcon className={className} aria-hidden="true" />;
  }
}

export interface CompanionContextBarProps {
  actions: readonly CompanionContextAction[];
  disabled?: boolean;
  onSelect: (action: CompanionContextAction) => void;
  onDismissClipboard: (fingerprint: string) => void;
}

/**
 * Compact, zero-intrusion row of contextual chips shown inside the quick panel
 * only while the draft is empty. Vanishes as soon as the user types or attaches files.
 */
export default function CompanionContextBar({
  actions,
  disabled = false,
  onSelect,
  onDismissClipboard,
}: CompanionContextBarProps) {
  if (actions.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle/70 px-3 pb-2 pt-2.5"
      role="group"
      aria-label={t('desktopCompanionContextLabel')}
      data-testid="companion-context-bar"
    >
      {actions.map(action => {
        const label = formatCompanionContextActionLabel(action, t);
        const isLive = action.emphasis === true;
        const dismissFingerprint = action.kind === CompanionContextActionKind.Clipboard
          ? action.clipboardFingerprint
          : undefined;
        const pillClass = isLive
          ? 'border-primary/25 bg-primary/[0.06] text-foreground hover:border-primary/45 hover:bg-primary/10'
          : 'border-border-subtle bg-surface-raised/60 text-secondary hover:border-primary/30 hover:bg-surface-raised hover:text-foreground';

        if (dismissFingerprint) {
          return (
            <div
              key={action.id}
              data-context-action={action.id}
              className={`inline-flex max-w-full items-center rounded-full border text-xs leading-4 transition-colors ${pillClass}`}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(action)}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
              >
                <span className={isLive ? 'text-primary' : 'text-secondary'}><ActionIcon action={action} /></span>
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('desktopCompanionContextDismissClipboard')}
                title={t('desktopCompanionContextDismissClipboard')}
                onClick={() => onDismissClipboard(dismissFingerprint)}
                data-context-dismiss={action.id}
                className="mr-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-black/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 dark:hover:bg-white/10"
              >
                <XMarkIcon className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        }

        return (
          <button
            key={action.id}
            type="button"
            disabled={disabled}
            title={action.fileName || label}
            data-context-action={action.id}
            onClick={() => onSelect(action)}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50 ${pillClass}`}
          >
            <span className={isLive ? 'text-primary' : 'text-secondary'}><ActionIcon action={action} /></span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
