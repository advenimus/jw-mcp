/**
 * RTF to Plain Text Parser
 * Ported from Python striprtf library
 * Based on n8n workflow RTF extractor
 */

// RTF destinations to ignore
const DESTINATIONS = new Set([
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'atnauthor', 'atndate', 'atnicn', 'atnid',
  'atnparent', 'atnref', 'atntime', 'atrfend', 'atrfstart', 'author', 'background',
  'bkmkend', 'bkmkstart', 'blipuid', 'buptim', 'category', 'colorschememapping',
  'colortbl', 'comment', 'company', 'creatim', 'datafield', 'datastore', 'defchp', 'defpap',
  'do', 'doccomm', 'docvar', 'dptxbxtext', 'ebcend', 'ebcstart', 'factoidname', 'falt',
  'fchars', 'ffdeftext', 'ffentrymcr', 'ffexitmcr', 'ffformat', 'ffhelptext', 'ffl',
  'ffname', 'ffstattext', 'file', 'filetbl', 'fldinst', 'fldtype', 'fonttbl',
  'fname', 'fontemb', 'fontfile', 'footer', 'footerf', 'footerl', 'footerr',
  'footnote', 'formfield', 'ftncn', 'ftnsep', 'ftnsepc', 'g', 'generator', 'gridtbl',
  'header', 'headerf', 'headerl', 'headerr', 'hl', 'hlfr', 'hlinkbase', 'hlloc', 'hlsrc',
  'hsv', 'htmltag', 'info', 'keycode', 'keywords', 'latentstyles', 'lchars', 'levelnumbers',
  'leveltext', 'lfolevel', 'linkval', 'list', 'listlevel', 'listname', 'listoverride',
  'listoverridetable', 'listpicture', 'liststylename', 'listtable', 'listtext',
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
  'objalias', 'objclass', 'objdata', 'object', 'objname', 'objsect', 'objtime', 'oldcprops',
  'oldpprops', 'oldsprops', 'oldtprops', 'oleclsid', 'operator', 'panose', 'password',
  'passwordhash', 'pgp', 'pgptbl', 'picprop', 'pict', 'pn', 'pnseclvl', 'pntext', 'pntxta',
  'pntxtb', 'printim', 'private', 'propname', 'protend', 'protstart', 'protusertbl', 'pxe',
  'result', 'revtbl', 'revtim', 'rsidtbl', 'rxe', 'shp', 'shpgrp', 'shpinst',
  'shppict', 'shprslt', 'shptxt', 'sn', 'sp', 'staticval', 'stylesheet', 'subject', 'sv',
  'svb', 'tc', 'template', 'themedata', 'title', 'txe', 'ud', 'upr', 'userprops',
  'wgrffmtfilter', 'windowcaption', 'writereservation', 'writereservhash', 'xe', 'xform',
  'xmlattrname', 'xmlattrvalue', 'xmlclose', 'xmlname', 'xmlnstbl', 'xmlopen',
]);

// Character set mappings
const CHARSET_MAP = {
  0: 'windows-1252', 42: 'windows-1252', 77: 'macintosh', 128: 'shift_jis', 129: 'cp949',
  134: 'gb2312', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 177: 'windows-1255',
  178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874',
  238: 'windows-1250', 254: 'cp437', 255: 'cp850',
};

// Section characters
const SECTION_CHARS = {
  'par': '\n',
  'sect': '\n\n',
  'page': '\n\n',
};

// Special characters
const SPECIAL_CHARS = {
  // JW.org exports keep the print layout's manual wraps as \line, mid-sentence.
  'line': ' ',
  'tab': '\t',
  'emdash': '\u2014',
  'endash': '\u2013',
  'emspace': ' ',
  'enspace': ' ',
  'qmspace': ' ',
  'bullet': '\u2022',
  'lquote': '\u2018',
  'rquote': '\u2019',
  'ldblquote': '\u201C',
  'rdblquote': '\u201D',
  'row': '\n',
  'cell': '|',
  'nestcell': '|',
  '~': ' ',
  '\n': '\n',
  '\r': '\r',
  '{': '{',
  '}': '}',
  '\\': '\\',
  '-': '\u00AD',
  '_': '\u2011',
  ...SECTION_CHARS,
};

