/**
 * RTF to plain text for the workbook and Watchtower tools.
 *
 * Output is the document's own text and nothing else: one line per RTF
 * paragraph, no rewrites and no inserted words, in any language. The only
 * layout added is a blank line before headings (paragraphs in a Title or
 * Heading style, or with an outline level) and one blank line wherever the
 * source has empty paragraphs.
 */

import { ToolError } from './results.js';

// Groups whose text is never shown. fldinst, listtext and pntext are read
// separately (link targets, list numbers).
const DESTINATIONS = new Set([
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'atnauthor', 'atndate', 'atnicn', 'atnid',
  'atnparent', 'atnref', 'atntime', 'atrfend', 'atrfstart', 'author', 'background',
  'bkmkend', 'bkmkstart', 'blipuid', 'buptim', 'category', 'colorschememapping',
  'colortbl', 'comment', 'company', 'creatim', 'datafield', 'datastore', 'defchp', 'defpap',
  'do', 'doccomm', 'docvar', 'dptxbxtext', 'ebcend', 'ebcstart', 'factoidname', 'falt',
  'fchars', 'ffdeftext', 'ffentrymcr', 'ffexitmcr', 'ffformat', 'ffhelptext', 'ffl',
  'ffname', 'ffstattext', 'file', 'filetbl', 'fldtype', 'fonttbl',
  'fname', 'fontemb', 'fontfile', 'footer', 'footerf', 'footerl', 'footerr',
  'footnote', 'formfield', 'ftncn', 'ftnsep', 'ftnsepc', 'g', 'generator', 'gridtbl',
  'header', 'headerf', 'headerl', 'headerr', 'hl', 'hlfr', 'hlinkbase', 'hlloc', 'hlsrc',
  'hsv', 'htmltag', 'info', 'keycode', 'keywords', 'latentstyles', 'lchars', 'levelnumbers',
  'leveltext', 'lfolevel', 'linkval', 'list', 'listlevel', 'listname', 'listoverride',
  'listoverridetable', 'listpicture', 'liststylename', 'listtable',
  'lsdlockedexcept', 'macc', 'maccPr', 'mailmerge', 'maln', 'malnScr', 'manager', 'margPr',
  'mbar', 'mbarPr', 'mbaseJc', 'mbegChr', 'mborderBox', 'mborderBoxPr', 'mbox', 'mboxPr',
  'mchr', 'mcount', 'mctrlPr', 'md', 'mdeg', 'mdegHide', 'mden', 'mdiff', 'mdPr', 'me',
  'mendChr', 'meqArr', 'meqArrPr', 'mf', 'mfName', 'mfPr', 'mfunc', 'mfuncPr', 'mgroupChr',
  'mgroupChrPr', 'mgrow', 'mhideBot', 'mhideLeft', 'mhideRight', 'mhideTop', 'mhtmltag',
  'mlim', 'mlimloc', 'mlimlow', 'mlimlowPr', 'mlimupp', 'mlimuppPr', 'mm', 'mmaddfieldname',
  'mmath', 'mmathPict', 'mmathPr', 'mmaxdist', 'mmc', 'mmcJc', 'mmconnectstr',
  'mmconnectstrdata', 'mmcPr', 'mmcs', 'mmdatasource', 'mmheadersource', 'mmmailsubject',
  'mmodso', 'mmodsofilter', 'mmodsofldmpdata', 'mmodsomappedname', 'mmodsoname',
  'mmodsorecipdata', 'mmodsosort', 'mmodsosrc', 'mmodsotable', 'mmodsoudl',
  'mmodsoudldata', 'mmodsouniquetag', 'mmPr', 'mmquery', 'mmr', 'mnary', 'mnaryPr',
  'mnoBreak', 'mnum', 'mobjDist', 'moMath', 'moMathPara', 'moMathParaPr', 'mopEmu',
  'mphant', 'mphantPr', 'mplcHide', 'mpos', 'mr', 'mrad', 'mradPr', 'mrPr', 'msepChr',
  'mshow', 'mshp', 'msPre', 'msPrePr', 'msSub', 'msSubPr', 'msSubSup', 'msSubSupPr', 'msSup',
  'msSupPr', 'mstrikeBLTR', 'mstrikeH', 'mstrikeTLBR', 'mstrikeV', 'msub', 'msubHide',
  'msup', 'msupHide', 'mtransp', 'mtype', 'mvertJc', 'mvfmf', 'mvfml', 'mvtof', 'mvtol',
  'mzeroAsc', 'mzeroDesc', 'mzeroWid', 'nesttableprops', 'nextfile', 'nonesttables',
  'nonshppict', 'objalias', 'objclass', 'objdata', 'object', 'objname', 'objsect', 'objtime',
  'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'oleclsid', 'operator', 'panose',
  'password', 'passwordhash', 'pgp', 'pgptbl', 'picprop', 'pict', 'pn', 'pnseclvl',
  'pntxta', 'pntxtb', 'printim', 'private', 'propname', 'protend', 'protstart', 'protusertbl',
  'pxe', 'result', 'revtbl', 'revtim', 'rsidtbl', 'rxe', 'shp', 'shpgrp', 'shpinst',
  'shppict', 'shprslt', 'shptxt', 'sn', 'sp', 'staticval', 'stylesheet', 'subject', 'sv',
  'svb', 'tc', 'template', 'themedata', 'title', 'txe', 'ud', 'upr', 'userprops',
  'wgrffmtfilter', 'windowcaption', 'writereservation', 'writereservhash', 'xe', 'xform',
  'xmlattrname', 'xmlattrvalue', 'xmlclose', 'xmlname', 'xmlnstbl', 'xmlopen',
]);

