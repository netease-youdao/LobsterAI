/**
 * Schema-driven form component
 * Renders form fields dynamically from JSON Schema properties, using uiHints for labels/metadata.
 * Fields are discovered from the schema — hints are optional supplementary info.
 */

import { ChevronRightIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import React from 'react';

/** A single uiHint entry from the gateway */
export interface UiHint {
  order?: number;
  label: string;
  help?: string;
  sensitive?: boolean;
  advanced?: boolean;
  placeholder?: string;
}

/** Props for SchemaForm */
export interface SchemaFormProps {
  /** JSON Schema (must have `properties` or be the properties object directly) */
  schema: Record<string, unknown>;
  /** uiHints entries. Keys are relative dot paths like 'appKey', 'p2p.policy', etc. */
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
  /** Optional field filter by relative dot-path */
  includePath?: (path: string, hint: UiHint) => boolean;
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

/** Humanize a camelCase/snake_case key into a label */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const SENSITIVE_KEY_RE = /key|secret|token|password/i;

/** Get or auto-generate a hint for a given path */
function getHint(hints: Record<string, UiHint>, path: string): UiHint {
  if (hints[path]) return hints[path];
  const key = path.split('.').pop() || path;
  return {
    label: humanizeKey(key),
    ...(SENSITIVE_KEY_RE.test(key) ? { sensitive: true } : {}),
  };
}

/**
 * Collect all renderable field paths from schema properties (recursive).
 * Returns { topLevelFields, groups } where groups have children.
 */
function collectFieldPaths(
  schema: Record<string, unknown>,
  hints: Record<string, UiHint>,
  includePath?: (path: string, hint: UiHint) => boolean,
  prefix = '',
): { topLevelFields: string[]; groups: { key: string; children: string[] }[] } {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const topLevelFields: string[] = [];
  const groups: { key: string; children: string[] }[] = [];

  // Sort by hint order, then alphabetically
  const sortedKeys = Object.keys(properties).sort((a, b) => {
    const pa = prefix ? `${prefix}.${a}` : a;
    const pb = prefix ? `${prefix}.${b}` : b;
    const orderA = hints[pa]?.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = hints[pb]?.order ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    if (key === 'enabled') continue; // Skip plugin enabled field

    const dotPath = prefix ? `${prefix}.${key}` : key;
    const prop = properties[key];
    if (!prop || typeof prop !== 'object') continue;

    const hint = getHint(hints, dotPath);
    if (includePath && !includePath(dotPath, hint)) continue;

    if (prop.type === 'object' && prop.properties) {
      // Nested object → collapsible group with children
      const childProps = prop.properties as Record<string, Record<string, unknown>>;
      const childKeys = Object.keys(childProps)
        .map(ck => `${dotPath}.${ck}`)
        .filter(cp => {
          const ch = getHint(hints, cp);
          return !includePath || includePath(cp, ch);
        })
        .sort((a, b) => {
          const oa = hints[a]?.order ?? Number.MAX_SAFE_INTEGER;
          const ob = hints[b]?.order ?? Number.MAX_SAFE_INTEGER;
          return oa - ob;
        });

      if (childKeys.length > 0) {
        groups.push({ key: dotPath, children: childKeys });
      }
    } else {
      topLevelFields.push(dotPath);
    }
  }

  return { topLevelFields, groups };
}

export const SchemaForm: React.FC<SchemaFormProps> = ({
  schema,
  hints,
  value,
  onChange,
  onBlur,
  showSecrets = {},
  onToggleSecret,
  includePath,
}) => {
  const { topLevelFields, groups } = collectFieldPaths(schema, hints, includePath);

  // Render a single field
  const renderField = (path: string): React.ReactNode => {
    const schemaProp = getSchemaProperty(schema, path);
    if (!schemaProp) return null;

    const hint = getHint(hints, path);
    const fieldValue = deepGet(value, path);
    const handleChange = (newValue: unknown) => {
      onChange(path, newValue);
    };

    const type = schemaProp.type as string;
    const enumValues = schemaProp.enum as string[] | undefined;
    const placeholder = hint.placeholder
      ?? (schemaProp.default !== undefined ? String(schemaProp.default) : undefined);
    const description = hint.help ?? (schemaProp.description as string | undefined);

    // Conditional visibility for allowFrom fields
    if (path.endsWith('.allowFrom')) {
      const policyPath = path.replace('.allowFrom', '.policy');
      const policyValue = deepGet(value, policyPath);
      if (policyValue !== 'allowlist') return null;
    }

    // Boolean toggle
    if (type === 'boolean') {
      const boolValue = Boolean(fieldValue);
      return (
        <div key={path} className="flex items-center justify-between py-1">
          <div>
            <label className="text-xs font-medium text-secondary">
              {hint.label}
            </label>
            {description && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
          <div
            className={`w-10 h-5 rounded-full flex items-center transition-colors cursor-pointer ${
              boolValue ? 'bg-green-500' : 'bg-border'
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
          <label className="block text-xs font-medium text-secondary">
            {hint.label}
          </label>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
          <select
            value={String(fieldValue || '')}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={onBlur}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
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
          <label className="block text-xs font-medium text-secondary">
            {hint.label}
          </label>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
          <div className="relative">
            <input
              type={shown ? 'text' : 'password'}
              value={strValue}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={onBlur}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-16 text-sm transition-colors"
              placeholder={placeholder ?? '••••••••••••'}
            />
            <div className="absolute right-2 inset-y-0 flex items-center gap-1">
              {strValue && (
                <button
                  type="button"
                  onClick={() => handleChange('')}
                  className="p-0.5 rounded text-secondary hover:text-foreground transition-colors"
                  title="Clear"
                >
                  <XCircleIconSolid className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggleSecret?.(path)}
                className="p-0.5 rounded text-secondary hover:text-foreground transition-colors"
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
          <label className="block text-xs font-medium text-secondary">
            {hint.label}
          </label>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
          <div className="relative">
            <input
              type="text"
              value={strValue}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={onBlur}
              className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 pr-8 text-sm transition-colors"
              placeholder={placeholder}
            />
            {strValue && (
              <div className="absolute right-2 inset-y-0 flex items-center">
                <button
                  type="button"
                  onClick={() => handleChange('')}
                  className="p-0.5 rounded text-secondary hover:text-foreground transition-colors"
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
          <label className="block text-xs font-medium text-secondary">
            {hint.label}
          </label>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
          <textarea
            value={arrValue}
            onChange={(e) => {
              const lines = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
              handleChange(lines);
            }}
            onBlur={onBlur}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors min-h-[60px] resize-y"
            placeholder={placeholder}
          />
        </div>
      );
    }

    // Number / integer → number input
    if (type === 'number' || type === 'integer') {
      const numValue = typeof fieldValue === 'number' ? fieldValue : '';
      return (
        <div key={path} className="space-y-1.5">
          <label className="block text-xs font-medium text-secondary">
            {hint.label}
          </label>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
          <input
            type="number"
            value={numValue}
            onChange={(e) => handleChange(e.target.value ? Number(e.target.value) : undefined)}
            onBlur={onBlur}
            className="block w-full rounded-lg bg-surface border-border-subtle border focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors"
            placeholder={placeholder}
          />
        </div>
      );
    }

    return null;
  };

  // Render a group (collapsible section)
  const renderGroup = (group: { key: string; children: string[] }): React.ReactNode => {
    const hint = getHint(hints, group.key);

    return (
      <details key={group.key} className="group">
        <summary className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-secondary select-none py-1">
          <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          {hint.label}
        </summary>
        <div className="mt-2 space-y-3 pl-2 border-l-2 border-border-subtle">
          {group.children.map((field) => renderField(field))}
        </div>
      </details>
    );
  };

  return (
    <div className="space-y-3">
      {/* Top-level fields */}
      {topLevelFields.map((field) => renderField(field))}

      {/* Groups */}
      {groups.map((group) => renderGroup(group))}
    </div>
  );
};
