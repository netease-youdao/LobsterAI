/**
 * Schema-driven form component
 * Renders form fields dynamically from JSON Schema + uiHints
 */

import React from 'react';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { XCircleIcon as XCircleIconSolid, ChevronRightIcon } from '@heroicons/react/20/solid';

/** A single uiHint entry from the gateway */
export interface UiHint {
  order: number;
  label: string;
  sensitive?: boolean;
  advanced?: boolean;
}

/** Props for SchemaForm */
export interface SchemaFormProps {
  /** JSON Schema for this channel (the `properties` object from `schema.properties.channels.properties.<channel>`) */
  schema: Record<string, unknown>;
  /** uiHints entries, already stripped of the `channels.<id>.` prefix. Keys are relative dot paths like 'appKey', 'p2p.policy', etc. */
  hints: Record<string, UiHint>;
  /** Current config value (nested object matching the schema) */
  value: Record<string, unknown>;
  /** Called when any field changes. Path is dot-notation ('p2p.policy'), value is the new value. */
  onChange: (path: string, value: unknown) => void;
  /** Called on field blur (for save-on-blur) */
  onBlur?: () => void;
  /** Map of dot-paths to show/hide state for sensitive fields */
  showSecrets?: Record<string, boolean>;
  /** Toggle secret field visibility */
  onToggleSecret?: (path: string) => void;
}

/** Deep-get a value from nested object by dot path */
function deepGet(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj as unknown);
}



/** Get JSON Schema property descriptor at a dot path */
function getSchemaProperty(schema: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const keys = path.split('.');
  let current = schema;
  for (const key of keys) {
    const props = (current.properties || current) as Record<string, unknown>;
    const next = props[key] as Record<string, unknown> | undefined;
    if (!next) return null;
    current = next;
  }
  return current;
}

export const SchemaForm: React.FC<SchemaFormProps> = ({
  schema,
  hints,
  value,
  onChange,
  onBlur,
  showSecrets = {},
  onToggleSecret,
}) => {
  // Identify groups and fields
  const groups: string[] = [];
  const topLevelFields: string[] = [];

  // Sort all hint keys by order
  const sortedKeys = Object.keys(hints).sort((a, b) => hints[a].order - hints[b].order);

  for (const key of sortedKeys) {
    // Skip 'enabled' field
    if (key === 'enabled') continue;

    // Check if it's a group (no dot + type: "object")
    if (!key.includes('.')) {
      const schemaProp = getSchemaProperty(schema, key);
      if (schemaProp && schemaProp.type === 'object') {
        groups.push(key);
      } else {
        topLevelFields.push(key);
      }
    }
  }

  // Render a single field
  const renderField = (path: string, hint: UiHint): React.ReactNode => {
    const schemaProp = getSchemaProperty(schema, path);
    if (!schemaProp) return null;

    const fieldValue = deepGet(value, path);
    const handleChange = (newValue: unknown) => {
      onChange(path, newValue);
    };

    const type = schemaProp.type as string;
    const enumValues = schemaProp.enum as string[] | undefined;
    const isBoolean = type === 'boolean';

    // Conditional visibility for allowFrom fields
    if (path.endsWith('.allowFrom')) {
      const policyPath = path.replace('.allowFrom', '.policy');
      const policyValue = deepGet(value, policyPath);
      if (policyValue !== 'allowlist') return null;
    }

    // Boolean toggle
    if (isBoolean) {
      const boolValue = Boolean(fieldValue);
      return (
        <div key={path} className="flex items-center justify-between py-1">
          <label className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <div
            className={`w-10 h-5 rounded-full flex items-center transition-colors cursor-pointer ${
              boolValue ? 'bg-green-500' : 'dark:bg-claude-darkBorder bg-claude-border'
            }`}
            onClick={() => handleChange(!boolValue)}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white shadow-md transform transition-transform ${
                boolValue ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </div>
        </div>
      );
    }

    // String with enum → select
    if (type === 'string' && enumValues) {
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <select
            value={String(fieldValue || '')}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={onBlur}
            className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
          >
            {enumValues.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // String with sensitive → password with show/hide
    if (type === 'string' && hint.sensitive) {
      const shown = showSecrets[path] || false;
      const strValue = String(fieldValue || '');
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <div className="relative">
            <input
              type={shown ? 'text' : 'password'}
              value={strValue}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={onBlur}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-sm transition-colors"
              placeholder="••••••••••••"
            />
            <div className="absolute right-2 inset-y-0 flex items-center gap-1">
              {strValue && (
                <button
                  type="button"
                  onClick={() => handleChange('')}
                  className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                  title="Clear"
                >
                  <XCircleIconSolid className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleSecret?.(path)}
                className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
              >
                {shown ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // String → text input
    if (type === 'string') {
      const strValue = String(fieldValue || '');
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <div className="relative">
            <input
              type="text"
              value={strValue}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={onBlur}
              className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-sm transition-colors"
            />
            {strValue && (
              <div className="absolute right-2 inset-y-0 flex items-center">
                <button
                  type="button"
                  onClick={() => handleChange('')}
                  className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                  title="Clear"
                >
                  <XCircleIconSolid className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Array → textarea (one line per entry)
    if (type === 'array') {
      const arrValue = Array.isArray(fieldValue) ? fieldValue.map(String).join('\n') : '';
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <textarea
            value={arrValue}
            onChange={(e) => {
              const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
              handleChange(lines);
            }}
            onBlur={onBlur}
            className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors min-h-[60px] resize-y"
          />
        </div>
      );
    }

    // Number / integer → number input
    if (type === 'number' || type === 'integer') {
      const numValue = typeof fieldValue === 'number' ? fieldValue : '';
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {hint.label}
          </label>
          <input
            type="number"
            value={numValue}
            onChange={(e) => handleChange(e.target.value ? Number(e.target.value) : undefined)}
            onBlur={onBlur}
            className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
          />
        </div>
      );
    }

    return null;
  };

  // Render a group (collapsible section)
  const renderGroup = (groupKey: string): React.ReactNode => {
    const groupHint = hints[groupKey];
    if (!groupHint) return null;

    // Find all child fields
    const childFields = sortedKeys.filter((key) => key.startsWith(`${groupKey}.`) && key.split('.').length === 2);

    return (
      <details key={groupKey} className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary select-none py-1">
          <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          {groupHint.label}
        </summary>
        <div className="space-y-3 mt-2 ml-1 pl-3 border-l-2 border-claude-border/30 dark:border-claude-darkBorder/30">
          {childFields.map((field) => renderField(field, hints[field]))}
        </div>
      </details>
    );
  };

  return (
    <div className="space-y-3">
      {/* Top-level fields */}
      {topLevelFields.map((field) => renderField(field, hints[field]))}

      {/* Groups */}
      {groups.map((group) => renderGroup(group))}
    </div>
  );
};
