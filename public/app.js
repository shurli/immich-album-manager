const state = {
  albums: [],
  query: '',
  scope: 'all',
  sort: 'name-asc',
  busy: new Set(),
};

const elements = {
  rows: document.querySelector('#albumRows'),
  empty: document.querySelector('#emptyState'),
  count: document.querySelector('#albumCount'),
  connection: document.querySelector('#connectionState'),
  search: document.querySelector('#searchInput'),
  scope: document.querySelector('#scopeSelect'),
  sort: document.querySelector('#sortSelect'),
  refresh: document.querySelector('#refreshButton'),
  toasts: document.querySelector('#toastStack'),
};

const actionHeaders = { 'content-type': 'application/json', 'x-album-manager-action': '1' };
const numberFormatter = new Intl.NumberFormat('de-AT');
const dateTimeFormatter = new Intl.DateTimeFormat('de-AT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

bindControls();
loadAlbums();

function bindControls() {
  elements.search.addEventListener('input', () => {
    state.query = elements.search.value.trim().toLocaleLowerCase('de');
    render();
  });

  elements.scope.addEventListener('change', () => {
    state.scope = elements.scope.value;
    loadAlbums();
  });

  elements.sort.addEventListener('change', () => {
    state.sort = elements.sort.value;
    render();
  });

  elements.refresh.addEventListener('click', loadAlbums);
}

async function loadAlbums() {
  elements.refresh.disabled = true;
  elements.connection.textContent = 'Lade Alben + Rand-Items …';
  elements.connection.className = 'connection-state loading';
  try {
    const albums = await api(`/api/albums?scope=${encodeURIComponent(state.scope)}`);
    state.albums = albums;
    elements.connection.textContent = 'Verbunden';
    elements.connection.className = 'connection-state ok';
    render();
  } catch (error) {
    elements.connection.textContent = 'Verbindung fehlgeschlagen';
    elements.connection.className = 'connection-state error';
    showToast(error.message, 'error', 7000);
  } finally {
    elements.refresh.disabled = false;
  }
}

function render() {
  const albums = filteredAlbums();
  elements.count.textContent = `${albums.length} ${albums.length === 1 ? 'Album' : 'Alben'}`;
  elements.empty.hidden = albums.length !== 0;
  elements.rows.replaceChildren(...albums.map(renderAlbumRow));
}

function filteredAlbums() {
  const result = state.albums.filter((album) => {
    if (!state.query) return true;
    const haystack = `${album.albumName} ${album.ownerName || ''} ${album.newestAsset?.fileName || ''} ${album.oldestAsset?.fileName || ''}`.toLocaleLowerCase('de');
    return haystack.includes(state.query);
  });

  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  return result.sort((a, b) => {
    switch (state.sort) {
      case 'name-desc': return collator.compare(b.albumName, a.albumName);
      case 'count-desc': return b.assetCount - a.assetCount || collator.compare(a.albumName, b.albumName);
      case 'count-asc': return a.assetCount - b.assetCount || collator.compare(a.albumName, b.albumName);
      case 'updated-desc': return compareDates(b.updatedAt, a.updatedAt) || collator.compare(a.albumName, b.albumName);
      case 'newest-desc': return compareDates(itemDate(b, 'newest'), itemDate(a, 'newest')) || collator.compare(a.albumName, b.albumName);
      case 'newest-asc': return compareDates(itemDate(a, 'newest'), itemDate(b, 'newest')) || collator.compare(a.albumName, b.albumName);
      case 'oldest-asc': return compareDates(itemDate(a, 'oldest'), itemDate(b, 'oldest')) || collator.compare(a.albumName, b.albumName);
      case 'oldest-desc': return compareDates(itemDate(b, 'oldest'), itemDate(a, 'oldest')) || collator.compare(a.albumName, b.albumName);
      default: return collator.compare(a.albumName, b.albumName);
    }
  });
}

function renderAlbumRow(album) {
  const row = document.createElement('article');
  row.className = 'album-row album-grid';
  row.dataset.id = album.id;
  if (state.busy.has(album.id)) row.classList.add('busy');

  const thumb = makeThumbnail(album.albumThumbnailAssetId, 'album-thumb');

  const nameCell = document.createElement('div');
  nameCell.className = 'name-cell';
  const input = document.createElement('input');
  input.className = 'inline-name';
  input.value = album.albumName;
  input.setAttribute('aria-label', `Album ${album.albumName} umbenennen`);
  input.title = 'Direkt bearbeiten; Enter oder Fokusverlust speichert';
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = album.albumName;
      input.blur();
    }
  });
  input.addEventListener('blur', () => renameAlbum(album, input));
  const sub = document.createElement('span');
  sub.className = 'subtle mono';
  sub.textContent = album.id.slice(0, 8);
  nameCell.append(input, sub);

  const count = document.createElement('div');
  count.className = 'asset-count';
  count.textContent = numberFormatter.format(album.assetCount);

  const newest = renderItemCell(album.newestAsset, album.endDate, 'Kein neuestes Item');
  const oldest = renderItemCell(album.oldestAsset, album.startDate, 'Kein ältestes Item');

  const sharing = document.createElement('div');
  sharing.className = 'sharing-cell';
  const role = document.createElement('span');
  role.className = `role-pill ${album.role || ''}`;
  role.textContent = album.role === 'owner' ? 'Eigentümer' : album.role === 'editor' ? 'Editor' : album.role === 'viewer' ? 'Betrachter' : 'Album';
  sharing.append(role);
  if (album.sharedUsers > 0) {
    const shared = document.createElement('span');
    shared.className = 'subtle';
    shared.textContent = `+ ${album.sharedUsers} geteilt`;
    sharing.append(shared);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const mergeWrap = document.createElement('div');
  mergeWrap.className = 'merge-control';
  const select = document.createElement('select');
  select.className = 'merge-select';
  select.setAttribute('aria-label', `${album.albumName} in anderes Album mergen`);
  select.append(new Option('Merge in …', ''));
  for (const target of state.albums
    .filter((candidate) => candidate.id !== album.id)
    .sort((a, b) => a.albumName.localeCompare(b.albumName, 'de', { numeric: true, sensitivity: 'base' }))) {
    select.append(new Option(`${target.albumName} (${target.assetCount})`, target.id));
  }
  const mergeButton = document.createElement('button');
  mergeButton.className = 'action-button merge-button';
  mergeButton.textContent = '⇢';
  mergeButton.title = 'Quelle in Zielalbum mergen und Quellalbum löschen';
  mergeButton.disabled = true;
  select.addEventListener('change', () => { mergeButton.disabled = !select.value; });
  mergeButton.addEventListener('click', () => mergeAlbum(album, select.value));
  mergeWrap.append(select, mergeButton);

  const deleteButton = document.createElement('button');
  deleteButton.className = 'action-button danger';
  deleteButton.textContent = '×';
  deleteButton.title = 'Album sofort löschen – ohne Rückfrage';
  deleteButton.setAttribute('aria-label', `${album.albumName} sofort löschen`);
  deleteButton.addEventListener('click', () => deleteAlbum(album));

  actions.append(mergeWrap, deleteButton);
  row.append(thumb, nameCell, count, newest, oldest, sharing, actions);
  return row;
}

