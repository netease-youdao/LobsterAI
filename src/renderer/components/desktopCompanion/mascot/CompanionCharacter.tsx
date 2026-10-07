import { CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { type CSSProperties, useEffect, useState } from 'react';

import type { CompanionGaze } from '../../../../shared/desktopCompanion/constants';
import { getCompanionSkin } from '../../../../shared/desktopCompanion/skins';
import { CompanionMood } from './companionMood';
import LobsterHood from './LobsterHood';

const BLINK_MS = 140;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Random blinks every 3–6 s while the eyes are open. */
function useBlink(enabled: boolean): boolean {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!enabled || prefersReducedMotion()) return;
    let open: ReturnType<typeof setTimeout>;
    let close: ReturnType<typeof setTimeout>;
    const schedule = () => {
      open = setTimeout(() => {
        setBlink(true);
        close = setTimeout(() => { setBlink(false); schedule(); }, BLINK_MS);
      }, 3_000 + Math.random() * 3_000);
    };
    schedule();
    return () => { clearTimeout(open); clearTimeout(close); setBlink(false); };
  }, [enabled]);
  return blink;
}

interface CompanionCharacterProps {
  skin: string;
  mood: CompanionMood;
  size: number;
  gaze?: CompanionGaze;
  showBadge?: boolean;
  className?: string;
}

export default function CompanionCharacter({ skin, mood, size, gaze, showBadge = true, className }: CompanionCharacterProps) {
  const definition = getCompanionSkin(skin);
  const eyesOpen = mood !== CompanionMood.Done && mood !== CompanionMood.Happy && mood !== CompanionMood.Snooze;
  const blink = useBlink(!definition.asset && eyesOpen);
  const badge = mood === CompanionMood.Done ? 'done' : mood === CompanionMood.Attention ? 'attention' : mood === CompanionMood.Error ? 'error' : null;
  return (
    <span
      className={`companion-character ${className ?? ''}`}
      data-mood={mood}
      data-kind={definition.asset ? 'image' : 'vector'}
      style={{ width: size, height: size, '--skin-accent': definition.accent } as CSSProperties}
    >
      {definition.asset
        ? <img className="character-image" src={definition.asset} alt="" draggable={false} />
        : <LobsterHood mood={mood} gaze={gaze} blink={blink} size={size} />}
      {showBadge && badge && (
        <span className="character-badge" data-badge={badge}>
          {badge === 'done' ? <CheckIcon /> : badge === 'attention' ? '!' : <ExclamationTriangleIcon />}
        </span>
      )}
    </span>
  );
}
