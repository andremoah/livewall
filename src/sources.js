const fs = require('node:fs');
const path = require('node:path');

/**
 * Remote wallpaper sources.
 *
 * Wallhaven needs no credentials. Pixabay and Pexels take a free API key, which the user
 * supplies in settings; nothing is proxied and no key ever ships inside the extension.
 *
 * Fetching and parsing are kept apart so responses can be cached as-is on disk.
 */

const UA = 'livewall-vscode';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SOURCES = ['wallhaven', 'wallhaven-anime', 'pixabay', 'pexels'];

/** Builds the upstream request. Keys come from the user's settings and go nowhere else. */
function upstream(source, query, keys = {}) {
  if (source === 'pixabay') {
    if (!keys.pixabay) throw new Error('NO_KEY');
    const params = new URLSearchParams({
      key: keys.pixabay,
      q: query || 'abstract',
      per_page: '30',
      safesearch: 'true',
    });
    return { url: `https://pixabay.com/api/videos/?${params}`, headers: { 'User-Agent': UA } };
  }

  if (source === 'pexels') {
    if (!keys.pexels) throw new Error('NO_KEY');
    const params = new URLSearchParams({
      query: query || 'abstract',
      per_page: '24',
      orientation: 'landscape',
    });
    return {
      url: `https://api.pexels.com/videos/search?${params}`,
      headers: { Authorization: keys.pexels, 'User-Agent': UA },
    };
  }

  const params = new URLSearchParams({
    q: query || '',
    categories: source === 'wallhaven-anime' ? '010' : '111',
    purity: '100', // SFW only
    sorting: query ? 'relevance' : 'toplist',
    atleast: '1920x1080',
  });
  return { url: `https://wallhaven.cc/api/v1/search?${params}`, headers: { 'User-Agent': UA } };
}

/** Largest variant still <= 1920 wide: above that you pay decode for pixels nobody sees. */
function pickVideoFile(files) {
  const sorted = files.filter((f) => f && f.url && f.width).sort((a, b) => b.width - a.width);
  return sorted.find((f) => f.width <= 1920) || sorted[sorted.length - 1];
}

function parse(source, body) {
  if (source === 'pixabay') {
    return (body.hits || []).map((v) => {
      const s = v.videos || {};
      const variants = [s.large, s.medium, s.small, s.tiny].filter(Boolean);
      const best = pickVideoFile(variants);
      // Each size carries its own thumbnail. There is no top-level thumb field, and the old
      // picture_id -> vimeo CDN trick no longer resolves.
      const thumb = (variants.find((f) => f.thumbnail) || {}).thumbnail || '';
      return {
        id: 'pb-' + v.id,
        source: 'Pixabay',
        kind: 'video',
        thumb,
        url: best && best.url,
        ext: '.mp4',
        label: best ? `${best.width}x${best.height} · ${v.duration}s` : '',
        bytes: (best && best.size) || 0,
        credit: v.pageURL,
        author: v.user,
      };
    }).filter((v) => v.url);
  }

  if (source === 'pexels') {
    return (body.videos || []).map((v) => {
      const best = pickVideoFile(
        (v.video_files || []).filter((f) => f.file_type === 'video/mp4').map((f) => ({ ...f, url: f.link }))
      );
      return {
        id: 'px-' + v.id,
        source: 'Pexels',
        kind: 'video',
        thumb: v.image,
        url: best && best.url,
        ext: '.mp4',
        label: best ? `${best.width}x${best.height} · ${v.duration}s` : '',
        bytes: 0,
        credit: v.url,
        author: v.user && v.user.name,
      };
    }).filter((v) => v.url);
  }

  return (body.data || []).map((w) => ({
    id: 'wh-' + w.id,
    source: 'Wallhaven',
    kind: 'image',
    thumb: w.thumbs && w.thumbs.small,
    url: w.path,
    ext: w.file_type === 'image/png' ? '.png' : '.jpg',
    label: w.resolution,
    bytes: w.file_size || 0,
    credit: w.url,
  }));
}

function cacheKey(source, query) {
  return source + '_' + Buffer.from(query || '').toString('base64url').slice(0, 60);
}

/** Local disk cache. Pixabay's terms require 24h caching; it also keeps us far under every limit. */
async function cached(dir, source, query, fetcher) {
  if (!dir) return fetcher();

  const file = path.join(dir, cacheKey(source, query) + '.json');
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}

  const fresh = await fetcher();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh), 'utf-8');
  } catch {}
  return fresh;
}

function httpError(source, status) {
  if (status === 401 || status === 400) return new Error('BAD_KEY');
  if (status === 429) return new Error('RATE_LIMIT');
  return new Error(`${source} ${status}`);
}

async function fetchRaw(source, query, keys) {
  const req = upstream(source, query, keys);
  const res = await fetch(req.url, { headers: req.headers });
  if (!res.ok) throw httpError(source, res.status);
  return res.json();
}

/**
 * @param {string} source one of SOURCES
 * @param {string} query
 * @param {{cacheDir?: string, keys?: {pixabay?: string, pexels?: string}}} opts
 */
async function search(source, query, opts = {}) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`);
  const body = await cached(opts.cacheDir, source, query, () =>
    fetchRaw(source, query, opts.keys || {})
  );
  return parse(source, body);
}

async function download(item, destDir, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${item.id}${item.ext}`);
  if (fs.existsSync(dest)) return dest;

  const res = await fetch(item.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (onProgress && total) onProgress(got / total);
  }

  // Temp name first: an interrupted download must not survive as a valid-looking cache hit.
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  fs.renameSync(tmp, dest);
  return dest;
}

module.exports = { SOURCES, search, parse, upstream, download };
