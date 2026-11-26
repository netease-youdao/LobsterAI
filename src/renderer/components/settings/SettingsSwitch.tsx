import React from 'react';

const SettingsSwitch: React.FC<{
  checked: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}> = ({ checked, label, disabled, onClick }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => {
      void onClick();
    }}
    disabled={disabled}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
      disabled ? 'opacity-50 cursor-not-allowed' : ''
    } ${
      checked
        ? 'bg-primary'
        : 'bg-gray-300 dark:bg-gray-600'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

export default SettingsSwitch;
