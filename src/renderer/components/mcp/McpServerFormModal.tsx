import React, { useEffect,useState } from 'react';

import { McpUrlValidationError, normalizeMcpServerUrlInput } from '../../../shared/mcp/url';
import { i18nService } from '../../services/i18n';
import { McpJsonImportErrorCode, McpJsonImportResult, parseMcpServersJson } from '../../services/mcpJsonImport';
import { McpRegistryEntry,McpServerConfig, McpServerFormData } from '../../types/mcp';
import Modal from '../common/Modal';

const TRANSPORT_OPTIONS: { value: 'stdio' | 'sse' | 'http'; label: string; descKey: string }[] = [
  { value: 'stdio', label: 'stdio', descKey: 'mcpTransportStdio' },
  { value: 'sse', label: 'SSE', descKey: 'mcpTransportSse' },
  { value: 'http', label: 'HTTP', descKey: 'mcpTransportHttp' },
];

export const McpFormInputMode = {
  Form: 'form',
  Json: 'json',
} as const;
export type McpFormInputMode = typeof McpFormInputMode[keyof typeof McpFormInputMode];

const INPUT_MODE_OPTIONS: { value: McpFormInputMode; labelKey: string }[] = [
  { value: McpFormInputMode.Form, labelKey: 'mcpFormModeForm' },
  { value: McpFormInputMode.Json, labelKey: 'mcpFormModeJson' },
];

