import React, { useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import { McpServerConfig, McpServerFormData, McpRegistryEntry } from '../../types/mcp';
import Modal from '../common/Modal';

interface McpServerFormModalProps {
  isOpen: boolean;
  server?: McpServerConfig | null; // null = create mode, defined = edit mode
  registryEntry?: McpRegistryEntry | null; // install from registry mode
  existingNames: string[];
  onClose: () => void;
  onSave: (data: McpServerFormData) => void;
}

const McpServerFormModal: React.FC<McpServerFormModalProps> = ({
  isOpen,
  server,
  registryEntry,
  existingNames,
  onClose,
  onSave,
}) => {
  const isEdit = !!server;
  const isRegistry = !!registryEntry && !isEdit;

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

  const inputClass = 'w-full px-3 py-2 text-sm rounded-xl bg-background text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary';
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
    <Modal onClose={onClose} overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60" className="w-full max-w-lg mx-4 rounded-2xl bg-surface border border-border shadow-2xl p-6 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div className="text-lg font-semibold text-foreground">
            {modalTitle}
          </div>
        </div>

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

          {error && (
            <div className="text-xs text-red-500">{error}</div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg border border-border text-secondary hover:bg-surface-raised transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              {saveText}
            </button>
          </div>
        </div>
    </Modal>
  );
};

export default McpServerFormModal;
