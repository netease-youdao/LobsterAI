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
export function CompareIcon(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 2v20" /><path d="M12 4h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7Z" fill="currentColor" stroke="none" opacity=".35" /></svg>;
}
/** A palette with a brush across it: the Edit entry on images shown in the conversation. */
export function PaletteBrushIcon(props: IconProps) {
  return <svg {...defaults} {...props}>
    <path d="M13.2 7.7C11.6 5.6 8.6 5.1 6.6 6.9 4.6 8.7 4.6 12.1 6 15.1c1.2 2.5 3.4 4.4 6.2 5.6" />
    <path d="M17.1 11.2c1.6 1.6 2.1 4.2.9 5.9-1 1.4-2.9 1.6-4.2.4" />
    <path d="M12.21 11.12 17.52 4.21A1.2 1.2 0 0 1 19.37 5.74L13.6 12.26" />
    <path d="M9.6 15.7Q9.79 12.49 11.37 10.42L14.45 12.96Q12.72 14.9 9.6 15.7Z" />
  </svg>;
}
/** A solid sparkle for AI actions; it stays crisp at 14–16 px on a filled button, unlike an outlined cluster. */
export function AiEditIcon(props: IconProps) {
  return <svg {...defaults} fill="currentColor" strokeWidth={1} {...props}>
    <path d="M10 6c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5C7.1 12.9 9.4 10.6 10 6Z" />
    <path d="M18.5 2.5c.25 1.85 1.15 2.75 3 3-1.85.25-2.75 1.15-3 3-.25-1.85-1.15-2.75-3-3 1.85-.25 2.75-1.15 3-3Z" />
  </svg>;
}
