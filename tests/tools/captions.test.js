// Offline tests for get_jw_captions. Every response comes from a stubbed
// globalThis.fetch; the captions, titles and pages below are synthetic.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  captionsTool,
  clearCaptionsCache,
  formatClock,
  formatTranscript,
  getCaptionsImplementation,
  handleCaptionsTool,
  parseVideoReference,
  parseVtt
} from '../../src/tools/captions-tool.js';
import { clearLanguageCache } from '../../src/tools/languages.js';
import { estimateTokens } from '../../src/tools/results.js';

const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  clearCaptionsCache();
  clearLanguageCache();
  globalThis.fetch = async (url) => {
    throw new Error(`offline test tried to fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// routes: [[string | RegExp, () => Response]]; anything else is a test failure.
function useRoutes(routes) {
  globalThis.fetch = async (url) => {
    url = String(url);
    calls.push(url);
    for (const [pattern, respond] of routes) {
      if (typeof pattern === 'string' ? url === pattern : pattern.test(url)) return respond(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const json = (value) => () =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const body = (text, type = 'text/vtt') => () => new Response(text, { headers: { 'content-type': type } });
const status = (code) => () => new Response('nope', { status: code });

const mediatorUrl = (lang, key) => `https://b.jw-cdn.org/apis/mediator/v1/media-items/${lang}/${key}?clientType=www`;
const VTT_URL = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_E_1.vtt';

function media({
  key = 'pub-test_1_VIDEO',
  lang = 'E',
  title = 'A Synthetic Test Program',
  subtitles = VTT_URL,
  subtitled = false,
  description = '',
  files
} = {}) {
  return {
    media: [
      {
        languageAgnosticNaturalKey: key,
        naturalKey: key.replace(/^([^_]+)_/, `$1_${lang}_`),
        primaryCategory: 'TestCategory',
        title,
        description,
        firstPublished: '2026-10-05T18:07:06.772Z',
        duration: 754.5,
        files: files ?? [
          { label: '144p', frameHeight: 144, subtitled },
          { label: '240p', frameHeight: 234, subtitled, ...(subtitles && { subtitles: { url: subtitles } }) },
          { label: '720p', frameHeight: 720, subtitled, ...(subtitles && { subtitles: { url: subtitles } }) }
        ],
        images: { wss: { sm: 'https://cms-imgp.jw-cdn.org/img/p/test/test_wss_sm.jpg' } },
        availableLanguages: ['E', 'S', 'F']
      }
    ],
    language: { languageCode: lang }
  };
}
const empty = { media: [], language: { languageCode: 'E' } };

// [[start s, end s, text]] -> WebVTT with CRLF, cue settings and a cue id, like JW.org's.
function vttOf(cues) {
  const t = (s) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor(s / 60) % 60).padStart(2, '0');
    return `${h}:${m}:${(s % 60).toFixed(3).padStart(6, '0')}`;
  };
  return `WEBVTT\r\n\r\n${cues
    .map(([a, b, text], i) => `${i + 1}\r\n${t(a)} --> ${t(b)} line:90% position:50% align:center\r\n${text.replace(/\n/g, '\r\n')}`)
    .join('\r\n\r\n')}\r\n`;
}

const SHORT_VTT = vttOf([
  [1, 4, 'Welcome to this <i>synthetic</i> program.'],
  [4, 8, 'Today we test\nhow captions are joined.'],
  [8, 12, 'Salt &amp; light are &lt;fine&gt; here.'],
  [40, 44, 'A later sentence starts a new paragraph.']
]);

// About 6,000 characters over ten minutes, for paging.
const LONG_VTT = vttOf(
  Array.from({ length: 120 }, (_, i) => [i * 5, i * 5 + 4.5, `Synthetic sentence number ${i + 1} is here for paging.`])
);

async function call(args) {
  const res = await handleCaptionsTool({ params: { name: 'get_jw_captions', arguments: args } });
  assert.ok(res && Array.isArray(res.content), 'an MCP result');
  return res;
}

function parts(res) {
  assert.notEqual(res.isError, true, res.content[0].text);
  return { meta: JSON.parse(res.content[0].text), text: res.content[1]?.text };
}

function assertError(res, pattern) {
  assert.equal(res.isError, true, `expected isError, got ${res.content[0].text}`);
  assert.equal(res.content.length, 1);
  assert.match(res.content[0].text, pattern);
  assert.doesNotMatch(res.content[0].text, /failed unexpectedly|TypeError|Cannot read/);
}

describe('tool definition', () => {
  it('keeps video_id required and adds optional langwritten, format, max_chars and offset', () => {
    assert.equal(captionsTool.name, 'get_jw_captions');
    assert.deepEqual(captionsTool.inputSchema.required, ['video_id']);
    assert.deepEqual(Object.keys(captionsTool.inputSchema.properties), ['video_id', 'langwritten', 'format', 'max_chars', 'offset']);
    assert.deepEqual(captionsTool.inputSchema.properties.format.enum, ['text', 'plain', 'vtt']);
    assert.match(captionsTool.description, /next_offset/);
  });

  it('the handler returns null for other tools', async () => {
    assert.equal(await handleCaptionsTool({ params: { name: 'get_bible_verse', arguments: {} } }), null);
  });
});

