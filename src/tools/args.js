// Argument coercion for tool handlers. Each helper returns the clean value or
// throws ArgError, whose message names the parameter, what was received and
// what is allowed. "Missing" means undefined, null or a blank string.

import { DEFAULT_ALLOW_HOSTS, isAllowedUrl } from './http.js';

export class ArgError extends Error {
  /**
   * @param {string} param    parameter name, e.g. 'chapter'
   * @param {*} received      the raw value the caller sent
   * @param {string} allowed  what is accepted, e.g. 'an integer from 1 to 150'
   * hint defaults to "Fix/Add "param" and call again.", so every error has a Next step line.
   */
  constructor(param, received, allowed, { hint, message } = {}) {
    const absent = received === undefined || received === null;
    super(
      message ??
        (absent
          ? `Missing required "${param}": expected ${allowed}.`
          : `Invalid "${param}": expected ${allowed}, got ${describeValue(received)}.`)
    );
    this.name = 'ArgError';
    this.param = param;
    this.received = received;
    this.allowed = allowed;
    this.hint = hint ?? `${absent ? 'Add' : 'Fix'} "${param}" and call again.`;
  }
}

export function describeValue(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // Too deep for JSON; String() on a nested array recurses too.
    text = typeof value === 'object' ? '(too deeply nested to show)' : String(value);
  }
  text = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  if (typeof value !== 'object') return text;
  return `${Array.isArray(value) ? 'array' : typeof value} ${text}`;
}

export function isMissing(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

// Resolves a missing value: default, then undefined if optional, else throws.
function missing(name, allowed, { optional, default: def }) {
  if (def !== undefined) return def;
  if (optional) return undefined;
  throw new ArgError(name, undefined, allowed);
}

/** MCP clients may omit `arguments` or send null; treat both as {}. */
export function requireArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ArgError('arguments', args, 'an object of named parameters');
  }
  return args;
}

const NUMERIC = /^[+-]?\d+(\.\d+)?$/;

function intRangeText(min, max) {
  if (min !== undefined && max !== undefined) return `an integer from ${min} to ${max}`;
  if (min !== undefined) return `an integer of at least ${min}`;
  if (max !== undefined) return `an integer no greater than ${max}`;
  return 'an integer';
}

/** Integer from a number or numeric string ("16", " 16 ", "16.0"). */
export function toInt(value, name, { min, max, optional = false, default: def } = {}) {
  const allowed = intRangeText(min, max);
  if (isMissing(value)) return missing(name, allowed, { optional, default: def });
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && NUMERIC.test(value.trim())) n = Number(value.trim());
  if (!Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new ArgError(name, value, allowed);
  }
  return n;
}

/** One of `allowed` (case-insensitive by default); returns the canonical spelling. */
export function toEnum(value, name, allowed, { optional = false, default: def, caseInsensitive = true } = {}) {
  const allowedText = `one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`;
  if (isMissing(value)) return missing(name, allowedText, { optional, default: def });
  const s = typeof value === 'string' ? value.trim() : value;
  const match = allowed.find((a) =>
    caseInsensitive && typeof a === 'string' && typeof s === 'string' ? a.toLowerCase() === s.toLowerCase() : a === s
  );
  if (match === undefined) throw new ArgError(name, value, allowedText);
  return match;
}

/** Trimmed string; numbers are accepted and converted. */
export function toStr(value, name, { optional = false, default: def, maxLength = 2000, pattern, patternText } = {}) {
  const allowed = patternText ?? `a text value of at most ${maxLength} characters`;
  if (isMissing(value)) return missing(name, allowed, { optional, default: def });
  if (typeof value !== 'string' && typeof value !== 'number') throw new ArgError(name, value, allowed);
  const s = String(value).trim();
  if (s.length > maxLength || (pattern && !pattern.test(s))) throw new ArgError(name, value, allowed);
  return s;
}

const TRUE_WORDS = new Set(['true', 'yes', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'no', '0', 'off']);

export function toBool(value, name, { optional = false, default: def } = {}) {
  const allowed = 'true or false';
  if (isMissing(value)) return missing(name, allowed, { optional, default: def });
  if (typeof value === 'boolean') return value;
  const s = typeof value === 'string' || typeof value === 'number' ? String(value).trim().toLowerCase() : '';
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  throw new ArgError(name, value, allowed);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const DATE_TEXT = 'a date as YYYY-MM-DD';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The model often has a relative date ("next week"); give it the server's today to count from.
function dateError(name, received, today) {
  const weekOn = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  return new ArgError(name, received, DATE_TEXT, {
    hint: `Today on this server is ${WEEKDAYS[today.getDay()]} ${formatIsoDate(today)}; count from that (a week from today is ${formatIsoDate(weekOn)}), or leave "${name}" out for today.`
  });
}

/**
 * Local Date at midnight. Accepts 'YYYY-MM-DD' (a trailing time is ignored),
 * 'today', or a Date. Missing means today in the server's local time zone.
 * `now` is injectable for tests.
 */
export function toIsoDate(value, name = 'date', { now = new Date() } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (isMissing(value) || (typeof value === 'string' && value.trim().toLowerCase() === 'today')) return today;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw dateError(name, 'Invalid Date', today);
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = typeof value === 'string' ? ISO_DATE.exec(value.trim()) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(y, mo - 1, d);
    if (y >= 1900 && y <= 2199 && date.getMonth() === mo - 1 && date.getDate() === d) return date;
  }
  throw dateError(name, value, today);
}

/** 'YYYY-MM-DD' for a Date, in local time. */
export function formatIsoDate(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

const URL_TEXT = 'an https link on wol.jw.org, www.jw.org, jw.org or *.jw-cdn.org';
const MAX_URL_LENGTH = 2000;

// error.tooLong lets callers that reword URL errors keep this reason.
function urlTooLong(name, value) {
  const error = new ArgError(name, value, URL_TEXT, {
    message: `Invalid "${name}": links are at most ${MAX_URL_LENGTH} characters, got ${value.length}.`,
    hint: 'Pass the link exactly as JW.org or this server\'s links tools give it.'
  });
  error.tooLong = true;
  return error;
}

/**
 * A JW.org URL string, at most 2000 characters. Adds https:// when the scheme
 * is missing and upgrades http://.
 */
export function toJwUrl(value, name = 'url', { optional = false, allowHosts = DEFAULT_ALLOW_HOSTS } = {}) {
  if (isMissing(value)) return missing(name, URL_TEXT, { optional });
  if (typeof value !== 'string') throw new ArgError(name, value, URL_TEXT);
  if (value.length > MAX_URL_LENGTH) throw urlTooLong(name, value);
  let s = value.trim();
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new ArgError(name, value, URL_TEXT);
  }
  if (!isAllowedUrl(url, allowHosts)) throw new ArgError(name, value, URL_TEXT);
  if (url.href.length > MAX_URL_LENGTH) throw urlTooLong(name, value); // percent-encoding can lengthen it
  return url.href;
}