// \fcharset -> Windows code page. 0, 1 and 2 (ANSI, default, symbol) use \ansicpg.
const CHARSET_CODEPAGES = {
  77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};

// Windows code page -> TextDecoder label.
const CODEPAGE_LABELS = {
  866: 'ibm866', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
  1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257',
  1258: 'windows-1258', 10000: 'macintosh', 20866: 'koi8-r', 21866: 'koi8-u', 65001: 'utf-8',
};

const SYMBOLS = {
  tab: '\t', emdash: '\u2014', endash: '\u2013', emspace: ' ', enspace: ' ', qmspace: ' ',
  bullet: '\u2022', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201C', rdblquote: '\u201D',
  zwj: '\u200D', zwnj: '\u200C', zwbo: '\u200B',
  // JW.org exports keep the print layout's manual wraps as \line, mid-sentence.
  line: ' ',
};

// Bullet glyphs from symbol fonts (JW's review-question bullet, Symbol, Wingdings).
// Other private-use characters pass through: some fonts use them for letters.
const PUA_BULLETS = new Set([0xF40A, 0xF0B7, 0xF0A7]);

const CELL = '\u001F';
const HEADING_STYLE = /^(title|subtitle|heading\s*\d+)$/i;
const FORM_FIELD = /^\s*FORM(TEXT|CHECKBOX|DROPDOWN)\b/i;
const HYPERLINK = /^\s*HYPERLINK\s+(?:"([^"]*)"|([^\s"\\]+))/i;
const BIBLE_LINK = /[?&]bible=|\/wol\/b\//i;
const NOT_RTF_HINT = 'Use an RTF file URL from getWorkbookLinks or getWatchtowerLinks.';
// JW exports never nest fields; the cap keeps out() linear on files that do.
const MAX_FIELD_DEPTH = 4;