describe('parseVideoReference', () => {
  const cases = [
    ['pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: undefined }],
    ['  pub-nwtsv_10_VIDEO \n', { kind: 'key', key: 'pub-nwtsv_10_VIDEO' }],
    ['PUB-JWB-142_1_video', { kind: 'key', key: 'pub-jwb-142_1_VIDEO' }],
    ['docid-502014331_1_VIDEO', { kind: 'key', key: 'docid-502014331_1_VIDEO' }],
    ['pub-fmh_x_VIDEO', { kind: 'key', key: 'pub-fmh_x_VIDEO' }],
    ['pub-jwb_202001_1_VIDEO', { kind: 'key', key: 'pub-jwb_202001_1_VIDEO' }],
    // Language-specific ("natural") keys, as in download names.
    ['pub-jwb-142_E_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'E' }],
    ['pub-jwb_S_202001_1_VIDEO', { kind: 'key', key: 'pub-jwb_202001_1_VIDEO', lang: 'S' }],
    ['pub-fmh_X_x_VIDEO', { kind: 'key', key: 'pub-fmh_x_VIDEO', lang: 'X' }],
    ['docid-502014331_CHS_1_VIDEO', { kind: 'key', key: 'docid-502014331_1_VIDEO', lang: 'CHS' }],
    ['502014331', { kind: 'docid', docid: '502014331' }],
    ['docid-502014331', { kind: 'docid', docid: '502014331' }],
    ['https://www.jw.org/finder?srcid=jwlshare&wtlocale=E&lank=pub-jwbvod25_17_VIDEO', { kind: 'key', key: 'pub-jwbvod25_17_VIDEO', lang: 'E' }],
    ['https://www.jw.org/finder?srcid=share&wtlocale=S&lank=pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'S' }],
    ['https://www.jw.org/en/library/videos/#en/mediaitems/BibleBooks/pub-nwtsv_10_VIDEO', { kind: 'key', key: 'pub-nwtsv_10_VIDEO', lang: 'en' }],
    ['https://www.jw.org/es/biblioteca/videos/#es/mediaitems/StudioMonthlyPrograms/pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'es' }],
    ['https://www.jw.org/en/library/videos/#en/mediaitems/VODBibleTeachings/docid-502014331_1_VIDEO', { kind: 'key', key: 'docid-502014331_1_VIDEO', lang: 'en' }],
    ['https://www.jw.org/en/library/videos/#en/mediaitems/pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO' }],
    ['https://www.jw.org/en/library/videos/%23en/mediaitems/x/pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO' }],
    ['https://tv.jw.org/#fr/mediaitems/VODStudio/pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'fr' }],
    ['https://www.jw.org/en/library/videos/?item=pub-jwbvod25_17_VIDEO&appLanguage=F', { kind: 'key', key: 'pub-jwbvod25_17_VIDEO', lang: 'F' }],
    ['https://b.jw-cdn.org/apis/mediator/v1/media-items/S/pub-jwb-142_1_VIDEO?clientType=www', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'S' }],
    ['www.jw.org/finder?wtlocale=E&lank=pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO', lang: 'E' }],
    ['jw.org/finder?lank=pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO' }],
    ['http://www.jw.org/finder?lank=pub-jwb-142_1_VIDEO', { kind: 'key', key: 'pub-jwb-142_1_VIDEO' }],
    ['https://www.jw.org/finder?wtlocale=E&docid=502014331', { kind: 'docid', docid: '502014331', lang: 'E' }],
    ['https://www.jw.org/open?docid=1011511&prefer=content', { kind: 'docid', docid: '1011511' }],
    [
      'https://www.jw.org/en/library/videos/Some-Series/some-video/',
      { kind: 'page', pageUrl: 'https://www.jw.org/en/library/videos/Some-Series/some-video/', lang: 'en' }
    ],
    ['jw.org/en/library/videos/Some-Series/some-video/', { kind: 'page', pageUrl: 'https://www.jw.org/en/library/videos/Some-Series/some-video/' }]
  ];
  for (const [input, want] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      const ref = parseVideoReference(input);
      assert.equal(ref.kind, want.kind);
      if (want.key) assert.equal(ref.key, want.key);
      if (want.docid) assert.equal(ref.docid, want.docid);
      if (want.pageUrl) assert.equal(ref.pageUrl, want.pageUrl);
      if ('lang' in want) assert.equal(ref.langHints[0]?.value, want.lang);
    });
  }

  it('prefers wtlocale over the #locale and the page locale', () => {
    const ref = parseVideoReference('https://www.jw.org/en/library/videos/?wtlocale=S#fr/mediaitems/x/pub-a_1_VIDEO');
    assert.deepEqual(ref.langHints.map((h) => h.value), ['S', 'fr', 'en']);
  });

  const rejects = [
    ['https://www.youtube.com/watch?v=abc123', /not a JW\.org link/],
    ['youtube.com/watch?v=abc123', /not a JW\.org link/],
    ['https://evil.example/?lank=pub-jwb-142_1_VIDEO', /not a JW\.org link/],
    ['https://www.jw.org/en/library/videos/#en/home', /opens a list of videos, not one video/],
    ['https://www.jw.org/en/', /no video key/],
    ['https://www.jw.org/finder?wtlocale=E', /no lank= or docid=/],
    ['https://wol.jw.org/en/wol/d/r1/lp-e/1102018451', /no video key/],
    ['https://cfp2.jw-cdn.org/a/874fdc/1/o/test_E_17_r720P.mp4', /download link/],
    ['not-a-video', /Could not find a JW\.org video in "not-a-video"/],
    ['42', /Could not find a JW\.org video/],
    ['javascript:alert(1)', /Could not find a JW\.org video/]
  ];
  for (const [input, pattern] of rejects) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.throws(() => parseVideoReference(input), (err) => {
        assert.equal(err.name, 'ArgError');
        assert.equal(err.param, 'video_id');
        assert.match(err.message, pattern);
        // A route the AI can take itself; the Share menu is only for the user.
        assert.match(err.hint, /latest:StudioMonthlyPrograms/);
        assert.match(err.hint, /latest:<Category>~N/);
        return true;
      });
    });
  }

  it('reads category links and "latest" requests as the newest video of a category', () => {
    for (const [input, category] of [
      ['https://www.jw.org/en/library/videos/#en/categories/VODStudio', 'VODStudio'],
      ['https://www.jw.org/es/biblioteca/videos/#es/categories/StudioMonthlyPrograms', 'StudioMonthlyPrograms'],
      ['latest monthly broadcast', 'StudioMonthlyPrograms'],
      ['the latest JW Broadcasting program', 'StudioMonthlyPrograms'],
      ['latest:StudioMonthlyPrograms', 'StudioMonthlyPrograms'],
      ['Latest: VODBibleTeachings', 'VODBibleTeachings'],
      ['latest', 'LatestVideos'],
      ['newest videos', 'LatestVideos'],
      ['latest morning worship', 'VODPgmEvtMorningWorship'],
      ['latest Governing Body update', 'StudioNewsReports'],
      ['latest news', 'StudioNewsReports'],
      ['latest JW Broadcasting talk', 'StudioTalks'],
      // A camel-case key is used as given, even when it says "Program"; free text is not.
      ['latest:VODProgramsEvents', 'VODProgramsEvents'],
      ['latest:VODProgramsEventsAD', 'VODProgramsEventsAD'],
      ['latest:broadcast', 'StudioMonthlyPrograms'],
      ['latest:BROADCAST', 'StudioMonthlyPrograms']
    ]) {
      const ref = parseVideoReference(input);
      assert.equal(ref.kind, 'category', input);
      assert.equal(ref.category, category, input);
    }
    assert.deepEqual(parseVideoReference('https://www.jw.org/es/biblioteca/videos/#es/categories/X1').langHints.map((h) => h.value), ['es', 'es']);
  });

  it('lists the category keys that work when "latest <words>" names none', () => {
    assert.throws(() => parseVideoReference('latest circuit assembly program'), (err) => {
      assert.equal(err.param, 'video_id');
      assert.match(err.message, /"latest circuit assembly program" names no JW\.org video category this tool knows/);
      assert.match(err.hint, /latest:VODPgmEvtMorningWorship \(Morning Worship\)/);
      assert.match(err.hint, /latest:StudioNewsReports/);
      return true;
    });
  });

  it('marks the language hints that are certainly JW codes', () => {
    const codes = (input) => parseVideoReference(input).langHints.map((h) => [h.value, h.code]);
    assert.deepEqual(codes('https://www.jw.org/finder?wtlocale=TL&lank=pub-x_1_VIDEO'), [['TL', true]]);
    assert.deepEqual(codes('pub-x_TL_1_VIDEO'), [['TL', true]]);
    assert.deepEqual(codes('https://b.jw-cdn.org/apis/mediator/v1/media-items/TL/pub-x_1_VIDEO'), [['TL', true]]);
    assert.deepEqual(codes('https://www.jw.org/ta/library/videos/#ta/mediaitems/x/pub-x_1_VIDEO'), [['ta', false], ['ta', false]]);
  });

  it('drops anything after the key, so the key cannot steer the mediator path', () => {
    assert.equal(parseVideoReference('pub-jwb-142_1_VIDEO/../../categories/E/VideoOnDemand').key, 'pub-jwb-142_1_VIDEO');
  });
});

describe('parseVtt / formatTranscript', () => {
  it('drops the header, cue ids, timings, settings, tags and entities, and joins cue lines', () => {
    const cues = parseVtt(SHORT_VTT);
    assert.deepEqual(
      cues.map((c) => c.text),
      [
        'Welcome to this synthetic program.',
        'Today we test how captions are joined.',
        'Salt & light are <fine> here.',
        'A later sentence starts a new paragraph.'
      ]
    );
    assert.equal(cues[0].start, 1);
    assert.equal(cues[3].end, 44);
  });

  it('skips NOTE, STYLE and REGION blocks, empty cues and overlapping repeats; reads mm:ss timings', () => {
    const vtt = [
      'WEBVTT - with a title',
      'NOTE this --> is not a cue',
      'STYLE\n::cue { color: yellow }',
      'REGION\nid:fred',
      '00:01.000 --> 00:02.500\n<c.yellow>One</c> <00:00:01.500>line',
      '00:02.000 --> 00:03.000\n<v Speaker>One line</v>',
      '00:03.000 --> 00:04.000\n   ',
      '00:04.000 --> 00:05.000\nCaf&eacute; &#8217;quote&#x2019; &#99999999; &nbsp;end'
    ].join('\n\n');
    const cues = parseVtt(vtt);
    assert.deepEqual(cues.map((c) => c.text), ['One line', 'Caf&eacute; ’quote’ &#99999999; end']);
    assert.equal(parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nA &constructor; and &__proto__; stay.')[0].text, 'A &constructor; and &__proto__; stay.');
    assert.deepEqual([cues[0].start, cues[0].end], [1, 3]);
  });

  it('joins Chinese and Japanese lines without a space', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n今日は\nいい天気です。\n\n00:00:03.000 --> 00:00:05.000\n散歩しましょう。');
    assert.equal(formatTranscript(cues, { timestamps: false }), '今日はいい天気です。散歩しましょう。');
  });

  it('keeps a cue break as a space when the cue ends without CJK punctuation', () => {
    const ja = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n今月のテーマは視力です\n\n00:00:03.000 --> 00:00:05.000\n定期的に視力検査を\n受けるのと同じように';
    assert.equal(formatTranscript(parseVtt(ja), { timestamps: false }), '今月のテーマは視力です 定期的に視力検査を受けるのと同じように');
    const zh = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你知道吗？\n\n00:00:03.000 --> 00:00:05.000\n今天很好\n\n00:00:05.000 --> 00:00:07.000\n我们出去吧';
    assert.equal(formatTranscript(parseVtt(zh), { timestamps: false }), '你知道吗？今天很好 我们出去吧');
    const en = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOne line\n\n00:00:03.000 --> 00:00:05.000\nand the next';
    assert.equal(formatTranscript(parseVtt(en), { timestamps: false }), 'One line and the next');
  });

  it('makes paragraphs at a sentence end after 30 s, or at 60 s regardless, with [m:ss] markers', () => {
    const cues = parseVtt(SHORT_VTT);
    assert.equal(
      formatTranscript(cues),
      '[0:01] Welcome to this synthetic program. Today we test how captions are joined. Salt & light are <fine> here.\n\n' +
        '[0:40] A later sentence starts a new paragraph.'
    );
    const run = parseVtt(vttOf(Array.from({ length: 30 }, (_, i) => [i * 5, i * 5 + 5, `words ${i} without an ending`])));
    const marks = formatTranscript(run).match(/^\[[^\]]+\]/gm);
    assert.deepEqual(marks, ['[0:00]', '[1:00]', '[2:00]']);
    assert.doesNotMatch(formatTranscript(run, { timestamps: false }), /\[/);
  });

  it('formats clock times past an hour', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(75.9), '1:15');
    assert.equal(formatClock(3725), '1:02:05');
    const late = parseVtt(vttOf([[3725, 3727, 'Late in the program.']]));
    assert.equal(formatTranscript(late), '[1:02:05] Late in the program.');
  });
});

