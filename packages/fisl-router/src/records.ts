// FISL location records (https://dasl.ing/fisl.html), read from a `jsonl`
// answer. The answer is untrusted, so it is read tolerantly and with a
// bound: a malformed line, a lapsed record or addr, or a URL that is not
// absolute http(s) is skipped. A record keeps every field as sent, for the
// routers that read an index's own extensions.

export interface FislRecord {
  /** The record's live addrs, in record order. */
  urls: string[];
  /** The record as sent, extension fields included. */
  fields: Record<string, unknown>;
}

export const MAX_ANSWER_BYTES = 8 * 2 ** 20;

// Reads the records line by line, as FISL asks of clients, and stops at the
// byte bound, dropping the line it cuts.
export async function readRecords(res: Response, now = Date.now()): Promise<FislRecord[]> {
  if (res.body === null) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out: FislRecord[] = [];
  const take = (line: string) => {
    const record = parseRecord(line, now);
    if (record !== null) out.push(record);
  };
  let pending = '';
  let room = MAX_ANSWER_BYTES;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const cut = value.length > room;
    // Split only the new text: a long line arriving in small chunks stays linear.
    const lines = decoder.decode(cut ? value.subarray(0, room) : value, { stream: true }).split('\n');
    const last = lines.pop()!;
    if (lines.length > 0) {
      lines[0] = pending + lines[0];
      lines.forEach(take);
      pending = '';
    }
    pending += last;
    if (cut) {
      await reader.cancel();
      return out;
    }
    room -= value.length;
  }
  take(pending + decoder.decode());
  return out;
}

function parseRecord(line: string, now: number): FislRecord | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(record) || !Array.isArray(record.addrs) || expired(record.expires, now)) return null;
  const urls = record.addrs.flatMap((addr) => (isObject(addr) && !expired(addr.expires, now) && isHttp(addr.url) ? [addr.url] : []));
  return urls.length ? { urls, fields: record } : null;
}

// An absent expiry never lapses; one that is not a date is treated as lapsed.
function expired(value: unknown, now: number): boolean {
  if (value === undefined) return false;
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return !(at > now);
}

function isHttp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
