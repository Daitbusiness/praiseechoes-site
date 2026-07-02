import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || '@PraiseEchoes';
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || '';
const MAX_RESULTS = Number(process.env.YOUTUBE_MAX_RESULTS || 6);
const MIN_DURATION_S = Number(process.env.YOUTUBE_MIN_DURATION_S || 60);
const OUT_FILE = process.env.YOUTUBE_OUT_FILE || 'data/latest-videos.json';
const FETCH_RETRIES = Number(process.env.YOUTUBE_FETCH_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.YOUTUBE_RETRY_DELAY_MS || 1200);
const STALE_FALLBACK_MAX_HOURS = Number(process.env.YOUTUBE_STALE_FALLBACK_MAX_HOURS || 72);

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
  return removeHashtags(value)
    .replace(/\s+\|?\s*PraiseEchoes$/i, '')
    .replace(/\s*[|—–-]\s*PraiseEchoes\s*$/i, '')
    .replace(/\s*\|?\s*PraiseEchoes\s*$/, '')
    .trim();
}

function cleanDescription(value = '') {
  // Strip URLs, social handles, email addresses
  let text = value
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/[\w.+-]+@\w+\.\w+/g, ' ')
    .replace(/(^|\s)#[^\s#]+/g, ' ');

  // Keep only lines with real substance (> 30 chars after cleaning)
  text = text.split('\n')
    .map(line => removeHashtags(stripTags(line)).trim())
    .filter(line => line.length > 30)
    .join(' ');

  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Short truncation for display
  return trimText(text, 120);
}

function generateDescription(title) {
  const lower = title.toLowerCase();

  if (/[一-鿿]/.test(title) && lower.includes('worship')) {
    return 'A Chinese worship song of praise and devotion.';
  }
  if (/[一-鿿]/.test(title)) {
    return 'A Chinese worship song for prayer and reflection.';
  }
  if (lower.includes('piano') || lower.includes('instrumental')) {
    return 'A gentle instrumental piece for prayer, reflection, and quiet peace.';
  }
  if (lower.includes('worship')) {
    return 'A worship song for quiet devotion and heartfelt praise.';
  }
  return 'A PraiseEchoes worship release for prayer and quiet reflection.';
}

function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match ? decodeHtml(match[1]) : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readPreviousData() {
  const value = await readFile(OUT_FILE, 'utf8').catch(() => '');

  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function hasFreshPreviousData(previous, channelId) {
  if (!previous || previous.channelId !== channelId) return false;
  if (!Array.isArray(previous.videos) || previous.videos.length === 0) return false;

  const updatedAtMs = Date.parse(previous.updatedAt || '');
  if (!Number.isFinite(updatedAtMs)) return false;

  const maxAgeMs = STALE_FALLBACK_MAX_HOURS * 60 * 60 * 1000;
  return Date.now() - updatedAtMs <= maxAgeMs;
}

async function fetchText(url) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;

      if (attempt < FETCH_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
}

async function resolveChannelId() {
  if (CHANNEL_ID) return CHANNEL_ID;

  const previous = await readPreviousData();

  if (previous?.channelId) {
    return previous.channelId;
  }

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
    .slice(0, MAX_RESULTS * 2)  // fetch extra to compensate for filtered shorts
    .map(([, entry]) => {
      const id =
        firstMatch(entry, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/) ||
        firstMatch(entry, /<id>yt:video:([\s\S]*?)<\/id>/);
      const title = cleanTitle(firstMatch(entry, /<title>([\s\S]*?)<\/title>/));
      const duration = Number(firstMatch(entry, /<media:content[^>]*\sduration="(\d+)"/));
      const publishedAt = firstMatch(entry, /<published>([\s\S]*?)<\/published>/);
      const mediaDescription = firstMatch(entry, /<media:description>([\s\S]*?)<\/media:description>/);
      const summary = firstMatch(entry, /<summary>([\s\S]*?)<\/summary>/);
      const rawDescription = cleanDescription(stripTags(mediaDescription || summary));
      const description = rawDescription.length > 20 ? rawDescription : generateDescription(title);

      return {
        id,
        title,
        duration,
        description,
        label: 'Latest Release',
        publishedAt
      };
    })
    .filter((video) => video.id && video.title)
    .filter((video) => !video.duration || video.duration >= MIN_DURATION_S)
    .slice(0, MAX_RESULTS)
    .map(({ duration, ...rest }) => rest);  // strip internal duration field
}

async function main() {
  const channelId = await resolveChannelId();
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let xml;

  try {
    xml = await fetchText(feedUrl);
  } catch (error) {
    const previous = await readPreviousData();

    if (hasFreshPreviousData(previous, channelId)) {
      console.warn(
        `YouTube RSS unavailable after ${FETCH_RETRIES} attempts: ${error.message}. ` +
        `Keeping existing ${OUT_FILE} from ${previous.updatedAt}.`
      );
      return;
    }

    throw error;
  }

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
