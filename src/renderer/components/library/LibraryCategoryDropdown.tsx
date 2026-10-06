import { FunnelIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { LibraryCategory } from '../../../shared/library/constants';
import { i18nService } from '../../services/i18n';
import LibraryFilterDropdown from './LibraryFilterDropdown';

interface LibraryCategoryDropdownProps {
  value: LibraryCategory;
  options: readonly LibraryCategory[];
  onChange: (value: LibraryCategory) => void;
  grouped?: boolean;
}

const LibraryCategoryDropdown: React.FC<LibraryCategoryDropdownProps> = ({
  value,
  options,
  onChange,
  grouped = false,
}) => {
  return (
    <LibraryFilterDropdown
      value={value}
      options={options.map(option => ({
        value: option,
        label: i18nService.t(`libraryCategory_${option}`),
      }))}
      ariaLabel={i18nService.t('libraryCategoryFilter')}
      onChange={onChange}
      triggerLabel={grouped ? i18nService.t('libraryFilterTypeLabel') : undefined}
      triggerLeading={grouped
        ? undefined
        : <FunnelIcon className="h-4 w-4 shrink-0 text-secondary" />}
      active={grouped && value !== LibraryCategory.All}
      triggerClassName={grouped ? 'min-w-[104px]' : undefined}
    />
  );
};

export default LibraryCategoryDropdown;