// Placeholder sample shown in the JSON textarea; code, not user-facing copy.
const MCP_JSON_EXAMPLE = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "your-key" }
    },
    "remote-server": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}`;

interface McpServerFormModalProps {
  isOpen: boolean;
  server?: McpServerConfig | null; // null = create mode, defined = edit mode
  registryEntry?: McpRegistryEntry | null; // install from registry mode
  existingNames: string[];
  onClose: () => void;
  onSave: (data: McpServerFormData) => void;
  onImportJson?: (servers: McpServerFormData[]) => Promise<{ success: boolean; error?: string }>;
}

const McpServerFormModal: React.FC<McpServerFormModalProps> = ({
  isOpen,
  server,
  registryEntry,
  existingNames,
  onClose,
  onSave,
  onImportJson,
}) => {
  const isEdit = !!server;
  const isRegistry = !!registryEntry && !isEdit;
  // JSON paste mode is only offered when creating from scratch.
  const supportsJsonMode = !isEdit && !isRegistry && !!onImportJson;

  const [inputMode, setInputMode] = useState<McpFormInputMode>(McpFormInputMode.Form);
  const [jsonText, setJsonText] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transportType, setTransportType] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<{ key: string; value: string; required?: boolean }[]>([]);
  const [url, setUrl] = useState('');
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState('');
  const [envErrors, setEnvErrors] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!isOpen) return;
    if (server) {
      // Edit mode
      setName(server.name);
      setDescription(server.description);
      setTransportType(server.transportType);
      setCommand(server.command || '');
      setArgsText((server.args || []).join('\n'));
      const requiredKeys = new Set(registryEntry?.requiredEnvKeys ?? []);
      setEnvRows(
        server.env
          ? Object.entries(server.env).map(([key, value]) => ({
              key,
              value,
              required: requiredKeys.has(key) || undefined,
            }))
          : []
      );
      setUrl(server.url || '');
      setHeaderRows(
        server.headers
          ? Object.entries(server.headers).map(([key, value]) => ({ key, value }))
          : []
      );
    } else if (registryEntry) {
      // Registry install mode — pre-fill from template
      setName(registryEntry.name);
      const registryDescription =
        (i18nService.getLanguage() === 'zh' ? registryEntry.description_zh : registryEntry.description_en)
        || (registryEntry.descriptionKey ? i18nService.t(registryEntry.descriptionKey) : '');
      setDescription(registryDescription);
      setTransportType(registryEntry.transportType);
      setCommand(registryEntry.command);
      // defaultArgs + argPlaceholders
      const allArgs = [...registryEntry.defaultArgs];
      if (registryEntry.argPlaceholders) {
        allArgs.push(...registryEntry.argPlaceholders);
      }
      setArgsText(allArgs.join('\n'));
      // Pre-fill required env keys
      const envEntries: { key: string; value: string; required?: boolean }[] = [];
      if (registryEntry.requiredEnvKeys) {
        for (const k of registryEntry.requiredEnvKeys) {
          envEntries.push({ key: k, value: '', required: true });
        }
      }
      if (registryEntry.optionalEnvKeys) {
        for (const k of registryEntry.optionalEnvKeys) {
          envEntries.push({ key: k, value: '', required: false });
        }
      }
      setEnvRows(envEntries);
      setUrl('');
      setHeaderRows([]);
    } else {
      // Create mode
      setName('');
      setDescription('');
      setTransportType('stdio');
      setCommand('');
      setArgsText('');
      setEnvRows([]);
      setUrl('');
      setHeaderRows([]);
    }
    setInputMode(McpFormInputMode.Form);
    setJsonText('');
    setIsImporting(false);
    setError('');
    setEnvErrors({});
  }, [isOpen, server, registryEntry]);

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(i18nService.t('mcpNameRequired'));
      return;
    }

    // Check name uniqueness (excluding current server in edit mode)
    const otherNames = existingNames.filter(n => !isEdit || n !== server?.name);
    if (otherNames.includes(trimmedName)) {
      setError(i18nService.t('mcpNameExists'));
      return;
    }

    if (transportType === 'stdio' && !command.trim()) {
      setError(i18nService.t('mcpCommandRequired'));
      return;
    }

    if ((transportType === 'sse' || transportType === 'http') && !url.trim()) {
      setError(i18nService.t('mcpUrlRequired'));
      return;
    }

    let normalizedUrl = '';
    if (transportType === 'sse' || transportType === 'http') {
      const normalized = normalizeMcpServerUrlInput(url);
      if (!normalized.ok) {
        setError(
          normalized.error === McpUrlValidationError.Multiple
            ? i18nService.t('mcpUrlMultiple')
            : i18nService.t('mcpUrlInvalid'),
        );
        return;
      }
      normalizedUrl = normalized.url;
      if (normalized.extracted && normalizedUrl !== url) {
        setUrl(normalizedUrl);
      }
    }

    // Validate required env vars
    const missingRequiredIndices: Record<number, boolean> = {};
    envRows.forEach((row, index) => {
      if (row.required && !row.value.trim()) {
        missingRequiredIndices[index] = true;
      }
    });
    if (Object.keys(missingRequiredIndices).length > 0) {
      setEnvErrors(missingRequiredIndices);
      return;
    }

    const args = argsText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const env: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      if (k) env[k] = row.value;
    }

    const headers: Record<string, string> = {};
    for (const row of headerRows) {
      const k = row.key.trim();
      if (k) headers[k] = row.value;
    }

    const data: McpServerFormData = {
      name: trimmedName,
      description: description.trim(),
      transportType,
    };

    if (transportType === 'stdio') {
      data.command = command.trim();
      data.args = args;
      data.env = env;
    } else {
      data.url = normalizedUrl;
      data.headers = headers;
    }

    // Attach registry metadata if installing from registry
    if (isRegistry && registryEntry) {
      data.isBuiltIn = true;
      data.registryId = registryEntry.id;
    }

    onSave(data);
  };

  const formatJsonImportError = (result: Extract<McpJsonImportResult, { ok: false }>): string => {
    switch (result.code) {
      case McpJsonImportErrorCode.InvalidJson:
        return i18nService.t('mcpJsonInvalid');
      case McpJsonImportErrorCode.NoServers:
        return i18nService.t('mcpJsonNoServers');
      case McpJsonImportErrorCode.MissingName:
        return i18nService.t('mcpJsonMissingName');
      case McpJsonImportErrorCode.DuplicateName:
        return i18nService.t('mcpJsonDuplicateName').replace('{name}', result.detail ?? '');
      case McpJsonImportErrorCode.EntryInvalid:
      default:
        return i18nService.t('mcpJsonEntryInvalid').replace('{name}', result.detail ?? '');
    }
  };

  const handleImportJson = async () => {
    if (!onImportJson) return;
    const result = parseMcpServersJson(jsonText);
    if (!result.ok) {
      setError(formatJsonImportError(result));
      return;
    }
    const conflicts = result.servers
      .map(item => item.name)
      .filter(itemName => existingNames.includes(itemName));
    if (conflicts.length > 0) {
      setError(i18nService.t('mcpJsonNameConflict').replace('{name}', conflicts.join(', ')));
      return;
    }
    setError('');
    setIsImporting(true);
    try {
      const importResult = await onImportJson(result.servers);
      if (!importResult.success) {
        setError(importResult.error || i18nService.t('mcpCreateFailed'));
      }
    } finally {
      setIsImporting(false);
    }
  };

  const handleAddEnvRow = () => {
    setEnvRows([...envRows, { key: '', value: '' }]);
  };

  const handleRemoveEnvRow = (index: number) => {
    setEnvRows(envRows.filter((_, i) => i !== index));
  };

  const handleUpdateEnvRow = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...envRows];
    updated[index] = { ...updated[index], [field]: val };
    setEnvRows(updated);
    if (field === 'value' && envErrors[index]) {
      setEnvErrors(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    }
  };

  const handleAddHeaderRow = () => {
    setHeaderRows([...headerRows, { key: '', value: '' }]);
  };

  const handleRemoveHeaderRow = (index: number) => {
    setHeaderRows(headerRows.filter((_, i) => i !== index));
  };

  const handleUpdateHeaderRow = (index: number, field: 'key' | 'value', val: string) => {
    const updated = [...headerRows];
    updated[index] = { ...updated[index], [field]: val };
    setHeaderRows(updated);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const inputClass = 'w-full px-3 py-2 text-sm rounded-lg bg-background text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary';
  const readOnlyInputClass = inputClass + ' opacity-60 cursor-not-allowed';
  const labelClass = 'text-xs font-semibold tracking-wide text-secondary';
  const kvInputClass = 'flex-1 px-2 py-1.5 text-sm rounded-lg bg-background text-foreground border border-border focus:outline-none focus:ring-1 focus:ring-primary';

  // Title
  const modalTitle = isEdit
    ? i18nService.t('editMcpServer')
    : isRegistry
      ? `${i18nService.t('mcpInstall')} ${registryEntry!.name}`
      : i18nService.t('addMcpServer');

  // Save button text
  const saveText = isRegistry && !isEdit
    ? i18nService.t('mcpInstall')
    : i18nService.t('saveMcpServer');

  return (
    <Modal onClose={onClose} overlayClassName="fixed inset-0 z-50 flex items-center justify-center modal-backdrop px-4" className="modal-content flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">
            {modalTitle}
          </h2>
          {supportsJsonMode && (
            <div className="flex flex-shrink-0 rounded-lg bg-surface-raised p-0.5">
              {INPUT_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setInputMode(opt.value);
                    setError('');
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    inputMode === opt.value
                      ? 'bg-surface text-foreground shadow-subtle'
                      : 'text-secondary hover:text-foreground'
                  }`}
                >
                  {i18nService.t(opt.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {inputMode === McpFormInputMode.Json ? (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-secondary">
                {i18nService.t('mcpJsonImportHint')}
              </p>
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder={MCP_JSON_EXAMPLE}
                rows={14}
                spellCheck={false}
                autoFocus
                className={inputClass + ' resize-none font-mono text-xs leading-5'}
              />
            </div>
          ) : (
          <>
          {/* Name */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('mcpServerName')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={i18nService.t('mcpServerNamePlaceholder')}
              className={isRegistry ? readOnlyInputClass : inputClass}
              readOnly={isRegistry}
              autoFocus={!isRegistry}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('mcpServerDescription')}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={i18nService.t('mcpServerDescriptionPlaceholder')}
              className={inputClass}
            />
          </div>

          {/* Transport Type */}
          <div className="space-y-1.5">
            <label className={labelClass}>{i18nService.t('mcpTransportType')}</label>
            <div className={`grid grid-cols-3 gap-1 rounded-lg bg-surface-raised p-1 ${isRegistry ? 'opacity-60' : ''}`}>
              {TRANSPORT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={isRegistry}
                  onClick={() => setTransportType(opt.value)}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    transportType === opt.value
                      ? 'bg-surface text-foreground shadow-subtle'
                      : 'text-secondary hover:text-foreground'
                  } ${isRegistry ? 'cursor-not-allowed' : ''}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-secondary">
              {i18nService.t(TRANSPORT_OPTIONS.find(opt => opt.value === transportType)!.descKey)}
            </p>
          </div>

          {/* stdio fields */}
          {transportType === 'stdio' && (
            <>
              <div className="space-y-1.5">
                <label className={labelClass}>{i18nService.t('mcpCommand')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span></label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={i18nService.t('mcpCommandPlaceholder')}
                  className={isRegistry ? readOnlyInputClass : inputClass}
                  readOnly={isRegistry}
                />
              </div>

              <div className="space-y-1.5">
                <label className={labelClass}>{i18nService.t('mcpArgs')}</label>
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={i18nService.t('mcpArgsPlaceholder')}
                  rows={3}
                  className={inputClass + ' resize-none'}
                  autoFocus={isRegistry}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelClass}>
                    {i18nService.t('mcpEnvVars')}
                    {isRegistry && envRows.some(r => r.required) && (
                      <span className="ml-2 text-[10px] text-red-400 font-normal">
                        * {i18nService.t('mcpRequiredConfig')}
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    onClick={handleAddEnvRow}
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    + {i18nService.t('addKeyValue')}
                  </button>
                </div>
                {envRows.map((row, index) => (
                  <div key={index} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(e) => handleUpdateEnvRow(index, 'key', e.target.value)}
                        placeholder={i18nService.t('mcpHeaderKey')}
                        className={row.required ? kvInputClass + ' opacity-60 cursor-not-allowed' : kvInputClass}
                        readOnly={!!row.required}
                      />
                      <input
                        type="text"
                        value={row.value}
                        onChange={(e) => handleUpdateEnvRow(index, 'value', e.target.value)}
                        placeholder={row.required ? `${row.key} *` : i18nService.t('mcpHeaderValue')}
                        className={
                          envErrors[index]
                            ? kvInputClass + ' border-red-500 focus:ring-red-500'
                            : kvInputClass
                        }
                        autoFocus={isRegistry && index === 0 && !!row.required}
                      />
                      {!row.required && (
                        <button
                          type="button"
                          onClick={() => handleRemoveEnvRow(index)}
                          className="p-1 text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                          </svg>
                        </button>
                      )}
                      {row.required && (
                        <span className="text-red-400 text-xs flex-shrink-0 w-4 text-center">*</span>
                      )}
                    </div>
                    {envErrors[index] && row.required && (
                      <p className="text-xs text-red-500 ml-[calc(50%+8px)]">
                        {i18nService.t('mcpEnvRequired')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* sse / http fields */}
          {(transportType === 'sse' || transportType === 'http') && (
            <>
              <div className="space-y-1.5">
                <label className={labelClass}>{i18nService.t('mcpUrl')}<span className="text-red-500 dark:text-red-400 ml-0.5">*</span></label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={i18nService.t('mcpUrlPlaceholder')}
                  className={inputClass}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className={labelClass}>{i18nService.t('mcpHeaders')}</label>
                  <button
                    type="button"
                    onClick={handleAddHeaderRow}
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                  >
                    + {i18nService.t('addKeyValue')}
                  </button>
                </div>
                {headerRows.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => handleUpdateHeaderRow(index, 'key', e.target.value)}
                      placeholder={i18nService.t('mcpHeaderKey')}
                      className={kvInputClass}
                    />
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) => handleUpdateHeaderRow(index, 'value', e.target.value)}
                      placeholder={i18nService.t('mcpHeaderValue')}
                      className={kvInputClass}
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveHeaderRow(index)}
                      className="p-1 text-secondary hover:text-red-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <p className="min-w-0 flex-1 text-xs text-red-500">{error}</p>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            {inputMode === McpFormInputMode.Json ? (
              <button
                type="button"
                onClick={handleImportJson}
                disabled={isImporting || !jsonText.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {i18nService.t('mcpJsonImport')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSave}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
              >
                {saveText}
              </button>
            )}
          </div>
        </div>
    </Modal>
  );
};

export default McpServerFormModal;
