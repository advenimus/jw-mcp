// MCP tool result builders and wrapTool(), which turns every thrown error
// into an isError result the calling model can act on.

import { ArgError } from './args.js';
import { JwFetchError } from './http.js';

/** A caller-facing failure that is not about one argument, e.g. "Genesis has 50 chapters". */
export class ToolError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }
}

export function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

/** The JSON text of a result. Compact: indentation would cost the model 15-20% more tokens. */
export function jsonText(value) {
  return JSON.stringify(value);
}

export function jsonResult(value) {
  return textResult(jsonText(value));
}

export function errorResult(message, hint) {
  return {
    content: [{ type: 'text', text: hint ? `${message}\nNext step: ${hint}` : String(message) }],
    isError: true
  };
}

// ---------------------------------------------------------------------------
// Result size. Claude Code refuses MCP results over 25K tokens
// (MAX_MCP_OUTPUT_TOKENS). JW output runs 1.1 to 3.5 characters a token
// (Japanese and Chinese, URLs and citations, English prose), so results are
// budgeted by estimated tokens, not characters.

/** Most estimated tokens in one result. */
export const MAX_RESULT_TOKENS = 22000;
/** Most estimated tokens of text on one page of a paged result, leaving room for its metadata. */
export const PAGE_TOKENS = 20000;

// A JSON escape, a run of ASCII letters, a run of whitespace, or one other character.
const PIECE = /\\[nt"\\]|[A-Za-z]+|\s+|[^\sA-Za-z]/gu;
const WIDE_MARK = /[\p{P}\p{S}\p{M}\u02b9]/u;

// Measured at 0.98-1.22x real Claude tokens on English, Japanese and link-heavy WOL output.
function pieceTokens(s, raw) {
  const c = s.charCodeAt(0);
  if (s.length === 2 && c === 92 && !raw) return 2; // \n, \" ... in JSON text
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return Math.ceil(s.length / 4);
  // Raw text is about to be JSON-escaped: a line break or quote becomes a two-character escape.
  if (/^\s/.test(s)) return 0.5 + (raw ? 2 * (s.match(/[\n\r\t]/g)?.length ?? 0) : 0);
  if (raw && (c === 34 || c === 92)) return 2;
  if (c > 127 && WIDE_MARK.test(s)) return 2; // curly quotes, dashes, stress marks
  return 1; // digits, ASCII punctuation, CJK and other letters
}

/** Rough Claude token count of a result's text (JSON or plain). */
export function estimateTokens(text) {
  let n = 0;
  for (const [s] of String(text).matchAll(PIECE)) n += pieceTokens(s, false);
  return Math.ceil(n);
}

/**
 * How many characters of text, from offset, fit in maxTokens estimated tokens
 * (at most maxChars). The text is counted as it will look JSON-escaped.
 */
export function charsWithinTokens(text, offset, maxTokens, maxChars = Infinity) {
  const s = text.slice(offset, Math.min(text.length, offset + maxChars));
  let n = 0;
  for (const m of s.matchAll(PIECE)) {
    const piece = m[0];
    const cost = pieceTokens(piece, true);
    if (n + cost > maxTokens) {
      // A long run of letters is cut inside, so even one huge word makes progress.
      const inside = /^[A-Za-z]/.test(piece) ? Math.floor((maxTokens - n) * 4) : 0;
      return Math.max(1, m.index + inside);
    }
    n += cost;
  }
  return s.length;
}

/**
 * Slice text at a paragraph break (else a line break) in the second half of
 * [offset, offset + maxChars). next_offset skips the break; it is null at the
 * end. Throws ArgError for an offset past the end.
 */
export function pageText(text, offset, maxChars) {
  if (offset > 0 && offset >= text.length) {
    throw new ArgError('offset', offset, `a number below ${text.length} (the text has ${text.length} characters)`, {
      hint: 'Start again at offset 0, or use the next_offset from the previous call.'
    });
  }
  let end = Math.min(text.length, offset + maxChars);
  if (end < text.length) {
    const floor = offset + maxChars / 2;
    let cut = text.lastIndexOf('\n\n', end);
    if (cut <= floor) cut = text.lastIndexOf('\n', end - 1);
    if (cut > floor) end = cut;
    else if (/[\ud800-\udbff]/.test(text[end - 1])) end -= 1; // never split a surrogate pair
    while (end > offset + 1 && text[end - 1] === '\n') end--;
  }
  let next = end;
  while (text[next] === '\n') next++;
  return { text: text.slice(offset, end), next_offset: next < text.length ? next : null };
}

/** pageText with the page also kept within PAGE_TOKENS estimated tokens. */
export function pageByTokens(text, offset, maxChars, maxTokens = PAGE_TOKENS) {
  return pageText(text, offset, charsWithinTokens(text, offset, maxTokens, maxChars));
}

/** Convert any thrown value into an errorResult. */
export function errorToResult(error, toolName = 'tool') {
  if (error instanceof ArgError || error instanceof JwFetchError || error instanceof ToolError) {
    return errorResult(error.message, error.hint);
  }
  console.error(`[jw-mcp] ${toolName} failed unexpectedly:`, error);
  const detail = error instanceof Error ? error.message : String(error);
  return errorResult(
    `${toolName} failed unexpectedly: ${detail}`,
    'This is a bug in jw-mcp, not in your request. Try again or use another tool, and report it if it repeats.'
  );
}

/**
 * Wrap a tool implementation or handler so it never throws.
 * Return values: an MCP result (has a content array) passes through; null or
 * undefined passes through (a handler's "not my tool"); a string becomes a
 * text result; anything else becomes a compact JSON result.
 */
export function wrapTool(fn, name = fn.name || 'tool') {
  return async function wrappedTool(...args) {
    try {
      const result = await fn(...args);
      if (result === null || result === undefined) return result;
      if (typeof result === 'string') return textResult(result);
      if (Array.isArray(result.content)) return result;
      return jsonResult(result);
    } catch (error) {
      return errorToResult(error, name);
    }
  };
}
