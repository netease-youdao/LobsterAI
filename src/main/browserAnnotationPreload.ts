import { ipcRenderer } from 'electron';

import {
  type BrowserAnnotationAnchor,
  BrowserAnnotationAnchorKind,
  type BrowserAnnotationElementEdit,
  type BrowserAnnotationElementPresentation,
  BrowserAnnotationElementStyleProperty,
  type BrowserAnnotationElementStyleProperty as BrowserAnnotationElementStylePropertyType,
  BrowserAnnotationGuestChannel,
  BrowserAnnotationGuestCommandType,
  type BrowserAnnotationGuestEnvelope,
  BrowserAnnotationGuestEventType,
  BrowserAnnotationLimit,
  BrowserAnnotationProtocolVersion,
  type BrowserAnnotationRect,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotation,
  getBrowserAnnotationElementChanges,
  hasBrowserAnnotationContent,
  resolveBrowserAnnotationMarkerViewportPoint,
  resolveBrowserAnnotationViewportRect,
} from '../shared/cowork/browserAnnotations';

let activeEnvelope: BrowserAnnotationGuestEnvelope | null = null;
let annotations: CoworkBrowserAnnotation[] = [];
let revision = 0;
let cleanup: (() => void) | null = null;
let activeCommandListener: ((
  event: Electron.IpcRendererEvent,
  command: BrowserAnnotationGuestEnvelope,
) => void) | null = null;

