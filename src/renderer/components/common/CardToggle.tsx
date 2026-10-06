import React from 'react';

interface CardToggleProps {
  isOn: boolean;
  label: string;
  onToggle: () => void;
  /** Keeps the state visible but inert, e.g. enterprise-managed read-only surfaces. */
  disabled?: boolean;
}

/**
 * Enable switch — the one action that stays on a management card's resting
 * surface. Shared by the MCP and skills pages so the two read as one product.
 *
 * The knob is laid out as a flex item rather than absolutely positioned: inside
 * a button, an absolute box with no `left` resolves against the centered static
 * position, which pushes the knob off the track.
 */
const CardToggle: React.FC<CardToggleProps> = ({ isOn, label, onToggle, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={isOn}
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={(event) => { event.stopPropagation(); onToggle(); }}
    className={`flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
    } ${isOn ? 'bg-primary' : 'bg-gray-400 dark:bg-gray-600'}`}
  >
    <span
      className={`h-3.5 w-3.5 rounded-full bg-white shadow-md transition-transform ${
        isOn ? 'translate-x-[18px]' : 'translate-x-[3px]'
      }`}
    />
  </button>
);

export default CardToggle;
