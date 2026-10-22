/**
 * Marketplace connector schema: how a marketplace entry describes a remote
 * (SSE / Streamable HTTP) MCP server and the credentials it needs.
 *
 * Marketplace JSON is remote data, so every entry is validated here before the
 * UI offers it. Credentials are entered in a form built from `tokenSchema` and
 * substituted into the `url` template and the `tokenAuth.headers` bindings when
 * the server is saved; OpenClaw only ever sees the final literal values.
 */
import { McpAuthMode } from './auth';
import { normalizeMcpServerUrlInput } from './url';

export const McpTokenFieldType = {
  Text: 'text',
  Password: 'password',
  Url: 'url',
} as const;
export type McpTokenFieldType = typeof McpTokenFieldType[keyof typeof McpTokenFieldType];

const TOKEN_FIELD_TYPES = new Set<string>(Object.values(McpTokenFieldType));

/** One credential input. Unsuffixed texts are Chinese; `_en` variants are English. */
export interface McpTokenField {
  key: string;
  label: string;
  label_en?: string;
  type: McpTokenFieldType;
  required: boolean;
  placeholder?: string;
  placeholder_en?: string;
  description?: string;
  description_en?: string;
  defaultValue?: string;
}

export interface McpTokenSchema {
  title?: string;
  title_en?: string;
  description?: string;
  description_en?: string;
  /** Where to get the credentials; opened in the system browser. */
  docUrl?: string;
  docLabel?: string;
  docLabel_en?: string;
  fields: McpTokenField[];
}

/** Sends `prefix + value of field` as the header. */
export interface McpTokenHeaderBinding {
  field: string;
  prefix?: string;
}

export interface McpTokenAuth {
  headers: Record<string, McpTokenHeaderBinding>;
}

/** Validated install settings carried by a marketplace entry, beyond stdio command/env. */
export interface McpMarketplaceConnector {
  /** Remote endpoint; may contain `${FIELD_KEY}` placeholders for tokenSchema fields. */
  url?: string;
  /** OAuth entries install without a credential form; the user signs in afterwards. */
  auth?: typeof McpAuthMode.OAuth;
  tokenSchema?: McpTokenSchema;
  tokenAuth?: McpTokenAuth;
  /** Pre-fills the server's toolFilter.include. */
  allowedTools?: string[];
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  examples_zh?: string[];
  examples_en?: string[];
}

export type McpMarketplaceConnectorParseResult =
  | { ok: true; connector: McpMarketplaceConnector | undefined }
  | { ok: false; error: string };

export const McpTokenValueError = {
  Required: 'required',
  InvalidUrl: 'invalid_url',
  InvalidCharacters: 'invalid_characters',
} as const;
export type McpTokenValueError = typeof McpTokenValueError[keyof typeof McpTokenValueError];

export const McpConnectorBuildError = {
  InvalidFields: 'invalid_fields',
  InvalidUrl: 'invalid_url',
} as const;
export type McpConnectorBuildError = typeof McpConnectorBuildError[keyof typeof McpConnectorBuildError];

export type McpConnectorCredentialsResult =
  | {
    ok: true;
    url: string;
    headers: Record<string, string>;
    /** Trimmed field values, stored so the form can be shown again on edit. */
    tokenValues: Record<string, string>;
  }
  | {
    ok: false;
    code: McpConnectorBuildError;
    fieldErrors: Record<string, McpTokenValueError>;
  };