function renderItemCell(asset, fallbackDate, emptyLabel) {
  const cell = document.createElement('div');
  cell.className = 'item-cell';
  const assetId = asset?.id || null;
  cell.append(makeThumbnail(assetId, 'item-thumb'));

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const date = document.createElement('span');
  date.className = 'item-date';
  date.textContent = formatDateTime(asset?.date || fallbackDate);
  const file = document.createElement('span');
  file.className = 'subtle item-file';
  file.textContent = asset?.fileName || (fallbackDate ? 'Datum aus Album-Metadaten' : emptyLabel);
  file.title = asset?.fileName || '';
  meta.append(date, file);
  cell.append(meta);
  return cell;
}

function makeThumbnail(assetId, className) {
  const thumb = document.createElement('div');
  thumb.className = className;
  if (assetId) {
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = `/api/thumbnail/${assetId}`;
    image.addEventListener('error', () => image.remove());
    thumb.append(image);
  }
  const fallback = document.createElement('span');
  fallback.textContent = '▧';
  thumb.append(fallback);
  return thumb;
}

async function renameAlbum(album, input) {
  const nextName = input.value.trim();
  if (!nextName || nextName === album.albumName || state.busy.has(album.id)) {
    input.value = album.albumName;
    return;
  }

  setBusy(album.id, true);
  try {
    const updated = await api(`/api/albums/${album.id}`, {
      method: 'PATCH',
      headers: actionHeaders,
      body: JSON.stringify({ albumName: nextName }),
    });
    album.albumName = updated.albumName || nextName;
    showToast(`Umbenannt: ${album.albumName}`, 'success');
  } catch (error) {
    input.value = album.albumName;
    showToast(error.message, 'error', 7000);
  } finally {
    setBusy(album.id, false);
    render();
  }
}

async function deleteAlbum(album) {
  if (state.busy.has(album.id)) return;
  setBusy(album.id, true);
  try {
    await api(`/api/albums/${album.id}`, { method: 'DELETE', headers: { 'x-album-manager-action': '1' } });
    state.albums = state.albums.filter((item) => item.id !== album.id);
    showToast(`Gelöscht: ${album.albumName}`, 'success');
  } catch (error) {
    showToast(error.message, 'error', 7000);
  } finally {
    state.busy.delete(album.id);
    render();
  }
}

async function mergeAlbum(source, targetId) {
  if (!targetId || state.busy.has(source.id)) return;
  const target = state.albums.find((album) => album.id === targetId);
  if (!target) return;

  setBusy(source.id, true);
  setBusy(targetId, true);
  showToast(`Merge läuft: ${source.albumName} → ${target.albumName}`, 'info', 2500);
  try {
    const result = await api(`/api/albums/${source.id}/merge`, {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify({ targetAlbumId: targetId }),
    });
    state.albums = state.albums.filter((album) => album.id !== source.id);
    showToast(`${source.albumName} → ${target.albumName}: ${result.assetCount} Assets verarbeitet`, 'success', 6000);
    await loadAlbums();
  } catch (error) {
    showToast(error.message, 'error', 9000);
  } finally {
    state.busy.delete(source.id);
    state.busy.delete(targetId);
    render();
  }
}

function setBusy(id, busy) {
  if (busy) state.busy.add(id);
  else state.busy.delete(id);
  const row = elements.rows.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.toggle('busy', busy);
}

async function api(url, init = {}) {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';
  let body = null;
  if (response.status !== 204) {
    body = contentType.includes('json') ? await response.json() : await response.text();
  }
  if (!response.ok) {
    const message = body?.error || body?.message || body || `HTTP ${response.status}`;
    throw new Error(Array.isArray(message) ? message.join('; ') : String(message));
  }
  return body;
}

function itemDate(album, edge) {
  if (edge === 'newest') return album.newestAsset?.date || album.endDate || null;
  return album.oldestAsset?.date || album.startDate || null;
}

function compareDates(a, b) {
  const left = a ? new Date(a).getTime() : Number.NEGATIVE_INFINITY;
  const right = b ? new Date(b).getTime() : Number.NEGATIVE_INFINITY;
  return left - right;
}

function formatDateTime(value) {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '–' : dateTimeFormatter.format(date);
}

function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toasts.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}
