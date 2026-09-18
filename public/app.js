const state = {
  albums: [],
  query: '',
  scope: 'all',
  sort: 'name-asc',
  busy: new Set(),
  mergeSources: new Set(),
  mergeTarget: null,
  merging: false,
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
  selectAllSources: document.querySelector('#selectAllSources'),
  mergeBar: document.querySelector('#mergeBar'),
  mergeSourceCount: document.querySelector('#mergeSourceCount'),
  mergeAssetCount: document.querySelector('#mergeAssetCount'),
  mergeTargetName: document.querySelector('#mergeTargetName'),
  mergeRun: document.querySelector('#mergeRunButton'),
  mergeClear: document.querySelector('#mergeClearButton'),
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
  elements.selectAllSources.addEventListener('change', toggleAllVisibleSources);
  elements.mergeClear.addEventListener('click', clearMergeSelection);
  elements.mergeRun.addEventListener('click', runMultiMerge);
}

async function loadAlbums() {
  elements.refresh.disabled = true;
  elements.connection.textContent = 'Lade Alben + Rand-Items …';
  elements.connection.className = 'connection-state loading';
  try {
    const albums = await api(`/api/albums?scope=${encodeURIComponent(state.scope)}`);
    state.albums = albums;
    reconcileMergeSelection();
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

function reconcileMergeSelection() {
  const ids = new Set(state.albums.map((album) => album.id));
  for (const id of state.mergeSources) {
    if (!ids.has(id)) state.mergeSources.delete(id);
  }
  if (state.mergeTarget && !ids.has(state.mergeTarget)) state.mergeTarget = null;
  if (state.mergeTarget) state.mergeSources.delete(state.mergeTarget);
}

function render() {
  const albums = filteredAlbums();
  elements.count.textContent = `${albums.length} ${albums.length === 1 ? 'Album' : 'Alben'}`;
  elements.empty.hidden = albums.length !== 0;
  updateMergeUi(albums);
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

function updateMergeUi(visibleAlbums) {
  const sources = state.albums.filter((album) => state.mergeSources.has(album.id));
  const target = state.albums.find((album) => album.id === state.mergeTarget) || null;
  const assetTotal = sources.reduce((sum, album) => sum + Number(album.assetCount || 0), 0);
  const hasSelection = sources.length > 0 || Boolean(target);

  elements.mergeBar.hidden = !hasSelection;
  elements.mergeSourceCount.textContent = `${sources.length} ${sources.length === 1 ? 'Quelle' : 'Quellen'}`;
  elements.mergeAssetCount.textContent = `${numberFormatter.format(assetTotal)} Assets`;
  elements.mergeTargetName.textContent = target ? target.albumName : 'Ziel noch wählen';
  elements.mergeTargetName.classList.toggle('missing', !target);
  elements.mergeRun.disabled = state.merging || sources.length === 0 || !target;
  elements.mergeRun.textContent = state.merging ? 'Merge läuft …' : `Merge starten`;
  elements.mergeClear.disabled = state.merging;

  const selectableVisible = visibleAlbums.filter((album) => album.id !== state.mergeTarget);
  const selectedVisible = selectableVisible.filter((album) => state.mergeSources.has(album.id));
  elements.selectAllSources.disabled = state.merging || selectableVisible.length === 0;
  elements.selectAllSources.checked = selectableVisible.length > 0 && selectedVisible.length === selectableVisible.length;
  elements.selectAllSources.indeterminate = selectedVisible.length > 0 && selectedVisible.length < selectableVisible.length;
}

function renderAlbumRow(album) {
  const row = document.createElement('article');
  row.className = 'album-row album-grid';
  row.dataset.id = album.id;
  if (state.busy.has(album.id)) row.classList.add('busy');
  if (state.mergeSources.has(album.id)) row.classList.add('merge-source-row');
  if (state.mergeTarget === album.id) row.classList.add('merge-target-row');

  const sourceCell = document.createElement('label');
  sourceCell.className = 'selection-cell source-cell';
  sourceCell.title = 'Als Quellalbum für Merge markieren';
  const sourceCheck = document.createElement('input');
  sourceCheck.type = 'checkbox';
  sourceCheck.className = 'source-check';
  sourceCheck.checked = state.mergeSources.has(album.id);
  sourceCheck.disabled = state.merging;
  sourceCheck.setAttribute('aria-label', `${album.albumName} als Merge-Quelle auswählen`);
  sourceCheck.addEventListener('change', () => toggleSource(album.id, sourceCheck.checked));
  sourceCell.append(sourceCheck);

  const targetCell = document.createElement('div');
  targetCell.className = 'selection-cell';
  const targetButton = document.createElement('button');
  targetButton.type = 'button';
  targetButton.className = 'target-selector';
  targetButton.classList.toggle('selected', state.mergeTarget === album.id);
  targetButton.disabled = state.merging;
  targetButton.setAttribute('aria-pressed', state.mergeTarget === album.id ? 'true' : 'false');
  targetButton.setAttribute('aria-label', `${album.albumName} als Merge-Ziel auswählen`);
  targetButton.title = state.mergeTarget === album.id ? 'Zielauswahl aufheben' : 'Als Zielalbum wählen';
  targetButton.textContent = state.mergeTarget === album.id ? '●' : '○';
  targetButton.addEventListener('click', () => toggleTarget(album.id));
  targetCell.append(targetButton);

  const thumb = makeThumbnail(album.albumThumbnailAssetId, 'album-thumb');

  const nameCell = document.createElement('div');
  nameCell.className = 'name-cell';
  const input = document.createElement('input');
  input.className = 'inline-name';
  input.value = album.albumName;
  input.setAttribute('aria-label', `Album ${album.albumName} umbenennen`);
  input.title = 'Direkt bearbeiten; Enter oder Fokusverlust speichert';
  input.disabled = state.merging;
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
  const deleteButton = document.createElement('button');
  deleteButton.className = 'action-button danger';
  deleteButton.textContent = '×';
  deleteButton.title = 'Album sofort löschen – ohne Rückfrage';
  deleteButton.setAttribute('aria-label', `${album.albumName} sofort löschen`);
  deleteButton.disabled = state.merging;
  deleteButton.addEventListener('click', () => deleteAlbum(album));
  actions.append(deleteButton);

  row.append(sourceCell, targetCell, thumb, nameCell, count, newest, oldest, sharing, actions);
  return row;
}

function toggleSource(id, checked) {
  if (state.merging) return;
  if (checked) {
    state.mergeSources.add(id);
    if (state.mergeTarget === id) state.mergeTarget = null;
  } else {
    state.mergeSources.delete(id);
  }
  render();
}

function toggleTarget(id) {
  if (state.merging) return;
  if (state.mergeTarget === id) {
    state.mergeTarget = null;
  } else {
    state.mergeTarget = id;
    state.mergeSources.delete(id);
  }
  render();
}

function toggleAllVisibleSources() {
  if (state.merging) return;
  const visible = filteredAlbums().filter((album) => album.id !== state.mergeTarget);
  if (elements.selectAllSources.checked) {
    for (const album of visible) state.mergeSources.add(album.id);
  } else {
    for (const album of visible) state.mergeSources.delete(album.id);
  }
  render();
}

function clearMergeSelection() {
  if (state.merging) return;
  state.mergeSources.clear();
  state.mergeTarget = null;
  render();
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
  if (!nextName || nextName === album.albumName || state.busy.has(album.id) || state.merging) {
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
  if (state.busy.has(album.id) || state.merging) return;
  setBusy(album.id, true);
  try {
    await api(`/api/albums/${album.id}`, { method: 'DELETE', headers: { 'x-album-manager-action': '1' } });
    state.albums = state.albums.filter((item) => item.id !== album.id);
    state.mergeSources.delete(album.id);
    if (state.mergeTarget === album.id) state.mergeTarget = null;
    showToast(`Gelöscht: ${album.albumName}`, 'success');
  } catch (error) {
    showToast(error.message, 'error', 7000);
  } finally {
    state.busy.delete(album.id);
    render();
  }
}

async function runMultiMerge() {
  if (state.merging || state.mergeSources.size === 0 || !state.mergeTarget) return;

  const sourceIds = [...state.mergeSources];
  const targetId = state.mergeTarget;
  const target = state.albums.find((album) => album.id === targetId);
  if (!target) return;

  state.merging = true;
  for (const id of sourceIds) state.busy.add(id);
  state.busy.add(targetId);
  render();
  showToast(`Merge läuft: ${sourceIds.length} Quelle(n) → ${target.albumName}`, 'info', 3000);

  try {
    const result = await api('/api/merge', {
      method: 'POST',
      headers: actionHeaders,
      body: JSON.stringify({ sourceAlbumIds: sourceIds, targetAlbumId: targetId }),
    });
    const sourceLabel = result.sourceCount === 1 ? 'Quellalbum' : 'Quellalben';
    if (result.cleanupComplete === false) {
      const failedNames = (result.cleanupFailures || []).map((item) => item.name).join(', ');
      showToast(`Assets wurden gemergt, aber ${result.cleanupFailures.length} Quellalbum/-alben konnten nicht gelöscht werden: ${failedNames}`, 'error', 10000);
    } else {
      showToast(`${result.sourceCount} ${sourceLabel} → ${result.target.name}: ${numberFormatter.format(result.uniqueAssetCount)} eindeutige Assets verarbeitet`, 'success', 7000);
    }
    state.mergeSources.clear();
    state.mergeTarget = null;
    await loadAlbums();
  } catch (error) {
    showToast(error.message, 'error', 10000);
  } finally {
    state.merging = false;
    for (const id of sourceIds) state.busy.delete(id);
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
