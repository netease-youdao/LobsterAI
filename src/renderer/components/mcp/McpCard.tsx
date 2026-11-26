import React, { useState } from 'react';

import { MANAGEMENT_META_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import ConnectorIcon from '../icons/ConnectorIcon';

interface McpIconTileProps {
  /** Icon URL from marketplace data. Falls back to the default connector glyph. */
  icon?: string;
  className?: string;
  iconClassName?: string;
}

/**
 * Icon shown for an MCP entry: the marketplace image when there is one, and
 * otherwise the connector glyph on a muted tile, so the name stays the thing
 * you read first.
 */
export const McpIconTile: React.FC<McpIconTileProps> = ({
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
      <ConnectorIcon className={iconClassName} />
    </span>
  );
};

interface McpCardProps {
  title: string;
  description: string;
  icon?: string;
  /** Capsule / overflow menu rendered next to the title. */
  actions?: React.ReactNode;
  /** Badge row pinned to the bottom of the card. */
  meta?: React.ReactNode;
  /** Opens the detail dialog; the card becomes a button when provided. */
  onOpenDetail?: () => void;
}

/**
 * Compact connector tile. Installed connectors can also show runtime actions.
 */
const McpCard: React.FC<McpCardProps> = ({
  title,
  description,
  icon,
  actions,
  meta,
  onOpenDetail,
}) => (
  <div
    role={onOpenDetail ? 'button' : undefined}
    tabIndex={onOpenDetail ? 0 : undefined}
    onClick={onOpenDetail}
    onKeyDown={onOpenDetail && ((event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpenDetail();
      }
    })}
    className={`group flex flex-col justify-center rounded-xl border border-border bg-surface p-3 transition-colors hover:bg-surface-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
      onOpenDetail ? 'cursor-pointer' : ''
    }`}
  >
    <div className="flex items-center gap-3">
      <McpIconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${MANAGEMENT_TITLE_TEXT} font-semibold text-foreground`}>{title}</div>
        <p title={description} className="mt-1 truncate text-xs text-secondary">{description}</p>
      </div>
      {actions && (
        <div className="flex flex-shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </div>

    {meta && (
      <div className={`mt-2 flex min-w-0 items-center gap-1.5 ${MANAGEMENT_META_TEXT} text-muted`}>
        {meta}
      </div>
    )}
  </div>
);

export default McpCard;
