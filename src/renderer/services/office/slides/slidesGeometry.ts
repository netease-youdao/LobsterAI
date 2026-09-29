import type { GeometryView } from './slidesModel';
import { elements, num } from './slidesXml';

/**
 * SVG paths for the preset geometries decks use most, and for custom geometry. Shapes outside the
 * list draw as their bounding rectangle, which keeps them visible and editable.
 */

const f = (value: number): string => String(Math.round(value * 100) / 100);

function polygon(points: [number, number][]): string {
  return `${points.map(([x, y], index) => `${index ? 'L' : 'M'}${f(x)},${f(y)}`).join(' ')} Z`;
}

function roundRect(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return `M${f(r)},0 H${f(w - r)} A${f(r)},${f(r)} 0 0 1 ${f(w)},${f(r)} V${f(h - r)} A${f(r)},${f(r)} 0 0 1 ${f(w - r)},${f(h)} H${f(r)} A${f(r)},${f(r)} 0 0 1 0,${f(h - r)} V${f(r)} A${f(r)},${f(r)} 0 0 1 ${f(r)},0 Z`;
}

function star(w: number, h: number, points: number, innerRatio: number): string {
  const corners: [number, number][] = [];
  for (let index = 0; index < points * 2; index++) {
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    const radius = index % 2 ? innerRatio : 1;
    corners.push([w / 2 + (w / 2) * radius * Math.cos(angle), h / 2 + (h / 2) * radius * Math.sin(angle)]);
  }
  return polygon(corners);
}

function regular(w: number, h: number, sides: number): string {
  const corners: [number, number][] = [];
  for (let index = 0; index < sides; index++) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
    corners.push([w / 2 + (w / 2) * Math.cos(angle), h / 2 + (h / 2) * Math.sin(angle)]);
  }
  return polygon(corners);
}

