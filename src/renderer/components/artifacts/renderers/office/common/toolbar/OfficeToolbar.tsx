import React from 'react';

import { i18nService } from '@/services/i18n';

import {
  formatOfficeFontLabel,
  formatOfficeFontSizeLabel,
} from './officeToolbarLabels';

const t = (key: string) => i18nService.t(key);

/** Office's usual family names; each editor maps them to an installed face or a stand-in. */
export const COMMON_FONTS = [
  '等线',
  'Noto Sans SC',
  '宋体',
  '黑体',
  '微软雅黑',
  '楷体',
  '仿宋',
  'Calibri',
  'Arial',
  'Times New Roman',
  'Cambria',
  'Courier New',
];
/** Font sizes in points, including standard Chinese typographic sizes. */
export const FONT_SIZES = [7.5, 9, 10, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 36, 42, 48, 72];

/** Formatting controls of one editor; `label` is the i18n key of its accessible name. */
export function OfficeToolbar({ label, children, toolbarRef }: {
  label: string; children: React.ReactNode; toolbarRef?: React.Ref<HTMLDivElement>;
}): React.ReactElement {
  return <div ref={toolbarRef} className="lobster-office-toolbar" role="toolbar" aria-label={t(label)}>{children}</div>;
}

export function OfficeToolbarDivider(): React.ReactElement {
  return <span className="lobster-office-toolbar-divider" />;
}

/** A toolbar button; pressing it keeps the focus, and so the selection, in the editor. */
export function OfficeToolbarButton({ label, active, disabled, onClick, onDoubleClick, children }: {
  /** i18n key of the tooltip and accessible name. */
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" title={t(label)} aria-label={t(label)} aria-pressed={active} disabled={disabled}
      onMouseDown={event => event.preventDefault()} onClick={onClick} onDoubleClick={onDoubleClick}>
      {children}
    </button>
  );
}

interface MenuFocus {
  /** Menus take the focus while open; editors that lose their selection with it pin it here. */
  onFocus?: () => void;
  onBlur?: () => void;
}

/** The font family menu: the current font, the document's own fonts and the usual ones. */
export function OfficeFontSelect({ value, fonts = [], hidden, disabled, className, onChange, onFocus, onBlur }: MenuFocus & {
  value?: string;
  fonts?: readonly string[];
  /** Fonts not to offer, e.g. an editor's private stand-in families. */
  hidden?: (font: string) => boolean;
  disabled?: boolean;
  className?: string;
  onChange: (font: string) => void;
}): React.ReactElement {
  const language = i18nService.getLanguage();
  const options = [...new Set([value, ...fonts, ...COMMON_FONTS])]
    .filter((font): font is string => Boolean(font) && !hidden?.(font!));
  return (
    <select className={className} aria-label={t('officeFont')} title={t('officeFont')} value={value ?? ''} disabled={disabled}
      onFocus={onFocus} onBlur={onBlur} onChange={event => onChange(event.target.value)}>
      <option value="" disabled>{t('officeFont')}</option>
      {options.map(font => <option key={font} value={font}>{formatOfficeFontLabel(font, language)}</option>)}
    </select>
  );
}

/** The font size menu in points: the current size among the usual ones. */
export function OfficeFontSizeSelect({ value, disabled, className, onChange, onFocus, onBlur }: MenuFocus & {
  value?: number;
  disabled?: boolean;
  className?: string;
  onChange: (points: number) => void;
}): React.ReactElement {
  const language = i18nService.getLanguage();
  const sizes = [...new Set([value, ...FONT_SIZES])].filter((size): size is number => typeof size === 'number').sort((a, b) => a - b);
  return (
    <select className={className} aria-label={t('officeFontSize')} title={t('officeFontSize')} value={value ?? ''} disabled={disabled}
      onFocus={onFocus} onBlur={onBlur} onChange={event => onChange(Number(event.target.value))}>
      <option value="" disabled>{t('officeFontSize')}</option>
      {sizes.map(size => <option key={size} value={size}>{formatOfficeFontSizeLabel(size, language)}</option>)}
    </select>
  );
}
