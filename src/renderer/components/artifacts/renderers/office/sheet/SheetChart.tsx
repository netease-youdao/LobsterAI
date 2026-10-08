import { CommandType, ICommandService } from '@univerjs/core';
import { useDependency } from '@univerjs/ui';
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { chartHost, readChartData } from '@/services/office/sheet/sheetChartHost';
import { chartOption } from '@/services/office/sheet/sheetChartOption';
import type { SheetChartData } from '@/services/office/sheet/sheetChartSpec';

echarts.use([BarChart, LineChart, PieChart, RadarChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer]);

const REDRAW_DELAY_MS = 120;
/** While the double click that opened the title field ends, Univer may take the focus back once. */
const TITLE_FOCUS_GRACE_MS = 400;

const t = (key: string) => i18nService.t(key);

/**
 * The chart title edited in place, as in Excel: Enter or leaving the field applies it (an empty
 * title deletes it), Escape keeps the old one. Keys and pointers stay with the field, not the grid.
 */
function TitleEditor({ initial, onDone }: { initial: string; onDone: (text: string | undefined) => void }): React.ReactElement {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const opened = useRef(Date.now());
  const finish = (value: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const take = () => {
    field.current?.focus();
    field.current?.select();
  };
  useEffect(() => {
    // Univer takes the focus back when the pointer that opened the field is released.
    const released = () => setTimeout(take, 0);
    window.addEventListener('pointerup', released, { once: true });
    const timer = setTimeout(take, 0);
    return () => { window.removeEventListener('pointerup', released); clearTimeout(timer); };
  }, []);
  return (
    <input ref={field} className="lobster-sheet-chart-title-editor" value={text} aria-label={t('sheetChartTitle')} placeholder={t('sheetChartPlaceholderTitle')}
      onChange={event => setText(event.target.value)}
      onBlur={() => { if (Date.now() - opened.current < TITLE_FOCUS_GRACE_MS) take(); else finish(text); }}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finish(text); }
        if (event.key === 'Escape') { event.preventDefault(); finish(undefined); }
      }} />
  );
}

/**
 * An Excel chart drawn over the grid as a Univer floating element. It redraws whenever the
 * workbook changes, so its series follow the cells they plot. Double-clicking the title edits it.
 */
export function SheetChart({ data, unitId, floatDomId }: { data?: SheetChartData; unitId: string; floatDomId?: string }): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const commands = useDependency(ICommandService);
  const spec = data?.spec;
  const drawable = Boolean(spec && !spec.unsupported && spec.plots.length);
  const [editing, setEditing] = useState<string>();

  useEffect(() => {
    const element = container.current;
    const host = chartHost(unitId);
    if (!element || !spec || !host || !drawable) return undefined;
    const chart = echarts.init(element, undefined, { renderer: 'canvas' });
    const draw = () => {
      try {
        // Univer keeps the data a floating element was first drawn with; settings change the model's.
        const latest = (floatDomId ? host.data?.(floatDomId) : undefined) ?? data;
        if (!latest?.spec) return;
        const option = chartOption(latest.spec, {
          read: source => readChartData(host, source, latest.origin?.edits),
          seriesName: index => t('sheetChartSeries').replace('{n}', String(index + 1)),
          placeholderTitle: t('sheetChartPlaceholderTitle'),
        });
        if (option) chart.setOption(option, true);
      } catch (error) {
        console.warn('[SheetChart] Could not draw a chart:', error);
      }
    };
    draw();
    // A double click on the title edits it in place, where the workbook can be edited. Univer takes
    // over the pointer after it goes down on a floating element, so the chart never sees click or
    // dblclick events: the second press is recognized by its click count instead.
    chart.on('mousedown', params => {
      const press = (params.event as { event?: MouseEvent } | undefined)?.event;
      if (params.componentType !== 'title' || !press || press.detail < 2 || !floatDomId || !host.setTitle) return;
      setEditing(host.title?.(floatDomId) ?? '');
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(draw, REDRAW_DELAY_MS);
    };
    const subscription = commands.onCommandExecuted(command => {
      if (command.type === CommandType.MUTATION && (command.id.startsWith('sheet.mutation.') || command.id.startsWith('lobster.mutation.'))) schedule();
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      subscription.dispose();
      observer.disconnect();
      if (timer) clearTimeout(timer);
      chart.dispose();
    };
  }, [commands, data, drawable, floatDomId, spec, unitId]);

  if (!drawable) {
    return (
      <div className="lobster-sheet-chart-placeholder" role="img" aria-label={t('sheetChartUnsupported')}>
        {t('sheetChartUnsupported')}
      </div>
    );
  }
  return (
    <div className="lobster-sheet-chart-frame">
      <div ref={container} className="lobster-sheet-chart" role="img" aria-label={spec?.title?.text || t('sheetChart')} />
      {editing !== undefined && (
        <TitleEditor initial={editing} onDone={text => {
          setEditing(undefined);
          const host = chartHost(unitId);
          if (text !== undefined && text !== editing && floatDomId) host?.setTitle?.(floatDomId, text);
        }} />
      )}
    </div>
  );
}
