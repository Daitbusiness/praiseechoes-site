import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || '@PraiseEchoes';
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const MAX_RESULTS = Number(process.env.YOUTUBE_MAX_RESULTS || 6);
const OUT_FILE = process.env.YOUTUBE_OUT_FILE || 'data/latest-videos.json';

const textDecoder = new TextDecoder();

function decodeHtml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function stripTags(value = '') {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function removeHashtags(value = '') {
  return value
    .replace(/(^|\s)#[^\s#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimText(value = '', maxLength = 170) {
  if (value.length <= maxLength) return value;

  const shortened = value.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return `${shortened}...`;
}

function cleanTitle(value = '') {
  return removeHashtags(value).replace(/\s+\|?\s*PraiseEchoes$/i, '').trim();
}

function cleanDescription(value = '') {
  return trimText(removeHashtags(value), 180);
}

function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match ? decodeHtml(match[1]) : '';
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': 'PraiseEchoes site updater'
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }

  return textDecoder.decode(await response.arrayBuffer());
}

async function resolveChannelId() {
  if (CHANNEL_ID) return CHANNEL_ID;

  const handle = CHANNEL_HANDLE.startsWith('@') ? CHANNEL_HANDLE : `@${CHANNEL_HANDLE}`;
  const html = await fetchText(`https://www.youtube.com/${handle}`);
  const id =
    firstMatch(html, /"channelId":"(UC[^"]+)"/) ||
    firstMatch(html, /<meta itemprop="channelId" content="(UC[^"]+)"/) ||
    firstMatch(html, /"externalId":"(UC[^"]+)"/);

  if (!id) {
    throw new Error(`Could not resolve YouTube channel ID for ${handle}`);
  }

  return id;
}

function parseEntries(xml) {
  return Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g))
    .slice(0, MAX_RESULTS)
    .map(([, entry]) => {
      const id =
        firstMatch(entry, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/) ||
        firstMatch(entry, /<id>yt:video:([\s\S]*?)<\/id>/);
      const title = cleanTitle(firstMatch(entry, /<title>([\s\S]*?)<\/title>/));
      const publishedAt = firstMatch(entry, /<published>([\s\S]*?)<\/published>/);
      const mediaDescription = firstMatch(entry, /<media:description>([\s\S]*?)<\/media:description>/);
      const summary = firstMatch(entry, /<summary>([\s\S]*?)<\/summary>/);
      const description = cleanDescription(stripTags(mediaDescription || summary));

      return {
        id,
        title,
        description: description || 'A recent PraiseEchoes worship release for prayer and reflection.',
        label: 'Latest Release',
        publishedAt
      };
    })
    .filter((video) => video.id && video.title);
}

async function main() {
  const channelId = await resolveChannelId();
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const xml = await fetchText(feedUrl);
  const videos = parseEntries(xml);

  if (!videos.length) {
    throw new Error(`No videos found in YouTube RSS feed for ${channelId}`);
  }

  const previous = await readFile(OUT_FILE, 'utf8').catch(() => '');
  const payload = `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: feedUrl,
    channelId,
    videos
  }, null, 2)}\n`;

  if (payload !== previous) {
    await mkdir(dirname(resolve(OUT_FILE)), { recursive: true });
    await writeFile(OUT_FILE, payload, 'utf8');
  }

  console.log(`Wrote ${videos.length} latest videos from ${channelId}`);
}

await main();
