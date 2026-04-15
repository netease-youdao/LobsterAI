import React, { useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { i18nService } from '../../services/i18n';
import { ArrowUpTrayIcon, LinkIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  fetchTemplateFromUrl,
  parseAgentTemplate,
  readTemplateFromFile,
  templateToCreateRequest,
} from '../../utils/agentTemplate';

interface AgentImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Tab = 'file' | 'url';

const AgentImportModal: React.FC<AgentImportModalProps> = ({ isOpen, onClose }) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [tab, setTab] = useState<Tab>('file');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const reset = () => {
    setUrl('');
    setError('');
    setSuccess('');
    setLoading(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const doImport = async (fetchFn: () => Promise<ReturnType<typeof parseAgentTemplate>>) => {
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const tpl = await fetchFn();
      const nameExists = agents.some(a => a.name === tpl.name);
      if (nameExists) {
        setError(i18nService.t('agentImportNameExists'));
        return;
      }
      await agentService.createAgent(templateToCreateRequest(tpl));
      setSuccess(i18nService.t('agentImportSuccess'));
      setTimeout(handleClose, 1200);
    } catch (e) {
      const msg = e instanceof SyntaxError
        ? i18nService.t('agentImportInvalidFormat')
        : i18nService.t('agentImportFailed') + ': ' + (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await doImport(() => readTemplateFromFile(file));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUrlFetch = () => {
    if (!url.trim()) return;
    doImport(() => fetchTemplateFromUrl(url.trim()));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" onClick={handleClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-background rounded-2xl shadow-xl border border-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            {i18nService.t('agentImport')}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-4">
          {(['file', 'url'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setError(''); setSuccess(''); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t
                  ? 'bg-primary/10 text-primary'
                  : 'text-secondary hover:bg-surface-raised'
              }`}
            >
              {t === 'file' ? <ArrowUpTrayIcon className="h-3.5 w-3.5" /> : <LinkIcon className="h-3.5 w-3.5" />}
              {i18nService.t(t === 'file' ? 'agentImportFromFile' : 'agentImportFromUrl')}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {tab === 'file' ? (
            <div
              className="flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed border-border hover:border-primary cursor-pointer transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <ArrowUpTrayIcon className="h-8 w-8 text-secondary" />
              <p className="text-sm text-secondary text-center">
                {i18nService.t('agentImportFromFile')}
                <br />
                <span className="text-xs opacity-70">.agent.json</span>
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUrlFetch()}
                placeholder={i18nService.t('agentImportUrlPlaceholder')}
                className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface-raised border border-border text-foreground placeholder:text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                type="button"
                onClick={handleUrlFetch}
                disabled={loading || !url.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {loading ? '…' : i18nService.t('agentImportUrlFetch')}
              </button>
            </div>
          )}

          {/* Feedback */}
          {error && (
            <p className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {success && (
            <p className="text-xs text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
              {success}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentImportModal;
