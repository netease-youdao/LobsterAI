import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import SkillIcon from '../icons/SkillIcon';
import KitIcon from '../kits/KitIcon';
import SkillIconTile from '../skills/SkillIconTile';
import ContextChip, {
  CONTEXT_CHIP_CLASS,
  CONTEXT_CHIP_ICON_CLASS,
  CONTEXT_CHIP_ICON_TONE_CLASS,
  CONTEXT_CHIP_TONE_CLASS,
  ContextChipTone,
} from './ContextChip';
import { placeContextChipDetail } from './contextChipDetailPlacement';

export const ContextChipDetailKind = {
  Skill: 'skill',
  Kit: 'kit',
} as const;
export type ContextChipDetailKind = typeof ContextChipDetailKind[keyof typeof ContextChipDetailKind];

/** What a sent message's skill or kit chip shows when opened. */
export interface ContextChipDetail {
  kind: ContextChipDetailKind;
  name: string;
  /** The raw id the chip shows, when it differs from the display name. */
  identifier?: string;
  iconUrl?: string;
  description: string;
  /** Short facts joined with dots, e.g. type, origin, version. */
  meta: string[];
  /** Skills a kit bundles. */
  includedSkills?: string[];
  /** Details are still being fetched; the description shows a loading line. */
  loading?: boolean;
}

const DETAIL_CHIP_CLASS = `${CONTEXT_CHIP_CLASS} ${CONTEXT_CHIP_TONE_CLASS[ContextChipTone.Reference]} cursor-pointer transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30`;

const ContextChipDetailCard = React.forwardRef<HTMLDivElement, {
  id: string;
  detail: ContextChipDetail;
  style: React.CSSProperties;
}>(({ id, detail, style }, ref) => (
  <div
    ref={ref}
    id={id}
    role="dialog"
    aria-label={detail.name}
    style={style}
    className="fixed z-50 w-80 max-w-[calc(100vw-16px)] animate-scale-in rounded-xl border border-border bg-surface p-4 text-left shadow-popover"
  >
    <div className="flex items-start gap-3">
      {detail.kind === ContextChipDetailKind.Kit ? (
        <KitIcon
          icon={detail.iconUrl}
          className="h-10 w-10"
          fallbackClassName="rounded-[10px] bg-primary-muted text-primary"
        />
      ) : (
        <SkillIconTile icon={detail.iconUrl} className="h-10 w-10 rounded-[10px]" iconClassName="h-5 w-5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold leading-5 text-foreground">{detail.name}</div>
        {detail.identifier && (
          <div className="truncate font-mono text-xs leading-4 text-muted">{detail.identifier}</div>
        )}
        {detail.meta.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs leading-4 text-secondary">
            {detail.meta.map((item, index) => (
              <React.Fragment key={item}>
                {index > 0 && <span aria-hidden="true" className="text-secondary/50">·</span>}
                <span>{item}</span>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
    {!detail.description.trim() && detail.loading ? (
      <p className="mt-3 animate-pulse text-[13px] leading-5 text-muted">{i18nService.t('loading')}</p>
    ) : (
      <p className="mt-3 line-clamp-6 whitespace-pre-wrap break-words text-[13px] leading-5 text-secondary">
        {detail.description.trim() || i18nService.t('contextChipNoDescription')}
      </p>
    )}
    {detail.includedSkills && detail.includedSkills.length > 0 && (
      <div className="mt-3 border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium text-foreground">{i18nService.t('kitSkills')}</div>
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto text-xs">
          {detail.includedSkills.map(skillName => (
            <ContextChip key={skillName} icon={SkillIcon} label={skillName} />
          ))}
        </div>
      </div>
    )}
  </div>
));
ContextChipDetailCard.displayName = 'ContextChipDetailCard';

const ContextChipDetailPopover: React.FC<{
  id: string;
  anchorRef: React.RefObject<HTMLButtonElement>;
  detail: ContextChipDetail;
  onClose: () => void;
}> = ({ id, anchorRef, detail, onClose }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card) return;
    const { top, left } = placeContextChipDetail(
      anchor.getBoundingClientRect(),
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition(prev => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (cardRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    // Details that finish loading change the card's height; keep it clear of the chip.
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (cardRef.current) resizeObserver?.observe(cardRef.current);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorRef, onClose, updatePosition]);

  return createPortal(
    <ContextChipDetailCard
      ref={cardRef}
      id={id}
      detail={detail}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? undefined : 'hidden',
      }}
    />,
    document.body,
  );
};

/**
 * A read-only skill or kit chip that opens a detail card on click, so a sent
 * message can answer "what does this skill do?" in place.
 */
export const ContextChipWithDetails: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail: ContextChipDetail;
  /** Called each time the card opens, e.g. to fetch details on demand. */
  onOpen?: () => void;
  className?: string;
}> = ({ icon: Icon, label, detail, onOpen, className = '' }) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const handleClose = useCallback(() => setOpen(false), []);
  const tone = ContextChipTone.Reference;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        className={`${DETAIL_CHIP_CLASS} ${open ? 'bg-surface-raised' : ''} ${className}`}
        title={i18nService.t('contextChipShowDetails')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
      >
        <Icon className={`${CONTEXT_CHIP_ICON_CLASS} ${CONTEXT_CHIP_ICON_TONE_CLASS[tone]}`} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && (
        <ContextChipDetailPopover id={popoverId} anchorRef={anchorRef} detail={detail} onClose={handleClose} />
      )}
    </>
  );
};
