/**
 * Settings backup as a JSON file – protection against Safari's storage cleanup (iOS deletes the data of web apps
 * that weren't opened for a while). Export uses the share sheet on iOS ("In Dateien sichern"), a download elsewhere.
 */
import { store } from '../core/store.js';
import { db } from '../core/db.js';
import { bus } from '../core/events.js';

const FORMAT = 'kasy-tv-backup';
const VERSION = 1;

/** Builds the backup object. includePlaylists also stores the uploaded playlist files. */
export async function buildBackup({ includePlaylists = true, includeCredentials = true } = {}) {
  const settings = store.snapshot();
  if (!includeCredentials) {
    settings.jellyfin = { ...settings.jellyfin, token: '', userId: '' };
    settings.youtube = { ...settings.youtube, apiKey: '' };
  }
  const kv = {};
  for (const [key, value] of await db.entries()) {
    if (key === 'settings') continue;
    if (key.startsWith('iptv.raw.') && !includePlaylists) continue;
    if (key.startsWith('cache.')) continue;
    kv[key] = value;
  }
  return {
    format: FORMAT,
    version: VERSION,
    app: 'Kasy TV PWA',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    settings,
    data: kv,
  };
}

function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `kasy-tv-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

/** Exports; returns 'shared' | 'downloaded' | 'cancelled'. */
export async function exportBackup(opts) {
  const data = await buildBackup(opts);
  const json = JSON.stringify(data, null, 2);
  const name = fileName();
  const blob = new Blob([json], { type: 'application/json' });
  let how = 'downloaded';

  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  const canShare = file && navigator.canShare && navigator.canShare({ files: [file] });
  const preferShare = canShare && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || /Android/.test(navigator.userAgent));
  if (preferShare) {
    try {
      await navigator.share({ files: [file], title: 'Kasy TV Backup' });
      how = 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      download(blob, name);
    }
  } else download(blob, name);

  store.set('backup.lastExport', Date.now());
  bus.emit('backup:exported');
  return how;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}

/** Validates and applies a backup file. mode: 'replace' (all) | 'settings' (settings only). */
export async function importBackup(file, { mode = 'replace' } = {}) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Die Datei ist kein gültiges JSON.');
  }
  if (!data || data.format !== FORMAT || typeof data.settings !== 'object') throw new Error('Das ist keine Kasy-TV-Sicherung.');
  if (data.version > VERSION) throw new Error('Die Sicherung stammt aus einer neueren App-Version.');

  // Keep the current Jellyfin login if the backup was exported without credentials.
  const cur = store.snapshot();
  const next = data.settings;
  if (next.jellyfin && !next.jellyfin.token && cur.jellyfin.token && next.jellyfin.server === cur.jellyfin.server) {
    next.jellyfin.token = cur.jellyfin.token;
    next.jellyfin.userId = cur.jellyfin.userId;
  }
  store.replace(next);

  let restored = 0;
  if (mode === 'replace' && data.data && typeof data.data === 'object') {
    for (const [key, value] of Object.entries(data.data)) {
      await db.set(key, value);
      restored++;
    }
    // Re-parse uploaded playlists and refresh URL sources in the background.
    const { refreshSource } = await import('./iptv.js');
    for (const s of store.get('iptv.sources') || []) {
      refreshSource(s.id).catch((e) => console.warn('[backup] Quelle', s.name, e.message));
    }
  }
  bus.emit('backup:imported');
  return { restored, exportedAt: data.exportedAt };
}

/** Days since the last export (Infinity = never). */
export function daysSinceBackup() {
  const t = store.get('backup.lastExport');
  return t ? (Date.now() - t) / 86400e3 : Infinity;
}