const TOKEN = /\\([a-zA-Z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-fA-F]{2})|\\([^a-zA-Z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/g;

// Node 22's TextDecoder('windows-1252') decodes as Latin-1, so 0x80-0x9F
// (curly quotes, dashes, ellipsis) are mapped here.
const CP1252_HIGH = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F'
  + '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';
const cp1252 = {
  decode: (bytes) => Array.from(bytes, (b) => (b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join(''),
};

const decoders = new Map([['windows-1252', cp1252]]);
function decoderFor(codepage, fallbackLabel) {
  const label = CODEPAGE_LABELS[codepage] || fallbackLabel || 'windows-1252';
  if (!decoders.has(label)) {
    let decoder = cp1252;
    try {
      const native = new TextDecoder(label);
      if (native.encoding !== 'windows-1252') decoder = native;
    } catch {
      // Unknown label: keep cp1252.
    }
    decoders.set(label, decoder);
  }
  return decoders.get(label);
}

function unicodeChar(code) {
  if (code < 0) code += 0x10000;
  if (PUA_BULLETS.has(code)) return '\u2022';
  if (code === 9 || code === 10 || code === 13) return ' ';
  if (code < 32 || code > 0x10FFFF) return '';
  // Values up to 0xFFFF may be surrogate halves; two \u escapes make one pair.
  return code <= 0xFFFF ? String.fromCharCode(code) : String.fromCodePoint(code);
}

/** Accept a string or the raw bytes; bytes keep \bin lengths and 8-bit text exact. */
function readInput(rtf) {
  let src;
  let bytesMode = false;
  if (typeof rtf === 'string') {
    src = rtf.replace(/^\uFEFF/, '');
  } else if (rtf instanceof Uint8Array || rtf instanceof ArrayBuffer) {
    let bytes = rtf instanceof ArrayBuffer ? new Uint8Array(rtf) : rtf;
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) bytes = bytes.subarray(3);
    src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    bytesMode = true;
  } else {
    throw new ToolError('RTF content must be a non-empty string or Buffer.', NOT_RTF_HINT);
  }
  const head = src.trimStart();
  if (!head) {
    throw new ToolError('The RTF file is empty.', NOT_RTF_HINT);
  }
  if (!head.startsWith('{\\rtf')) {
    const what = /^<(!doctype|html|\?xml)/i.test(head) ? 'an HTML or XML page' : `text starting "${head.slice(0, 20)}"`;
    throw new ToolError(`Invalid RTF format: expected a file starting with {\\rtf, got ${what}.`, NOT_RTF_HINT);
  }
  return { src, bytesMode };
}

/**
 * Tokenize RTF into paragraphs, the style sheet, hyperlink fields and the
 * document title. Group state (destination, hidden text, font, paragraph
 * style, field) is saved on '{' and restored on '}', as RTF specifies.
 */
function readRtf(src, { bytesMode = false, encoding = 'windows-1252' } = {}) {
  const paragraphs = [];
  const styles = new Map();
  const fonts = new Map();
  const links = [];
  const stack = [];
  let title = null;
  let codepage = null;
  let defaultFont = null;
  let line = '';
  let emitted = 0;
  let curskip = 0;
  let bytes = [];
  let st = {
    ucskip: 1, ignorable: false, hidden: false, dest: null, info: false,
    font: null, style: 0, outline: null, fontDef: null, styleDef: null,
    field: null, result: null, ownsField: false,
  };

  const visible = () => !st.ignorable && !st.hidden && !st.dest;

  function out(text) {
    if (!text) return;
    switch (st.dest) {
      case 'fldinst': st.field.inst += text; return;
      case 'title': title += text; return;
      case 'stylesheet': if (st.styleDef) st.styleDef.name += text; return;
      case 'fonttbl': return;
    }
    if (st.ignorable || st.hidden) return;
    line += text;
    emitted += text.length;
    for (let f = st.result; f; f = f.outer) f.text += text;
  }

  function flushBytes() {
    if (!bytes.length) return;
    const codepageOfFont = fonts.get(st.font) ?? codepage;
    const text = decoderFor(codepageOfFont, encoding).decode(Uint8Array.from(bytes));
    bytes = [];
    out(text);
  }

  function endParagraph(row = false) {
    paragraphs.push({ text: line, style: st.style, outline: st.outline, row });
    line = '';
    emitted++;
  }

  function finishField(field) {
    const m = HYPERLINK.exec(field.inst);
    const url = m && (m[1] ?? m[2]).trim();
    if (!url) return;
    const prev = links[links.length - 1];
    // Exporters split one link into several fields ("th " + "study 11").
    if (prev && prev.url === url && prev.end === field.start) {
      prev.text += field.text;
      prev.end = emitted;
    } else {
      links.push({ url, text: field.text, end: emitted });
    }
  }

  function controlWord(word, arg) {
    const n = arg === undefined ? null : Number(arg);
    switch (word) {
      case 'u':
        if (n !== null) {
          out(unicodeChar(n));
          curskip = st.ucskip;
        }
        return;
      case 'uc': st.ucskip = n ?? 1; return;
      case 'ansicpg': codepage = n; return;
      case 'deff':
        defaultFont = n;
        if (st.font === null) st.font = n;
        return;
      case 'f':
        if (st.dest === 'fonttbl') st.fontDef = n;
        else st.font = n;
        return;
      case 'fcharset':
        if (st.fontDef !== null) fonts.set(st.fontDef, CHARSET_CODEPAGES[n] ?? null);
        return;
      case 'cpg':
        if (st.fontDef !== null) fonts.set(st.fontDef, n);
        return;
      case 'fonttbl':
      case 'stylesheet':
        st.dest = word;
        return;
      case 's':
        if (st.dest === 'stylesheet') {
          st.styleDef = { name: '', outline: null };
          styles.set(n ?? 0, st.styleDef);
        } else {
          st.style = n ?? 0;
        }
        return;
      case 'cs': case 'ds': case 'ts':
        // Character, section and table styles have their own numbering.
        if (st.dest === 'stylesheet') st.styleDef = { name: '', outline: null };
        return;
      case 'outlinelevel':
        if (st.dest === 'stylesheet') {
          if (st.styleDef) st.styleDef.outline = n;
        } else {
          st.outline = n;
        }
        return;
      case 'pard':
        st.style = 0;
        st.outline = null;
        return;
      case 'plain':
        st.hidden = false;
        st.font = defaultFont;
        return;
      case 'v': st.hidden = n !== 0; return;
      case 'info':
        st.info = true;
        st.ignorable = true;
        st.dest = null;
        return;
      case 'title':
        if (st.info) {
          st.dest = 'title';
          title = '';
        } else {
          st.ignorable = true;
          st.dest = null;
        }
        return;
      case 'field': {
        if (!visible()) return;
        const depth = (st.result?.depth ?? 0) + 1;
        if (depth > MAX_FIELD_DEPTH) {
          // Too deep: drop the instruction, show the result as plain text.
          st.field = null;
          return;
        }
        st.field = { inst: '', text: '', outer: st.result, start: emitted, depth };
        st.ownsField = true;
        return;
      }
      case 'fldinst':
        if (st.field) {
          st.dest = 'fldinst';
          st.ignorable = false;
        } else {
          st.ignorable = true;
          st.dest = null;
        }
        return;
      case 'fldrslt':
        if (!st.field) return;
        st.ignorable = false;
        // Form fields show placeholder blanks, not document text.
        if (FORM_FIELD.test(st.field.inst)) st.ignorable = true;
        else st.result = st.field;
        return;
      case 'par':
        if (visible()) endParagraph();
        return;
      case 'row':
      case 'nestrow':
        if (visible()) endParagraph(true);
        return;
      case 'sect':
      case 'page':
        if (visible()) {
          endParagraph();
          endParagraph();
        }
        return;
      case 'cell':
      case 'nestcell':
        if (visible()) line += CELL;
        return;
    }
    if (DESTINATIONS.has(word)) {
      st.ignorable = true;
      st.dest = null;
    } else if (Object.hasOwn(SYMBOLS, word)) {
      out(SYMBOLS[word]);
    }
  }

  function controlSymbol(char) {
    switch (char) {
      case '*':
        st.ignorable = true;
        st.dest = null;
        return;
      case '\\': case '{': case '}': out(char); return;
      case '~': out('\u00A0'); return;
      case '_': out('-'); return;
      case '\n': case '\r':
        if (visible()) endParagraph();
        return;
    }
    // \- (optional hyphen) and anything unknown print nothing.
  }

  function textRun(run) {
    if (curskip > 0) {
      const skip = Math.min(curskip, run.length);
      run = run.slice(skip);
      curskip -= skip;
    }
    if (!run) return;
    if (!bytesMode || !/[\x80-\xFF]/.test(run)) {
      flushBytes();
      out(run);
      return;
    }
    for (const part of run.match(/[\x00-\x7F]+|[\x80-\xFF]+/g)) {
      if (part.charCodeAt(0) < 0x80) {
        flushBytes();
        out(part);
      } else {
        for (let i = 0; i < part.length; i++) bytes.push(part.charCodeAt(i));
      }
    }
  }

  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(src)) !== null) {
    const [, word, arg, hex, symbol, brace, run] = match;
    if (hex !== undefined) {
      if (curskip > 0) curskip--;
      else bytes.push(parseInt(hex, 16));
      continue;
    }
    if (run !== undefined) {
      textRun(run);
      continue;
    }
    if (word === undefined && symbol === undefined && brace === undefined) continue; // raw newline
    flushBytes();
    curskip = 0;
    if (brace === '{') {
      stack.push(st);
      st = { ...st, ownsField: false };
    } else if (brace === '}') {
      if (st.ownsField) finishField(st.field);
      // Text after the document's closing brace is not part of it.
      st = stack.length > 1 ? stack.pop() : { ...(stack.pop() ?? st), ignorable: true, dest: null };
    } else if (word === 'bin') {
      if (arg !== undefined) TOKEN.lastIndex += Math.max(0, Number(arg));
    } else if (word !== undefined) {
      controlWord(word, arg);
    } else {
      controlSymbol(symbol);
    }
  }
  flushBytes();
  if (line) endParagraph();

  return { paragraphs, styles, links, title };
}

function isHeading(paragraph, styles) {
  if (paragraph.outline !== null && paragraph.outline < 9) return true;
  const def = styles.get(paragraph.style);
  if (!def) return false;
  return HEADING_STYLE.test(def.name.split(';')[0].trim()) || (def.outline !== null && def.outline < 9);
}

function cellsToText(raw) {
  if (!raw.includes(CELL)) return raw;
  const row = raw.replace(/\u001F[^\S\n]*$/, '').replace(/[^\S\n]*\u001F[^\S\n]*/g, ' | ');
  return /^[\s|]*$/.test(row) ? '' : row;
}

function cleanUrl(url) {
  if (!/[?&]srcid=/.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('srcid');
    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Whitespace and invisible-character cleanup only; never changes words.
 * Strips control characters, soft hyphens and BOMs, turns any run of spaces,
 * tabs or no-break spaces into one space, trims lines and keeps at most one
 * blank line in a row.
 */
export function cleanAndFormatText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u00AD\uFEFF]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Raw text of the RTF: one line per paragraph, empty paragraphs kept,
 * whitespace untouched, table cells joined with ' | '. `encoding` is the
 * fallback for \'xx bytes when the file declares no \ansicpg.
 */
export function rtfToText(rtf, encoding = 'windows-1252') {
  const { src, bytesMode } = readInput(rtf);
  return readRtf(src, { bytesMode, encoding }).paragraphs.map((p) => cellsToText(p.text)).join('\n');
}

/**
 * Parse RTF into text plus metadata.
 * @param {string|Buffer|Uint8Array} rtf The RTF file; pass the bytes when you have them.
 * @param {{bibleLinks?: boolean}} [options] bibleLinks: also list links to Bible
 *   verses (their reference is already in the text, so they are left out by default).
 * @returns {{text: string, title: string|null, headings: string[], links: {text: string, url: string}[]}}
 *   links are de-duplicated by URL, in document order.
 * @throws {ToolError} when the input is not RTF or has no readable text.
 */
export function parseRTFDocument(rtf, options = {}) {
  const { bibleLinks = false } = options ?? {};
  const { src, bytesMode } = readInput(rtf);
  const doc = readRtf(src, { bytesMode });

  const lines = [];
  const headings = [];
  let blank = false;
  let prevHeading = false;
  for (const paragraph of doc.paragraphs) {
    const text = cleanAndFormatText(cellsToText(paragraph.text));
    if (!text) {
      // An empty table row is not a paragraph break.
      if (!paragraph.row) blank = lines.length > 0;
      continue;
    }
    const heading = isHeading(paragraph, doc.styles);
    // A heading starts a block; a run of headings (section + part title) stays together.
    if (lines.length && (blank || (heading && !prevHeading))) lines.push('');
    lines.push(text);
    if (heading) headings.push(text);
    blank = false;
    prevHeading = heading;
  }

  const text = lines.join('\n');
  if (!text) {
    throw new ToolError(
      'The RTF file contains no readable text.',
      'The file may be damaged or not a publication article. Fetch the links again and pick another file.'
    );
  }

  const seen = new Set();
  const links = [];
  for (const link of doc.links) {
    const url = cleanUrl(link.url);
    const linkText = cleanAndFormatText(link.text);
    if (!linkText || seen.has(url) || (!bibleLinks && BIBLE_LINK.test(url))) continue;
    seen.add(url);
    links.push({ text: linkText, url });
  }

  return {
    text,
    title: doc.title === null ? null : cleanAndFormatText(doc.title) || null,
    headings,
    links,
  };
}

/**
 * Parse RTF and return formatted plain text.
 * @param {string|Buffer|Uint8Array} rtfContent RTF content
 * @returns {string} Plain text, one line per paragraph
 * @throws {ToolError} when the input is not RTF or has no readable text
 */
export function parseRTF(rtfContent) {
  return parseRTFDocument(rtfContent).text;
}