const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// RFC 9110 token characters.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// The transport owns these; a connector must not set them.
const FORBIDDEN_HEADER_NAMES = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
// CR / LF / NUL would split or truncate an HTTP header.
const HEADER_UNSAFE_CHARS_RE = /[\r\n\0]/;
const REMOTE_TRANSPORTS = new Set(['sse', 'http']);
const CONNECTOR_KEYS = [
  'url',
  'auth',
  'tokenSchema',
  'tokenAuth',
  'allowedTools',
  'requestTimeoutMs',
  'connectionTimeoutMs',
  'examples_zh',
  'examples_en',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isHttpUrl = (value: string): boolean => {
  const normalized = normalizeMcpServerUrlInput(value);
  return normalized.ok && !normalized.extracted;
};

const cleanStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/** The `${KEY}` names a URL template refers to, in order of appearance. */
export function listMcpUrlTemplateKeys(template: string): string[] {
  return Array.from(template.matchAll(URL_PLACEHOLDER_RE), match => match[1]);
}

/** `${` left over once every `${KEY}` placeholder is removed, e.g. `${lower-case}` or an unclosed `${`. */
const hasStrayPlaceholder = (template: string): boolean =>
  template.replace(URL_PLACEHOLDER_RE, '').includes('${');

function parseTokenField(raw: unknown, index: number): McpTokenField | string {
  if (!isRecord(raw)) return `tokenSchema.fields[${index}] must be an object`;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!FIELD_KEY_RE.test(key)) return `tokenSchema.fields[${index}].key must be an identifier`;
  const label = optionalString(raw.label);
  if (!label) return `tokenSchema field "${key}" needs a label`;
  const type = raw.type === undefined ? McpTokenFieldType.Text : raw.type;
  if (typeof type !== 'string' || !TOKEN_FIELD_TYPES.has(type)) {
    return `tokenSchema field "${key}" has unsupported type`;
  }
  if (raw.defaultValue !== undefined && typeof raw.defaultValue !== 'string') {
    return `tokenSchema field "${key}" defaultValue must be a string`;
  }
  return {
    key,
    label,
    label_en: optionalString(raw.label_en),
    type: type as McpTokenFieldType,
    required: raw.required === true,
    placeholder: optionalString(raw.placeholder),
    placeholder_en: optionalString(raw.placeholder_en),
    description: optionalString(raw.description),
    description_en: optionalString(raw.description_en),
    defaultValue: typeof raw.defaultValue === 'string' ? raw.defaultValue : undefined,
  };
}

function parseTokenSchema(raw: unknown): McpTokenSchema | string {
  if (!isRecord(raw)) return 'tokenSchema must be an object';
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) return 'tokenSchema.fields must be a non-empty array';
  const fields: McpTokenField[] = [];
  const keys = new Set<string>();
  for (const [index, rawField] of raw.fields.entries()) {
    const field = parseTokenField(rawField, index);
    if (typeof field === 'string') return field;
    if (keys.has(field.key)) return `tokenSchema field "${field.key}" is declared twice`;
    keys.add(field.key);
    fields.push(field);
  }
  const docUrl = optionalString(raw.docUrl);
  if (docUrl && !isHttpUrl(docUrl)) return 'tokenSchema.docUrl must be an http(s) URL';
  return {
    title: optionalString(raw.title),
    title_en: optionalString(raw.title_en),
    description: optionalString(raw.description),
    description_en: optionalString(raw.description_en),
    docUrl,
    docLabel: optionalString(raw.docLabel),
    docLabel_en: optionalString(raw.docLabel_en),
    fields,
  };
}

function parseTokenAuth(raw: unknown, fieldKeys: Set<string>): McpTokenAuth | string {
  if (!isRecord(raw) || !isRecord(raw.headers)) return 'tokenAuth.headers must be an object';
  const headers: Record<string, McpTokenHeaderBinding> = {};
  const seen = new Set<string>();
  for (const [name, rawBinding] of Object.entries(raw.headers)) {
    const lowerName = name.toLowerCase();
    if (!HEADER_NAME_RE.test(name)) return `tokenAuth header "${name}" is not a valid header name`;
    if (FORBIDDEN_HEADER_NAMES.has(lowerName)) return `tokenAuth header "${name}" is not allowed`;
    if (seen.has(lowerName)) return `tokenAuth header "${name}" is declared twice`;
    seen.add(lowerName);
    if (!isRecord(rawBinding) || typeof rawBinding.field !== 'string') {
      return `tokenAuth header "${name}" needs a field`;
    }
    const field = rawBinding.field;
    if (!fieldKeys.has(field)) {
      return `tokenAuth header "${name}" refers to unknown field "${field}"`;
    }
    const rawPrefix = rawBinding.prefix;
    if (rawPrefix !== undefined && typeof rawPrefix !== 'string') {
      return `tokenAuth header "${name}" prefix must be a string`;
    }
    const prefix = typeof rawPrefix === 'string' ? rawPrefix : '';
    if (HEADER_UNSAFE_CHARS_RE.test(prefix)) {
      return `tokenAuth header "${name}" prefix contains CR, LF or NUL`;
    }
    headers[name] = { field, ...(prefix ? { prefix } : {}) };
  }
  if (Object.keys(headers).length === 0) return 'tokenAuth.headers must not be empty';
  return { headers };
}

