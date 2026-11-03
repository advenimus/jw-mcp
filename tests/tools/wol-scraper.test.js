import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WOLScraper,
  WOLBlockedError,
  isBotChallenge,
} from '../../src/tools/wol-scraper.js';

const CHALLENGE_HTML = `<!DOCTYPE html><html><head>
<script>window.awsWafCookieDomainList = []; window.gokuProps = {};</script>
</head><body><div id="challenge-container"></div>
<script>AwsWafIntegration.saveReferrer();</script></body></html>`;

const CHAPTER_HTML = `<!DOCTYPE html><html><body>
<span class="v" id="v43-3-16">16 For God loved the world so much</span>
<span class="v" id="v43-3-17">17 For God did not send his Son</span>
</body></html>`;

function fakeResponse(status, body) {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Accepted',
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

function scraperReturning(status, body, calls = []) {
  return new WOLScraper({
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse(status, body);
    },
  });
}

test('isBotChallenge flags the AWS WAF challenge page', () => {
  assert.equal(isBotChallenge(202, CHALLENGE_HTML), true);
  assert.equal(isBotChallenge(200, CHALLENGE_HTML), true);
});

test('isBotChallenge flags an empty 202 response', () => {
  assert.equal(isBotChallenge(202, ''), true);
});

test('isBotChallenge passes a real chapter page', () => {
  assert.equal(isBotChallenge(200, CHAPTER_HTML), false);
});

test('scraper does not pretend to be a browser', () => {
  const calls = [];
  const scraper = scraperReturning(200, CHAPTER_HTML, calls);
  return scraper.extractChapterContent(43, 3).then(() => {
    const ua = calls[0].options.headers['User-Agent'];
    assert.ok(ua, 'User-Agent header must be set');
    assert.doesNotMatch(ua, /Mozilla|Chrome|Safari|AppleWebKit/);
    assert.ok(calls[0].options.headers['Accept-Language']);
  });
});

test('getSingleVerse returns the verse from a real page', async () => {
  const scraper = scraperReturning(200, CHAPTER_HTML);
  const verse = await scraper.getSingleVerse(43, 3, 16);
  assert.equal(verse.verse_num, 16);
  assert.match(verse.verse_text, /God loved the world/);
});

const POETRY_HTML = `<!DOCTYPE html><html><body>
<span class="v" id="v19-91-1-1">91 Anyone dwelling in the secret place of the Most High</span>
<span class="v" id="v19-91-1-2">Will lodge under the shadow of the Almighty.</span>
<span class="v" id="v19-91-2-1">2 I will say to Jehovah: “You are my refuge and my stronghold,</span>
<span class="v" id="v19-91-2-2">My God in whom I trust.”</span>
</body></html>`;

test('poetry verses split across lines come back as one verse', async () => {
  const scraper = scraperReturning(200, POETRY_HTML);
  const { verses } = await scraper.extractChapterContent(19, 91);
  assert.deepEqual(verses.map(v => v.verse_num), [1, 2]);
  assert.equal(
    verses[0].verse_text,
    '91 Anyone dwelling in the secret place of the Most High Will lodge under the shadow of the Almighty.'
  );
});

test('getSingleVerse returns the whole poetry verse', async () => {
  const scraper = scraperReturning(200, POETRY_HTML);
  const verse = await scraper.getSingleVerse(19, 91, 2);
  assert.match(verse.verse_text, /stronghold, My God in whom I trust/);
});

test('challenge page raises WOLBlockedError, not "verse not found"', async () => {
  const scraper = scraperReturning(202, CHALLENGE_HTML);
  await assert.rejects(scraper.getSingleVerse(43, 3, 16), (error) => {
    assert.ok(error instanceof WOLBlockedError);
    assert.match(error.message, /blocked/i);
    assert.doesNotMatch(error.message, /not found/i);
    return true;
  });
});

test('getVerseWithStudy also surfaces the block', async () => {
  const scraper = scraperReturning(202, CHALLENGE_HTML);
  await assert.rejects(scraper.getVerseWithStudy(43, 3, '16'), WOLBlockedError);
});

test('HTTP errors still raise a plain error', async () => {
  const scraper = scraperReturning(500, 'oops');
  await assert.rejects(scraper.extractChapterContent(43, 3), (error) => {
    assert.ok(!(error instanceof WOLBlockedError));
    assert.match(error.message, /HTTP 500/);
    return true;
  });
});
