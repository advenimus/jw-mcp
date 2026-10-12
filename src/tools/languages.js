// JW.org language codes and the URL parts each site needs.
//
// A language resolves to:
//   { code: 'S', iso: 'es', name: 'Spanish', vernacular: 'español',
//     jwPath: 'es', rtl: false, signLanguage: false,
//     wol: { r: 'r4', lp: 'lp-s', path: 'es' } }
// code    JW.org/MEPS code: pub-media langwritten, mediator media-items/<code>, finder wtlocale=<code>
// jwPath  www.jw.org/<jwPath>/...
// wol     wol.jw.org/<path>/wol/.../<r>/<lp>/...; null when WOL has no library for the language
//
// The built-in table answers instantly. Anything else is looked up in the
// mediator language list and the WOL finder redirect, cached for a day.

import { ArgError, describeValue } from './args.js';
import { TtlLruCache, cached } from './cache.js';
import { JwFetchError, fetchJson, fetchRedirect } from './http.js';

/** Schema text for the langwritten parameter, shared so every tool says the same. */
export const LANGWRITTEN_DESCRIPTION = 'JW.org code (E, S...), ISO tag or name. Default E.';

// Verified against wol.jw.org/en/wol/li/r1/lp-e (data-rsconf, data-locale) and
// b.jw-cdn.org/apis/mediator/v1/languages/E/web on 2026-10-11.
// [code, iso (= WOL path), English name, vernacular name, WOL r, rtl]
const BUILT_IN_ROWS = [
  ['E', 'en', 'English', 'English', 'r1'],
  ['S', 'es', 'Spanish', 'español', 'r4'],
  ['F', 'fr', 'French', 'Français', 'r30'],
  ['T', 'pt', 'Portuguese (Brazil)', 'Português (Brasil)', 'r5'],
  ['TPO', 'pt-PT', 'Portuguese (Portugal)', 'Português (Portugal)', 'r296'],
  ['X', 'de', 'German', 'Deutsch', 'r10'],
  ['I', 'it', 'Italian', 'Italiano', 'r6'],
  ['O', 'nl', 'Dutch', 'Nederlands', 'r18'],
  ['J', 'ja', 'Japanese', '日本語', 'r7'],
  ['KO', 'ko', 'Korean', '한국어', 'r8'],
  ['CHS', 'cmn-Hans', 'Chinese Mandarin (Simplified)', '中文简体（普通话）', 'r23'],
  ['CH', 'cmn-Hant', 'Chinese Mandarin (Traditional)', '中文繁體（國語）', 'r24'],
  ['U', 'ru', 'Russian', 'русский', 'r2'],
  ['P', 'pl', 'Polish', 'polski', 'r12'],
  ['TG', 'tl', 'Tagalog', 'Tagalog', 'r27'],
  ['K', 'uk', 'Ukrainian', 'українська', 'r15'],
  ['VT', 'vi', 'Vietnamese', 'Việt', 'r47'],
  ['IN', 'id', 'Indonesian', 'Indonesia', 'r25'],
  ['A', 'ar', 'Arabic', 'العربية', 'r39', true]
];

// Common spellings that are not a language's own code, ISO tag or name.
const CODE_ALIASES = { CHT: 'CH' };
const ISO_ALIASES = {
  'pt-br': 'T',
  zh: 'CHS',
  'zh-cn': 'CHS',
  'zh-sg': 'CHS',
  'zh-hans': 'CHS',
  cmn: 'CHS',
  'zh-tw': 'CH',
  'zh-hk': 'CH',
  'zh-mo': 'CH',
  'zh-hant': 'CH',
  yue: 'CHC',
  'zh-yue': 'CHC',
  fil: 'TG'
};
// Keys go through nameKey, so word order and parentheses do not matter.
const NAME_ALIASES = {
  portuguese: 'T',
  'brazilian portuguese': 'T',
  'european portuguese': 'TPO',
  chinese: 'CHS',
  mandarin: 'CHS',
  'chinese simplified': 'CHS',
  'chinese traditional': 'CH',
  'mandarin traditional': 'CH',
  'mandarin simplified': 'CHS',
  cantonese: 'CHC',
  'chinese cantonese': 'CHC',
  'cantonese traditional': 'CHC',
  'cantonese simplified': 'CNS',
  filipino: 'TG'
};

