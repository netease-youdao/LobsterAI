import React, { useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import { McpServerConfig, McpServerFormData, McpRegistryEntry, McpTransportType } from '../../types/mcp';

type FormMode = 'manual' | 'json';
type JsonStep = 'input' | 'preview';

interface ParsedEntry {
  name: string;
  formData: McpServerFormData;
  isDuplicate: boolean;
  selected: boolean;
  hasOriginalName: boolean;
}

interface McpServerFormModalProps {
  isOpen: boolean;
  server?: McpServerConfig | null; // null = create mode, defined = edit mode
  registryEntry?: McpRegistryEntry | null; // install from registry mode
  existingNames: string[];
  onClose: () => void;
  onSave: (data: McpServerFormData) => void;
  onBatchSave?: (entries: McpServerFormData[]) => Promise<void>;
}

/** Strip // line comments and /* block comments from JSONC text */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      result += ch;
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }
    if (ch === '/' && i + 1 < text.length) {
      if (text[i + 1] === '/') {
        // skip until newline
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text[i + 1] === '*') {
        i += 2;
        while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function detectTransport(entry: Record<string, unknown>): McpTransportType {
  if (entry.command) return 'stdio';
  if (typeof entry.url === 'string') {
    return entry.url.includes('/sse') ? 'sse' : 'http';
  }
  return 'stdio';
}

function entryToFormData(name: string, raw: Record<string, unknown>): McpServerFormData {
  const transport = detectTransport(raw);
  const data: McpServerFormData = {
    name,
    description: '',
    transportType: transport,
  };
  if (transport === 'stdio') {
    data.command = String(raw.command || '');
    if (Array.isArray(raw.args)) data.args = raw.args.map(String);
    if (raw.env && typeof raw.env === 'object') {
      data.env = Object.fromEntries(
        Object.entries(raw.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );
    }
  } else {
    data.url = String(raw.url || '');
    if (raw.headers && typeof raw.headers === 'object') {
      data.headers = Object.fromEntries(
        Object.entries(raw.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );
    }
  }
  return data;
}

function parseJsonConfig(root: unknown): { name: string; formData: McpServerFormData }[] {
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('invalid');
  }
  const obj = root as Record<string, unknown>;

  // Format 1: Claude Desktop — { mcpServers: { name: {...} } }
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const servers = obj.mcpServers as Record<string, unknown>;
    return Object.entries(servers).map(([name, cfg]) => ({
      name,
      formData: entryToFormData(name, cfg as Record<string, unknown>),
    }));
  }

  // Format 3/4: Single server object — { command: "npx", ... } or { url: "http://..." }
  if (obj.command || obj.url) {
    return [{ name: '', formData: entryToFormData('', obj) }];
  }

  // Format 2: Bare multi-server — { name: { command: ... }, name2: { url: ... } }
  const entries = Object.entries(obj);
  if (entries.length > 0 && entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) {
    return entries.map(([name, cfg]) => ({
      name,
      formData: entryToFormData(name, cfg as Record<string, unknown>),
    }));
  }

  throw new Error('invalid');
}

const TRANSPORT_BADGE_COLORS: Record<string, string> = {
  stdio: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  sse: 'bg-green-500/10 text-green-600 dark:text-green-400',
  http: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
};

const McpServerFormModal: React.FC<McpServerFormModalProps> = ({
  isOpen,
  server,
  registryEntry,
  existingNames,
  onClose,
  onSave,
  onBatchSave,
}) => {
  const isEdit = !!server;
  const isRegistry = !!registryEntry && !isEdit;
  const isCreateMode = !isEdit && !isRegistry;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transportType, setTransportType] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<{ key: string; value: string; required?: boolean }[]>([]);
  const [url, setUrl] = useState('');
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState('');

  // JSON paste mode state
  const [formMode, setFormMode] = useState<FormMode>('manual');
  const [jsonStep, setJsonStep] = useState<JsonStep>('input');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [parsedEntries, setParsedEntries] = useState<ParsedEntry[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Reset JSON mode state on open
    setFormMode('manual');
    setJsonStep('input');
    setJsonText('');
    setJsonError('');
    setParsedEntries([]);
    setIsSubmitting(false);

    if (server) {
      // Edit mode
      setName(server.name);
      setDescription(server.description);
      setTransportType(server.transportType);
      setCommand(server.command || '');
      setArgsText((server.args || []).join('\n'));
      setEnvRows(
        server.env
          ? Object.entries(server.env).map(([key, value]) => ({ key, value }))
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
    setError('');
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
      if (args.length > 0) data.args = args;
      if (Object.keys(env).length > 0) data.env = env;
    } else {
      data.url = url.trim();
      if (Object.keys(headers).length > 0) data.headers = headers;
    }

    // Attach registry metadata if installing from registry
    if (isRegistry && registryEntry) {
      data.isBuiltIn = true;
      data.registryId = registryEntry.id;
    }

    onSave(data);
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

  // JSON mode handlers
  const handleParseJson = () => {
    setJsonError('');
    try {
      const cleaned = stripJsonComments(jsonText.trim());
      const parsed = JSON.parse(cleaned);
      const raw = parseJsonConfig(parsed);
      const entries: ParsedEntry[] = raw.map((r) => {
        const isDuplicate = existingNames.includes(r.name);
        return {
          name: r.name,
          formData: { ...r.formData, name: r.name },
          isDuplicate,
          selected: !isDuplicate && r.name.trim().length > 0,
          hasOriginalName: r.name.trim().length > 0,
        };
      });
      setParsedEntries(entries);
      setJsonStep('preview');
    } catch {
      setJsonError(i18nService.t('mcpPasteJsonParseError'));
    }
  };

  const handleToggleEntry = (index: number) => {
    setParsedEntries(prev => prev.map((e, i) =>
      i === index ? { ...e, selected: !e.selected } : e
    ));
  };

  const handleEntryNameChange = (index: number, newName: string) => {
    setParsedEntries(prev => prev.map((e, i) => {
      if (i !== index) return e;
      const isDuplicate = existingNames.includes(newName);
      return {
        ...e,
        name: newName,
        formData: { ...e.formData, name: newName },
        isDuplicate,
      };
    }));
  };

  const handleBatchConfirm = async () => {
    if (!onBatchSave) return;
    const selected = parsedEntries.filter(e => e.selected && e.name.trim().length > 0);
    if (selected.length === 0) return;
    setIsSubmitting(true);
    try {
      await onBatchSave(selected.map(e => e.formData));
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedCount = parsedEntries.filter(e => e.selected && e.name.trim().length > 0).length;

  const getEntrySummary = (entry: ParsedEntry): string => {
    const fd = entry.formData;
    if (fd.transportType === 'stdio') {
      const parts = [fd.command || ''];
      if (fd.args && fd.args.length > 0) {
        parts.push(fd.args[0]);
        if (fd.args.length > 1) parts.push('...');
      }
      return parts.join(' ');
    }
    return fd.url || '';
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

  const inputClass = 'w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
  const readOnlyInputClass = inputClass + ' opacity-60 cursor-not-allowed';
  const labelClass = 'text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const kvInputClass = 'flex-1 px-2 py-1.5 text-sm rounded-lg dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent';

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

  const pillClass = (active: boolean) =>
    `px-3 py-1 text-xs rounded-lg transition-colors ${
      active
        ? 'bg-claude-accent text-white'
        : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {modalTitle}
          </div>
        </div>

        {/* Mode toggle — only in create mode */}
        {isCreateMode && (
          <div className="flex items-center gap-2 mb-4">
            <button
              type="button"
              onClick={() => setFormMode('manual')}
              className={pillClass(formMode === 'manual')}
            >
              {i18nService.t('mcpFormModeManual')}
            </button>
            <button
              type="button"
              onClick={() => setFormMode('json')}
              className={pillClass(formMode === 'json')}
            >
              {i18nService.t('mcpFormModeJson')}
            </button>
          </div>
        )}

        {/* ── JSON Mode ── */}
        {formMode === 'json' && isCreateMode && (
          <div className="space-y-4">
            {jsonStep === 'input' && (
              <>
                <textarea
                  value={jsonText}
                  onChange={(e) => { setJsonText(e.target.value); setJsonError(''); }}
                  placeholder={`${i18nService.t('mcpPasteJsonPlaceholder')}\n\n// e.g. Claude Desktop format:\n{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "@example/mcp-server"]\n    }\n  }\n}`}
                  rows={10}
                  className={inputClass + ' resize-none font-mono text-xs'}
                  autoFocus
                />
                {jsonError && (
                  <div className="text-xs text-red-500">{jsonError}</div>
                )}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleParseJson}
                    disabled={!jsonText.trim()}
                    className="px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {i18nService.t('mcpPasteJsonParse')}
                  </button>
                </div>
              </>
            )}

            {jsonStep === 'preview' && (
              <>
                <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
                  {i18nService.t('mcpPasteJsonFound').replace('{count}', String(parsedEntries.length))}
                </div>
                <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                  {parsedEntries.map((entry, index) => (
                    <div
                      key={index}
                      className={`flex items-center gap-3 p-2.5 rounded-xl border transition-colors ${
                        entry.selected
                          ? 'dark:border-claude-accent/40 border-claude-accent/40 dark:bg-claude-darkBg/50 bg-claude-bg/50'
                          : 'dark:border-claude-darkBorder border-claude-border'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={entry.selected}
                        onChange={() => handleToggleEntry(index)}
                        className="rounded accent-claude-accent flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          {entry.hasOriginalName ? (
                            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                              {entry.name}
                            </span>
                          ) : (
                            <input
                              type="text"
                              value={entry.name}
                              onChange={(e) => handleEntryNameChange(index, e.target.value)}
                              placeholder={i18nService.t('mcpPasteJsonNoName')}
                              className="text-sm font-medium px-1.5 py-0.5 rounded-lg dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-1 focus:ring-claude-accent w-32"
                            />
                          )}
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TRANSPORT_BADGE_COLORS[entry.formData.transportType] || ''}`}>
                            {entry.formData.transportType}
                          </span>
                          {entry.isDuplicate && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
                              {i18nService.t('mcpPasteJsonDuplicate')}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                          {getEntrySummary(entry)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setJsonStep('input')}
                    className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                  >
                    {i18nService.t('mcpPasteJsonBack')}
                  </button>
                  <button
                    type="button"
                    onClick={handleBatchConfirm}
                    disabled={selectedCount === 0 || isSubmitting}
                    className="px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting
                      ? '...'
                      : i18nService.t('mcpPasteJsonConfirm').replace('{count}', String(selectedCount))
                    }
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Manual Mode (original form) ── */}
        {(formMode === 'manual' || !isCreateMode) && (
          <div className="space-y-4">
            {/* Name */}
            <div className="space-y-1.5">
              <label className={labelClass}>{i18nService.t('mcpServerName')}</label>
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
              <select
                value={transportType}
                onChange={(e) => setTransportType(e.target.value as 'stdio' | 'sse' | 'http')}
                className={isRegistry ? readOnlyInputClass : inputClass}
                disabled={isRegistry}
              >
                <option value="stdio">{i18nService.t('mcpTransportStdio')}</option>
                <option value="sse">{i18nService.t('mcpTransportSse')}</option>
                <option value="http">{i18nService.t('mcpTransportHttp')}</option>
              </select>
            </div>

            {/* stdio fields */}
            {transportType === 'stdio' && (
              <>
                <div className="space-y-1.5">
                  <label className={labelClass}>{i18nService.t('mcpCommand')}</label>
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
                      className="text-xs text-claude-accent hover:text-claude-accent/80 transition-colors"
                    >
                      + {i18nService.t('addKeyValue')}
                    </button>
                  </div>
                  {envRows.map((row, index) => (
                    <div key={index} className="flex items-center gap-2">
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
                        className={kvInputClass}
                        autoFocus={isRegistry && index === 0 && !!row.required}
                      />
                      {!row.required && (
                        <button
                          type="button"
                          onClick={() => handleRemoveEnvRow(index)}
                          className="p-1 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
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
                  ))}
                </div>
              </>
            )}

            {/* sse / http fields */}
            {(transportType === 'sse' || transportType === 'http') && (
              <>
                <div className="space-y-1.5">
                  <label className={labelClass}>{i18nService.t('mcpUrl')}</label>
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
                      className="text-xs text-claude-accent hover:text-claude-accent/80 transition-colors"
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
                        className="p-1 text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors flex-shrink-0"
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

            {error && (
              <div className="text-xs text-red-500">{error}</div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="px-3 py-1.5 text-xs rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors"
              >
                {saveText}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default McpServerFormModal;