describe('get_jw_captions: lookups and output', () => {
  it('returns a JSON metadata block, then the cleaned transcript as its own text block', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media({ description: 'A short description.' }))],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const res = await call({ video_id: 'pub-test_1_VIDEO' });
    assert.equal(res.content.length, 2);
    const { meta, text } = parts(res);
    assert.deepEqual(meta, {
      title: 'A Synthetic Test Program',
      key: 'pub-test_1_VIDEO',
      language: 'E',
      language_name: 'English',
      duration: '12:34',
      duration_seconds: 755,
      published: '2026-10-05',
      category: 'TestCategory',
      description: 'A short description.',
      url: 'https://www.jw.org/finder?wtlocale=E&lank=pub-test_1_VIDEO',
      thumbnail: 'https://cms-imgp.jw-cdn.org/img/p/test/test_wss_sm.jpg',
      subtitles_url: VTT_URL,
      captions_available: true,
      format: 'text',
      total_chars: text.length,
      offset: 0,
      returned_chars: text.length,
      truncated: false,
      next_offset: null
    });
    assert.match(text, /^\[0:01\] Welcome to this synthetic program\. Today we test how captions are joined\./);
    assert.doesNotMatch(text, /WEBVTT|-->|line:90%|<i>|&amp;|\r/);
    assert.deepEqual(calls, [mediatorUrl('E', 'pub-test_1_VIDEO'), VTT_URL]);
  });

  it('still accepts the old call form getCaptionsImplementation(video_id)', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await getCaptionsImplementation('pub-test_1_VIDEO'));
    assert.equal(meta.title, 'A Synthetic Test Program');
  });

  it('accepts url as another name for video_id', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ url: 'https://www.jw.org/finder?lank=pub-test_1_VIDEO' }));
    assert.equal(meta.key, 'pub-test_1_VIDEO');
  });

  it('returns raw WebVTT with format "vtt" (and "raw"), and drops markers with "plain"', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    for (const format of ['vtt', 'RAW']) {
      const { meta, text } = parts(await call({ video_id: 'pub-test_1_VIDEO', format }));
      assert.equal(meta.format, 'vtt');
      assert.match(text, /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:04\.000 line:90%/);
    }
    const { text } = parts(await call({ video_id: 'pub-test_1_VIDEO', format: 'plain' }));
    assert.match(text, /^Welcome to this synthetic program\./);
    assert.doesNotMatch(text, /\[\d/);
    assert.equal(calls.filter((u) => u === VTT_URL).length, 1, 'the caption file is cached');
  });

  it('picks the subtitle file from whichever rendition has one, preferring the largest', async () => {
    const other = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_E_1_hd.vtt';
    useRoutes([
      [
        mediatorUrl('E', 'pub-test_1_VIDEO'),
        json(media({ files: [{ label: '240p', frameHeight: 234, subtitles: { url: VTT_URL } }, { label: '720p', frameHeight: 720, subtitles: { url: other } }] }))
      ],
      [mediatorUrl('E', 'pub-one_1_VIDEO'), json(media({ key: 'pub-one_1_VIDEO', files: [{ label: '720p', subtitles: { url: VTT_URL } }] }))],
      [other, body(SHORT_VTT)],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    assert.equal(parts(await call({ video_id: 'pub-test_1_VIDEO' })).meta.subtitles_url, other);
    // A single rendition at index 0 (the old code only looked at files[1]).
    assert.equal(parts(await call({ video_id: 'pub-one_1_VIDEO' })).meta.subtitles_url, VTT_URL);
  });

  it('takes the language from wtlocale, a #locale, a natural key, and langwritten (which wins)', async () => {
    const vttS = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_S_1.vtt';
    const vttF = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_F_1.vtt';
    useRoutes([
      [mediatorUrl('S', 'pub-test_1_VIDEO'), json(media({ lang: 'S', title: 'Programa de prueba', subtitles: vttS }))],
      [mediatorUrl('F', 'pub-test_1_VIDEO'), json(media({ lang: 'F', title: 'Programme de test', subtitles: vttF }))],
      [vttS, body(SHORT_VTT)],
      [vttF, body(SHORT_VTT)]
    ]);
    for (const [args, lang] of [
      [{ video_id: 'https://www.jw.org/finder?srcid=share&wtlocale=S&lank=pub-test_1_VIDEO' }, 'S'],
      [{ video_id: 'https://www.jw.org/es/biblioteca/videos/#es/mediaitems/Cat/pub-test_1_VIDEO' }, 'S'],
      [{ video_id: 'pub-test_F_1_VIDEO' }, 'F'],
      [{ video_id: 'https://www.jw.org/finder?wtlocale=S&lank=pub-test_1_VIDEO', langwritten: 'french' }, 'F'],
      [{ video_id: 'pub-test_1_VIDEO', langwritten: 'es-MX' }, 'S']
    ]) {
      const { meta } = parts(await call(args));
      assert.equal(meta.language, lang, JSON.stringify(args));
      assert.equal(meta.url, `https://www.jw.org/finder?wtlocale=${lang}&lank=pub-test_1_VIDEO`);
      assert.equal(meta.requested_language, undefined);
    }
  });

  it('ignores a URL language JW.org does not know, with a note, and uses English', async () => {
    useRoutes([
      ['https://b.jw-cdn.org/apis/mediator/v1/languages/E/all', json({ languages: [{ code: 'E', locale: 'en', name: 'English' }] })],
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: 'https://www.jw.org/zz/videos/#zz/mediaitems/x/pub-test_1_VIDEO' }));
    assert.equal(meta.language, 'E');
    assert.match(meta.notes[0], /Ignored the language "zz" from #zz\/ in the link \(not a JW\.org language\)/);
  });

  it('rejects an unknown langwritten instead of guessing', async () => {
    useRoutes([['https://b.jw-cdn.org/apis/mediator/v1/languages/E/all', json({ languages: [{ code: 'E', locale: 'en', name: 'English' }] })]]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'Klingon' }), /Invalid "langwritten"/);
  });
});

describe('get_jw_captions: English fallback and missing captions', () => {
  it('falls back to English, with a note, when the video is not published in the language', async () => {
    useRoutes([
      [mediatorUrl('S', 'pub-test_1_VIDEO'), json(empty)],
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta, text } = parts(await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'S' }));
    assert.equal(meta.language, 'E');
    assert.equal(meta.requested_language, 'S');
    assert.deepEqual(meta.notes, ['This video is not published in Spanish (S); showing the English version.']);
    assert.match(text, /Welcome/);
  });

  it('falls back to English captions, with a note, when the language has the video but no caption file', async () => {
    useRoutes([
      [mediatorUrl('S', 'pub-test_1_VIDEO'), json(media({ lang: 'S', title: 'Un programa de prueba', subtitles: null }))],
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta, text } = parts(await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'S' }));
    // The video stays the Spanish one; only the transcript is English.
    assert.equal(meta.language, 'S');
    assert.equal(meta.captions_language, 'E');
    assert.equal(meta.requested_language, undefined);
    assert.equal(meta.title, 'Un programa de prueba');
    assert.match(meta.url, /wtlocale=S&/);
    assert.equal(meta.subtitles_url, VTT_URL);
    assert.match(text, /Welcome to this synthetic program/);
    assert.match(meta.notes[0], /no Spanish \(S\) captions for this video; showing the English captions/);
  });

  it('returns the metadata and the reason, not an error, when no caption file exists (burned-in subtitles)', async () => {
    useRoutes([[mediatorUrl('E', 'pub-movie_x_VIDEO'), json(media({ key: 'pub-movie_x_VIDEO', title: 'A Synthetic Movie', subtitles: null, subtitled: true }))]]);
    const res = await call({ video_id: 'pub-movie_x_VIDEO' });
    assert.equal(res.isError, undefined);
    assert.equal(res.content.length, 1);
    const meta = JSON.parse(res.content[0].text);
    assert.equal(meta.title, 'A Synthetic Movie');
    assert.equal(meta.duration, '12:34');
    assert.equal(meta.captions_available, false);
    assert.match(meta.reason, /no caption file for this video in English \(E\); its only subtitles are burned into the picture/);
    assert.match(meta.next_step, /published in 3 languages/);
  });

  it('says which languages were checked when neither has captions', async () => {
    useRoutes([
      [mediatorUrl('S', 'pub-test_1_VIDEO'), json(media({ lang: 'S', subtitles: null }))],
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media({ subtitles: null }))]
    ]);
    const res = await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'S' });
    const meta = JSON.parse(res.content[0].text);
    assert.equal(res.isError, undefined);
    assert.equal(meta.language, 'S');
    assert.equal(meta.reason, 'JW.org publishes no caption file for this video in Spanish (S) and English (E).');
  });

  it('reports an empty caption file as no captions', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n<i></i>\r\n')]
    ]);
    const meta = JSON.parse((await call({ video_id: 'pub-test_1_VIDEO' })).content[0].text);
    assert.equal(meta.captions_available, false);
    assert.match(meta.reason, /has no text/);
  });
});

