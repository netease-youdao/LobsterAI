import React, { useState } from 'react';

import SkillIcon from '../icons/SkillIcon';

interface SkillIconTileProps {
  /** Server-provided icon URL. Falls back to the default skill icon when absent. */
  icon?: string;
  className?: string;
  iconClassName?: string;
}

/**
 * Icon shown for a skill. Renders the server-provided image when there is one,
 * and otherwise the default skill glyph on a muted tile — deliberately uniform,
 * so the skill name stays the thing you read first.
 */
const SkillIconTile: React.FC<SkillIconTileProps> = ({
  icon,
  className = 'h-10 w-10 rounded-[10px]',
  iconClassName = 'h-5 w-5',
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedIcon = icon?.trim();

  if (normalizedIcon && !imageFailed) {
    return (
      <img
        alt=""
        className={`${className} shrink-0 bg-surface-raised object-cover`}
        draggable={false}
        src={normalizedIcon}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={`${className} inline-flex shrink-0 items-center justify-center bg-primary-muted text-primary`}
    >
      <SkillIcon className={iconClassName} />
    </span>
  );
};

export default SkillIconTile;