const cleanText = (value: string | null | undefined, max = BrowserAnnotationLimit.MaxExcerptLength) =>
  (value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const ELEMENT_STYLE_DEFINITIONS: ReadonlyArray<{
  key: BrowserAnnotationElementStylePropertyType;
  cssProperty: string;
}> = [
  { key: BrowserAnnotationElementStyleProperty.Color, cssProperty: 'color' },
  { key: BrowserAnnotationElementStyleProperty.BackgroundColor, cssProperty: 'background-color' },
  { key: BrowserAnnotationElementStyleProperty.FontSize, cssProperty: 'font-size' },
  { key: BrowserAnnotationElementStyleProperty.FontFamily, cssProperty: 'font-family' },
  { key: BrowserAnnotationElementStyleProperty.FontWeight, cssProperty: 'font-weight' },
  { key: BrowserAnnotationElementStyleProperty.BorderRadius, cssProperty: 'border-radius' },
  { key: BrowserAnnotationElementStyleProperty.BorderColor, cssProperty: 'border-color' },
  { key: BrowserAnnotationElementStyleProperty.BorderWidth, cssProperty: 'border-width' },
  { key: BrowserAnnotationElementStyleProperty.PaddingTop, cssProperty: 'padding-top' },
  { key: BrowserAnnotationElementStyleProperty.PaddingRight, cssProperty: 'padding-right' },
  { key: BrowserAnnotationElementStyleProperty.PaddingBottom, cssProperty: 'padding-bottom' },
  { key: BrowserAnnotationElementStyleProperty.PaddingLeft, cssProperty: 'padding-left' },
  { key: BrowserAnnotationElementStyleProperty.MarginTop, cssProperty: 'margin-top' },
  { key: BrowserAnnotationElementStyleProperty.MarginRight, cssProperty: 'margin-right' },
  { key: BrowserAnnotationElementStyleProperty.MarginBottom, cssProperty: 'margin-bottom' },
  { key: BrowserAnnotationElementStyleProperty.MarginLeft, cssProperty: 'margin-left' },
  { key: BrowserAnnotationElementStyleProperty.Width, cssProperty: 'width' },
  { key: BrowserAnnotationElementStyleProperty.Height, cssProperty: 'height' },
  { key: BrowserAnnotationElementStyleProperty.Opacity, cssProperty: 'opacity' },
  { key: BrowserAnnotationElementStyleProperty.FlexDirection, cssProperty: 'flex-direction' },
  { key: BrowserAnnotationElementStyleProperty.JustifyContent, cssProperty: 'justify-content' },
  { key: BrowserAnnotationElementStyleProperty.AlignItems, cssProperty: 'align-items' },
  { key: BrowserAnnotationElementStyleProperty.Gap, cssProperty: 'gap' },
  { key: BrowserAnnotationElementStyleProperty.RowGap, cssProperty: 'row-gap' },
  { key: BrowserAnnotationElementStyleProperty.ColumnGap, cssProperty: 'column-gap' },
];

const cloneElementEdit = (edit: BrowserAnnotationElementEdit): BrowserAnnotationElementEdit => ({
  canEditText: edit.canEditText,
  original: { ...edit.original },
  current: { ...edit.current },
  originalInlineStyle: {
    ...edit.originalInlineStyle,
    styles: edit.originalInlineStyle.styles
      ? Object.fromEntries(Object.entries(edit.originalInlineStyle.styles).map(([key, value]) => [
          key,
          value ? { ...value } : value,
        ]))
      : undefined,
  },
});

function selectorFor(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`.slice(0, BrowserAnnotationLimit.MaxSelectorLength);
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 6 && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(item => item.tagName === current?.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(' > ').slice(0, BrowserAnnotationLimit.MaxSelectorLength);
}

function resolveElement(selector?: string): HTMLElement | null {
  if (!selector) return null;
  try {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement ? element : null;
  } catch {
    return null;
  }
}

function rectOf(rect: DOMRect): BrowserAnnotationRect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function baseAnchor(rect: BrowserAnnotationRect, element?: Element): Omit<BrowserAnnotationAnchor, 'kind'> {
  return {
    pageUrl: location.href.slice(0, BrowserAnnotationLimit.MaxUrlLength),
    pageTitle: document.title.slice(0, BrowserAnnotationLimit.MaxTitleLength),
    framePath: [],
    rect,
    documentRect: {
      ...rect,
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
    },
    selector: element ? selectorFor(element) : undefined,
    elementPath: element ? selectorFor(element) : undefined,
    role: element?.getAttribute('role') || undefined,
    name: cleanText(element?.getAttribute('aria-label') || element?.getAttribute('alt')) || undefined,
    immediateText: element ? cleanText(element.textContent) : undefined,
    nearbyText: element?.parentElement ? cleanText(element.parentElement.textContent) : undefined,
    isFixed: element ? getComputedStyle(element).position === 'fixed' : undefined,
  } as Omit<BrowserAnnotationAnchor, 'kind'>;
}

function captureFor(rect: BrowserAnnotationRect): CoworkBrowserAnnotation['capture'] {
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    viewportScale: window.devicePixelRatio || 1,
    zoomPercent: 100,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    targetRect: rect,
    markerViewportPoint: {
      x: rect.x + Math.min(16, rect.width / 2),
      y: rect.y + Math.min(16, rect.height / 2),
    },
  };
}

function elementAnchor(element: Element): BrowserAnnotationAnchor {
  const rect = rectOf(element.getBoundingClientRect());
  const computed = getComputedStyle(element);
  return {
    ...baseAnchor(rect, element),
    kind: BrowserAnnotationAnchorKind.Element,
    tagName: element.tagName.toLowerCase(),
    color: computed.color,
    fontFamily: computed.fontFamily,
  } as BrowserAnnotationAnchor;
}

function readElementEdit(element: HTMLElement): BrowserAnnotationElementEdit {
  const computed = getComputedStyle(element);
  const opacity = Number.parseFloat(computed.opacity);
  const original: BrowserAnnotationElementPresentation = {
    text: (element.textContent || '').slice(0, BrowserAnnotationLimit.MaxCommentLength),
  };
  const originalValues = original as Record<
    BrowserAnnotationElementStylePropertyType,
    string | number | undefined
  >;
  const originalInlineStyles: NonNullable<BrowserAnnotationElementEdit['originalInlineStyle']['styles']> = {};
  for (const definition of ELEMENT_STYLE_DEFINITIONS) {
    originalValues[definition.key] = definition.key === BrowserAnnotationElementStyleProperty.Opacity
      ? (Number.isFinite(opacity) ? opacity : 1)
      : computed.getPropertyValue(definition.cssProperty);
    originalInlineStyles[definition.key] = {
      value: element.style.getPropertyValue(definition.cssProperty),
      priority: element.style.getPropertyPriority(definition.cssProperty),
    };
  }
  return {
    canEditText: element.children.length === 0,
    original,
    current: { ...original },
    originalInlineStyle: {
      color: element.style.getPropertyValue('color'),
      colorPriority: element.style.getPropertyPriority('color'),
      backgroundColor: element.style.getPropertyValue('background-color'),
      backgroundColorPriority: element.style.getPropertyPriority('background-color'),
      opacity: element.style.getPropertyValue('opacity'),
      opacityPriority: element.style.getPropertyPriority('opacity'),
      fontFamily: element.style.getPropertyValue('font-family'),
      fontFamilyPriority: element.style.getPropertyPriority('font-family'),
      styles: originalInlineStyles,
    },
  };
}

function setOrRestoreStyle(
  element: HTMLElement,
  property: string,
  current: string | number | undefined,
  original: string | number | undefined,
  originalInlineValue?: string,
  originalPriority?: string,
): void {
  if (current === original) {
    if (originalInlineValue) {
      element.style.setProperty(property, originalInlineValue, originalPriority || '');
    } else {
      element.style.removeProperty(property);
    }
    return;
  }
  if (current === undefined || current === '') {
    element.style.removeProperty(property);
  } else {
    element.style.setProperty(property, String(current), 'important');
  }
}

function applyElementEdit(element: HTMLElement, edit: BrowserAnnotationElementEdit): void {
  if (edit.canEditText) {
    element.textContent = edit.current.text === edit.original.text
      ? edit.original.text || ''
      : edit.current.text || '';
  }
  for (const definition of ELEMENT_STYLE_DEFINITIONS) {
    const inlineStyle = edit.originalInlineStyle.styles?.[definition.key];
    const legacyInlineStyle = definition.key === BrowserAnnotationElementStyleProperty.Color
      ? { value: edit.originalInlineStyle.color, priority: edit.originalInlineStyle.colorPriority }
      : definition.key === BrowserAnnotationElementStyleProperty.BackgroundColor
        ? {
            value: edit.originalInlineStyle.backgroundColor,
            priority: edit.originalInlineStyle.backgroundColorPriority,
          }
        : definition.key === BrowserAnnotationElementStyleProperty.Opacity
          ? { value: edit.originalInlineStyle.opacity, priority: edit.originalInlineStyle.opacityPriority }
          : definition.key === BrowserAnnotationElementStyleProperty.FontFamily
            ? {
                value: edit.originalInlineStyle.fontFamily,
                priority: edit.originalInlineStyle.fontFamilyPriority,
              }
            : undefined;
    setOrRestoreStyle(
      element,
      definition.cssProperty,
      edit.current[definition.key],
      edit.original[definition.key],
      inlineStyle?.value ?? legacyInlineStyle?.value,
      inlineStyle?.priority ?? legacyInlineStyle?.priority,
    );
  }
}

function restoreElementEdit(element: HTMLElement, edit: BrowserAnnotationElementEdit): void {
  applyElementEdit(element, { ...edit, current: { ...edit.original } });
}

function sameElementChanges(
  first?: BrowserAnnotationElementEdit,
  second?: BrowserAnnotationElementEdit,
): boolean {
  if (!first && !second) return true;
  if (!first || !second) return false;
  return JSON.stringify(first.current) === JSON.stringify(second.current);
}

function send(type: string, payload: Partial<BrowserAnnotationGuestEnvelope> = {}): void {
  if (!activeEnvelope) return;
  ipcRenderer.sendToHost(BrowserAnnotationGuestChannel.Event, {
    ...activeEnvelope,
    type,
    revision,
    ...payload,
  });
}

function start(envelope: BrowserAnnotationGuestEnvelope): void {
  if (activeCommandListener) {
    ipcRenderer.removeListener(BrowserAnnotationGuestChannel.Command, activeCommandListener);
    activeCommandListener = null;
  }
  cleanup?.();
  cleanup = null;
  activeEnvelope = envelope;
  revision = envelope.revision;
  annotations = envelope.annotations ? [...envelope.annotations] : [];

  const labels = envelope.labels || {};
  const root = document.createElement('div');
  root.dataset.lobsterBrowserAnnotations = 'true';
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = root.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial} *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .highlight{position:fixed;display:none;border:2px solid #1683ff;background:rgba(22,131,255,.12);box-shadow:0 0 0 1px rgba(255,255,255,.82);pointer-events:none}
    .marker,.pending-marker{position:fixed;width:26px;height:26px;border:2px solid white;border-radius:999px;background:#1683ff;color:white;font:600 12px/22px sans-serif;text-align:center;box-shadow:0 2px 7px rgba(0,0,0,.3)}
    .marker{pointer-events:auto;cursor:pointer}.pending-marker{display:none;pointer-events:none}
    .editor{position:fixed;display:none;width:352px;max-height:min(380px,calc(100vh - 16px));overflow:hidden;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#292929;color:#f5f5f5;box-shadow:0 18px 54px rgba(0,0,0,.48);pointer-events:auto}
    .editor-top{display:flex;align-items:center;gap:8px;min-height:58px;padding:9px 10px}
    .icon-button{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border:0;border-radius:999px;background:transparent;color:#dedede;cursor:pointer}
    .icon-button:hover,.icon-button.active{background:#3a3a3a}.icon-button:disabled{opacity:.35;cursor:default}
    .comment{width:100%;min-width:0;min-height:34px;max-height:92px;resize:none;border:0;background:transparent;color:#fff;padding:7px 2px;outline:none;font-size:14px;line-height:20px}
    .comment::placeholder{color:#a4a4a4}
    .top-confirm{display:grid;place-items:center;width:34px;height:34px;flex:0 0 34px;border:0;border-radius:999px;background:#fff;color:#202020;font-size:18px;cursor:pointer}
    button:disabled{opacity:.42;cursor:default}
    .properties{display:none;max-height:min(272px,calc(100vh - 124px));overflow:auto;border-top:1px solid #3b3b3b;background:#303030}
    .editor.expanded .properties{display:block}
    .property-title{display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 16px;border-bottom:1px solid #3d3d3d;color:#ededed;font-size:14px}
    .drag-dots{color:#8c8c8c;letter-spacing:1px}
    .property-grid{display:grid;grid-template-columns:112px minmax(0,1fr);align-items:center;gap:12px 10px;padding:10px 16px 14px}
    .property-label{color:#b8b8b8;font-size:13px}
    .property-control{width:100%;height:32px;border:1px solid #555;border-radius:10px;background:#303030;color:#f1f1f1;padding:0 11px;outline:none;font-size:13px}
    .property-control:focus{border-color:#777}.property-control:disabled{opacity:.45}
    .property-separator{grid-column:1/-1;height:1px;background:#454545;margin:1px 0}
    .unit-control{display:flex;align-items:center;height:32px;border:1px solid #555;border-radius:10px;overflow:hidden}
    .unit-control:focus-within{border-color:#777}.unit-input{width:100%;min-width:0;height:30px;border:0;background:transparent;color:#f1f1f1;padding:0 4px 0 11px;outline:none;text-align:right;font-size:13px}
    .unit-input::-webkit-inner-spin-button{display:none}.unit-suffix{padding:0 10px 0 5px;color:#aaa;font-size:12px}
    .multi-control{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));height:32px;border:1px solid #555;border-radius:10px;overflow:hidden}
    .multi-control.gap-control{grid-template-columns:repeat(2,minmax(0,1fr))}.multi-input{width:100%;min-width:0;border:0;border-right:1px solid #454545;background:transparent;color:#ddd;outline:none;text-align:center;font-size:12px}.multi-input:last-child{border-right:0}.multi-input::-webkit-inner-spin-button{display:none}
    .color-control{display:flex;align-items:center;gap:7px;height:32px;border:1px solid #555;border-radius:10px;padding:0 9px}
    .color-swatch{width:19px;height:19px;flex:0 0 19px;border:0;border-radius:6px;background:transparent;padding:0;overflow:hidden;cursor:pointer}
    .color-swatch::-webkit-color-swatch-wrapper{padding:0}.color-swatch::-webkit-color-swatch{border:0;border-radius:5px}
    .color-value{width:100%;min-width:0;border:0;background:transparent;color:#bcbcbc;outline:none;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace}
    .bottom-actions{display:flex;align-items:center;gap:8px;min-height:50px;padding:8px 10px;border-top:1px solid #3b3b3b}
    .editor.create:not(.expanded) .bottom-actions{display:none}.editor.edit .top-confirm,.editor.expanded .top-confirm{display:none}
    .action-button{height:32px;border:1px solid #555;border-radius:999px;background:transparent;color:#eee;padding:0 12px;cursor:pointer;font-size:13px}
    .delete-button{display:grid;place-items:center;width:32px;padding:0;border-color:transparent}.delete-button:hover{background:#3a3a3a}.delete-button svg{width:16px;height:16px}
    .action-spacer{flex:1}.save-button{border-color:#fff;background:#fff;color:#202020;font-weight:600}
    .editor.create .delete-button{display:none}
  `;

  const highlight = document.createElement('div');
  highlight.className = 'highlight';
  const markerLayer = document.createElement('div');
  const pendingMarker = document.createElement('div');
  pendingMarker.className = 'pending-marker';
  const editor = document.createElement('div');
  editor.className = 'editor create';
  editor.setAttribute('role', 'dialog');

  const editorTop = document.createElement('div');
  editorTop.className = 'editor-top';
  const settingsButton = document.createElement('button');
  settingsButton.className = 'icon-button';
  settingsButton.type = 'button';
  settingsButton.setAttribute('aria-label', labels.settings || 'Element settings');
  settingsButton.title = labels.settings || 'Element settings';
  settingsButton.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/></svg>';
  const textarea = document.createElement('textarea');
  textarea.className = 'comment';
  textarea.rows = 1;
  textarea.maxLength = BrowserAnnotationLimit.MaxCommentLength;
  textarea.placeholder = labels.placeholder || 'Describe the change';
  const topConfirm = document.createElement('button');
  topConfirm.className = 'top-confirm';
  topConfirm.type = 'button';
  topConfirm.textContent = '✓';
  topConfirm.setAttribute('aria-label', labels.save || 'Save');
  editorTop.append(settingsButton, textarea, topConfirm);

  const properties = document.createElement('div');
  properties.className = 'properties';
  const propertyTitle = document.createElement('div');
  propertyTitle.className = 'property-title';
  const tagName = document.createElement('span');
  const dragDots = document.createElement('span');
  dragDots.className = 'drag-dots';
  dragDots.textContent = '⠿';
  propertyTitle.append(tagName, dragDots);
  const propertyGrid = document.createElement('div');
  propertyGrid.className = 'property-grid';

  const textInput = document.createElement('input');
  textInput.className = 'property-control';
  textInput.type = 'text';
  textInput.maxLength = BrowserAnnotationLimit.MaxCommentLength;
  const colorInput = document.createElement('input');
  colorInput.className = 'color-value';
  colorInput.type = 'text';
  const colorSwatch = document.createElement('input');
  colorSwatch.className = 'color-swatch';
  colorSwatch.type = 'color';
  const backgroundInput = document.createElement('input');
  backgroundInput.className = 'color-value';
  backgroundInput.type = 'text';
  const backgroundSwatch = document.createElement('input');
  backgroundSwatch.className = 'color-swatch';
  backgroundSwatch.type = 'color';
  const opacityInput = document.createElement('input');
  opacityInput.className = 'property-control';
  opacityInput.type = 'number';
  opacityInput.min = '0';
  opacityInput.max = '1';
  opacityInput.step = '0.05';
  const fontInput = document.createElement('select');
  fontInput.className = 'property-control';
  const fontWeightInput = document.createElement('select');
  fontWeightInput.className = 'property-control';
  const flexDirectionInput = document.createElement('select');
  flexDirectionInput.className = 'property-control';
  const justifyContentInput = document.createElement('select');
  justifyContentInput.className = 'property-control';
  const alignItemsInput = document.createElement('select');
  alignItemsInput.className = 'property-control';

  const createNumberInput = (min: number, max: number, step = 1) => {
    const input = document.createElement('input');
    input.className = 'unit-input';
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    return input;
  };
  const fontSizeInput = createNumberInput(0, 512, 0.5);
  const borderRadiusInput = createNumberInput(0, 9_999, 0.5);
  const borderWidthInput = createNumberInput(0, 128, 0.5);
  const widthInput = createNumberInput(0, 100_000, 0.5);
  const heightInput = createNumberInput(0, 100_000, 0.5);
  const paddingInputs = [
    createNumberInput(0, 10_000, 0.5),
    createNumberInput(0, 10_000, 0.5),
    createNumberInput(0, 10_000, 0.5),
    createNumberInput(0, 10_000, 0.5),
  ];
  const marginInputs = [
    createNumberInput(-10_000, 10_000, 0.5),
    createNumberInput(-10_000, 10_000, 0.5),
    createNumberInput(-10_000, 10_000, 0.5),
    createNumberInput(-10_000, 10_000, 0.5),
  ];
  const gapInputs = [
    createNumberInput(0, 10_000, 0.5),
    createNumberInput(0, 10_000, 0.5),
  ];
  const borderColorInput = document.createElement('input');
  borderColorInput.className = 'color-value';
  borderColorInput.type = 'text';
  const borderColorSwatch = document.createElement('input');
  borderColorSwatch.className = 'color-swatch';
  borderColorSwatch.type = 'color';

  const appendProperty = (label: string, control: HTMLElement) => {
    const labelElement = document.createElement('label');
    labelElement.className = 'property-label';
    labelElement.textContent = label;
    propertyGrid.append(labelElement, control);
  };
  const appendSeparator = () => {
    const separator = document.createElement('div');
    separator.className = 'property-separator';
    propertyGrid.appendChild(separator);
  };
  const createUnitControl = (input: HTMLInputElement, unit = 'px') => {
    const control = document.createElement('div');
    control.className = 'unit-control';
    const suffix = document.createElement('span');
    suffix.className = 'unit-suffix';
    suffix.textContent = unit;
    control.append(input, suffix);
    return control;
  };
  const createMultiControl = (inputs: HTMLInputElement[], className = '') => {
    const control = document.createElement('div');
    control.className = `multi-control ${className}`.trim();
    inputs.forEach(input => {
      input.className = 'multi-input';
      control.appendChild(input);
    });
    return control;
  };
  const colorControl = document.createElement('div');
  colorControl.className = 'color-control';
  colorControl.append(colorSwatch, colorInput);
  const backgroundControl = document.createElement('div');
  backgroundControl.className = 'color-control';
  backgroundControl.append(backgroundSwatch, backgroundInput);
  const borderColorControl = document.createElement('div');
  borderColorControl.className = 'color-control';
  borderColorControl.append(borderColorSwatch, borderColorInput);
  const insetNames = [
    labels.top || 'Top',
    labels.right || 'Right',
    labels.bottom || 'Bottom',
    labels.left || 'Left',
  ];
  paddingInputs.forEach((input, index) => input.setAttribute(
    'aria-label',
    `${labels.padding || 'Padding'} ${insetNames[index]}`,
  ));
  marginInputs.forEach((input, index) => input.setAttribute(
    'aria-label',
    `${labels.margin || 'Margin'} ${insetNames[index]}`,
  ));
  gapInputs[0].setAttribute('aria-label', `${labels.gap || 'Gap'} ${labels.vertical || 'Vertical'}`);
  gapInputs[1].setAttribute('aria-label', `${labels.gap || 'Gap'} ${labels.horizontal || 'Horizontal'}`);
  appendProperty(labels.text || 'Text', textInput);
  appendProperty(labels.textColor || 'Text color', colorControl);
  appendProperty(labels.background || 'Background', backgroundControl);
  appendProperty(labels.opacity || 'Opacity', opacityInput);
  appendProperty(labels.font || 'Font', fontInput);
  appendProperty(labels.fontSize || 'Font size', createUnitControl(fontSizeInput));
  appendProperty(labels.fontWeight || 'Font weight', fontWeightInput);
  appendSeparator();
  appendProperty(labels.borderRadius || 'Border radius', createUnitControl(borderRadiusInput));
  appendProperty(labels.borderColor || 'Border color', borderColorControl);
  appendProperty(labels.borderWidth || 'Border width', createUnitControl(borderWidthInput));
  appendProperty(labels.width || 'Width', createUnitControl(widthInput));
  appendProperty(labels.height || 'Height', createUnitControl(heightInput));
  appendProperty(labels.padding || 'Padding', createMultiControl(paddingInputs));
  appendProperty(labels.margin || 'Margin', createMultiControl(marginInputs));
  appendSeparator();
  appendProperty(labels.flexDirection || 'Layout direction', flexDirectionInput);
  appendProperty(labels.justifyContent || 'Distribution', justifyContentInput);
  appendProperty(labels.alignItems || 'Alignment', alignItemsInput);
  appendProperty(labels.gap || 'Gap', createMultiControl(gapInputs, 'gap-control'));
  properties.append(propertyTitle, propertyGrid);

  const bottomActions = document.createElement('div');
  bottomActions.className = 'bottom-actions';
  const remove = document.createElement('button');
  remove.className = 'action-button delete-button';
  remove.type = 'button';
  remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>';
  remove.setAttribute('aria-label', labels.remove || 'Delete');
  remove.title = labels.remove || 'Delete';
  const actionSpacer = document.createElement('span');
  actionSpacer.className = 'action-spacer';
  const cancel = document.createElement('button');
  cancel.className = 'action-button';
  cancel.type = 'button';
  cancel.textContent = labels.cancel || 'Cancel';
  const saveButton = document.createElement('button');
  saveButton.className = 'action-button save-button';
  saveButton.type = 'button';
  saveButton.textContent = labels.save || 'Save';
  bottomActions.append(remove, actionSpacer, cancel, saveButton);
  editor.append(editorTop, properties, bottomActions);
  shadow.append(style, highlight, markerLayer, pendingMarker, editor);
  document.documentElement.appendChild(root);

  let hoveredElement: Element | null = null;
  let editingId: string | null = null;
  let pendingAnchor: BrowserAnnotationAnchor | null = null;
  let pendingElement: HTMLElement | null = null;
  let draftElementEdit: BrowserAnnotationElementEdit | null = null;
  let initialElementEdit: BrowserAnnotationElementEdit | null = null;
  let regionStart: { x: number; y: number } | null = null;
  let captureMode = false;
  let markerRenderFrame: number | null = null;
  let editorExpanded = false;
  let ignoreOutsideClickUntil = 0;

  const resolveAnchorRect = (
    anchor: BrowserAnnotationAnchor,
    capture?: CoworkBrowserAnnotation['capture'],
  ): BrowserAnnotationRect => resolveBrowserAnnotationViewportRect(anchor, capture, {
    x: window.scrollX,
    y: window.scrollY,
  });

  const isMarkerVisible = (left: number, top: number) => (
    left + 26 > 0
    && top + 26 > 0
    && left < window.innerWidth
    && top < window.innerHeight
  );

  const positionEditor = (rect: BrowserAnnotationRect) => {
    const width = editor.offsetWidth || 352;
    const height = editor.offsetHeight || 116;
    const preferredLeft = rect.x + Math.min(96, Math.max(18, rect.width * 0.16));
    const preferredTop = rect.y + Math.min(32, Math.max(10, rect.height * 0.28));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, preferredLeft));
    const top = preferredTop + height <= window.innerHeight - 8
      ? preferredTop
      : Math.max(8, rect.y - height - 8);
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
  };

  const showHighlight = (rect: BrowserAnnotationRect) => {
    highlight.style.display = 'block';
    highlight.style.left = `${rect.x}px`;
    highlight.style.top = `${rect.y}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  };

  const positionPendingMarker = (rect: BrowserAnnotationRect) => {
    if (editingId) {
      pendingMarker.style.display = 'none';
      return;
    }
    const left = rect.x + Math.min(16, rect.width / 2) - 13;
    const top = rect.y + Math.min(16, rect.height / 2) - 13;
    pendingMarker.style.display = isMarkerVisible(left, top) ? 'block' : 'none';
    pendingMarker.style.left = `${left}px`;
    pendingMarker.style.top = `${top}px`;
  };

  const refreshEditingGeometry = () => {
    if (!pendingAnchor) return;
    if (pendingElement?.isConnected) pendingAnchor = elementAnchor(pendingElement);
    const annotation = editingId ? annotations.find(item => item.id === editingId) : undefined;
    const rect = resolveAnchorRect(pendingAnchor, annotation?.capture);
    showHighlight(rect);
    positionPendingMarker(rect);
    positionEditor(rect);
  };

  const setEditorExpanded = (expanded: boolean) => {
    editorExpanded = expanded && Boolean(draftElementEdit);
    editor.classList.toggle('expanded', editorExpanded);
    settingsButton.classList.toggle('active', editorExpanded);
    requestAnimationFrame(refreshEditingGeometry);
  };

  const updateSaveDisabled = () => {
    const disabled = !hasBrowserAnnotationContent(textarea.value, draftElementEdit || undefined);
    topConfirm.disabled = disabled;
    saveButton.disabled = disabled;
  };

  const colorToHex = (value?: string): string => {
    const match = value?.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!match) return '#000000';
    return `#${[match[1], match[2], match[3]]
      .map(part => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0'))
      .join('')}`;
  };

  const fillNumberInput = (input: HTMLInputElement, value?: string) => {
    const number = Number.parseFloat(value || '');
    input.value = Number.isFinite(number) ? String(Number(number.toFixed(3))) : '';
  };

  const fillSelect = (
    select: HTMLSelectElement,
    currentValue: string | undefined,
    options: Array<{ value: string; label: string }>,
  ) => {
    const values = [
      ...(currentValue ? [{ value: currentValue, label: currentValue }] : []),
      ...options,
    ].filter((option, index, all) => all.findIndex(item => item.value === option.value) === index);
    select.replaceChildren(...values.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    select.value = currentValue || values[0]?.value || '';
  };

  const fillPropertyControls = (anchor: BrowserAnnotationAnchor) => {
    tagName.textContent = anchor.kind === BrowserAnnotationAnchorKind.Element ? anchor.tagName : anchor.kind;
    settingsButton.disabled = !draftElementEdit;
    if (!draftElementEdit) return;
    const current = draftElementEdit.current;
    textInput.value = current.text || '';
    textInput.disabled = !draftElementEdit.canEditText;
    textInput.title = draftElementEdit.canEditText ? '' : (labels.complexText || 'Nested text cannot be edited directly');
    colorInput.value = current.color || '';
    colorSwatch.value = colorToHex(current.color);
    backgroundInput.value = current.backgroundColor || '';
    backgroundSwatch.value = colorToHex(current.backgroundColor);
    borderColorInput.value = current.borderColor || '';
    borderColorSwatch.value = colorToHex(current.borderColor);
    opacityInput.value = String(current.opacity ?? 1);
    const fonts = [
      current.fontFamily || '',
      'system-ui',
      '-apple-system',
      'Arial',
      'Georgia',
      '"Times New Roman"',
      'monospace',
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    fontInput.replaceChildren(...fonts.map(font => {
      const option = document.createElement('option');
      option.value = font;
      option.textContent = font;
      return option;
    }));
    fontInput.value = current.fontFamily || fonts[0] || '';
    fillNumberInput(fontSizeInput, current.fontSize);
    fillSelect(fontWeightInput, current.fontWeight, [
      ...Array.from({ length: 9 }, (_, index) => {
        const value = String((index + 1) * 100);
        return { value, label: value };
      }),
      { value: 'normal', label: 'normal' },
      { value: 'bold', label: 'bold' },
    ]);
    fillNumberInput(borderRadiusInput, current.borderRadius);
    fillNumberInput(borderWidthInput, current.borderWidth);
    fillNumberInput(widthInput, current.width);
    fillNumberInput(heightInput, current.height);
    [current.paddingTop, current.paddingRight, current.paddingBottom, current.paddingLeft]
      .forEach((value, index) => fillNumberInput(paddingInputs[index], value));
    [current.marginTop, current.marginRight, current.marginBottom, current.marginLeft]
      .forEach((value, index) => fillNumberInput(marginInputs[index], value));
    fillSelect(flexDirectionInput, current.flexDirection, [
      { value: 'row', label: labels.horizontal || 'Horizontal' },
      { value: 'column', label: labels.vertical || 'Vertical' },
      { value: 'row-reverse', label: labels.horizontalReverse || 'Horizontal reverse' },
      { value: 'column-reverse', label: labels.verticalReverse || 'Vertical reverse' },
    ]);
    fillSelect(justifyContentInput, current.justifyContent, [
      { value: 'flex-start', label: labels.start || 'Start' },
      { value: 'center', label: labels.center || 'Center' },
      { value: 'flex-end', label: labels.end || 'End' },
      { value: 'space-between', label: labels.spaceBetween || 'Space between' },
      { value: 'space-around', label: labels.spaceAround || 'Space around' },
      { value: 'space-evenly', label: labels.spaceEvenly || 'Space evenly' },
    ]);
    fillSelect(alignItemsInput, current.alignItems, [
      { value: 'flex-start', label: labels.start || 'Start' },
      { value: 'center', label: labels.center || 'Center' },
      { value: 'flex-end', label: labels.end || 'End' },
      { value: 'stretch', label: labels.stretch || 'Stretch' },
    ]);
    fillNumberInput(gapInputs[0], current.rowGap || current.gap);
    fillNumberInput(gapInputs[1], current.columnGap || current.gap);
  };

  const rollbackPendingEdit = () => {
    if (!pendingElement || !initialElementEdit) return;
    applyElementEdit(pendingElement, initialElementEdit);
  };

  const closeEditor = (rollback = true) => {
    if (rollback) rollbackPendingEdit();
    editingId = null;
    pendingAnchor = null;
    pendingElement = null;
    draftElementEdit = null;
    initialElementEdit = null;
    editorExpanded = false;
    editor.style.display = 'none';
    editor.className = 'editor create';
    pendingMarker.style.display = 'none';
    textarea.value = '';
  };

  const openEditor = (
    anchor: BrowserAnnotationAnchor,
    id?: string,
    targetElement?: HTMLElement | null,
    suppressImmediateOutsideClick = false,
  ) => {
    const annotation = id ? annotations.find(item => item.id === id) : undefined;
    pendingAnchor = anchor;
    editingId = id || null;
    pendingElement = targetElement
      || (anchor.kind === BrowserAnnotationAnchorKind.Element ? resolveElement(anchor.selector) : null);
    if (pendingElement && anchor.kind === BrowserAnnotationAnchorKind.Element) {
      const liveElementEdit = readElementEdit(pendingElement);
      if (annotation?.elementEdit) {
        const savedElementEdit = cloneElementEdit(annotation.elementEdit);
        const mergedInlineStyles = {
          ...liveElementEdit.originalInlineStyle.styles,
          ...savedElementEdit.originalInlineStyle.styles,
        };
        if (!savedElementEdit.originalInlineStyle.styles?.color) {
          mergedInlineStyles.color = {
            value: savedElementEdit.originalInlineStyle.color || '',
            priority: savedElementEdit.originalInlineStyle.colorPriority || '',
          };
        }
        if (!savedElementEdit.originalInlineStyle.styles?.backgroundColor) {
          mergedInlineStyles.backgroundColor = {
            value: savedElementEdit.originalInlineStyle.backgroundColor || '',
            priority: savedElementEdit.originalInlineStyle.backgroundColorPriority || '',
          };
        }
        if (!savedElementEdit.originalInlineStyle.styles?.opacity) {
          mergedInlineStyles.opacity = {
            value: savedElementEdit.originalInlineStyle.opacity || '',
            priority: savedElementEdit.originalInlineStyle.opacityPriority || '',
          };
        }
        if (!savedElementEdit.originalInlineStyle.styles?.fontFamily) {
          mergedInlineStyles.fontFamily = {
            value: savedElementEdit.originalInlineStyle.fontFamily || '',
            priority: savedElementEdit.originalInlineStyle.fontFamilyPriority || '',
          };
        }
        draftElementEdit = {
          canEditText: savedElementEdit.canEditText,
          original: { ...liveElementEdit.original, ...savedElementEdit.original },
          current: { ...liveElementEdit.current, ...savedElementEdit.current },
          originalInlineStyle: {
            ...liveElementEdit.originalInlineStyle,
            ...savedElementEdit.originalInlineStyle,
            styles: mergedInlineStyles,
          },
        };
      } else {
        draftElementEdit = liveElementEdit;
      }
    } else {
      draftElementEdit = null;
    }
    initialElementEdit = draftElementEdit ? cloneElementEdit(draftElementEdit) : null;
    textarea.value = annotation?.comment || '';
    editor.className = `editor ${id ? 'edit' : 'create'}`;
    editor.style.display = 'block';
    setEditorExpanded(false);
    fillPropertyControls(anchor);
    updateSaveDisabled();
    refreshEditingGeometry();
    ignoreOutsideClickUntil = suppressImmediateOutsideClick ? performance.now() + 150 : 0;
    textarea.focus();
  };

  const renderMarkers = () => {
    markerLayer.replaceChildren();
    annotations.slice().sort((a, b) => a.order - b.order).forEach((annotation, index) => {
      const rect = resolveAnchorRect(annotation.anchor, annotation.capture);
      const markerPoint = resolveBrowserAnnotationMarkerViewportPoint(
        annotation.anchor,
        annotation.capture,
        { x: window.scrollX, y: window.scrollY },
      );
      const markerLeft = markerPoint.x - 13;
      const markerTop = markerPoint.y - 13;
      const marker = document.createElement('button');
      marker.className = 'marker';
      marker.textContent = String(index + 1);
      marker.title = annotation.comment;
      marker.style.display = isMarkerVisible(markerLeft, markerTop) ? 'block' : 'none';
      marker.style.left = `${markerLeft}px`;
      marker.style.top = `${markerTop}px`;
      marker.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (pendingAnchor) closeEditor();
        openEditor(
          { ...annotation.anchor, rect },
          annotation.id,
          annotation.anchor.kind === BrowserAnnotationAnchorKind.Element
            ? resolveElement(annotation.anchor.selector)
            : null,
        );
      });
      markerLayer.appendChild(marker);
    });
  };

  const scheduleMarkerRender = () => {
    if (markerRenderFrame !== null) return;
    markerRenderFrame = requestAnimationFrame(() => {
      markerRenderFrame = null;
      renderMarkers();
      if (pendingAnchor) refreshEditingGeometry();
      else {
        hoveredElement = null;
        highlight.style.display = 'none';
      }
    });
  };

  const emitChanged = () => {
    revision += 1;
    send(BrowserAnnotationGuestEventType.Changed, { annotations });
    renderMarkers();
  };

  const applyAnnotationEdits = (nextAnnotations: CoworkBrowserAnnotation[]) => {
    for (const current of annotations) {
      const next = nextAnnotations.find(item => item.id === current.id);
      if (current.elementEdit && (!next || !sameElementChanges(current.elementEdit, next.elementEdit))) {
        const element = resolveElement(current.anchor.selector);
        if (element) restoreElementEdit(element, current.elementEdit);
      }
    }
    annotations = [...nextAnnotations];
    for (const annotation of annotations) {
      if (!annotation.elementEdit) continue;
      const element = resolveElement(annotation.anchor.selector);
      if (element) applyElementEdit(element, annotation.elementEdit);
    }
  };

  const updateDraft = (patch: Partial<BrowserAnnotationElementPresentation>) => {
    if (!draftElementEdit || !pendingElement) return;
    draftElementEdit.current = { ...draftElementEdit.current, ...patch };
    applyElementEdit(pendingElement, draftElementEdit);
    updateSaveDisabled();
    requestAnimationFrame(refreshEditingGeometry);
  };

  const selectedTextAnchor = (): BrowserAnnotationAnchor | null => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !cleanText(selection.toString())) return null;
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).map(rectOf).filter(rect => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map(rect => rect.x));
    const top = Math.min(...rects.map(rect => rect.y));
    const right = Math.max(...rects.map(rect => rect.x + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
    const rect = { x: left, y: top, width: right - left, height: bottom - top };
    const element = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    return {
      ...baseAnchor(rect, element || undefined),
      kind: BrowserAnnotationAnchorKind.Text,
      selectedText: cleanText(selection.toString()),
      selectionRects: rects,
      textLocator: {
        kind: 'dom-range',
        selector: element ? selectorFor(element) : undefined,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        rangeText: cleanText(selection.toString()),
      },
    } as BrowserAnnotationAnchor;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (captureMode || pendingAnchor || regionStart) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || root.contains(element)) return;
    hoveredElement = element;
    const rect = rectOf(element.getBoundingClientRect());
    if (rect.width > 0 && rect.height > 0) showHighlight(rect);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (!event.shiftKey || pendingAnchor || captureMode) return;
    event.preventDefault();
    event.stopPropagation();
    regionStart = { x: event.clientX, y: event.clientY };
  };

  const onMouseUp = (event: MouseEvent) => {
    if (captureMode || pendingAnchor) return;
    if (regionStart) {
      event.preventDefault();
      const rect = {
        x: Math.min(regionStart.x, event.clientX),
        y: Math.min(regionStart.y, event.clientY),
        width: Math.abs(event.clientX - regionStart.x),
        height: Math.abs(event.clientY - regionStart.y),
      };
      regionStart = null;
      if (rect.width >= 8 && rect.height >= 8) {
        openEditor({
          ...baseAnchor(rect),
          kind: BrowserAnnotationAnchorKind.Region,
          documentRect: { ...rect, x: rect.x + window.scrollX, y: rect.y + window.scrollY },
        } as BrowserAnnotationAnchor, undefined, null, true);
      }
      return;
    }
    const anchor = selectedTextAnchor();
    if (anchor) openEditor(anchor, undefined, null, true);
  };

  const onClick = (event: MouseEvent) => {
    if (captureMode || event.shiftKey) return;
    if (pendingAnchor) {
      const clickedOverlay = event.composedPath().includes(root);
      if (!clickedOverlay && performance.now() >= ignoreOutsideClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeEditor();
      }
      return;
    }
    const element = event.target instanceof HTMLElement ? event.target : hoveredElement;
    if (!(element instanceof HTMLElement) || root.contains(element)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const anchor = elementAnchor(element);
    const existing = annotations.find(item => (
      item.anchor.kind === BrowserAnnotationAnchorKind.Element
      && item.anchor.selector === anchor.selector
    ));
    if (existing) {
      openEditor({ ...existing.anchor, rect: anchor.rect }, existing.id, element);
    } else {
      openEditor(anchor, undefined, element);
    }
  };

  const saveAnnotation = () => {
    const comment = textarea.value.trim().slice(0, BrowserAnnotationLimit.MaxCommentLength);
    const elementEdit = draftElementEdit
      && getBrowserAnnotationElementChanges(draftElementEdit).length > 0
      ? cloneElementEdit(draftElementEdit)
      : undefined;
    if (!pendingAnchor || !hasBrowserAnnotationContent(comment, elementEdit)) return;
    const now = Date.now();
    const anchor = pendingElement?.isConnected ? elementAnchor(pendingElement) : pendingAnchor;
    if (editingId) {
      annotations = annotations.map(item => {
        if (item.id !== editingId) return item;
        const visualChange = !sameElementChanges(item.elementEdit, elementEdit);
        return {
          ...item,
          comment,
          anchor,
          capture: visualChange ? captureFor(anchor.rect) : item.capture,
          screenshot: visualChange
            ? {
                status: BrowserAnnotationScreenshotStatus.Capturing,
                requestId: crypto.randomUUID(),
                startedAt: now,
              }
            : item.screenshot,
          elementEdit,
          updatedAt: now,
        };
      });
    } else if (annotations.length < BrowserAnnotationLimit.MaxAnnotations) {
      annotations = [...annotations, {
        id: crypto.randomUUID(),
        order: annotations.length,
        comment,
        anchor,
        capture: captureFor(anchor.rect),
        screenshot: {
          status: BrowserAnnotationScreenshotStatus.Capturing,
          requestId: crypto.randomUUID(),
          startedAt: now,
        },
        elementEdit,
        createdAt: now,
        updatedAt: now,
      }];
    }
    closeEditor(false);
    emitChanged();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (pendingAnchor) closeEditor();
      else send(BrowserAnnotationGuestEventType.CloseRequested);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && pendingAnchor) saveAnnotation();
  };

  settingsButton.addEventListener('click', () => setEditorExpanded(!editorExpanded));
  textarea.addEventListener('input', updateSaveDisabled);
  textInput.addEventListener('input', () => updateDraft({ text: textInput.value }));
  colorInput.addEventListener('change', () => {
    if (CSS.supports('color', colorInput.value)) {
      updateDraft({ color: colorInput.value });
      colorSwatch.value = colorToHex(getComputedStyle(pendingElement as HTMLElement).color);
    }
  });
  colorSwatch.addEventListener('input', () => {
    colorInput.value = colorSwatch.value;
    updateDraft({ color: colorSwatch.value });
  });
  backgroundInput.addEventListener('change', () => {
    if (CSS.supports('background-color', backgroundInput.value)) {
      updateDraft({ backgroundColor: backgroundInput.value });
      backgroundSwatch.value = colorToHex(getComputedStyle(pendingElement as HTMLElement).backgroundColor);
    }
  });
  backgroundSwatch.addEventListener('input', () => {
    backgroundInput.value = backgroundSwatch.value;
    updateDraft({ backgroundColor: backgroundSwatch.value });
  });
  borderColorInput.addEventListener('change', () => {
    if (CSS.supports('border-color', borderColorInput.value)) {
      updateDraft({ borderColor: borderColorInput.value });
      borderColorSwatch.value = colorToHex(getComputedStyle(pendingElement as HTMLElement).borderColor);
    }
  });
  borderColorSwatch.addEventListener('input', () => {
    borderColorInput.value = borderColorSwatch.value;
    updateDraft({ borderColor: borderColorSwatch.value });
  });
  opacityInput.addEventListener('input', () => {
    const opacity = Number.parseFloat(opacityInput.value);
    if (Number.isFinite(opacity)) updateDraft({ opacity: Math.max(0, Math.min(1, opacity)) });
  });
  const bindPixelInput = (
    input: HTMLInputElement,
    property: BrowserAnnotationElementStylePropertyType,
    min: number,
    max: number,
  ) => input.addEventListener('input', () => {
    const value = Number.parseFloat(input.value);
    updateDraft({
      [property]: Number.isFinite(value)
        ? `${Math.max(min, Math.min(max, value))}px`
        : undefined,
    });
  });
  fontInput.addEventListener('change', () => updateDraft({ fontFamily: fontInput.value }));
  fontWeightInput.addEventListener('change', () => updateDraft({ fontWeight: fontWeightInput.value }));
  bindPixelInput(fontSizeInput, BrowserAnnotationElementStyleProperty.FontSize, 0, 512);
  bindPixelInput(borderRadiusInput, BrowserAnnotationElementStyleProperty.BorderRadius, 0, 9_999);
  bindPixelInput(borderWidthInput, BrowserAnnotationElementStyleProperty.BorderWidth, 0, 128);
  bindPixelInput(widthInput, BrowserAnnotationElementStyleProperty.Width, 0, 100_000);
  bindPixelInput(heightInput, BrowserAnnotationElementStyleProperty.Height, 0, 100_000);
  const paddingProperties = [
    BrowserAnnotationElementStyleProperty.PaddingTop,
    BrowserAnnotationElementStyleProperty.PaddingRight,
    BrowserAnnotationElementStyleProperty.PaddingBottom,
    BrowserAnnotationElementStyleProperty.PaddingLeft,
  ];
  paddingInputs.forEach((input, index) => {
    bindPixelInput(input, paddingProperties[index], 0, 10_000);
  });
  const marginProperties = [
    BrowserAnnotationElementStyleProperty.MarginTop,
    BrowserAnnotationElementStyleProperty.MarginRight,
    BrowserAnnotationElementStyleProperty.MarginBottom,
    BrowserAnnotationElementStyleProperty.MarginLeft,
  ];
  marginInputs.forEach((input, index) => {
    bindPixelInput(input, marginProperties[index], -10_000, 10_000);
  });
  flexDirectionInput.addEventListener('change', () => updateDraft({
    flexDirection: flexDirectionInput.value,
  }));
  justifyContentInput.addEventListener('change', () => updateDraft({
    justifyContent: justifyContentInput.value,
  }));
  alignItemsInput.addEventListener('change', () => updateDraft({ alignItems: alignItemsInput.value }));
  bindPixelInput(gapInputs[0], BrowserAnnotationElementStyleProperty.RowGap, 0, 10_000);
  bindPixelInput(gapInputs[1], BrowserAnnotationElementStyleProperty.ColumnGap, 0, 10_000);
  cancel.addEventListener('click', () => closeEditor());
  remove.addEventListener('click', () => {
    if (editingId) {
      const annotation = annotations.find(item => item.id === editingId);
      const element = annotation ? resolveElement(annotation.anchor.selector) : null;
      if (pendingElement && draftElementEdit) {
        restoreElementEdit(pendingElement, draftElementEdit);
      } else if (annotation?.elementEdit && element) {
        restoreElementEdit(element, annotation.elementEdit);
      }
      annotations = annotations
        .filter(item => item.id !== editingId)
        .map((item, index) => ({ ...item, order: index }));
      closeEditor(false);
      emitChanged();
    }
  });
  topConfirm.addEventListener('click', saveAnnotation);
  saveButton.addEventListener('click', saveAnnotation);

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', scheduleMarkerRender, true);
  window.addEventListener('resize', scheduleMarkerRender);
  applyAnnotationEdits(annotations);
  renderMarkers();

  cleanup = () => {
    if (pendingAnchor) rollbackPendingEdit();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', scheduleMarkerRender, true);
    window.removeEventListener('resize', scheduleMarkerRender);
    if (markerRenderFrame !== null) cancelAnimationFrame(markerRenderFrame);
    root.remove();
  };

  const commandListener = (_event: Electron.IpcRendererEvent, command: BrowserAnnotationGuestEnvelope) => {
    if (!activeEnvelope || command.protocolVersion !== BrowserAnnotationProtocolVersion) return;
    if (
      command.browserTabId !== activeEnvelope.browserTabId
      || command.documentId !== activeEnvelope.documentId
      || command.navigationVersion !== activeEnvelope.navigationVersion
      || command.batchId !== activeEnvelope.batchId
    ) return;
    if (command.type === BrowserAnnotationGuestCommandType.Sync) {
      applyAnnotationEdits(command.annotations ? [...command.annotations] : []);
      revision = Math.max(revision, command.revision);
      renderMarkers();
    } else if (command.type === BrowserAnnotationGuestCommandType.Focus) {
      const annotation = annotations.find(item => item.id === command.annotationId);
      if (annotation) {
        const rect = resolveAnchorRect(annotation.anchor, annotation.capture);
        openEditor(
          { ...annotation.anchor, rect },
          annotation.id,
          annotation.anchor.kind === BrowserAnnotationAnchorKind.Element
            ? resolveElement(annotation.anchor.selector)
            : null,
        );
      }
    } else if (command.type === BrowserAnnotationGuestCommandType.PrepareCapture) {
      const annotation = annotations.find(item => item.id === command.annotationId);
      const resolvedRect = annotation
        ? resolveAnchorRect(annotation.anchor, annotation.capture)
        : null;
      captureMode = true;
      editor.style.display = 'none';
      pendingMarker.style.display = 'none';
      markerLayer.style.display = 'none';
      if (resolvedRect) showHighlight(resolvedRect);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!annotation || !resolvedRect) return;
        send(BrowserAnnotationGuestEventType.CaptureReady, {
          requestId: command.requestId,
          annotationId: annotation.id,
          capture: captureFor(resolvedRect),
        });
      }));
    } else if (command.type === BrowserAnnotationGuestCommandType.ResumeAfterCapture) {
      captureMode = false;
      highlight.style.display = 'none';
      markerLayer.style.display = '';
      if (pendingAnchor) {
        editor.style.display = 'block';
        refreshEditingGeometry();
      }
    } else if (command.type === BrowserAnnotationGuestCommandType.Clear) {
      closeEditor();
      for (const annotation of annotations) {
        const element = annotation.elementEdit ? resolveElement(annotation.anchor.selector) : null;
        if (annotation.elementEdit && element) restoreElementEdit(element, annotation.elementEdit);
      }
      annotations = [];
      emitChanged();
    } else if (command.type === BrowserAnnotationGuestCommandType.Stop) {
      ipcRenderer.removeListener(BrowserAnnotationGuestChannel.Command, commandListener);
      activeCommandListener = null;
      cleanup?.();
      cleanup = null;
      activeEnvelope = null;
    }
  };
  activeCommandListener = commandListener;
  ipcRenderer.on(BrowserAnnotationGuestChannel.Command, commandListener);
  send(BrowserAnnotationGuestEventType.Ready);
}

ipcRenderer.on(
  BrowserAnnotationGuestChannel.Command,
  (_event, envelope: BrowserAnnotationGuestEnvelope) => {
    if (
      envelope?.protocolVersion === BrowserAnnotationProtocolVersion
      && envelope.type === BrowserAnnotationGuestCommandType.Start
    ) start(envelope);
  },
);