// Upper-case ISO tags of built-in languages that are also another language's
// JW code (checked against the mediator list on 2026-10-12). Free text reads
// them as the ISO tag; the entry's note says how to get the other language.
const ISO_CODE_CLASHES = {
  __proto__: null,
  AR: 'Bambara',
  EN: 'Bena',
  FR: 'Faroese',
  ID: 'Idoma',
  IT: 'Itsekiri',
  JA: 'Javanese',
  RU: 'Kirundi',
  TL: 'Tamil',
  UK: 'Sukuma',
  VI: 'Tuvinian'
};

function withClashNote(lang, s) {
  const other = ISO_CODE_CLASHES[s];
  if (!other || lang.code === s) return lang;
  return Object.freeze({
    ...lang,
    note: `"${s}" was read as the ISO tag for ${lang.name} (JW.org code ${lang.code}). For ${other}, whose JW.org code is ${s}, pass langwritten "${other}".`
  });
}

const DIRECTORY_URL = 'https://b.jw-cdn.org/apis/mediator/v1/languages/E/all';
const DAY_MS = 24 * 60 * 60 * 1000;
const EXAMPLES =
  'a JW.org language code such as E (English), S (Spanish), F (French), T (Portuguese), X (German) or CHS (Chinese); ISO tags like "es" or "pt-BR" also work';

function makeEntry({ code, iso, name, vernacular, rtl = false, signLanguage = false, wol }) {
  return Object.freeze({
    code,
    iso,
    name,
    vernacular,
    jwPath: iso.toLowerCase(),
    rtl,
    signLanguage,
    wol: wol ? Object.freeze(wol) : wol
  });
}

// 'Traditional Chinese', 'Chinese (Traditional)' and 'chinese traditional'
// share a key.
function nameKey(s) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[\s()（）,]+/u)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function localeKey(s) {
  return s.trim().toLowerCase().replace(/_/g, '-');
}

function buildIndex(entries, { isoAliases = {}, nameAliases = {} } = {}) {
  const byCode = new Map();
  const byLocale = new Map();
  const byName = new Map();
  for (const e of entries) {
    byCode.set(e.code, e);
    if (!byLocale.has(localeKey(e.iso))) byLocale.set(localeKey(e.iso), e);
    for (const n of [e.name, e.vernacular]) {
      if (n && !byName.has(nameKey(n))) byName.set(nameKey(n), e);
    }
  }
  for (const [tag, code] of Object.entries(isoAliases)) if (byCode.has(code)) byLocale.set(tag, byCode.get(code));
  for (const [n, code] of Object.entries(nameAliases)) if (byCode.has(code)) byName.set(nameKey(n), byCode.get(code));
  return { byCode, byLocale, byName, entries };
}

export const BUILT_IN_LANGUAGES = Object.freeze(
  BUILT_IN_ROWS.map(([code, iso, name, vernacular, r, rtl = false]) =>
    makeEntry({ code, iso, name, vernacular, rtl, wol: { r, lp: `lp-${code.toLowerCase()}`, path: iso } })
  )
);
const builtInIndex = buildIndex(BUILT_IN_LANGUAGES, { isoAliases: ISO_ALIASES, nameAliases: NAME_ALIASES });

// Exact tag first, then drop trailing region subtags: 'es-MX' -> 'es', but
// 'fr-x-acd' (Acadian) never falls back to 'fr'.
function matchLocale(index, s) {
  const parts = localeKey(s).split('-');
  while (parts.length) {
    const hit = index.byLocale.get(parts.join('-'));
    if (hit) return hit;
    if (parts.length < 2 || !/^([a-z]{2}|\d{3})$/.test(parts[parts.length - 1])) return undefined;
    parts.pop();
  }
  return undefined;
}

