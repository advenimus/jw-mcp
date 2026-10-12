// Live checks of get_jw_captions against JW.org (about 34 requests).
// Skipped unless JW_MCP_LIVE=1.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleCaptionsTool } from '../../src/tools/captions-tool.js';
import { fetchJson } from '../../src/tools/http.js';
import { estimateTokens } from '../../src/tools/results.js';

const LIVE = process.env.JW_MCP_LIVE === '1';
const skip = LIVE ? false : 'set JW_MCP_LIVE=1 to run live tests';

async function call(args) {
  return handleCaptionsTool({ params: { name: 'get_jw_captions', arguments: args } });
}

function ok(res) {
  assert.notEqual(res.isError, true, res.content[0].text);
  return { meta: JSON.parse(res.content[0].text), text: res.content[1]?.text };
}

function assertTranscript(text) {
  assert.match(text, /^\[\d+:\d{2}\] \S/);
  assert.doesNotMatch(text, /WEBVTT|-->|align:center|<\/?[bi]>/);
}

describe('get_jw_captions live', { skip }, () => {
  it('reads the October 2026 monthly program in one call', async () => {
    const whole = ok(await call({ video_id: 'pub-jwb-142_1_VIDEO' }));
    assert.match(whole.meta.title, /JW Broadcasting/);
    assert.equal(whole.meta.key, 'pub-jwb-142_1_VIDEO');
    assert.equal(whole.meta.language, 'E');
    assert.equal(whole.meta.category, 'StudioMonthlyPrograms');
    assert.match(whole.meta.published, /^2026-10-\d\d$/);
    assert.ok(whole.meta.duration_seconds > 1800, `duration ${whole.meta.duration}`);
    assertTranscript(whole.text);
    assert.ok(whole.meta.total_chars > 40000, `total ${whole.meta.total_chars}`);
    assert.equal(whole.meta.truncated, false);
    assert.equal(whole.meta.returned_chars, whole.meta.total_chars);
  });

  it('pages the same program in two about equal parts with max_chars 25000', async () => {
    const first = ok(await call({ video_id: 'pub-jwb-142_1_VIDEO', max_chars: 25000 }));
    assert.equal(first.meta.truncated, true);
    assert.ok(first.meta.returned_chars <= 25000);
    const second = ok(await call({ video_id: 'pub-jwb-142_1_VIDEO', max_chars: 25000, offset: first.meta.next_offset }));
    assert.equal(second.meta.truncated, false);
    assert.equal(second.meta.next_offset, null);
    assert.equal(first.meta.returned_chars + second.meta.returned_chars, first.meta.total_chars);
    assert.ok(Math.abs(first.meta.returned_chars - second.meta.returned_chars) < 0.1 * first.meta.total_chars);
  });

  it('finds the newest monthly program with latest:StudioMonthlyPrograms', async () => {
    const { meta } = ok(await call({ video_id: 'latest:StudioMonthlyPrograms', max_chars: 1000 }));
    assert.match(meta.title, /^JW Broadcasting/);
    assert.equal(meta.category, 'StudioMonthlyPrograms');
    const age = (Date.now() - new Date(meta.published).getTime()) / 86400000;
    assert.ok(age >= 0 && age < 45, `published ${meta.published}`);
    assert.match(meta.notes.join(' '), /newest video in the JW\.org category/);
  });

  it('picks the latest publish date of a curated category, not its first item', async () => {
    const { meta } = ok(await call({ video_id: 'latest:VODBibleTeachings', max_chars: 1000 }));
    const listing = await fetchJson('https://b.jw-cdn.org/apis/mediator/v1/categories/E/VODBibleTeachings?clientType=www&limit=100');
    const dates = listing.category.media.map((m) => m.firstPublished.slice(0, 10));
    for (const date of dates) assert.ok(meta.published >= date, `${meta.published} is before ${date}`);
    assert.match(meta.notes.join(' '), /newest video in the JW\.org category .* \(VODBibleTeachings\)/);
  });

  it('reads "latest Governing Body update" from StudioNewsReports', async () => {
    const { meta } = ok(await call({ video_id: 'latest Governing Body update', max_chars: 1000 }));
    assert.equal(meta.category, 'StudioNewsReports');
    assert.match(meta.title, /Governing Body Update/i);
  });

  it('reads latest:VODProgramsEvents as that group of categories, listing them', async () => {
    const res = await call({ video_id: 'latest:VODProgramsEvents' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /\(VODProgramsEvents\) on JW\.org is a group of video categories[^]*Next step: Pass one of its categories: latest:\w+/);
  });

  it('keeps sentence breaks in a Japanese transcript, in parts of about 20K tokens', async () => {
    const { meta, text } = ok(await call({ video_id: 'pub-jwb-142_1_VIDEO', langwritten: 'J' }));
    assert.equal(meta.language, 'J');
    assert.ok(estimateTokens(text) <= 21000, `about ${estimateTokens(text)} tokens`);
    const breaks = text.match(/[\p{Script=Hiragana}\p{Script=Han}] [\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? [];
    assert.ok(breaks.length > 100, `${breaks.length} spaced cue breaks`);
  });

  it('reads a Bible book introduction from an address-bar link', async () => {
    const { meta, text } = ok(await call({ video_id: 'https://www.jw.org/en/library/videos/#en/mediaitems/BibleBooks/pub-nwtsv_10_VIDEO' }));
    assert.equal(meta.title, 'Introduction to Genesis');
    assert.equal(meta.key, 'pub-nwtsv_10_VIDEO');
    assert.equal(meta.truncated, false);
    assertTranscript(text);
  });

  it("reads a children's video from a scheme-less share link, without markers", async () => {
    const { meta, text } = ok(await call({ video_id: 'www.jw.org/finder?srcid=share&wtlocale=E&lank=pub-ljf_10_VIDEO', format: 'plain' }));
    assert.match(meta.title, /Ruth/);
    assert.equal(meta.format, 'plain');
    assert.ok(text.length > 500);
    assert.doesNotMatch(text, /\[\d+:\d{2}\]|-->/);
  });

  it('reads Spanish captions when the link says wtlocale=S', async () => {
    const { meta, text } = ok(
      await call({ video_id: 'https://www.jw.org/finder?srcid=share&wtlocale=S&lank=pub-jwb-142_1_VIDEO', max_chars: 5000 })
    );
    assert.equal(meta.language, 'S');
    assert.equal(meta.language_name, 'Spanish');
    assert.match(meta.subtitles_url, /_S_/);
    assert.match(meta.url, /wtlocale=S&lank=pub-jwb-142_1_VIDEO$/);
    assert.match(text, /\b(que|los|las|para)\b/);
    assert.equal(meta.truncated, true);
  });

  it('resolves a finder?docid= link and the video page it redirects to', async () => {
    const viaDocid = ok(await call({ video_id: 'https://www.jw.org/finder?wtlocale=E&docid=502014331' }));
    assert.equal(viaDocid.meta.key, 'docid-502014331_1_VIDEO');
    assert.equal(viaDocid.meta.title, 'Does God Have a Name?');
    const viaPage = ok(await call({ video_id: 'https://www.jw.org/en/library/videos/Good-News-From-God-Video-Series/video-gods-name/' }));
    assert.equal(viaPage.meta.key, 'docid-502014331_1_VIDEO');
  });

  it('returns metadata and a reason for a video without a caption file', async () => {
    const res = await call({ video_id: 'pub-ivdd_x_VIDEO' });
    assert.notEqual(res.isError, true);
    const meta = JSON.parse(res.content[0].text);
    assert.match(meta.title, /David/);
    assert.equal(meta.captions_available, false);
    assert.match(meta.reason, /burned into the picture/);
  });

  it('falls back to English with a note when a language has no captions (ASL)', async () => {
    const { meta } = ok(await call({ video_id: 'pub-jwb-142_1_VIDEO', langwritten: 'ASL', max_chars: 1000 }));
    if (meta.language === 'ASL') {
      assert.equal(meta.captions_available, true);
      if (meta.captions_language) {
        assert.equal(meta.captions_language, 'E');
        assert.match(meta.notes.join(' '), /no American Sign Language \(ASL\) captions/);
      }
    } else {
      assert.equal(meta.language, 'E');
      assert.equal(meta.requested_language, 'ASL');
      assert.match(meta.notes.join(' '), /American Sign Language \(ASL\)/);
    }
  });

  it('reports a key that does not exist, and a docid that is an article', async () => {
    const missing = await call({ video_id: 'pub-doesnotexist_1_VIDEO' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /no video with the key pub-doesnotexist_1_VIDEO/);

    const article = await call({ video_id: 'https://www.jw.org/open?docid=1011511&prefer=content' });
    assert.equal(article.isError, true);
    assert.match(article.content[0].text, /docid 1011511 .*no video player/);
  });
});

describe('get_jw_captions live: series and earlier videos', { skip }, () => {
  it('"latest Governing Body update" is a real update, not an excerpt or news report', async () => {
    const { meta } = ok(await call({ video_id: 'latest Governing Body update', max_chars: 1000 }));
    assert.match(meta.title, /^\d{4} Governing Body Update #\d+$/);
    assert.match(meta.notes.join(' '), /newest Governing Body update/);
  });

  it('"previous broadcast" is the monthly program before the newest', async () => {
    const newest = ok(await call({ video_id: 'latest broadcast', max_chars: 1000 }));
    const before = ok(await call({ video_id: 'previous broadcast', max_chars: 1000 }));
    assert.equal(before.meta.category, 'StudioMonthlyPrograms');
    assert.ok(before.meta.published < newest.meta.published, `${before.meta.published} < ${newest.meta.published}`);
    assert.match(newest.meta.notes.join(' '), new RegExp(before.meta.key));
  });
});

describe('get_jw_captions round 4 (live)', { skip }, () => {
  it('points a song video at its lyrics page', async () => {
    const { meta } = ok(await call({ video_id: 'pub-sjjm_129_VIDEO' }));
    assert.equal(meta.captions_available, false);
    assert.match(meta.next_step, /read_wol_document docid "1102016929"/);
    assert.doesNotMatch(meta.next_step, /another language/);
  });

  it('"last month\'s broadcast" is last month\'s program, counted from the server date', async () => {
    const today = new Date();
    const last = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const month = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;
    const { meta, text } = ok(await call({ video_id: "last month's broadcast", max_chars: 1000 }));
    assert.equal(meta.category, 'StudioMonthlyPrograms');
    assert.equal(meta.published.slice(0, 7), month, meta.title);
    assertTranscript(text);
  });
});