describe('get_jw_captions: docid links and video pages', () => {
  const FINDER = 'https://www.jw.org/finder?wtlocale=E&docid=1234567';
  const ARTICLE = 'https://www.jw.org/en/library/some-article/';
  const redirect = (to) => () => new Response(null, { status: 302, headers: { location: to } });
  const page = (inner) => body(`<html><body><h1>Synthetic page</h1>${inner}</body></html>`, 'text/html; charset=utf-8');
  const player = (query) =>
    `<div class='jsIncludeVideo' data-jsonurl='https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?${query}&amp;output=json&amp;fileformat=m4v%2Cmp4%2C3gp%2Cmp3&amp;alllangs=1&amp;langwritten=E'></div>`;
  const audio = `<a data-jsonurl="https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS?docid=1234567&amp;output=json&amp;fileformat=MP3&amp;langwritten=E"></a>`;

  it('maps finder?docid=N to the docid-N_1_VIDEO key', async () => {
    useRoutes([
      [mediatorUrl('E', 'docid-1234567_1_VIDEO'), json(media({ key: 'docid-1234567_1_VIDEO' }))],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: `${FINDER}&srcid=share` }));
    assert.equal(meta.key, 'docid-1234567_1_VIDEO');
    assert.equal(calls.length, 2);
  });

  it('reads the key from the page player when docid-N_1_VIDEO does not exist', async () => {
    useRoutes([
      [mediatorUrl('E', 'docid-1234567_1_VIDEO'), json(empty)],
      [FINDER, redirect(ARTICLE)],
      [ARTICLE, page(audio + player('docid=1234567&amp;track=2'))],
      [mediatorUrl('E', 'docid-1234567_2_VIDEO'), json(media({ key: 'docid-1234567_2_VIDEO' }))],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: '1234567' }));
    assert.equal(meta.key, 'docid-1234567_2_VIDEO');
  });

  it('reads a pub video page and lists the other players in a note', async () => {
    const url = 'https://www.jw.org/en/library/videos/Some-Series/some-video/';
    useRoutes([
      [url, page(player('pub=mwbv&amp;issue=20241100&amp;track=2') + player('pub=jwb-142&amp;track=1'))],
      [mediatorUrl('E', 'pub-mwbv_202411_2_VIDEO'), json(media({ key: 'pub-mwbv_202411_2_VIDEO' }))],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: url }));
    assert.equal(meta.key, 'pub-mwbv_202411_2_VIDEO');
    assert.match(meta.notes[0], /2 videos; this is the first\. The others: pub-jwb-142_1_VIDEO/);
  });

  it('explains when a docid is an article without a video, listing videos it links to', async () => {
    useRoutes([
      [mediatorUrl('E', 'docid-1234567_1_VIDEO'), json(empty)],
      [FINDER, redirect(ARTICLE)],
      [ARTICLE, page(`${audio}<a href="/en/library/videos/#en/mediaitems/Cat/pub-other_3_VIDEO">see</a>`)]
    ]);
    const res = await call({ video_id: FINDER });
    assertError(res, /page for docid 1234567 .* has no video player of its own.*It links to these videos: pub-other_3_VIDEO/s);
    assert.match(res.content[0].text, /Next step: Pass one of those keys/);
  });

  it('reports a docid the finder does not know as not found', async () => {
    useRoutes([
      [mediatorUrl('E', 'docid-1234567_1_VIDEO'), json(empty)],
      [FINDER, status(404)]
    ]);
    assertError(await call({ video_id: FINDER }), /JW\.org has no video for docid 1234567 with the key docid-1234567_1_VIDEO \(looked up in English \(E\)\)/);
  });

  it('explains when the player key from the page does not exist either', async () => {
    useRoutes([
      [mediatorUrl('E', 'docid-1234567_1_VIDEO'), json(empty)],
      [FINDER, redirect(ARTICLE)],
      [ARTICLE, page(player('docid=7654321&amp;track=1'))],
      [mediatorUrl('E', 'docid-7654321_1_VIDEO'), json(empty)]
    ]);
    assertError(await call({ video_id: FINDER }), /no video for docid 1234567 with the key docid-1234567_1_VIDEO or docid-7654321_1_VIDEO/);
  });
});

describe('get_jw_captions: paging', () => {
  beforeEach(() => {
    useRoutes([
      [mediatorUrl('E', 'pub-long_1_VIDEO'), json(media({ key: 'pub-long_1_VIDEO' }))],
      [VTT_URL, body(LONG_VTT)]
    ]);
  });

  it('reads a long transcript in parts that add up to the whole, cut on boundaries', async () => {
    const full = parts(await call({ video_id: 'pub-long_1_VIDEO' }));
    assert.equal(full.meta.truncated, false);
    const whole = full.text;
    assert.ok(whole.length > 5000, `fixture is ${whole.length} chars`);

    let offset = 0;
    let joined = '';
    for (let i = 0; i < 20 && offset !== null; i++) {
      const { meta, text } = parts(await call({ video_id: 'pub-long_1_VIDEO', max_chars: 1000, offset }));
      assert.equal(meta.total_chars, whole.length);
      assert.equal(meta.offset, offset);
      assert.ok(meta.returned_chars <= 1000);
      const chunk = whole.slice(offset, offset + meta.returned_chars);
      assert.ok(text.startsWith(chunk.trimEnd()));
      if (meta.truncated) {
        assert.equal(meta.next_offset, offset + meta.returned_chars);
        assert.match(whole.slice(meta.next_offset - 1, meta.next_offset + 1), /^\s/, 'cut after a space or break');
        assert.match(text, /\[Transcript continues: call get_jw_captions again with the same arguments and offset \d+/);
      } else {
        assert.equal(meta.next_offset, null);
        assert.doesNotMatch(text, /Transcript continues/);
      }
      joined += chunk;
      offset = meta.next_offset;
    }
    assert.equal(offset, null);
    assert.equal(joined, whole);
    assert.equal(calls.filter((u) => u === VTT_URL).length, 1, 'later parts come from the cache');
  });

  it('clamps a vtt part to 50000 characters, with paging for the rest', async () => {
    const big = vttOf(Array.from({ length: 900 }, (_, i) => [i * 5, i * 5 + 4.5, `Synthetic cue ${i + 1} for the raw file.`]));
    useRoutes([
      [mediatorUrl('E', 'pub-long_1_VIDEO'), json(media({ key: 'pub-long_1_VIDEO' }))],
      [VTT_URL, body(big)]
    ]);
    const { meta } = parts(await call({ video_id: 'pub-long_1_VIDEO', format: 'vtt', max_chars: 80000 }));
    assert.ok(meta.total_chars > 50000, `fixture is ${meta.total_chars} chars`);
    assert.ok(meta.returned_chars <= 50000);
    assert.equal(meta.truncated, true);
    assert.equal(typeof meta.next_offset, 'number');
  });

  it('rejects an offset past the end and says how long the transcript is', async () => {
    const res = await call({ video_id: 'pub-long_1_VIDEO', offset: 999999 });
    assertError(res, /Invalid "offset": expected an integer from 0 to \d+, got 999999\.\nNext step: The text transcript has \d+ characters/);
  });
});

describe('get_jw_captions: default part size', () => {
  // A cue a sentence long; n cues give about 55 * n characters of transcript.
  const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const program = (n) => vttOf(Array.from({ length: n }, (_, i) => [i * 4, i * 4 + 3.5, `This is synthetic caption sentence ${WORDS[i % 8]} of a program.`]));
  const serve = (vtt) =>
    useRoutes([
      [mediatorUrl('E', 'pub-long_1_VIDEO'), json(media({ key: 'pub-long_1_VIDEO' }))],
      [VTT_URL, body(vtt)]
    ]);

  it('returns a monthly-program-length transcript (about 45K characters) in one part', async () => {
    serve(program(860));
    const { meta } = parts(await call({ video_id: 'pub-long_1_VIDEO' }));
    assert.ok(meta.total_chars > 40000 && meta.total_chars <= 60000, `fixture is ${meta.total_chars} chars`);
    assert.equal(meta.truncated, false);
    assert.equal(meta.returned_chars, meta.total_chars);
  });

  it('splits a longer transcript into equal parts instead of a full part and a small tail', async () => {
    serve(program(1430));
    const first = parts(await call({ video_id: 'pub-long_1_VIDEO' }));
    const { total_chars: total } = first.meta;
    assert.ok(total > 60000 && total < 120000, `fixture is ${total} chars`);
    assert.equal(first.meta.truncated, true);
    const second = parts(await call({ video_id: 'pub-long_1_VIDEO', offset: first.meta.next_offset }));
    assert.equal(second.meta.truncated, false);
    const [a, b] = [first.meta.returned_chars, second.meta.returned_chars];
    assert.ok(a <= 60000 && b <= 60000);
    assert.ok(Math.abs(a - b) <= 0.1 * Math.max(a, b), `parts of ${a} and ${b}`);
    assert.equal(a + b, total);
  });

  it('keeps each part of a Japanese transcript within about 20K estimated tokens', async () => {
    // Synthetic kana/kanji, about one token a character: 2,000 cues of 18 characters.
    const vtt = vttOf(Array.from({ length: 2000 }, (_, i) => [i * 3, i * 3 + 2.5, `これは字幕の試験用の文です番号${'一二三四五六七八九十'[i % 10]}`]));
    serve(vtt);
    let offset = 0;
    let count = 0;
    let total = 0;
    while (offset !== null && count < 10) {
      const { meta, text } = parts(await call({ video_id: 'pub-long_1_VIDEO', offset }));
      const part = text.replace(/\n\n\[Transcript continues:[^\]]*\]$/, '');
      assert.ok(estimateTokens(part) <= 20500, `part ${count} is about ${estimateTokens(part)} tokens`);
      total = meta.total_chars;
      offset = meta.next_offset;
      count++;
    }
    assert.equal(offset, null);
    assert.ok(total > 30000 && count >= 2, `${total} characters in ${count} parts`);
  });
});