/** The path of a geometry in a w × h box, or undefined when a plain rectangle will do. */
export function geometryPath(geometry: GeometryView, w: number, h: number): string | undefined {
  const adj = (name: string, fallback: number): number => (geometry.adjust[name] ?? fallback) / 100000;
  const ss = Math.min(w, h);
  switch (geometry.preset) {
    case 'rect': case 'flowChartProcess': case 'textBox': return undefined;
    case 'custom': return customPath(geometry.paths ?? [], w, h);
    case 'roundRect': case 'flowChartAlternateProcess': return roundRect(w, h, ss * adj('adj', 16667));
    case 'ellipse': case 'flowChartConnector': return `M0,${f(h / 2)} A${f(w / 2)},${f(h / 2)} 0 1 1 ${f(w)},${f(h / 2)} A${f(w / 2)},${f(h / 2)} 0 1 1 0,${f(h / 2)} Z`;
    case 'flowChartTerminator': return roundRect(w, h, h / 2);
    case 'triangle': return polygon([[w * adj('adj', 50000), 0], [w, h], [0, h]]);
    case 'rtTriangle': return polygon([[0, 0], [w, h], [0, h]]);
    case 'diamond': case 'flowChartDecision': return polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'parallelogram': case 'flowChartInputOutput': {
      const x = ss * adj('adj', 25000);
      return polygon([[x, 0], [w, 0], [w - x, h], [0, h]]);
    }
    case 'trapezoid': {
      const x = ss * adj('adj', 25000);
      return polygon([[x, 0], [w - x, 0], [w, h], [0, h]]);
    }
    case 'pentagon': return regular(w, h, 5);
    case 'hexagon': {
      const x = ss * adj('adj', 25000);
      return polygon([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]]);
    }
    case 'heptagon': return regular(w, h, 7);
    case 'octagon': {
      const x = ss * adj('adj', 29289);
      return polygon([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]]);
    }
    case 'decagon': return regular(w, h, 10);
    case 'dodecagon': return regular(w, h, 12);
    case 'plus': {
      const x = ss * adj('adj', 25000);
      return polygon([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]]);
    }
    case 'star4': return star(w, h, 4, adj('adj', 12500) * 2);
    case 'star5': return star(w, h, 5, 0.382);
    case 'star6': return star(w, h, 6, 0.577);
    case 'star8': return star(w, h, 8, 0.75);
    case 'rightArrow': {
      const body = h * adj('adj1', 50000);
      const head = ss * adj('adj2', 50000);
      return polygon([[0, (h - body) / 2], [w - head, (h - body) / 2], [w - head, 0], [w, h / 2], [w - head, h], [w - head, (h + body) / 2], [0, (h + body) / 2]]);
    }
    case 'leftArrow': {
      const body = h * adj('adj1', 50000);
      const head = ss * adj('adj2', 50000);
      return polygon([[w, (h - body) / 2], [head, (h - body) / 2], [head, 0], [0, h / 2], [head, h], [head, (h + body) / 2], [w, (h + body) / 2]]);
    }
    case 'upArrow': {
      const body = w * adj('adj1', 50000);
      const head = ss * adj('adj2', 50000);
      return polygon([[(w - body) / 2, h], [(w - body) / 2, head], [0, head], [w / 2, 0], [w, head], [(w + body) / 2, head], [(w + body) / 2, h]]);
    }
    case 'downArrow': {
      const body = w * adj('adj1', 50000);
      const head = ss * adj('adj2', 50000);
      return polygon([[(w - body) / 2, 0], [(w - body) / 2, h - head], [0, h - head], [w / 2, h], [w, h - head], [(w + body) / 2, h - head], [(w + body) / 2, 0]]);
    }
    case 'leftRightArrow': {
      const body = h * adj('adj1', 50000);
      const head = ss * adj('adj2', 50000);
      return polygon([[0, h / 2], [head, 0], [head, (h - body) / 2], [w - head, (h - body) / 2], [w - head, 0], [w, h / 2], [w - head, h], [w - head, (h + body) / 2], [head, (h + body) / 2], [head, h]]);
    }
    case 'chevron': {
      const x = ss * adj('adj', 50000);
      return polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]]);
    }
    case 'homePlate': case 'flowChartOffpageConnector': {
      const x = ss * adj('adj', 50000);
      return geometry.preset === 'homePlate' ? polygon([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]]) : polygon([[0, 0], [w, 0], [w, h * 0.8], [w / 2, h], [0, h * 0.8]]);
    }
    case 'snip1Rect': {
      const x = ss * adj('adj', 16667);
      return polygon([[0, 0], [w - x, 0], [w, x], [w, h], [0, h]]);
    }
    case 'snip2SameRect': {
      const x = ss * adj('adj1', 16667);
      return polygon([[x, 0], [w - x, 0], [w, x], [w, h], [0, h], [0, x]]);
    }
    case 'round1Rect': {
      const r = ss * adj('adj', 16667);
      return `M0,0 H${f(w - r)} A${f(r)},${f(r)} 0 0 1 ${f(w)},${f(r)} V${f(h)} H0 Z`;
    }
    case 'round2SameRect': {
      const r = ss * adj('adj1', 16667);
      return `M${f(r)},0 H${f(w - r)} A${f(r)},${f(r)} 0 0 1 ${f(w)},${f(r)} V${f(h)} H0 V${f(r)} A${f(r)},${f(r)} 0 0 1 ${f(r)},0 Z`;
    }
    case 'donut': {
      const t = ss * adj('adj', 25000);
      return `M0,${f(h / 2)} A${f(w / 2)},${f(h / 2)} 0 1 1 ${f(w)},${f(h / 2)} A${f(w / 2)},${f(h / 2)} 0 1 1 0,${f(h / 2)} Z M${f(t)},${f(h / 2)} A${f(w / 2 - t)},${f(h / 2 - t)} 0 1 0 ${f(w - t)},${f(h / 2)} A${f(w / 2 - t)},${f(h / 2 - t)} 0 1 0 ${f(t)},${f(h / 2)} Z`;
    }
    case 'line': case 'straightConnector1': case 'bentConnector2': case 'bentConnector3': case 'curvedConnector3':
      return `M0,0 L${f(w)},${f(h)}`;
    case 'wedgeRectCallout': case 'wedgeRoundRectCallout': {
      const tipX = w / 2 + w * adj('adj1', -20833);
      const tipY = h / 2 + h * adj('adj2', 62500);
      return `${geometry.preset === 'wedgeRoundRectCallout' ? roundRect(w, h, ss * 0.16667) : polygon([[0, 0], [w, 0], [w, h], [0, h]])} M${f(w * 0.3)},${f(h)} L${f(tipX)},${f(tipY)} L${f(w * 0.45)},${f(h)} Z`;
    }
    case 'cloud': case 'cloudCallout':
      return roundRect(w, h, ss / 2);
    case 'can': case 'flowChartMagneticDisk': {
      const ry = h * Math.min(adj('adj', 25000), 0.5) / 2;
      return `M0,${f(ry)} A${f(w / 2)},${f(ry)} 0 0 1 ${f(w)},${f(ry)} V${f(h - ry)} A${f(w / 2)},${f(ry)} 0 0 1 0,${f(h - ry)} Z M0,${f(ry)} A${f(w / 2)},${f(ry)} 0 0 0 ${f(w)},${f(ry)}`;
    }
    default: return undefined;
  }
}

