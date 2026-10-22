const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parses an ISO-style date and time and returns it as a UTC ISO string.
 * Without an offset the value is the computer's local time, which matches how people speak
 * ("4pm" means 4pm here). Impossible dates such as 2026-02-30 are rejected, not rolled over.
 */
export function parseDateTime(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = DATE_TIME.exec(text);
  const hint = `${field} must look like 2026-10-15T16:00 (local time) or 2026-10-15T16:00:00-04:00`;
  if (!match) throw new Error(`${hint}; got ${JSON.stringify(value)}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${field} is not a real calendar date: ${text}`);
  }
  if (hour > 23 || minute > 59) throw new Error(`${field} has an invalid time: ${text}`);

  // Date.parse only accepts offsets written as +hh:mm, so add the colon when it is missing.
  const normalized = text.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new Error(`${hint}; got ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}