describe('get_jw_captions: the newest video of a category', () => {
  const categoryUrl = (lang, key, query = 'limit=100') => `https://b.jw-cdn.org/apis/mediator/v1/categories/${lang}/${key}?clientType=www&${query}`;
  const category = (fields, totalCount) =>
    json({ category: { key: 'StudioMonthlyPrograms', type: 'ondemand', name: 'Monthly Programs', ...fields }, pagination: { totalCount: totalCount ?? fields.media?.length ?? 0 } });
  // One media item with its own key, title and first publish date.
  const item = (key, title, firstPublished) => ({ ...media({ key, title }).media[0], firstPublished });

  it('reads the newest video of a date-ordered category and names the one before', async () => {
    const list = [item('pub-jwb-999_1_VIDEO', 'JW Broadcasting—Test Month', '2026-10-05T18:07:06Z'), item('pub-jwb-998_1_VIDEO', 'JW Broadcasting—Month Before', '2026-09-07T13:01:44Z')];
    useRoutes([
      [categoryUrl('E', 'StudioMonthlyPrograms', 'limit=6'), category({ media: list })],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    for (const video_id of ['latest monthly broadcast', 'latest:StudioMonthlyPrograms', 'https://www.jw.org/en/library/videos/#en/categories/StudioMonthlyPrograms']) {
      const { meta, text } = parts(await call({ video_id }));
      assert.equal(meta.key, 'pub-jwb-999_1_VIDEO');
      assert.equal(meta.title, 'JW Broadcasting—Test Month');
      assert.match(meta.notes[0], /newest video in the JW\.org category "Monthly Programs" \(StudioMonthlyPrograms\)\./);
      assert.match(meta.notes[0], /Earlier ones \(pass a key as video_id, or latest:StudioMonthlyPrograms~N for the Nth before the newest\): pub-jwb-998_1_VIDEO \("JW Broadcasting—Month Before", 2026-09-07\)/);
      assert.match(text, /Welcome to this synthetic program/);
    }
    const listings = calls.filter((u) => u.includes('/categories/'));
    assert.deepEqual(listings, [categoryUrl('E', 'StudioMonthlyPrograms', 'limit=6')], 'one small request, then the cache');
  });

  it('picks the latest firstPublished of a curated category, not its first item', async () => {
    const list = [
      item('pub-old_1_VIDEO', 'Shown First', '2020-03-19T00:00:00Z'),
      item('pub-mid_1_VIDEO', 'In Between', '2025-12-04T00:00:00Z'),
      item('pub-new_1_VIDEO', 'Newest By Date', '2026-04-23T00:00:00Z')
    ];
    useRoutes([
      [categoryUrl('E', 'VODTestTeachings'), category({ key: 'VODTestTeachings', name: 'Test Teachings', media: list })],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: 'latest:VODTestTeachings' }));
    assert.equal(meta.key, 'pub-new_1_VIDEO');
    assert.match(meta.notes[0], /newest video in the JW\.org category "Test Teachings" \(VODTestTeachings\)\. Earlier ones [^)]*\): pub-mid_1_VIDEO[^;]*; pub-old_1_VIDEO/);
    assert.deepEqual(calls.filter((u) => u.includes('/categories/')), [categoryUrl('E', 'VODTestTeachings')]);
  });

  it('reads every page of a long curated category', async () => {
    const first = Array.from({ length: 100 }, (_, i) => item(`pub-p${i}_1_VIDEO`, `Video ${i}`, `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`));
    useRoutes([
      [categoryUrl('E', 'VODLong'), category({ key: 'VODLong', name: 'Long', media: first }, 101)],
      [categoryUrl('E', 'VODLong', 'limit=100&offset=100'), category({ key: 'VODLong', name: 'Long', media: [item('pub-last_1_VIDEO', 'On Page Two', '2026-01-01T00:00:00Z')] }, 101)],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: 'latest:VODLong' }));
    assert.equal(meta.key, 'pub-last_1_VIDEO');
    assert.doesNotMatch(meta.notes[0], /first \d+ listed/);
    assert.equal(calls.filter((u) => u.includes('/categories/')).length, 2);
  });

  it('says so when no video has a date, instead of calling the first one the newest', async () => {
    const undated = (key) => ({ ...item(key, key, ''), firstPublished: undefined });
    useRoutes([
      [categoryUrl('E', 'VODNoDates'), category({ key: 'VODNoDates', name: 'No Dates', media: [undated('pub-a_1_VIDEO'), undated('pub-b_1_VIDEO')] })],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: 'latest:VODNoDates' }));
    assert.equal(meta.key, 'pub-a_1_VIDEO');
    assert.match(meta.notes[0], /first video jw\.org lists in the category "No Dates" \(VODNoDates\), in its own order, not by date/);
    assert.doesNotMatch(meta.notes[0], /newest/);
  });

  it('reports an unknown category, a group of categories and an empty one as errors', async () => {
    useRoutes([
      [categoryUrl('E', 'NoSuchCategory'), status(404)],
      [categoryUrl('E', 'VideoOnDemand'), json({ category: { key: 'VideoOnDemand', type: 'container', name: 'Video Categories' } })],
      [categoryUrl('E', 'VideoOnDemand', 'detailed=1'), json({ category: { key: 'VideoOnDemand', type: 'container', name: 'Video Categories', subcategories: [{ key: 'StudioTalks', name: 'Talks' }, { key: 'StudioNewsReports', name: 'News' }] } })],
      [categoryUrl('E', 'VODProgramsEvents'), json({ category: { key: 'VODProgramsEvents', type: 'container', name: 'Programs and Events' } })],
      [categoryUrl('E', 'VODProgramsEvents', 'detailed=1'), status(500)],
      [categoryUrl('E', 'EmptyOne'), category({ key: 'EmptyOne', media: [] })]
    ]);
    const unknown = await call({ video_id: 'latest:NoSuchCategory' });
    assertError(unknown, /JW\.org has no video category "NoSuchCategory"\.\nNext step: Use one of latest:StudioMonthlyPrograms/);
    assert.match(unknown.content[0].text, /latest:StudioNewsReports/);
    const group = await call({ video_id: 'https://www.jw.org/en/library/videos/#en/categories/VideoOnDemand' });
    assertError(group, /is a group of video categories, not a list of videos\.\nNext step: Pass one of its categories: latest:StudioTalks \(Talks\), latest:StudioNewsReports \(News\)\./);
    // The key form and the link form read the same category.
    for (const video_id of ['latest:VODProgramsEvents', 'https://www.jw.org/en/library/videos/#en/categories/VODProgramsEvents']) {
      assertError(await call({ video_id }), /"Programs and Events" \(VODProgramsEvents\) on JW\.org is a group of video categories[^]*Next step: Use one of latest:/);
    }
    assertError(await call({ video_id: 'latest:EmptyOne' }), /category EmptyOne lists no videos in English \(E\)\.\nNext step: Use one of latest:/);
  });
});

