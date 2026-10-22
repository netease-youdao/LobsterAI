import './managementSearchHeader.css';

import React from 'react';

import { MANAGEMENT_BODY_TEXT } from './managementTypography';

interface ManagementSearchHeaderProps {
  description: string;
  children: React.ReactNode;
}

const ManagementSearchHeader: React.FC<ManagementSearchHeaderProps> = ({ description, children }) => (
  <div className="management-search-header">
    <div className="management-search-header__row flex items-center justify-between gap-x-6 gap-y-3">
      <p className={`min-w-0 flex-1 ${MANAGEMENT_BODY_TEXT} text-secondary`}>
        {description}
      </p>
      <div className="management-search-header__controls flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  </div>
);

export default ManagementSearchHeader;
