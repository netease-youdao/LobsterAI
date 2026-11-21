import { CheckIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { type CSSProperties } from 'react';

import { type PetAction } from '../../../../shared/desktopCompanion/petAtlas';
import { CompanionSkinKind, getCompanionSkin } from '../../../../shared/desktopCompanion/skins';
import { CompanionMood } from './companionMood';
import LobsterMark from './LobsterMark';
import PetAtlasPlayer, { type LoadedPetAtlas } from './PetAtlasPlayer';

/**
 * Matches the standing character height inside a 192x208 Codex atlas cell
 * (~73% fill) closely to the 64px static `.webp` while keeping jump headroom
 * inside the 84x84 transparent orb window.
 */
const ATLAS_HEIGHT_SCALE = 1.25;

interface CompanionCharacterProps {
  skin: string;
  mood: CompanionMood;
  size: number;
  atlas?: LoadedPetAtlas | null;
  action?: PetAction | null;
  landing?: boolean;
  dragTiltDeg?: number;
  onActionCycleComplete?: (action: PetAction) => void;
  showBadge?: boolean;
  className?: string;
}

export default function CompanionCharacter({
  skin,
  mood,
  size,
  atlas = null,
  action = null,
  landing = false,
  dragTiltDeg = 0,
  onActionCycleComplete,
  showBadge = true,
  className,
}: CompanionCharacterProps) {
  const definition = getCompanionSkin(skin);
  const isImageSkin = definition.kind === CompanionSkinKind.Image;
  const showingAtlas = isImageSkin && !!atlas && action !== null;
  const atlasHeight = Math.round(size * ATLAS_HEIGHT_SCALE);
  const badge = mood === CompanionMood.Done ? 'done' : mood === CompanionMood.Attention ? 'attention' : mood === CompanionMood.Error ? 'error' : null;

  return (
    <span
      className={`companion-character ${className ?? ''}`}
      data-mood={mood}
      data-kind={definition.kind}
      data-action={showingAtlas ? action : undefined}
      data-landing={isImageSkin && landing ? 'true' : undefined}
      data-atlas-active={showingAtlas}
      style={{
        width: size,
        height: size,
        '--skin-accent': definition.accent,
        '--drag-tilt': `${dragTiltDeg}deg`,
      } as CSSProperties}
    >
      {definition.kind === CompanionSkinKind.Brand && <LobsterMark size={size} />}
      {showingAtlas && atlas && action && (
        <PetAtlasPlayer
          atlas={atlas}
          action={action}
          displayHeight={atlasHeight}
          onCycleComplete={onActionCycleComplete}
        />
      )}
      {isImageSkin && !showingAtlas && definition.asset && (
        <img className="character-image" src={definition.asset} alt="" draggable={false} />
      )}
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