function matchCode(index, s) {
  const upper = s.toUpperCase();
  return index.byCode.get(CODE_ALIASES[upper] ?? upper);
}

// Free text: all-uppercase input is read as a JW code first ('DA' = Douala);
// anything else as an ISO tag first ('da' = Danish). The built-in table is
// searched before the full list, so its ISO tags win over the directory's JW
// codes even for all-caps input: 'EN', 'TL' and 'RU' mean English, Tagalog
// and Russian, not Bena, Tamil and Kirundi (resolveLanguage adds a note). A
// value that is certainly a JW code (wtlocale=, an entry's code) is matched
// with matchCode alone.
function matchIn(index, s) {
  const upper = s.toUpperCase();
  const byCode = () => matchCode(index, s);
  const byLocale = () => matchLocale(index, s);
  const byName = () => index.byName.get(nameKey(s));
  const looksUpper = s === upper && /[A-Z]/.test(s);
  return (looksUpper ? byCode() ?? byLocale() : byLocale() ?? byCode()) ?? byName();
}

const langCache = new TtlLruCache({ maxEntries: 500, ttlMs: DAY_MS });
let directory = null;

async function loadDirectory(deadline) {
  return cached(
    'directory',
    DAY_MS,
    async () => {
      const data = await fetchJson(DIRECTORY_URL, { deadline });
      const list = Array.isArray(data?.languages) ? data.languages : [];
      const entries = list
        .filter((l) => typeof l?.code === 'string' && typeof l?.locale === 'string')
        .map((l) =>
          makeEntry({
            code: l.code,
            iso: localeKey(l.locale),
            name: l.name || l.code,
            vernacular: l.vernacular || l.name || l.code,
            rtl: Boolean(l.isRTL),
            signLanguage: Boolean(l.isSignLanguage)
          })
        );
      if (!entries.length) {
        throw new JwFetchError({
          kind: 'bad_content',
          url: DIRECTORY_URL,
          message: `b.jw-cdn.org returned no languages from ${DIRECTORY_URL}`,
          hint: 'Use a built-in language code such as E, S or F, or try again later.'
        });
      }
      directory = buildIndex(entries, { isoAliases: ISO_ALIASES, nameAliases: NAME_ALIASES });
      return directory;
    },
    { cache: langCache }
  );
}

// false (cached) means WOL has no library for the language: its finder then
// redirects to English.
async function loadWolLibrary(code, deadline) {
  return cached(
    `wol:${code}`,
    DAY_MS,
    async () => {
      const url = `https://wol.jw.org/wol/finder?wtlocale=${encodeURIComponent(code)}`;
      const location = await fetchRedirect(url, { deadline });
      const m = location && /^https:\/\/wol\.jw\.org\/([^/]+)\/wol\/[a-z]+\/(r\d+)\/(lp-[a-z0-9-]+)/i.exec(location);
      if (!m) {
        throw new JwFetchError({
          kind: 'bad_content',
          url,
          message: `wol.jw.org answered the language lookup for ${code} with an unexpected address (${location ?? 'no redirect'})`,
          hint: 'Try again later, or use a built-in language such as E, S or F.'
        });
      }
      if (m[3].toLowerCase() !== `lp-${code.toLowerCase()}`) return false;
      return { r: m[2], lp: m[3].toLowerCase(), path: decodeURIComponent(m[1]) };
    },
    { cache: langCache }
  );
}

