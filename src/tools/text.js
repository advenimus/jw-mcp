// Small text helpers shared by the scripture, WOL and captions tools. No
// imports, so any module can use them without loading cheerio.

/** Whitespace collapsed; zero-width, direction and isolate marks removed. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[​‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Chinese and Japanese text has no spaces between words or lines.
export const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** The last character of s, a whole surrogate pair when there is one. */
export function lastChar(s) {
  return [...s.slice(-2)].at(-1) ?? '';
}

/** Joins text pieces with a space, except between two CJK characters. */
export function joinText(a, b) {
  const left = cleanText(a);
  const right = cleanText(b);
  if (!left || !right) return left || right;
  const tight = NO_SPACE_SCRIPT.test(lastChar(left)) && NO_SPACE_SCRIPT.test(String.fromCodePoint(right.codePointAt(0)));
  return tight ? left + right : `${left} ${right}`;
}

/**
 * Any Unicode decimal digit (Arabic-Indic, Devanagari ...) to ASCII. Digit
 * blocks are runs of ten starting at zero.
 */
export function asciiDigits(s) {
  return String(s).replace(/\p{Nd}/gu, (ch) => {
    if (ch >= '0' && ch <= '9') return ch;
    let cp = ch.codePointAt(0);
    let k = 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) {
      cp -= 1;
      k += 1;
    }
    return String(k % 10);
  });
}

/** href resolved against base, or null when it is not a valid URL. */
export function absoluteUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}