/** Whether a geometry is an open stroke (a line), drawn without a fill. */
export const isLineGeometry = (geometry: GeometryView): boolean => ['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3'].includes(geometry.preset);

/** a:custGeom paths scaled into the box; arcs follow DrawingML's start and swing angles. */
function customPath(paths: Element[], w: number, h: number): string {
  const out: string[] = [];
  for (const path of paths) {
    const pw = num(path, 'w') || w;
    const ph = num(path, 'h') || h;
    const sx = pw ? w / pw : 1;
    const sy = ph ? h / ph : 1;
    let cx = 0;
    let cy = 0;
    const point = (element: Element | undefined): [number, number] => [(num(element, 'x') ?? 0) * sx, (num(element, 'y') ?? 0) * sy];
    for (const command of elements(path)) {
      const pts = elements(command).filter(child => child.localName === 'pt').map(point);
      switch (command.localName) {
        case 'moveTo': [cx, cy] = pts[0] ?? [cx, cy]; out.push(`M${f(cx)},${f(cy)}`); break;
        case 'lnTo': [cx, cy] = pts[0] ?? [cx, cy]; out.push(`L${f(cx)},${f(cy)}`); break;
        case 'cubicBezTo': if (pts.length === 3) { out.push(`C${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}`); [cx, cy] = pts[2]; } break;
        case 'quadBezTo': if (pts.length === 2) { out.push(`Q${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}`); [cx, cy] = pts[1]; } break;
        case 'arcTo': {
          const rx = (num(command, 'wR') ?? 0) * sx;
          const ry = (num(command, 'hR') ?? 0) * sy;
          const start = ((num(command, 'stAng') ?? 0) / 60000) * (Math.PI / 180);
          const swing = ((num(command, 'swAng') ?? 0) / 60000) * (Math.PI / 180);
          const centerX = cx - rx * Math.cos(start);
          const centerY = cy - ry * Math.sin(start);
          const endX = centerX + rx * Math.cos(start + swing);
          const endY = centerY + ry * Math.sin(start + swing);
          out.push(`A${f(rx)},${f(ry)} 0 ${Math.abs(swing) > Math.PI ? 1 : 0} ${swing > 0 ? 1 : 0} ${f(endX)},${f(endY)}`);
          [cx, cy] = [endX, endY];
          break;
        }
        case 'close': out.push('Z'); break;
        default: break;
      }
    }
  }
  return out.join(' ');
}
