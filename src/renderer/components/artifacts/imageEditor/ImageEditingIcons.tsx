import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
const defaults = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function DrawIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M3 16C7 7 13 2 14 5S5 18 9 19 20 7 20 11s-7 12-2 10l3-2" /></svg>;
}
export function RegionEditIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3" /><path d="m12 10 9 5-5 1-1 5-3-11Z" /></svg>;
}
export function RemoveBackgroundIcon(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="3" y="3" width="18" height="18" rx="3" /><path opacity=".4" d="M9 3v18m6-18v18M3 9h18M3 15h18" /><path d="m5 19 14-14" /><path d="m4 11 7-7m2 16 7-7" /></svg>;
}
export function EraserIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m14 3 7 7a2 2 0 0 1 0 3l-7 8H9l-6-6a2 2 0 0 1 0-3l8-9a2 2 0 0 1 3 0Z" /><path d="m7 8 10 10M9 21h12" /></svg>;
}
export function ReframeIcon(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h10a2 2 0 0 1 2 2v7" /></svg>;
}
export function TextIcon(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M5 6V4h14v2M12 4v16m-4 0h8" /></svg>;
}
