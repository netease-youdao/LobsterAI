import { CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { type CSSProperties } from 'react';

import { CompanionSkinKind, getCompanionSkin } from '../../../../shared/desktopCompanion/skins';
import { CompanionMood } from './companionMood';
import LobsterMark from './LobsterMark';

interface CompanionCharacterProps {
  skin: string;
  mood: CompanionMood;
  size: number;
  showBadge?: boolean;
  className?: string;
}

export default function CompanionCharacter({ skin, mood, size, showBadge = true, className }: CompanionCharacterProps) {
  const definition = getCompanionSkin(skin);
  const badge = mood === CompanionMood.Done ? 'done' : mood === CompanionMood.Attention ? 'attention' : mood === CompanionMood.Error ? 'error' : null;
  return (
    <span
      className={`companion-character ${className ?? ''}`}
      data-mood={mood}
      data-kind={definition.kind}
      style={{ width: size, height: size, '--skin-accent': definition.accent } as CSSProperties}
    >
      {definition.kind === CompanionSkinKind.Brand && <LobsterMark size={size} />}
      {definition.kind === CompanionSkinKind.Image && definition.asset
        && <img className="character-image" src={definition.asset} alt="" draggable={false} />}
      {showBadge && mood === CompanionMood.Working && (
        <span className="character-thinking" aria-hidden="true">
          <span /><span /><span />
        </span>
      )}
      {showBadge && badge && (
        <span className="character-badge" data-badge={badge}>
          {badge === 'done' ? <CheckIcon /> : badge === 'attention' ? '!' : <ExclamationTriangleIcon />}
        </span>
      )}
    </span>
  );
}
