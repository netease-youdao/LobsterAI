import { XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import { MANAGEMENT_BODY_TEXT, MANAGEMENT_META_TEXT, MANAGEMENT_TITLE_TEXT } from '../common/managementTypography';
import Modal from '../common/Modal';
import { McpIconTile } from './McpCard';

export interface McpDetailStat {
  label: string;
  value: string;
}

export interface McpDetailInfoRow {
  label: string;
  value: string;
  /** Commands, URLs and env keys read better in a monospace face. */
  mono?: boolean;
  /** Renders the value as a link, e.g. to open a URL externally. */
  onSelect?: () => void;
}

interface McpDetailModalProps {
  title: string;
  subtitle?: string;
  icon?: string;
  description: string;
  stats: McpDetailStat[];
  info: McpDetailInfoRow[];
  /** Primary action pill in the header (install / connect). */
  action?: React.ReactNode;
  /** Management strip along the bottom (enable, edit, delete). */
  footer?: React.ReactNode;
  onClose: () => void;
}

/**
 * Product page for one MCP entry, built like the skill detail dialog: identity
 * plus a single action on top, a facts strip, then the prose. Long descriptions
 * scroll inside the dialog instead of pushing the header and footer away.
 */
const McpDetailModal: React.FC<McpDetailModalProps> = ({
  title,
  subtitle,
  icon,
  description,
  stats,
  info,
  action,
  footer,
  onClose,
}) => createPortal(
  <Modal
    onClose={onClose}
    onEscape={onClose}
    overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    className="mx-4 flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-2xl"
  >
    <div className="relative flex-shrink-0 px-6 pb-4 pt-6">
      <button
        type="button"
        onClick={onClose}
        aria-label={i18nService.t('close')}
        className="absolute right-4 top-4 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-3.5 pr-9">
        <McpIconTile icon={icon} className="h-14 w-14 rounded-2xl" iconClassName="h-7 w-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold leading-tight text-foreground">
            {title}
          </div>
          {subtitle && (
            <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} text-secondary`}>{subtitle}</div>
          )}
        </div>
        {action}
      </div>
    </div>

    {stats.length > 0 && (
      <div className="flex flex-shrink-0 border-y border-border">
        {stats.map((stat, index) => (
          <div
            key={stat.label}
            className={`flex-1 px-6 py-3 text-center ${index > 0 ? 'border-l border-border' : ''}`}
          >
            <div className={`${MANAGEMENT_META_TEXT} font-medium uppercase tracking-wide text-muted`}>
              {stat.label}
            </div>
            <div className={`mt-1 truncate ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>
    )}

    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {description && (
        <>
          <h3 className={`mb-2 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground`}>
            {i18nService.t('mcpDetailAbout')}
          </h3>
          <p className={`whitespace-pre-wrap break-words ${MANAGEMENT_TITLE_TEXT} leading-relaxed text-secondary`}>
            {description}
          </p>
        </>
      )}

      {info.length > 0 && (
        <>
          <h3 className={`mb-2 ${MANAGEMENT_BODY_TEXT} font-semibold text-foreground ${description ? 'mt-5' : ''}`}>
            {i18nService.t('mcpDetailInfo')}
          </h3>
          <div className="space-y-2">
            {info.map(row => (
              <div key={row.label} className="flex items-start text-xs">
                <span className="w-20 flex-shrink-0 text-secondary">{row.label}</span>
                {row.onSelect ? (
                  <button
                    type="button"
                    onClick={row.onSelect}
                    className={`min-w-0 break-all text-left text-primary hover:underline ${row.mono ? 'font-mono' : ''}`}
                  >
                    {row.value}
                  </button>
                ) : (
                  <span className={`min-w-0 break-all text-foreground ${row.mono ? 'font-mono' : ''}`}>
                    {row.value}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>

    {footer && (
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border px-6 py-3">
        {footer}
      </div>
    )}
  </Modal>,
  document.body,
);

export default McpDetailModal;