/** Accepts only finite positive numbers, as OpenClaw's config schema does. */
function parseTimeout(value: unknown, name: string): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return `${name} must be a positive number`;
  }
  return value;
}

/** A sample value per field, so a URL template can be checked before anyone fills it in. */
const sampleTemplateValue = (field: McpTokenField | undefined): string =>
  field?.type === McpTokenFieldType.Url ? 'https://example.invalid' : 'sample';

/**
 * Validates the connector part of one marketplace entry. Returns
 * `connector: undefined` for a plain stdio entry that uses none of it.
 */
export function parseMcpMarketplaceConnector(
  raw: Record<string, unknown>,
  transportType: string,
): McpMarketplaceConnectorParseResult {
  if (!CONNECTOR_KEYS.some(key => raw[key] !== undefined)) return { ok: true, connector: undefined };

  const isRemote = REMOTE_TRANSPORTS.has(transportType);
  const connector: McpMarketplaceConnector = {};

  if (raw.auth !== undefined && raw.auth !== McpAuthMode.None) {
    if (raw.auth !== McpAuthMode.OAuth) return { ok: false, error: 'auth must be "oauth" or "none"' };
    connector.auth = McpAuthMode.OAuth;
  }

  if (raw.tokenSchema !== undefined) {
    const tokenSchema = parseTokenSchema(raw.tokenSchema);
    if (typeof tokenSchema === 'string') return { ok: false, error: tokenSchema };
    connector.tokenSchema = tokenSchema;
  }
  const fields = connector.tokenSchema?.fields ?? [];
  const fieldKeys = new Set(fields.map(field => field.key));

  if (raw.tokenAuth !== undefined) {
    if (!connector.tokenSchema) return { ok: false, error: 'tokenAuth needs a tokenSchema' };
    const tokenAuth = parseTokenAuth(raw.tokenAuth, fieldKeys);
    if (typeof tokenAuth === 'string') return { ok: false, error: tokenAuth };
    connector.tokenAuth = tokenAuth;
  }

  if (connector.auth && (connector.tokenSchema || connector.tokenAuth)) {
    return { ok: false, error: 'OAuth entries cannot declare tokenSchema or tokenAuth' };
  }

  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string' || !raw.url.trim()) return { ok: false, error: 'url must be a string' };
    const template = raw.url.trim();
    if (hasStrayPlaceholder(template)) return { ok: false, error: 'url has a malformed ${...} placeholder' };
    const unknownKey = listMcpUrlTemplateKeys(template).find(key => !fieldKeys.has(key));
    if (unknownKey) return { ok: false, error: `url refers to unknown field "${unknownKey}"` };
    const sample = template.replace(URL_PLACEHOLDER_RE, (_match, key: string) =>
      sampleTemplateValue(fields.find(field => field.key === key)));
    if (!isHttpUrl(sample)) return { ok: false, error: 'url must be an http(s) URL' };
    connector.url = template;
  }

  if (isRemote && !connector.url) return { ok: false, error: 'remote entries need a url' };
  if (!isRemote && (connector.url || connector.auth || connector.tokenSchema)) {
    return { ok: false, error: 'url, auth and tokenSchema need an sse or http transport' };
  }

  if (connector.tokenSchema) {
    const usedKeys = new Set([
      ...listMcpUrlTemplateKeys(connector.url ?? ''),
      ...Object.values(connector.tokenAuth?.headers ?? {}).map(binding => binding.field),
    ]);
    const unusedField = fields.find(field => !usedKeys.has(field.key));
    if (unusedField) return { ok: false, error: `tokenSchema field "${unusedField.key}" is not used by url or tokenAuth` };
  }

  if (raw.allowedTools !== undefined) {
    if (!Array.isArray(raw.allowedTools) || raw.allowedTools.some(item => typeof item !== 'string')) {
      return { ok: false, error: 'allowedTools must be an array of strings' };
    }
    connector.allowedTools = cleanStringList(raw.allowedTools);
  }

  for (const key of ['requestTimeoutMs', 'connectionTimeoutMs'] as const) {
    const timeout = parseTimeout(raw[key], key);
    if (typeof timeout === 'string') return { ok: false, error: timeout };
    if (timeout !== undefined) connector[key] = timeout;
  }

  // Display-only; tolerate stray non-string items instead of hiding the entry.
  connector.examples_zh = cleanStringList(raw.examples_zh);
  connector.examples_en = cleanStringList(raw.examples_en);

  return { ok: true, connector };
}

