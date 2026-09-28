import { CommandType, ICommandService } from '@univerjs/core';
import { useDependency } from '@univerjs/ui';
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import React, { useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';
import { chartHost, readChartData } from '@/services/sheet/sheetChartHost';
import { chartOption } from '@/services/sheet/sheetChartOption';
import type { SheetChartData } from '@/services/sheet/sheetChartSpec';

echarts.use([BarChart, LineChart, PieChart, RadarChart, ScatterChart, GridComponent, LegendComponent, TitleComponent, TooltipComponent, CanvasRenderer]);

const REDRAW_DELAY_MS = 120;

const t = (key: string) => i18nService.t(key);

/**
 * An Excel chart drawn over the grid as a Univer floating element. It redraws whenever the
 * workbook changes, so its series follow the cells they plot.
 */
export function SheetChart({ data, unitId, floatDomId }: { data?: SheetChartData; unitId: string; floatDomId?: string }): React.ReactElement {
  const container = useRef<HTMLDivElement>(null);
  const commands = useDependency(ICommandService);
  const spec = data?.spec;
  const drawable = Boolean(spec && !spec.unsupported && spec.plots.length);

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
  return <div ref={container} className="lobster-sheet-chart" role="img" aria-label={spec?.title?.text || t('sheetChart')} />;
}
