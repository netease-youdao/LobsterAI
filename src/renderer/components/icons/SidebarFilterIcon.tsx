import React from 'react';

const FUNNEL_PATH =
  'M8 2c1.84 0 3.64.16 5.39.45.35.06.61.37.61.73v.7c0 .4-.16.78-.44 1.06L9.94 8.56c-.28.28-.44.66-.44 1.06v1.95c0 .56-.31 1.07-.83 1.34L6.5 14V9.62c0-.4-.16-.78-.44-1.06L2.44 4.94A1.5 1.5 0 0 1 2 3.88v-.7c0-.36.26-.67.61-.73A32.2 32.2 0 0 1 8 2Z';

interface SidebarFilterIconProps {
  className?: string;
  /** Fills the funnel while a filter is applied; animated by `.sidebar-filter-icon` in index.css. */
  isActive?: boolean;
}

// The fill and the drop are animated from index.css (`.sidebar-filter-icon*`), so the icon stays
// a plain outline wherever those styles do not apply.
const SidebarFilterIcon: React.FC<SidebarFilterIconProps> = ({ className, isActive = false }) => {
  return (
    <svg
      className={`sidebar-filter-icon ${className ?? ''}`}
      data-active={isActive ? 'true' : undefined}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.13"
      strokeLinecap="round"
      strokeLinejoin="round"
      overflow="visible"
      aria-hidden="true"
    >
      <g className="sidebar-filter-icon-funnel">
        <path className="sidebar-filter-icon-fill" d={FUNNEL_PATH} fill="currentColor" stroke="none" />
        <path d={FUNNEL_PATH} />
      </g>
      <circle className="sidebar-filter-icon-drop" cx="8" cy="13.9" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
};

export default SidebarFilterIcon;