describe('get_jw_captions: JW codes in links', () => {
  const DIRECTORY = 'https://b.jw-cdn.org/apis/mediator/v1/languages/E/all';
  const directory = json({ languages: [{ code: 'E', locale: 'en', name: 'English' }, { code: 'TL', locale: 'ta', name: 'Tamil' }, { code: 'FR', locale: 'fo', name: 'Faroese' }] });

  it('reads wtlocale=TL, a _TL_ key and media-items/TL/ as Tamil, not Tagalog', async () => {
    const vttTL = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_TL_1.vtt';
    useRoutes([
      [DIRECTORY, directory],
      [mediatorUrl('TL', 'pub-test_1_VIDEO'), json(media({ lang: 'TL', title: 'Tamil test', subtitles: vttTL }))],
      [vttTL, body(SHORT_VTT)]
    ]);
    for (const video_id of [
      'https://www.jw.org/finder?wtlocale=TL&lank=pub-test_1_VIDEO',
      'pub-test_TL_1_VIDEO',
      'https://b.jw-cdn.org/apis/mediator/v1/media-items/TL/pub-test_1_VIDEO?clientType=www'
    ]) {
      const { meta } = parts(await call({ video_id }));
      assert.equal(meta.language, 'TL', video_id);
      assert.equal(meta.language_name, 'Tamil');
    }
    assert.ok(!calls.some((u) => u.includes('/TG/')), 'never Tagalog');
  });

  it('reads wtlocale=FR as Faroese and an explicit wtlocale argument as a code', async () => {
    useRoutes([
      [DIRECTORY, directory],
      [mediatorUrl('FR', 'pub-test_1_VIDEO'), json(media({ lang: 'FR', title: 'Faroese test' }))],
      [mediatorUrl('TL', 'pub-test_1_VIDEO'), json(media({ lang: 'TL', title: 'Tamil test' }))],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    assert.equal(parts(await call({ video_id: 'https://www.jw.org/finder?wtlocale=FR&lank=pub-test_1_VIDEO' })).meta.language, 'FR');
    assert.equal(parts(await call({ video_id: 'pub-test_1_VIDEO', wtlocale: 'TL' })).meta.language, 'TL');
  });
});

describe('get_jw_captions: every failure is an isError result', () => {
  const offline = [
    [{}, /Missing required "video_id": expected a JW\.org video key/],
    [{ video_id: '   ' }, /Missing required "video_id"/],
    [{ video_id: 42 }, /Could not find a JW\.org video in "42"/],
    [{ video_id: { id: 'x' } }, /Invalid "video_id"/],
    [{ video_id: ['pub-a_1_VIDEO'] }, /Invalid "video_id"/],
    [{ video_id: true }, /Invalid "video_id"/],
    [{ video_id: 'x'.repeat(3000) }, /Invalid "video_id"/],
    [{ video_id: 'https://www.youtube.com/watch?v=abc' }, /not a JW\.org link/],
    [{ video_id: 'pub-a_1_VIDEO', format: 'srt' }, /Invalid "format": expected one of "text", "plain", "vtt"/],
    [{ video_id: 'pub-a_1_VIDEO', format: 'constructor' }, /Invalid "format"/],
    [{ video_id: 'pub-a_1_VIDEO', format: '__proto__' }, /Invalid "format"/],
    [{ video_id: 'pub-a_1_VIDEO', max_chars: 10 }, /Invalid "max_chars": expected an integer from 1000 to 80000/],
    [{ video_id: 'pub-a_1_VIDEO', max_chars: 200000 }, /Invalid "max_chars": expected an integer from 1000 to 80000/],
    [{ video_id: 'pub-a_1_VIDEO', max_chars: 'lots' }, /Invalid "max_chars"/],
    [{ video_id: 'pub-a_1_VIDEO', offset: -1 }, /Invalid "offset": expected an integer of at least 0/],
    [{ video_id: 'pub-a_1_VIDEO', langwritten: 42 }, /Invalid "langwritten"/]
  ];
  for (const [args, pattern] of offline) {
    it(`${JSON.stringify(args).slice(0, 70)} fails without touching the network`, async () => {
      assertError(await call(args), pattern);
      assert.equal(calls.length, 0);
    });
  }

  it('handles missing and non-object arguments', async () => {
    assertError(await handleCaptionsTool({ params: { name: 'get_jw_captions' } }), /Missing required "video_id"/);
    assertError(await handleCaptionsTool({ params: { name: 'get_jw_captions', arguments: null } }), /Missing required "video_id"/);
    assertError(await handleCaptionsTool({ params: { name: 'get_jw_captions', arguments: [] } }), /Invalid "arguments"/);
    assertError(await getCaptionsImplementation(undefined), /Missing required "video_id"/);
  });

  it('names the key and the languages tried when the video does not exist', async () => {
    useRoutes([
      [mediatorUrl('S', 'pub-nope_1_VIDEO'), json(empty)],
      [mediatorUrl('E', 'pub-nope_1_VIDEO'), json(empty)]
    ]);
    const res = await call({ video_id: 'pub-nope_1_VIDEO', langwritten: 'S' });
    assertError(res, /JW\.org has no video with the key pub-nope_1_VIDEO \(looked up in Spanish \(S\) and English \(E\)\)\.\nNext step: Check the key/);
  });

  it('treats a mediator 404 as not found', async () => {
    useRoutes([[mediatorUrl('E', 'pub-nope_1_VIDEO'), status(404)]]);
    assertError(await call({ video_id: 'pub-nope_1_VIDEO' }), /no video with the key pub-nope_1_VIDEO \(looked up in English \(E\)\)/);
  });

  it('reports a failing mediator with host and status (after one retry)', async () => {
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), status(503)]]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO' }), /b\.jw-cdn\.org returned 503 .*\nNext step: JW\.org is having trouble/);
    assert.equal(calls.length, 2);
  });

  it('reports HTML or an unexpected shape from the mediator', async () => {
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), body('<html>Access denied</html>', 'text/html')]]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO' }), /returned an HTML page instead of JSON/);
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), json({ error: 'nope' })]]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO' }), /without a media list/);
  });

  it('names the video when its caption file cannot be downloaded', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, status(404)]
    ]);
    assertError(
      await call({ video_id: 'pub-test_1_VIDEO' }),
      /Found "A Synthetic Test Program" \(pub-test_1_VIDEO, E\) but could not download its caption file: cfp2\.jw-cdn\.org returned 404/
    );
  });

  it('rejects a caption file that is not WebVTT', async () => {
    useRoutes([
      [mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())],
      [VTT_URL, body('<html><body>Service unavailable</body></html>', 'text/html')]
    ]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO' }), /cfp2\.jw-cdn\.org did not return a WebVTT caption file/);
  });

  it('reports a page that fails to load', async () => {
    const url = 'https://www.jw.org/en/library/videos/gone/';
    useRoutes([[url, status(404)]]);
    assertError(await call({ video_id: url }), /www\.jw\.org returned 404 .*\/videos\/gone\//);
  });
});

