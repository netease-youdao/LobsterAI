import { CatalogLayout, CatalogSort } from '../../services/capabilityCatalog';
import { i18nService } from '../../services/i18n';

interface Props {
  sort: CatalogSort;
  onSort: (value: CatalogSort) => void;
  layout: CatalogLayout;
  onLayout: (value: CatalogLayout) => void;
}

export default function CatalogControls({ sort, onSort, layout, onLayout }: Props) {
  return <div className="my-3 flex flex-wrap items-center justify-end gap-3 text-xs text-secondary">
    <label className="flex items-center gap-2">{i18nService.t('capabilitySort')}
      <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={sort} onChange={event => onSort(event.target.value as CatalogSort)}>
        <option value={CatalogSort.Recommended}>{i18nService.t('capabilitySortDefault')}</option>
        <option value={CatalogSort.Name}>{i18nService.t('capabilitySortName')}</option>
        <option value={CatalogSort.Downloads}>{i18nService.t('capabilitySortDownloads')}</option>
      </select>
    </label>
    <label className="flex items-center gap-2">{i18nService.t('capabilityLayout')}
      <select className="rounded-lg border border-border bg-surface px-2 py-1.5" value={layout} onChange={event => onLayout(event.target.value as CatalogLayout)}>
        <option value={CatalogLayout.Grid}>{i18nService.t('capabilityGrid')}</option>
        <option value={CatalogLayout.List}>{i18nService.t('capabilityList')}</option>
      </select>
    </label>
  </div>;
}