/** Field values as the form starts out: saved values on edit, else the schema defaults. */
export function getInitialMcpTokenValues(
  schema: McpTokenSchema,
  saved?: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    schema.fields.map(field => [field.key, saved?.[field.key] ?? field.defaultValue ?? '']),
  );
}

export function validateMcpTokenValues(
  schema: McpTokenSchema,
  values: Record<string, string>,
): Record<string, McpTokenValueError> {
  const errors: Record<string, McpTokenValueError> = {};
  for (const field of schema.fields) {
    const value = (values[field.key] ?? '').trim();
    if (!value) {
      if (field.required) errors[field.key] = McpTokenValueError.Required;
      continue;
    }
    if (HEADER_UNSAFE_CHARS_RE.test(value)) {
      errors[field.key] = McpTokenValueError.InvalidCharacters;
    } else if (field.type === McpTokenFieldType.Url && !isHttpUrl(value)) {
      errors[field.key] = McpTokenValueError.InvalidUrl;
    }
  }
  return errors;
}

/**
 * Builds the literal URL and headers a remote connector is saved with. Values
 * substituted into the URL are percent-encoded, except `url` fields, which are
 * whole URLs or URL prefixes by design.
 */
export function buildMcpConnectorCredentials(
  connector: McpMarketplaceConnector,
  rawValues: Record<string, string>,
): McpConnectorCredentialsResult {
  const fields = connector.tokenSchema?.fields ?? [];
  const tokenValues = Object.fromEntries(
    fields.map(field => [field.key, (rawValues[field.key] ?? '').trim()]),
  );
  const fieldErrors = connector.tokenSchema ? validateMcpTokenValues(connector.tokenSchema, tokenValues) : {};
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, code: McpConnectorBuildError.InvalidFields, fieldErrors };
  }

  const template = connector.url ?? '';
  const fieldsByKey = new Map(fields.map(field => [field.key, field]));
  if (
    !template
    || hasStrayPlaceholder(template)
    || listMcpUrlTemplateKeys(template).some(key => !fieldsByKey.has(key))
  ) {
    return { ok: false, code: McpConnectorBuildError.InvalidUrl, fieldErrors: {} };
  }
  const substituted = template.replace(URL_PLACEHOLDER_RE, (_match, key: string) => {
    const value = tokenValues[key];
    return fieldsByKey.get(key)?.type === McpTokenFieldType.Url ? value : encodeURIComponent(value);
  });
  const normalized = normalizeMcpServerUrlInput(substituted);
  if (!normalized.ok || normalized.extracted) {
    return { ok: false, code: McpConnectorBuildError.InvalidUrl, fieldErrors: {} };
  }

  const headers: Record<string, string> = {};
  for (const [name, binding] of Object.entries(connector.tokenAuth?.headers ?? {})) {
    const value = tokenValues[binding.field];
    // An optional field left empty sends no header rather than a bare prefix.
    if (value) headers[name] = `${binding.prefix ?? ''}${value}`;
  }

  return { ok: true, url: normalized.url, headers, tokenValues };
}
