import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const APP_VERSION = '0.4.1';
const PORT = Number(process.env.PORT || 3473);
const IMMICH_URL = normalizeImmichUrl(process.env.IMMICH_URL || 'http://immich-server:2283');
const IMMICH_PUBLIC_URL = normalizeImmichPublicUrl(process.env.IMMICH_PUBLIC_URL || process.env.IMMICH_URL || 'http://immich-server:2283');
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MERGE_PAGE_SIZE = clamp(Number(process.env.MERGE_PAGE_SIZE || 1000), 1, 1000);
const MERGE_CHUNK_SIZE = clamp(Number(process.env.MERGE_CHUNK_SIZE || 1000), 1, 5000);
const MERGE_SOURCE_CONCURRENCY = clamp(Number(process.env.MERGE_SOURCE_CONCURRENCY || 3), 1, 10);
const EXTREMA_CONCURRENCY = clamp(Number(process.env.EXTREMA_CONCURRENCY || 6), 1, 20);
const EXTREMA_CACHE_TTL_MS = clamp(Number(process.env.EXTREMA_CACHE_TTL_MS || 120000), 0, 3600000);
const ARCHIVE_STATUS_CONCURRENCY = clamp(Number(process.env.ARCHIVE_STATUS_CONCURRENCY || 4), 1, 12);
const ARCHIVE_STATUS_CACHE_TTL_MS = clamp(Number(process.env.ARCHIVE_STATUS_CACHE_TTL_MS || 120000), 0, 3600000);
const ARCHIVE_CHUNK_SIZE = clamp(Number(process.env.ARCHIVE_CHUNK_SIZE || 1000), 1, 5000);
const extremaCache = new Map();
const archiveStatusCache = new Map();

if (!IMMICH_API_KEY) {
  console.warn('[config] IMMICH_API_KEY is empty. API calls will fail until it is configured.');
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(optionalBasicAuth);
app.use('/assets', express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, version: APP_VERSION });
});

