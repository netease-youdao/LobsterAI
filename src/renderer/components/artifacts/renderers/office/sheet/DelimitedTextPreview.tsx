import React, { useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';
import {
  decodeDelimitedText,
  DelimitedTextEncoding,
  DelimitedTextEncodingError,
  DelimitedTextEncodingSource,
  getDelimitedTextEncoding,
  rememberDelimitedTextEncoding,
} from '@/services/office/sheet/delimitedTextEncoding';

import { SheetFallbackRenderer } from './SheetFallbackRenderer';

const t = (key: string) => i18nService.t(key);
const ENCODING_LABELS: Record<DelimitedTextEncoding, string> = {
  [DelimitedTextEncoding.Auto]: 'artifactEncodingAuto',
  [DelimitedTextEncoding.Utf8]: 'artifactEncodingUtf8',
  [DelimitedTextEncoding.Gb18030]: 'artifactEncodingGb18030',
  [DelimitedTextEncoding.Utf16Le]: 'artifactEncodingUtf16Le',
  [DelimitedTextEncoding.Utf16Be]: 'artifactEncodingUtf16Be',
  [DelimitedTextEncoding.Big5]: 'artifactEncodingBig5',
};

interface DelimitedTextPreviewProps {
  data: ArrayBuffer;
  fileName: string;
  fileKey: string;
}

export const DelimitedTextPreview: React.FC<DelimitedTextPreviewProps> = ({ data, fileName, fileKey }) => {
  const [encoding, setEncoding] = useState(() => getDelimitedTextEncoding(fileKey));
  const result = useMemo(() => decodeDelimitedText(new Uint8Array(data), encoding), [data, encoding]);
  const fallback = result.ok && result.decoded.source === DelimitedTextEncodingSource.Fallback;
  const status = result.ok
    ? t(fallback ? 'artifactEncodingFallback' : 'artifactEncodingUsing')
      .replace('{encoding}', t(ENCODING_LABELS[result.decoded.encoding]))
    : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white text-[#383a42]">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#e0e0e0] px-3 py-2 text-xs">
        <label className="flex items-center gap-2">
          <span>{t('artifactEncoding')}</span>
          <select
            value={encoding}
            title={t('artifactEncodingPreviewOnly')}
            className="max-w-full rounded border border-[#d0d0d0] bg-white px-2 py-1 text-[#383a42] focus:outline-none focus:ring-1 focus:ring-[#217346]"
            onChange={event => {
              const next = event.target.value as DelimitedTextEncoding;
              rememberDelimitedTextEncoding(fileKey, next);
              setEncoding(next);
            }}
          >
            {Object.values(DelimitedTextEncoding).map(value => (
              <option key={value} value={value}>{t(ENCODING_LABELS[value])}</option>
            ))}
          </select>
        </label>
        {status && <span role="status" className={fallback ? 'text-[#946200]' : 'text-[#666]'}>{status}</span>}
        <span className="text-[#777]">{t('artifactEncodingPreviewOnly')}</span>
      </div>
      <div className="min-h-0 flex-1">
        {result.ok ? (
          <SheetFallbackRenderer data={result.decoded.text} fileName={fileName} />
        ) : (
          <div role="alert" className="flex h-full items-center justify-center p-4 text-sm text-red-600">
            {t(result.error === DelimitedTextEncodingError.UnsupportedBom ? 'artifactEncodingUnsupported' : 'artifactEncodingInvalid')}
          </div>
        )}
      </div>
    </div>
  );
};