// Up to 3 spoken languages sharing a word stem with the query: 'brazilian'
// finds Portuguese (Brazil), 'cantonese' both Cantonese scripts.
function suggest(index, s) {
  const stem = (w) => w.slice(0, 5);
  const words = nameKey(s).split(' ').filter((w) => w.length >= 4).map(stem);
  if (!words.length) return [];
  return index.entries
    .filter((e) => !e.signLanguage)
    .map((e) => {
      const names = nameKey(e.name).split(' ').map(stem);
      return { e, score: names.filter((n) => words.includes(n)).length };
    })
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.e);
}

function unknownLanguage(name, input, candidates) {
  if (!candidates.length) return new ArgError(name, input, EXAMPLES);
  const list = candidates.map((e) => `${e.code} (${e.name})`).join(', ');
  return new ArgError(name, input, EXAMPLES, {
    message: `Unknown language ${describeValue(input)} for "${name}". Did you mean ${list}?`,
    hint: `Call again with "${name}" set to one of those codes, e.g. "${candidates[0].code}".`
  });
}

function checkInput(input, name) {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > 40) {
    throw new ArgError(name, input, EXAMPLES);
  }
  return input.trim();
}

/**
 * Synchronous lookup in the built-in table and, once loaded, the full list.
 * Returns the entry or null. For languages outside the built-in table, wol is
 * undefined (not looked up); use resolveLanguage for that. `as` as in
 * resolveLanguage.
 */
export function lookupLanguage(input, { as = 'any' } = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const s = input.trim();
  const match = as === 'code' ? matchCode : matchIn;
  return match(builtInIndex, s) ?? (directory && match(directory, s)) ?? null;
}

/**
 * Resolve a JW code, ISO tag or language name to a language entry.
 * Never touches the network for built-in languages. Throws ArgError for an
 * unknown language and JwFetchError when the JW.org lookup itself fails.
 * Options: name (parameter name for errors), wol (false skips the WOL lookup;
 * wol is then undefined for non-built-in languages), as ('code' when the
 * input is certainly a JW code, e.g. wtlocale=TL is Tamil, not the ISO tag
 * tl of Tagalog; default 'any'), deadline (the calling tool's time limit,
 * epoch ms). Free text that is both a built-in ISO tag and another
 * language's JW code ("TL") gets a `note` saying how to get the other one.
 */
export async function resolveLanguage(input, { name = 'langwritten', wol = true, as = 'any', deadline } = {}) {
  const s = checkInput(input, name);
  const match = as === 'code' ? matchCode : matchIn;
  const builtIn = match(builtInIndex, s);
  if (builtIn) return as === 'code' ? builtIn : withClashNote(builtIn, s);

  const index = await loadDirectory(deadline);
  const found = match(index, s);
  if (!found) throw unknownLanguage(name, input, as === 'code' ? [] : suggest(index, s));
  if (!wol) return found;
  const library = await loadWolLibrary(found.code, deadline);
  return Object.freeze({ ...found, wol: library ? Object.freeze(library) : null });
}

/**
 * WOL URL for a resolved language, e.g. wolUrl(es, 'b', 'nwtsty', 43, 3) ->
 * https://wol.jw.org/es/wol/b/r4/lp-s/nwtsty/43/3. Throws ArgError when WOL
 * has no library for the language.
 */
export function wolUrl(lang, type, ...segments) {
  if (lang.wol === undefined) throw new Error(`wolUrl: ${lang.code} was resolved with { wol: false }`);
  if (!lang.wol) {
    throw new ArgError('langwritten', lang.code, 'a language available on wol.jw.org', {
      message: `${lang.name} (${lang.code}) has no Watchtower Online Library on wol.jw.org.`,
      hint: 'Use another language, such as E (English).'
    });
  }
  const { path, r, lp } = lang.wol;
  const rest = segments.map((s) => `/${encodeURIComponent(s)}`).join('');
  return `https://wol.jw.org/${path}/wol/${type}/${r}/${lp}${rest}`;
}

/** For tests: forget the downloaded language list and WOL lookups. */
export function clearLanguageCache() {
  langCache.clear();
  directory = null;
}
