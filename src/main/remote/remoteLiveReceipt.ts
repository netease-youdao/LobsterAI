const identityFields = ['sessionId', 'writerGeneration', 'objectKind', 'objectId', 'sourceObjectRevision'] as const;
const rejectedOptionalFields = new Set<string>(['objectKind', 'sourceObjectRevision']);
const invalid = (): never => { throw new Error('REMOTE_LIVE_RECEIPT_INVALID'); };
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

function decimal(value: unknown, positive: boolean): boolean {
  // Server versions are unsigned decimal strings within Java's signed long range.
  if (typeof value !== 'string' || !/^[0-9]{1,19}$/u.test(value)) return false;
  const number = BigInt(value);
  return number <= 9223372036854775807n && (!positive || number > 0n);
}

/** Validate before persisting an ACK or clearing recovery evidence; never rewrite the receipt. */
export function assertLiveReceipt(requestBody: Record<string, any>, result: any, strict = false): void {
  if (!record(requestBody) || !record(result) || !Object.hasOwn(result, 'publicationId')
    || typeof requestBody.publicationId !== 'string' || !requestBody.publicationId
    || result.publicationId !== requestBody.publicationId || !Object.hasOwn(result, 'state')
    || !['accepted', 'superseded', 'rejected'].includes(result.state)) invalid();
  const rejected = result.state === 'rejected';
  for (const field of identityFields) {
    if (!Object.hasOwn(result, field)) {
      // Existing deterministic rejections omit kind/source/projection revision.
      if (strict && !(rejected && rejectedOptionalFields.has(field))) invalid();
      continue;
    }
    if (typeof result[field] !== 'string' || !result[field] || result[field] !== requestBody[field]
      || field === 'sourceObjectRevision' && !decimal(result[field], true)) invalid();
  }
  for (const field of ['projectionRevision', 'committedSeq'] as const) {
    if (!Object.hasOwn(result, field)) {
      if (strict && !(rejected && field === 'projectionRevision')) invalid();
      continue;
    }
    if (!decimal(result[field], field === 'projectionRevision' && !rejected)) invalid();
  }
}