describe('get_jw_captions: series, earlier videos and months', () => {
  const categoryUrl = (lang, key, query = 'limit=100') => `https://b.jw-cdn.org/apis/mediator/v1/categories/${lang}/${key}?clientType=www&${query}`;
  const category = (key, name, list, totalCount = list.length) =>
    json({ category: { key, type: 'ondemand', name, media: list }, pagination: { totalCount } });
  const item = (key, title, firstPublished) => ({ ...media({ key, title }).media[0], firstPublished });

  it('reads the series and how far back from free text, without swallowing ~N', () => {
    for (const s of ['latest Governing Body update', 'latest update', 'the latest Governing Body updates']) {
      assert.deepEqual([parseVideoReference(s).category, parseVideoReference(s).series], ['StudioNewsReports', 'gbUpdate'], s);
    }
    for (const s of ['latest news', 'latest:StudioNewsReports', 'latest Governing Body talk']) assert.equal(parseVideoReference(s).series, undefined, s);
    assert.deepEqual(pick(parseVideoReference('latest:StudioMonthlyPrograms~2')), ['StudioMonthlyPrograms', 2]);
    assert.deepEqual(pick(parseVideoReference('latest broadcast ~ 3')), ['StudioMonthlyPrograms', 3]);
    assert.deepEqual(pick(parseVideoReference('previous broadcast')), ['StudioMonthlyPrograms', 1]);
    assert.deepEqual(pick(parseVideoReference('the previous morning worship')), ['VODPgmEvtMorningWorship', 1]);
    assert.deepEqual(pick(parseVideoReference('the last morning worship')), ['VODPgmEvtMorningWorship', 0], '"last" is the most recent');
    assert.equal(parseVideoReference('latest broadcast').back, 0);
    assert.throws(() => parseVideoReference('latest:StudioMonthlyPrograms~600'), /reaches back 600 videos; the limit is 499/);
    for (const [s, month] of [['August 2026 broadcast', '2026-08'], ['the September 2026 JW Broadcasting', '2026-09'], ['JW Broadcasting—August 2026', '2026-08'], ['2026-07 monthly program', '2026-07']]) {
      const ref = parseVideoReference(s);
      assert.deepEqual([ref.category, ref.month], ['StudioMonthlyPrograms', month], s);
    }
    function pick(ref) {
      return [ref.category, ref.back];
    }
  });

  const NEWS_E = [
    item('pub-mwbv_202609_1_VIDEO', '2024 Governing Body Update #6—Excerpt', '2026-08-17T00:00:00Z'),
    item('pub-jwb-134_6_VIDEO', '2025 Sample Construction Project Update', '2026-08-10T00:00:00Z'),
    item('docid-5_1_VIDEO', '2026 Governing Body Update #5', '2026-08-01T00:00:00Z'),
    item('docid-4_1_VIDEO', '2026 Governing Body Update #4', '2026-06-01T00:00:00Z')
  ];

  it('picks the newest real Governing Body update, skipping excerpts and news', async () => {
    useRoutes([[categoryUrl('E', 'StudioNewsReports'), category('StudioNewsReports', 'News', NEWS_E)], [VTT_URL, body(SHORT_VTT)]]);
    const { meta } = parts(await call({ video_id: 'latest Governing Body update' }));
    assert.equal(meta.key, 'docid-5_1_VIDEO');
    assert.match(meta.notes[0], /newest Governing Body update \(titled "<year> Governing Body Update #<n>"\) in the JW\.org category "News" \(StudioNewsReports\); excerpts and news reports there are skipped/);
    assert.match(meta.notes[0], /Earlier ones \(pass a key as video_id, or latest Governing Body update~N [^)]*\): docid-4_1_VIDEO \("2026 Governing Body Update #4"/);
    assert.equal(parts(await call({ video_id: 'latest Governing Body update~1' })).meta.key, 'docid-4_1_VIDEO');
    const news = parts(await call({ video_id: 'latest news' }));
    assert.equal(news.meta.key, 'pub-mwbv_202609_1_VIDEO', 'news is the whole category');
    assert.equal(calls.filter((u) => u.includes('/categories/')).length, 1, 'one listing for both');
  });

  it('in another language, picks the newest update already published there', async () => {
    const english = [item('docid-6_1_VIDEO', '2026 Governing Body Update #6', '2026-09-01T00:00:00Z'), ...NEWS_E];
    const spanish = [
      item('pub-mwbv_202609_1_VIDEO', 'Informe del Cuerpo Gobernante 2024 n.º 6 (extracto)', '2026-08-17T00:00:00Z'),
      item('docid-5_1_VIDEO', 'Informe del Cuerpo Gobernante 2026 n.º 5', '2026-08-02T00:00:00Z'),
      item('docid-4_1_VIDEO', 'Informe del Cuerpo Gobernante 2026 n.º 4', '2026-06-02T00:00:00Z')
    ];
    useRoutes([
      [categoryUrl('S', 'StudioNewsReports'), category('StudioNewsReports', 'Noticias', spanish)],
      [categoryUrl('E', 'StudioNewsReports'), category('StudioNewsReports', 'News', english)],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const { meta } = parts(await call({ video_id: 'latest Governing Body update', langwritten: 'S' }));
    assert.equal(meta.key, 'docid-5_1_VIDEO');
    assert.equal(meta.language, 'S');
  });

  it('says so when no title marks an update, and returns the newest video', async () => {
    const plain = [item('pub-a_1_VIDEO', 'Something New', '2026-08-17T00:00:00Z'), item('pub-b_1_VIDEO', 'Something Old', '2026-01-01T00:00:00Z')];
    useRoutes([[categoryUrl('E', 'StudioNewsReports'), category('StudioNewsReports', 'News', plain)], [VTT_URL, body(SHORT_VTT)]]);
    const res = await call({ video_id: 'latest Governing Body update' });
    assert.equal(res.isError, undefined);
    const { meta } = parts(res);
    assert.equal(meta.key, 'pub-a_1_VIDEO');
    assert.match(meta.notes[0], /^Could not tell Governing Body updates from other news in "News" by title, so this is simply the category's newest video; check the title\./);
  });

  it('reads the Nth video before the newest', async () => {
    const programs = Array.from({ length: 9 }, (_, i) => item(`pub-jwb-${150 - i}_1_VIDEO`, `Program ${150 - i}`, `2026-${String(9 - i).padStart(2, '0')}-05T00:00:00Z`));
    const worship = [
      item('pub-mw-a_1_VIDEO', 'Shown First', '2026-01-01T00:00:00Z'),
      item('pub-mw-b_1_VIDEO', 'Newest', '2026-09-01T00:00:00Z'),
      item('pub-mw-c_1_VIDEO', 'Second', '2026-08-01T00:00:00Z'),
      item('pub-mw-d_1_VIDEO', 'Third', '2026-07-01T00:00:00Z')
    ];
    useRoutes([
      [categoryUrl('E', 'StudioMonthlyPrograms'), category('StudioMonthlyPrograms', 'Monthly Programs', programs, 9)],
      [categoryUrl('E', 'VODPgmEvtMorningWorship'), category('VODPgmEvtMorningWorship', 'Morning Worship', worship)],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const third = parts(await call({ video_id: 'latest:StudioMonthlyPrograms~2' }));
    assert.equal(third.meta.key, 'pub-jwb-148_1_VIDEO');
    assert.match(third.meta.notes[0], /This is number 2 before the newest video in the JW\.org category "Monthly Programs"/);
    assert.match(third.meta.notes[0], /Earlier ones [^)]*\): pub-jwb-147_1_VIDEO/);
    assert.equal(parts(await call({ video_id: 'previous broadcast' })).meta.key, 'pub-jwb-149_1_VIDEO');
    assert.equal(parts(await call({ video_id: 'latest:StudioMonthlyPrograms~3' })).meta.key, 'pub-jwb-147_1_VIDEO');
    assert.equal(calls.filter((u) => u.includes('/StudioMonthlyPrograms')).length, 1, '~1, ~2 and ~3 share one listing');
    assert.equal(parts(await call({ video_id: 'latest:VODPgmEvtMorningWorship~2' })).meta.key, 'pub-mw-d_1_VIDEO');
    assertError(await call({ video_id: 'latest:VODPgmEvtMorningWorship~4' }), /"Morning Worship" \(VODPgmEvtMorningWorship\) lists only 4 videos\.\nNext step: Use a smaller ~N/);
  });

  it('finds the monthly program of a month by its publish date', async () => {
    // Newest first, one a month: pub-jwb-150 is October 2026, 149 September 2026 ...
    const page = (offset) => Array.from({ length: 12 }, (_, i) => {
      const n = offset + i;
      const d = new Date(Date.UTC(2026, 9 - n, 5));
      return item(`pub-jwb-${150 - n}_1_VIDEO`, `Program ${150 - n}`, d.toISOString());
    });
    useRoutes([
      [categoryUrl('E', 'StudioMonthlyPrograms', 'limit=12'), category('StudioMonthlyPrograms', 'Monthly Programs', page(0), 68)],
      [categoryUrl('E', 'StudioMonthlyPrograms', 'limit=12&offset=12'), category('StudioMonthlyPrograms', 'Monthly Programs', page(12), 68)],
      [/limit=12&offset=/, category('StudioMonthlyPrograms', 'Monthly Programs', [], 68)],
      [VTT_URL, body(SHORT_VTT)]
    ]);
    const sept = parts(await call({ video_id: 'September 2026 broadcast' }));
    assert.equal(sept.meta.key, 'pub-jwb-149_1_VIDEO');
    assert.match(sept.meta.notes[0], /first published in September 2026/);
    assert.equal(parts(await call({ video_id: 'JW Broadcasting—August 2025' })).meta.key, 'pub-jwb-136_1_VIDEO');
    assertError(await call({ video_id: 'December 2019 broadcast' }), /JW\.org lists no monthly program published in December 2019\.\nNext step: Pass latest:StudioMonthlyPrograms/);
    assert.ok(calls.filter((u) => u.includes('/categories/')).length <= 6);
  });

  it('notes a language code read as an ISO tag', async () => {
    useRoutes([[mediatorUrl('TG', 'pub-test_1_VIDEO'), json(media({ lang: 'TG' }))], [VTT_URL, body(SHORT_VTT)]]);
    const { meta } = parts(await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'TL' }));
    assert.equal(meta.language, 'TG');
    assert.ok(meta.notes.some((n) => /"TL" was read as the ISO tag for Tagalog/.test(n)), meta.notes.join('\n'));
  });
});

describe('transcript text', () => {
  const plain = (cues) => formatTranscript(parseVtt(vttOf(cues)), { timestamps: false });
  const cues = (texts) => texts.map((text, i) => [i * 2, i * 2 + 2, text]);

  it('keeps identical cues that do not overlap, merges ones that do', () => {
    const parsed = parseVtt(vttOf([[1, 3, 'Amen.'], [3, 4, 'Amen.'], [5, 7, 'Amen.'], [6, 8, 'Amen.']]));
    assert.deepEqual(parsed.map((c) => [c.start, c.end]), [[1, 3], [3, 4], [5, 8]]);
    assert.equal(formatTranscript(parsed, { timestamps: false }), 'Amen. Amen. Amen.');
    assert.equal(parseVtt(vttOf([[1, 3, 'X.'], [4, 6, 'X.']])).length, 2);
  });

  it('shows a quotation\'s opening mark once, not at the start of every cue', () => {
    assert.equal(plain(cues(['<b>“</b>Put forth effort', '“to supply virtue,', 'to love.”'])), '“Put forth effort to supply virtue, to love.”');
    assert.equal(
      plain(cues(['“And he said:', '“‘If you are', '“‘tell these stones', '“to become bread.’', '“But he answered: ‘It is written: “Man must live,', '“‘“not on bread alone.”’”', '“New quote.”'])),
      '“And he said: ‘If you are tell these stones to become bread.’ But he answered: ‘It is written: “Man must live, not on bread alone.”’” “New quote.”'
    );
    assert.equal(plain(cues(['He thought: ‘Jehovah’s view', '‘matters.’', '‘Next.’'])), 'He thought: ‘Jehovah’s view matters.’ ‘Next.’');
    assert.equal(plain(cues(['‘하루가 낫다’는 말', '‘오 하느님'])), '‘하루가 낫다’는 말 ‘오 하느님');
    assert.equal(plain(cues(['Er sagte: „Komm“ und „geh', '“, sagte er.'])), 'Er sagte: „Komm“ und „geh “, sagte er.');
  });

  it('leaves the vtt format as JW.org wrote it', async () => {
    const vtt = vttOf(cues(['“Put forth effort', '“to supply virtue,', 'to love.”']));
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())], [VTT_URL, body(vtt)]]);
    const { text } = parts(await call({ video_id: 'pub-test_1_VIDEO', format: 'vtt' }));
    assert.match(text, /\n“to supply virtue,/);
  });
});