app.get('/api/status', async (_req, res, next) => {
  try {
    const albums = await immichJson('/albums?isOwned=true');
    res.json({
      ok: true,
      version: APP_VERSION,
      immichUrl: redactUrl(IMMICH_URL),
      immichPublicUrl: IMMICH_PUBLIC_URL,
      albumCount: Array.isArray(albums) ? albums.length : null,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/albums', async (req, res, next) => {
  try {
    const scope = String(req.query.scope || 'all');
    const params = new URLSearchParams();
    if (scope === 'owned') params.set('isOwned', 'true');
    if (scope === 'shared') params.set('isOwned', 'false');

    const suffix = params.size ? `?${params}` : '';
    const albums = await immichJson(`/albums${suffix}`);
    const summaries = (Array.isArray(albums) ? albums : []).map(toAlbumSummary);

    // No UI pagination: enrich every album, but cap concurrency so larger libraries do not hammer Immich.
    const enriched = await mapConcurrent(summaries, EXTREMA_CONCURRENCY, async (album) => {
      if (!album.id || album.assetCount < 1) return album;
      try {
        const extremes = await getAlbumExtremes(album.id);
        return { ...album, ...extremes };
      } catch (error) {
        console.warn(`[extrema] ${album.id}: ${error.message}`);
        return album;
      }
    });

    res.json(enriched);
  } catch (error) {
    next(error);
  }
});

app.post('/api/albums/archive-status', async (req, res, next) => {
  try {
    const albumsRaw = Array.isArray(req.body?.albums) ? req.body.albums : [];
    if (albumsRaw.length > 500) return res.status(400).json({ error: 'Zu viele Alben für eine Statusabfrage (maximal 500).' });

    const albums = albumsRaw.map((item) => ({
      id: requireUuid(item?.id, 'album id'),
      assetCount: clamp(Number(item?.assetCount || 0), 0, Number.MAX_SAFE_INTEGER),
    }));

    const statuses = await mapConcurrent(albums, ARCHIVE_STATUS_CONCURRENCY, async ({ id, assetCount }) => {
      try {
        return await getAlbumArchiveStatus(id, assetCount);
      } catch (error) {
        console.warn(`[archive-status] ${id}: ${error.message}`);
        return {
          albumId: id,
          state: 'error',
          assetCount,
          accessibleCount: 0,
          archivedCount: 0,
          missingCount: 0,
          error: error.message,
        };
      }
    });

    res.json(statuses);
  } catch (error) {
    next(error);
  }
});

app.post('/api/albums/:id/archive-toggle', requireActionHeader, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, 'album id');
    const album = await immichJson(`/albums/${id}`);
    const expectedCount = Number(album?.assetCount || 0);
    const scan = await scanAlbumArchiveState(id, expectedCount);

    if (scan.accessibleCount === 0) {
      archiveStatusCache.set(id, { value: scan, expiresAt: Date.now() + ARCHIVE_STATUS_CACHE_TTL_MS });
      return res.json({
        ok: true,
        action: 'none',
        updatedCount: 0,
        status: scan,
      });
    }

    const targetVisibility = scan.state === 'all' ? 'timeline' : 'archive';
    const ids = scan.assets.map((asset) => asset.id);

    for (const batch of chunk(ids, ARCHIVE_CHUNK_SIZE)) {
      await immichJson('/assets', {
        method: 'PATCH',
        body: JSON.stringify({ ids: batch, visibility: targetVisibility }),
      });
    }

    const archivedCount = targetVisibility === 'archive' ? scan.accessibleCount : 0;
    const state = scan.missingCount > 0
      ? 'partial'
      : targetVisibility === 'archive'
        ? 'all'
        : 'none';

    const status = {
      albumId: id,
      state,
      assetCount: scan.assetCount,
      accessibleCount: scan.accessibleCount,
      archivedCount,
      missingCount: scan.missingCount,
    };

    if (ARCHIVE_STATUS_CACHE_TTL_MS > 0) {
      archiveStatusCache.set(id, { value: status, expiresAt: Date.now() + ARCHIVE_STATUS_CACHE_TTL_MS });
    }

    res.json({
      ok: true,
      action: targetVisibility === 'archive' ? 'archive' : 'unarchive',
      updatedCount: scan.accessibleCount,
      status,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/thumbnail/:assetId', async (req, res, next) => {
  try {
    const assetId = requireUuid(req.params.assetId, 'assetId');
    const response = await immichFetch(`/assets/${assetId}/thumbnail?size=thumbnail`, {
      headers: { Accept: 'image/avif,image/webp,image/*,*/*' },
    });

    const contentType = response.headers.get('content-type');
    const cacheControl = response.headers.get('cache-control');
    if (contentType) res.setHeader('content-type', contentType);
    if (cacheControl) res.setHeader('cache-control', cacheControl);
    res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    next(error);
  }
});

app.patch('/api/albums/:id', requireActionHeader, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, 'album id');
    const albumName = String(req.body?.albumName ?? '').trim();
    if (!albumName) return res.status(400).json({ error: 'Albumname darf nicht leer sein.' });
    if (albumName.length > 200) return res.status(400).json({ error: 'Albumname ist zu lang.' });

    const album = await immichJson(`/albums/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ albumName }),
    });
    res.json(toAlbumSummary(album));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/albums/:id', requireActionHeader, async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, 'album id');
    await immichJson(`/albums/${id}`, { method: 'DELETE' });
    extremaCache.delete(id);
    archiveStatusCache.delete(id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/merge', requireActionHeader, async (req, res, next) => {
  try {
    const sourceIdsRaw = Array.isArray(req.body?.sourceAlbumIds) ? req.body.sourceAlbumIds : [];
    if (sourceIdsRaw.length < 1) return res.status(400).json({ error: 'Mindestens ein Quellalbum auswählen.' });
    if (sourceIdsRaw.length > 500) return res.status(400).json({ error: 'Zu viele Quellalben in einem Merge (maximal 500).' });

    const targetId = requireUuid(req.body?.targetAlbumId, 'target album id');
    const sourceIds = [...new Set(sourceIdsRaw.map((id) => requireUuid(id, 'source album id')))];
    if (sourceIds.includes(targetId)) return res.status(400).json({ error: 'Das Zielalbum darf nicht gleichzeitig Quelle sein.' });

    const result = await mergeAlbums(sourceIds, targetId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Backward-compatible single-source route for clients from 0.2.x.
app.post('/api/albums/:sourceId/merge', requireActionHeader, async (req, res, next) => {
  try {
    const sourceId = requireUuid(req.params.sourceId, 'source album id');
    const targetId = requireUuid(req.body?.targetAlbumId, 'target album id');
    if (sourceId === targetId) return res.status(400).json({ error: 'Quelle und Ziel müssen unterschiedliche Alben sein.' });
    const result = await mergeAlbums([sourceId], targetId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  const status = Number(error?.status || error?.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const payload = { error: error?.message || 'Unbekannter Fehler' };
  if (error?.details) payload.details = error.details;
  if (process.env.NODE_ENV !== 'production' && error?.stack) payload.stack = error.stack;
  console.error('[request]', error);
  res.status(safeStatus).json(payload);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Immich Album Manager v${APP_VERSION} listening on :${PORT}`);
  console.log(`Immich API: ${redactUrl(IMMICH_URL)}`);
  console.log(`Immich Web: ${IMMICH_PUBLIC_URL}`);
});

function normalizeImmichUrl(input) {
  const trimmed = String(input).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function normalizeImmichPublicUrl(input) {
  const trimmed = String(input).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed;
}

function redactUrl(input) {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return input;
  }
}

function optionalBasicAuth(req, res, next) {
  if (!APP_USERNAME && !APP_PASSWORD) return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return requestBasicAuth(res);

  let decoded = '';
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch {
    return requestBasicAuth(res);
  }
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  if (!safeEqual(username, APP_USERNAME) || !safeEqual(password, APP_PASSWORD)) return requestBasicAuth(res);
  next();
}

function requestBasicAuth(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Immich Album Manager"');
  res.status(401).send('Authentication required');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireActionHeader(req, res, next) {
  if (req.get('x-album-manager-action') !== '1') {
    return res.status(403).json({ error: 'Aktions-Header fehlt.' });
  }
  next();
}

function requireUuid(value, label) {
  const text = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    const error = new Error(`Ungültige ${label}.`);
    error.status = 400;
    throw error;
  }
  return text;
}

async function immichFetch(apiPath, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers || {});
  headers.set('x-api-key', IMMICH_API_KEY);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  try {
    const response = await fetch(`${IMMICH_URL}${apiPath}`, {
      ...init,
      headers,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      let details;
      try {
        details = contentType.includes('json') ? await response.json() : await response.text();
      } catch {
        details = null;
      }
      const message = details?.message || details?.error || (typeof details === 'string' && details) || `Immich API Fehler ${response.status}`;
      const error = new Error(Array.isArray(message) ? message.join('; ') : String(message));
      error.status = response.status;
      error.details = details;
      throw error;
    }
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Immich API Timeout nach ${REQUEST_TIMEOUT_MS} ms.`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function immichJson(apiPath, init = {}) {
  const response = await immichFetch(apiPath, init);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getAlbumExtremes(albumId) {
  const cached = extremaCache.get(albumId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [newestAsset, oldestAsset] = await Promise.all([
    getAlbumExtremeAsset(albumId, 'desc'),
    getAlbumExtremeAsset(albumId, 'asc'),
  ]);
  const value = { newestAsset, oldestAsset };
  if (EXTREMA_CACHE_TTL_MS > 0) {
    extremaCache.set(albumId, { value, expiresAt: Date.now() + EXTREMA_CACHE_TTL_MS });
  }
  return value;
}

async function getAlbumExtremeAsset(albumId, order) {
  const data = await immichJson('/search/metadata', {
    method: 'POST',
    body: JSON.stringify({
      albumIds: [albumId],
      page: 1,
      size: 1,
      order,
      withExif: false,
      withPeople: false,
      withStacked: false,
    }),
  });

  const container = data?.assets || data || {};
  const items = Array.isArray(container.items) ? container.items : Array.isArray(data?.items) ? data.items : [];
  return items[0] ? toAssetSummary(items[0]) : null;
}

async function mergeAlbums(sourceIds, targetId) {
  const [targetAlbum, sourceAlbums] = await Promise.all([
    immichJson(`/albums/${targetId}`),
    mapConcurrent(sourceIds, MERGE_SOURCE_CONCURRENCY, (sourceId) => immichJson(`/albums/${sourceId}`)),
  ]);

  const assetsBySource = await mapConcurrent(sourceIds, MERGE_SOURCE_CONCURRENCY, async (sourceId) => ({
    sourceId,
    assetIds: await getAlbumAssetIds(sourceId),
  }));

  const uniqueAssetIds = [];
  const seen = new Set();
  for (const source of assetsBySource) {
    for (const assetId of source.assetIds) {
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      uniqueAssetIds.push(assetId);
    }
  }

  let newlyAdded = 0;
  let duplicates = 0;
  for (const ids of chunk(uniqueAssetIds, MERGE_CHUNK_SIZE)) {
    const result = await immichJson(`/albums/${targetId}/assets`, {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    });

    const failures = [];
    for (const item of Array.isArray(result) ? result : []) {
      if (item?.success === true) {
        newlyAdded += 1;
        continue;
      }
      const reason = String(item?.error || item?.errorCode || '').toLowerCase();
      if (reason.includes('duplicate')) {
        duplicates += 1;
        continue;
      }
      failures.push(item);
    }

    if (failures.length > 0) {
      const error = new Error(`Merge abgebrochen: ${failures.length} Asset(s) konnten nicht ins Zielalbum übernommen werden. Kein Quellalbum wurde gelöscht.`);
      error.status = 409;
      error.details = failures.slice(0, 20);
      throw error;
    }
  }

  // Important: do not start deleting sources until every asset batch for every source succeeded.
  // Cleanup is attempted for every source; individual delete failures are reported to the UI.
  const deleteResults = await Promise.allSettled(sourceIds.map(async (sourceId) => {
    await immichJson(`/albums/${sourceId}`, { method: 'DELETE' });
    extremaCache.delete(sourceId);
    archiveStatusCache.delete(sourceId);
    return sourceId;
  }));
  extremaCache.delete(targetId);
  archiveStatusCache.delete(targetId);

  const cleanupFailures = deleteResults
    .map((result, index) => ({ result, id: sourceIds[index], name: sourceAlbums[index]?.albumName || sourceIds[index] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, id, name }) => ({ id, name, error: result.reason?.message || 'Löschen fehlgeschlagen' }));

  return {
    ok: cleanupFailures.length === 0,
    cleanupComplete: cleanupFailures.length === 0,
    cleanupFailures,
    sourceCount: sourceIds.length,
    sources: sourceIds.map((id, index) => ({
      id,
      name: sourceAlbums[index]?.albumName || id,
      assetCount: assetsBySource[index]?.assetIds?.length || 0,
    })),
    target: { id: targetId, name: targetAlbum?.albumName || targetId },
    uniqueAssetCount: uniqueAssetIds.length,
    sourceAssetCount: assetsBySource.reduce((sum, source) => sum + source.assetIds.length, 0),
    newlyAdded,
    alreadyPresent: Math.max(duplicates, uniqueAssetIds.length - newlyAdded),
    deletedSourceCount: sourceIds.length - cleanupFailures.length,
  };
}

async function getAlbumArchiveStatus(albumId, expectedCount) {
  const cached = archiveStatusCache.get(albumId);
  if (cached && cached.expiresAt > Date.now() && cached.value?.assetCount === expectedCount) return cached.value;

  const scan = await scanAlbumArchiveState(albumId, expectedCount);
  const value = {
    albumId,
    state: scan.state,
    assetCount: scan.assetCount,
    accessibleCount: scan.accessibleCount,
    archivedCount: scan.archivedCount,
    missingCount: scan.missingCount,
  };

  if (ARCHIVE_STATUS_CACHE_TTL_MS > 0) {
    archiveStatusCache.set(albumId, { value, expiresAt: Date.now() + ARCHIVE_STATUS_CACHE_TTL_MS });
  }
  return value;
}

async function scanAlbumArchiveState(albumId, expectedCount) {
  const assets = await getAlbumAssetEntries(albumId);
  const accessibleCount = assets.length;
  const assetCount = Math.max(Number(expectedCount || 0), accessibleCount);
  const archivedCount = assets.filter(isArchivedAsset).length;
  const missingCount = Math.max(assetCount - accessibleCount, 0);

  let state = 'none';
  if (assetCount === 0) state = 'empty';
  else if (missingCount > 0) state = 'partial';
  else if (archivedCount === accessibleCount && accessibleCount > 0) state = 'all';
  else if (archivedCount > 0) state = 'mixed';

  return {
    albumId,
    state,
    assetCount,
    accessibleCount,
    archivedCount,
    missingCount,
    assets,
  };
}

function isArchivedAsset(asset) {
  return asset?.visibility === 'archive' || asset?.isArchived === true;
}

async function getAlbumAssetEntries(albumId) {
  const assets = [];
  const seen = new Set();
  let page = 1;

  const addAsset = (asset) => {
    if (!asset?.id || seen.has(asset.id)) return;
    seen.add(asset.id);
    assets.push({
      id: asset.id,
      visibility: asset.visibility || (asset.isArchived ? 'archive' : null),
      isArchived: asset.isArchived === true,
    });
  };

  while (true) {
    const data = await immichJson('/search/metadata', {
      method: 'POST',
      body: JSON.stringify({
        albumIds: [albumId],
        page,
        size: MERGE_PAGE_SIZE,
        withExif: false,
        withPeople: false,
        withStacked: true,
      }),
    });

    const container = data?.assets || data || {};
    const items = Array.isArray(container.items) ? container.items : Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      addAsset(item);
      for (const child of item?.stack?.assets || []) addAsset(child);
    }

    const nextPageRaw = container.nextPage ?? data?.nextPage ?? null;
    const nextPage = Number(nextPageRaw);
    if (Number.isFinite(nextPage) && nextPage > page) {
      page = nextPage;
      continue;
    }
    if (items.length === MERGE_PAGE_SIZE) {
      page += 1;
      continue;
    }
    break;
  }

  return assets;
}

async function getAlbumAssetIds(albumId) {
  return (await getAlbumAssetEntries(albumId)).map((asset) => asset.id);
}

function toAlbumSummary(album = {}) {
  const ownMembership = Array.isArray(album.albumUsers) ? album.albumUsers[0] : null;
  const ownerEntry = Array.isArray(album.albumUsers)
    ? album.albumUsers.find((entry) => entry?.role === 'owner') || album.albumUsers[0]
    : null;

  return {
    id: album.id,
    albumName: album.albumName || '',
    assetCount: Number(album.assetCount || 0),
    albumThumbnailAssetId: album.albumThumbnailAssetId || null,
    webUrl: `${IMMICH_PUBLIC_URL}/albums/${album.id}`,
    createdAt: album.createdAt || null,
    updatedAt: album.updatedAt || null,
    startDate: album.startDate || null,
    endDate: album.endDate || null,
    newestAsset: null,
    oldestAsset: null,
    isActivityEnabled: album.isActivityEnabled ?? null,
    role: ownMembership?.role || null,
    ownerName: ownerEntry?.user?.name || ownerEntry?.user?.email || '',
    sharedUsers: Math.max((album.albumUsers?.length || 1) - 1, 0),
    hasSharedLink: Boolean(album.hasSharedLink || album.sharedLink),
  };
}

function toAssetSummary(asset = {}) {
  return {
    id: asset.id || null,
    // Legacy metadata search is ordered by fileCreatedAt, so expose that timestamp first.
    date: asset.fileCreatedAt || asset.localDateTime || asset.createdAt || null,
    fileName: asset.originalFileName || '',
    type: asset.type || null,
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