// Main RTF pattern
const PATTERN = /\\([a-z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|(.)/gi;

// Hyperlink pattern
const HYPERLINKS = /(\{\\field\{\s*\\\*\\fldinst\{.*HYPERLINK\s(\".*\")\}{2}\s*\{.*?\s+(.*?)\}{2,3})/gi;

// Font table pattern
const FONTTABLE = /\\f(\d+).*?\\fcharset(\d+).*?([^;]+);/g;

/**
 * Remove picture groups from RTF to reduce size
 */
function removePictGroups(rtfText) {
  if (!rtfText.includes('\\pict') || !rtfText.includes('\\bin')) {
    return rtfText;
  }

  const result = [];
  let i = 0;
  const n = rtfText.length;
  let inPict = false;

  while (i < n) {
    if (!inPict && rtfText.substring(i, i + 5) === '\\pict') {
      inPict = true;
      i += 5;
      continue;
    }

    if (inPict) {
      if (rtfText.substring(i, i + 4) === '\\bin') {
        i += 4;
        let lengthStr = '';
        while (i < n && /\d/.test(rtfText[i])) {
          lengthStr += rtfText[i];
          i++;
        }
        if (lengthStr) {
          i += parseInt(lengthStr);
        }
        continue;
      } else if (rtfText[i] === '}') {
        inPict = false;
        i++;
        continue;
      }
    }

    if (!inPict) {
      result.push(rtfText[i]);
    }
    i++;
  }

  return result.join('');
}

/**
 * Convert RTF to plain text
 */
export function rtfToText(text, encoding = 'windows-1252') {
  // Remove picture groups
  text = removePictGroups(text);

  // Convert hyperlinks
  text = text.replace(HYPERLINKS, '$1($2)');

  const stack = [];
  const fonttbl = {};
  let defaultFont = null;
  let currentFont = null;
  let ignorable = false;
  let suppressOutput = false;
  let ucskip = 1;
  let curskip = 0;
  let out = '';

  // Parse font table
  let fontMatch;
  while ((fontMatch = FONTTABLE.exec(text)) !== null) {
    const [, fontId, fcharset, fontName] = fontMatch;
    fonttbl[fontId] = {
      name: fontName.trim(),
      charset: fcharset,
      encoding: CHARSET_MAP[parseInt(fcharset)] || encoding,
    };
  }

  // Reset regex
  PATTERN.lastIndex = 0;

  // Parse RTF
  let match;
  while ((match = PATTERN.exec(text)) !== null) {
    const [, word, arg, hex, char, brace, tchar] = match;

    if (brace) {
      curskip = 0;
      if (brace === '{') {
        stack.push([ucskip, ignorable, suppressOutput]);
      } else if (brace === '}') {
        if (stack.length > 0) {
          [ucskip, ignorable, suppressOutput] = stack.pop();
        } else {
          ucskip = 0;
          ignorable = true;
        }
      }
    } else if (char) {
      curskip = 0;
      if (SPECIAL_CHARS[char]) {
        if (SECTION_CHARS[char]) {
          currentFont = defaultFont;
        }
        if (!ignorable) {
          out += SPECIAL_CHARS[char];
        }
      } else if (char === '*') {
        ignorable = true;
      }
    } else if (word) {
      curskip = 0;
      if (DESTINATIONS.has(word)) {
        ignorable = true;
      } else if (word === 'ansicpg') {
        encoding = `cp${arg}`;
      }

      if (ignorable || suppressOutput) {
        // Skip
      } else if (SPECIAL_CHARS[word]) {
        out += SPECIAL_CHARS[word];
      } else if (word === 'uc') {
        ucskip = arg ? parseInt(arg) : 1;
      } else if (word === 'u') {
        if (arg === null || arg === undefined) {
          curskip = ucskip;
        } else {
          try {
            let c = parseInt(arg);
            if (c < 0) {
              c += 0x10000;
            }
            // Only add valid printable Unicode characters
            if ((c >= 32 && c < 0x110000) || [9, 10, 13].includes(c)) {
              out += String.fromCharCode(c);
            }
            curskip = ucskip;
          } catch (e) {
            curskip = ucskip;
          }
        }
      } else if (word === 'f') {
        currentFont = arg;
      } else if (word === 'deff') {
        defaultFont = arg;
      } else if (word === 'fonttbl') {
        suppressOutput = true;
      } else if (word === 'colortbl') {
        suppressOutput = true;
      }
    } else if (hex) {
      if (curskip > 0) {
        curskip--;
      } else if (!ignorable) {
        try {
          // Convert hex to character
          const byte = parseInt(hex, 16);
          // Try to decode using current encoding
          let char = String.fromCharCode(byte);

          // For extended ASCII (128-255), keep as-is
          if (byte >= 128 && byte <= 255) {
            out += char;
          } else if (byte >= 32) {
            out += char;
          }
        } catch (e) {
          // Ignore decoding errors
        }
      }
    } else if (tchar) {
      if (curskip > 0) {
        curskip--;
      } else if (!ignorable && !suppressOutput) {
        out += tchar;
      }
    }
  }

  return out;
}

/**
 * Whitespace and invisible-character cleanup only; never changes words.
 * Strips control characters, soft hyphens and BOMs, turns any run of spaces,
 * tabs or no-break spaces into one space, trims lines and keeps at most one
 * blank line in a row. The text is the publication's own, in any language,
 * so nothing is inserted, renamed or re-wrapped.
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
 * Parse RTF and return formatted plain text
 * @param {string} rtfContent - RTF content string
 * @returns {string} Plain text formatted
 */
export function parseRTF(rtfContent) {
  if (!rtfContent || typeof rtfContent !== 'string') {
    throw new Error('RTF content must be a non-empty string');
  }

  if (!rtfContent.trim().startsWith('{\\rtf')) {
    throw new Error('Invalid RTF format - must start with {\\rtf');
  }

  // Extract plain text from RTF
  const plainText = rtfToText(rtfContent);

  // Clean and format the text
  const formatted = cleanAndFormatText(plainText);

  return formatted;
}
