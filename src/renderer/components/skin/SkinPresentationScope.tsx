import './skinPresentation.css';

import React, { type CSSProperties } from 'react';

import type { SkinPresentation } from '../../../shared/skin/presentation';
import { useSkin } from '../../providers/SkinProvider';

type SkinPresentationStyle = CSSProperties & Record<`--lobster-skin-${string}`, string>;

export const buildSkinPresentationStyle = (
  presentation: SkinPresentation,
): SkinPresentationStyle => ({
  '--lobster-skin-canvas': presentation.palette.canvas,
  '--lobster-skin-panel': presentation.palette.panel,
  '--lobster-skin-panel-raised': presentation.palette.panelRaised,
  '--lobster-skin-accent': presentation.palette.accent,
  '--lobster-skin-accent-foreground': presentation.palette.accentForeground,
  '--lobster-skin-accent-alt': presentation.palette.accentAlt,
  '--lobster-skin-foreground': presentation.palette.foreground,
  '--lobster-skin-muted': presentation.palette.muted,
  '--lobster-skin-border': presentation.palette.border,
  '--lobster-skin-focus-x': `${(presentation.art?.focusX ?? 0.5) * 100}%`,
  '--lobster-skin-focus-y': `${(presentation.art?.focusY ?? 0.5) * 100}%`,
});

interface SkinPresentationScopeProps extends React.HTMLAttributes<HTMLDivElement> {
  enabled: boolean;
}

const SkinPresentationScope: React.FC<SkinPresentationScopeProps> = ({
  children,
  enabled,
  style,
  ...props
}) => {
  const { activeSkin } = useSkin();
  const presentation = enabled ? activeSkin?.presentation : undefined;

  return (
    <div
      {...props}
      data-skin-presentation={presentation?.mode}
      style={presentation ? { ...style, ...buildSkinPresentationStyle(presentation) } : style}
    >
      {children}
    </div>
  );
};

export default SkinPresentationScope;
