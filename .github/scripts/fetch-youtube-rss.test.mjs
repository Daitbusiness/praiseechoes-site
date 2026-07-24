import assert from 'node:assert/strict';
import test from 'node:test';

import { extractVideoIds, parseEntries } from './fetch-youtube-rss.mjs';

function entry({ id, title, duration, publishedAt = '2026-07-24T00:00:00+00:00' }) {
  return `
    <entry>
      <yt:videoId>${id}</yt:videoId>
      <title>${title}</title>
      <published>${publishedAt}</published>
      <media:content duration="${duration}" />
      <media:description>A worship release with enough detail to use as the card description.</media:description>
    </entry>
  `;
}

test('extractVideoIds returns unique YouTube video ids', () => {
  const html = [
    '{"videoId":"abcdefghijk"}',
    '{"videoId":"12345678901"}',
    '{"videoId":"abcdefghijk"}'
  ].join('');

  assert.deepEqual([...extractVideoIds(html)], ['abcdefghijk', '12345678901']);
});

test('parseEntries removes Shorts ids and videos under the duration threshold', () => {
  const xml = `
    <feed>
      ${entry({ id: 'shortvideo1', title: 'Short release', duration: 120 })}
      ${entry({ id: 'tinyvideo01', title: 'Very short release', duration: 45 })}
      ${entry({ id: 'fullvideo01', title: 'Full worship release', duration: 260 })}
    </feed>
  `;

  const videos = parseEntries(xml, new Set(['shortvideo1']));

  assert.equal(videos.length, 1);
  assert.equal(videos[0].id, 'fullvideo01');
  assert.equal('duration' in videos[0], false);
});

test('parseEntries filters every feed entry before limiting the results', () => {
  const shortEntries = Array.from({ length: 12 }, (_, index) => {
    const id = `short${String(index).padStart(5, '0')}`;
    return entry({ id, title: `Short release ${index + 1}`, duration: 120 });
  });
  const fullEntries = [
    entry({ id: 'fullvideo01', title: 'Full worship release one', duration: 260 }),
    entry({ id: 'fullvideo02', title: 'Full worship release two', duration: 280 })
  ];
  const shortVideoIds = new Set(
    Array.from({ length: 12 }, (_, index) => `short${String(index).padStart(5, '0')}`)
  );
  const xml = `<feed>${shortEntries.join('')}${fullEntries.join('')}</feed>`;

  const videos = parseEntries(xml, shortVideoIds);

  assert.deepEqual(videos.map(video => video.id), ['fullvideo01', 'fullvideo02']);
});