describe('get_jw_captions: relative months, songs and odd listings', () => {
  const categoryUrl = (lang, key, query = 'limit=100') => `https://b.jw-cdn.org/apis/mediator/v1/categories/${lang}/${key}?clientType=www&${query}`;
  const category = (key, name, list, totalCount = list.length) =>
    json({ category: { key, type: 'ondemand', name, media: list }, pagination: { totalCount } });
  const item = (key, title, firstPublished) => ({ ...media({ key, title }).media[0], firstPublished });

  it('reads this, last and bare months against the server\'s local date', () => {
    const now = new Date(2026, 9, 12);
    const month = (s, at = now) => parseVideoReference(s, { now: at }).month;
    assert.equal(month("last month's broadcast"), '2026-09');
    assert.equal(month("this month's broadcast"), '2026-10');
    assert.equal(month("previous month's JW Broadcasting"), '2026-09');
    assert.equal(month('September broadcast'), '2026-09');
    assert.equal(month('November broadcast'), '2025-11', 'a month not reached yet this year is last year\'s');
    assert.equal(month("last month's broadcast", new Date(2027, 0, 3)), '2026-12');
    assert.equal(parseVideoReference("last month's broadcast", { now }).category, 'StudioMonthlyPrograms');
    assert.throws(() => parseVideoReference("last week's morning worship", { now }), (e) => /names a video by week/.test(e.message) && /latest:VODPgmEvtMorningWorship/.test(e.hint) && /2026-10-12/.test(e.hint));
    assert.throws(() => parseVideoReference("last week's broadcast", { now }), (e) => /comes out once a month/.test(e.message) && /"last month's broadcast"/.test(e.hint));
    assert.throws(() => parseVideoReference("this week's Governing Body update", { now }), (e) => /"latest Governing Body update"/.test(e.hint) && !/latest:StudioNewsReports/.test(e.hint));
    // "last" alone still means the most recent, and "previous" one before it.
    assert.equal(parseVideoReference('the last morning worship').back, 0);
    assert.equal(parseVideoReference('previous broadcast').back, 1);
  });

  it('"last month\'s broadcast" finds last month\'s program, not this month\'s', async () => {
    const today = new Date();
    // Newest first, one a month, the newest published this month.
    const programs = Array.from({ length: 12 }, (_, n) => {
      const d = new Date(today.getFullYear(), today.getMonth() - n, 5);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-05T00:00:00Z`;
      return item(`pub-jwb-${150 - n}_1_VIDEO`, `Program ${150 - n}`, iso);
    });
    useRoutes([[categoryUrl('E', 'StudioMonthlyPrograms', 'limit=12'), category('StudioMonthlyPrograms', 'Monthly Programs', programs, 68)], [VTT_URL, body(SHORT_VTT)]]);
    assert.equal(parts(await call({ video_id: "last month's broadcast" })).meta.key, 'pub-jwb-149_1_VIDEO');
    assert.equal(parts(await call({ video_id: "this month's broadcast" })).meta.key, 'pub-jwb-150_1_VIDEO');
  });

  it('names the month form in the hint when a phrase cannot be read', async () => {
    const res = await call({ video_id: 'the thing from the meeting' });
    assertError(res, /Next step: [^]*"September 2026 broadcast", "last month's broadcast"/);
    assert.match(res.content[0].text, /Next step: [^]*"previous broadcast"/);
    assert.throws(() => parseVideoReference('latest circuit assembly program'), (e) => /"latest Governing Body update" \(the updates only\)/.test(e.hint));
  });

  it('points a song video with no captions to the songbook lyrics, not other languages', async () => {
    const song = (key, lang, title) => json({ ...media({ key, lang, title, subtitles: null }) });
    useRoutes([
      [mediatorUrl('E', 'pub-sjjm_603_VIDEO'), song('pub-sjjm_603_VIDEO', 'E', '103. Shepherds—Gifts in Men (With Audio Descriptions)')],
      [mediatorUrl('S', 'pub-sjjm_652_VIDEO'), song('pub-sjjm_652_VIDEO', 'S', '152. Un lugar que te honrará (con audiodescripciones)')],
      [mediatorUrl('E', 'pub-sjjm_652_VIDEO'), song('pub-sjjm_652_VIDEO', 'E', '152. A Place That Will Bring You Praise (With Audio Descriptions)')]
    ]);
    const en = parts(await call({ video_id: 'https://www.jw.org/finder?wtlocale=E&lank=pub-sjjm_603_VIDEO' })).meta;
    assert.equal(en.captions_available, false);
    assert.doesNotMatch(en.next_step, /another language/);
    assert.match(en.next_step, /lyrics, see the song's page in the songbook: https:\/\/www\.jw\.org\/finder\?wtlocale=E&docid=1102016903\.$/);
    const es = parts(await call({ video_id: 'pub-sjjm_652_VIDEO', langwritten: 'S' })).meta;
    assert.match(es.next_step, /wtlocale=S&docid=1102022952/);
  });

  it('maps song numbers to WOL docids', async () => {
    const { songbookDocid, songOfKey } = await import('../../src/tools/songbook.js');
    assert.deepEqual([1, 151, 160, 0, 200].map(songbookDocid), ['1102016801', '1102016951', '1102022960', null, null]);
    assert.deepEqual(['pub-sjjm_103_VIDEO', 'pub-sjjm_603_VIDEO', 'pub-jwb-142_1_VIDEO'].map(songOfKey), [103, 103, null]);
  });

  it('skips a listed video with odd field types instead of failing', async () => {
    const list = [
      item('pub-jwb-150_1_VIDEO', 'Program 150', '2026-10-05T00:00:00Z'),
      { ...item('pub-jwb-149_1_VIDEO', 'Program 149', '2026-09-05T00:00:00Z'), firstPublished: 5 },
      { ...item('pub-jwb-148_1_VIDEO', 'x', '2026-08-05T00:00:00Z'), title: {} }
    ];
    useRoutes([[categoryUrl('E', 'StudioMonthlyPrograms', 'limit=6'), category('StudioMonthlyPrograms', 'Monthly Programs', list)], [VTT_URL, body(SHORT_VTT)]]);
    const res = await call({ video_id: 'latest broadcast' });
    const { meta, text } = parts(res);
    assert.equal(meta.key, 'pub-jwb-150_1_VIDEO');
    assert.match(text, /Welcome to this synthetic program/);
    const note = meta.notes.join(' ');
    assert.doesNotMatch(note, /unexpectedly|\[object Object\]|"null"/);
    assert.doesNotMatch(note, /pub-jwb-149_1_VIDEO/, 'no usable date');
    assert.match(note, /pub-jwb-148_1_VIDEO \(2026-08-05\)/);
  });

  it('closes an em dash split across English cues or lines, and keeps Spanish spacing', async () => {
    const vtt = vttOf([
      [1, 3, 'the times we’re facing'],
      [3, 5, '—anxious times.'],
      [5, 9, 'the concerns that we have—\nmake us aware.']
    ]);
    const english = formatTranscript(parseVtt(vtt, { closedDashes: true }), { timestamps: false, closedDashes: true });
    assert.equal(english, 'the times we’re facing—anxious times. the concerns that we have—make us aware.');
    assert.match(formatTranscript(parseVtt(vtt), { timestamps: false }), /facing —anxious/, 'off by default');
    const spanishVtt = vttOf([[1, 3, 'Los judíos'], [3, 5, '—cansados de esperar— oyeron.']]);
    const S_VTT = 'https://cfp2.jw-cdn.org/a/abc/1/o/test_S_1.vtt';
    useRoutes([[mediatorUrl('S', 'pub-test_1_VIDEO'), json(media({ lang: 'S', subtitles: S_VTT }))], [S_VTT, body(spanishVtt)]]);
    assert.match(parts(await call({ video_id: 'pub-test_1_VIDEO', langwritten: 'S' })).text, /Los judíos —cansados/);
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())], [VTT_URL, body(vtt)]]);
    assert.match(parts(await call({ video_id: 'pub-test_1_VIDEO' })).text, /facing—anxious times\. the concerns that we have—make us/);
  });

  it('explains a 403 from the captions file server as a missing file', async () => {
    useRoutes([[mediatorUrl('E', 'pub-test_1_VIDEO'), json(media())], [VTT_URL, status(403)]]);
    assertError(await call({ video_id: 'pub-test_1_VIDEO' }), /Next step: JW\.org's file server answers 403 when a captions file does not exist/);
  });
});
