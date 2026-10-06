import React from 'react';

import {
  LibraryCloudAvailabilityFilter,
  type LibraryCloudAvailabilityFilter as LibraryCloudAvailabilityFilterValue,
} from '../../../shared/library/constants';
import { i18nService } from '../../services/i18n';
import LibraryFilterDropdown, {
  type LibraryFilterDropdownOption,
} from './LibraryFilterDropdown';

interface LibraryAvailabilityDropdownProps {
  value: LibraryCloudAvailabilityFilterValue;
  options: readonly LibraryCloudAvailabilityFilterValue[];
  onChange: (value: LibraryCloudAvailabilityFilterValue) => void;
  grouped?: boolean;
}

const STATUS_TEXT_CLASSNAME: Record<LibraryCloudAvailabilityFilterValue, string> = {
  [LibraryCloudAvailabilityFilter.All]: '',
  [LibraryCloudAvailabilityFilter.Available]: 'text-emerald-600 dark:text-emerald-400',
  [LibraryCloudAvailabilityFilter.Unavailable]: 'text-secondary',
};

const LibraryAvailabilityDropdown: React.FC<LibraryAvailabilityDropdownProps> = ({
  value,
  options,
  onChange,
  grouped = false,
}) => {
  const dropdownOptions: LibraryFilterDropdownOption<LibraryCloudAvailabilityFilterValue>[] = (
    options.map(option => ({
      value: option,
      label: i18nService.t(`libraryCloudAvailability_${option}`),
      labelClassName: STATUS_TEXT_CLASSNAME[option],
    }))
  );

  return (
    <LibraryFilterDropdown
      value={value}
      options={dropdownOptions}
      ariaLabel={i18nService.t('libraryCloudAvailabilityFilter')}
      onChange={onChange}
      triggerLabel={grouped ? i18nService.t('libraryFilterStatusLabel') : undefined}
      showSelectedLeading={!grouped}
      active={grouped && value !== LibraryCloudAvailabilityFilter.All}
      triggerClassName={grouped ? 'min-w-[104px]' : 'min-w-[116px]'}
      menuClassName="w-40"
    />
  );
};

export default LibraryAvailabilityDropdown;
