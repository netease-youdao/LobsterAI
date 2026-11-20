/** CSS variable holding the main window zoom factor; WindowZoomIndicator keeps it current. */
export const APP_ZOOM_CSS_VARIABLE = '--app-zoom';

// The macOS traffic lights are native and keep their size when the page zooms, so the room left for them
// is divided by the zoom to stay the same on screen. Tailwind needs these class names written out in full.
export const MAC_TRAFFIC_LIGHT_INSET_CLASS = 'pl-[calc(68px/var(--app-zoom,1))]';
export const MAC_TRAFFIC_LIGHT_WIDE_INSET_CLASS = 'pl-[calc(84px/var(--app-zoom,1))]';
