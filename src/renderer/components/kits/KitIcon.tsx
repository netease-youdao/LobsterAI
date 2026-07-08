import React, { useState } from 'react';

import SidebarKitsIcon from '../icons/SidebarKitsIcon';

interface KitIconProps {
  icon?: string;
  className?: string;
  fallbackClassName?: string;
  fallbackIconClassName?: string;
}

const KitIcon: React.FC<KitIconProps> = ({
  icon,
  className = 'h-16 w-16',
  fallbackClassName = 'rounded-xl bg-primary-muted text-primary',
  fallbackIconClassName = 'h-1/2 w-1/2',
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedIcon = icon?.trim();

  if (normalizedIcon && !imageFailed) {
    return (
      <img
        alt=""
        className={`${className} shrink-0 object-contain`}
        draggable={false}
        src={normalizedIcon}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <span className={`${className} ${fallbackClassName} inline-flex shrink-0 items-center justify-center`}>
      <SidebarKitsIcon className={fallbackIconClassName} />
    </span>
  );
};

export default KitIcon;
