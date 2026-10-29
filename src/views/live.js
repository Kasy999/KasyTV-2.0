/** Live-TV: playlist sources, categories, search, favourites, channel grid/list. */
import { h, icon, button } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate, router } from '../core/router.js';
import { debounce } from '../core/util.js';
import { preserveFocus } from '../core/focus.js';
import { channelCard, emptyState, loading, batchedList } from '../components/cards.js';
import { pickOption, promptDialog, dialog } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import * as iptv from '../services/iptv.js';
import { playChannel, playUrl } from '../player/player.js';

export const M3U_ACCEPT = '.m3u,.m3u8,audio/x-mpegurl,audio/mpegurl,application/x-mpegurl,application/vnd.apple.mpegurl,text/plain';

/**
 * Opens the native file picker for M3U files (iOS: Dateien-App, iCloud, Downloads).
 * `any` drops the type filter – some iOS versions grey out .m3u files when a filter is set.
 */
let fileInput = null;

export function pickPlaylistFile({ any = false } = {}) {
  return new Promise((resolve) => {
    // One hidden input that stays in the DOM (iOS needs it attached while the picker is open).
    if (!fileInput) {
      fileInput = h('input', { type: 'file', style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' }, tabindex: '-1', 'aria-hidden': 'true' });
      document.body.appendChild(fileInput);
    }
    const input = fileInput;
    if (any) input.removeAttribute('accept');
    else input.setAttribute('accept', M3U_ACCEPT);
    input.value = '';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function uploadPlaylistFlow({ any = false } = {}) {
  const file = await pickPlaylistFile({ any });
  if (!file) return null;
  const done = toast(`„${file.name}“ wird eingelesen …`, { duration: 60000 });
  try {
    const src = await iptv.addFileSource(file);
    done && done();
    const s = iptv.getSources().find((x) => x.id === src.id);
    toast(`${s.count} Sender aus „${s.name}“ geladen`, { kind: 'success' });
    return src;
  } catch (e) {
    done && done();
    toast(e.message, { kind: 'error', duration: 6000 });
    return null;
  }
}

export async function addUrlFlow() {
  const url = await promptDialog('Playlist-Adresse', {
    label: 'M3U/M3U8-URL',
    placeholder: 'https://anbieter.example/playlist.m3u',
    type: 'url',
    hint: 'Funktioniert, wenn der Anbieter Web-Apps den Abruf erlaubt (CORS). Sonst die Datei hochladen oder einen CORS-Proxy eintragen.',
  });
  if (!url) return null;
  const done = toast('Playlist wird geladen …', { duration: 60000 });
  try {
    const src = await iptv.addUrlSource('', url);
    done && done();
    const s = iptv.getSources().find((x) => x.id === src.id);
    toast(`${s.count} Sender geladen`, { kind: 'success' });
    return src;
  } catch (e) {
    done && done();
    toast(e.message, { kind: 'error', duration: 7000 });
    return null;
  }
}

export async function playSingleStreamFlow() {
  const url = await promptDialog('Einzelnen Stream abspielen', { label: 'Adresse (m3u8, ts, mp4, YouTube-Link …)', type: 'url', placeholder: 'https://…/stream.m3u8' });
  if (url && /^https?:\/\//i.test(url.trim())) playUrl(url.trim(), { title: 'Stream', subtitle: url.trim() });
}

export async function channelContextMenu(sourceId, ch, onChange) {
  const key = iptv.channelKey(sourceId, ch);
  const fav = await iptv.isFavorite(key);
  const v = await pickOption(ch.name, [
    { value: 'play', label: 'Abspielen' },
    { value: 'fav', label: fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen' },
    { value: 'copy', label: 'Stream-Adresse kopieren' },
    { value: 'info', label: 'Details' },
  ]);
  if (v === 'play') playChannel(sourceId, [ch], 0);
  else if (v === 'fav') {
    const now = await iptv.toggleFavorite(key);
    toast(now ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', { iconName: 'star' });
    if (onChange) onChange();
  } else if (v === 'copy') {
    try {
      await navigator.clipboard.writeText(ch.url);
      toast('Adresse kopiert');
    } catch {
      promptDialog('Stream-Adresse', { value: ch.url });
    }
  } else if (v === 'info') {
    const rows = [
      ['Name', ch.name],
      ['Nummer', ch.number],
      ['Kategorie', ch.group],
      ['tvg-id', ch.tvgId || '–'],
      ['Archiv', ch.catchup && ch.catchup.type !== 'NONE' ? `${ch.catchup.type}, ${ch.catchup.days} Tage` : 'nein'],
      ['Adresse', ch.url],
    ];
    if (ch.headers) rows.push(['HTTP-Header', Object.keys(ch.headers).join(', ') + ' (vom Browser nicht setzbar)']);
    dialog({ title: 'Sender-Details', body: h('dl.info-list', rows.map(([k, val]) => [h('dt', k), h('dd', String(val))])), actions: [{ label: 'OK', primary: true }] });
  }
}

export async function liveView(el, { query }) {
  let source = iptv.getActiveSource();
  if (!source) {
    el.append(
      h('header.view-head', h('h1', 'Live-TV')),
      emptyState({
        iconName: 'tv',
        title: 'Noch keine Senderliste',
        text: 'Lade eine M3U/M3U8-Playlist direkt vom Gerät (z. B. aus „Dateien“, iCloud Drive oder Downloads) oder gib die Adresse deines Anbieters ein.',
        actions: [
          button('Datei hochladen', () => uploadPlaylistFlow(), { variant: 'primary', icon: 'upload', default: true }),
          button('Datei (alle Typen)', () => uploadPlaylistFlow({ any: true }), { icon: 'folder' }),
          button('Adresse eingeben', () => addUrlFlow(), { icon: 'link' }),
          button('Einzelnen Stream', playSingleStreamFlow, { icon: 'play' }),
        ],
      }),
    );
    const off = bus.on('iptv:changed', () => refreshView());
    return { unmount: off };
  }

  const state = {
    group: query.group || store.get('iptv.lastGroup') || '__all',
    query: '',
    view: store.get('iptv.view'),
    sort: store.get('iptv.sort'),
  };

  const search = h('input.input.search', { type: 'search', placeholder: 'Sender suchen …', data: { focus: true }, autocomplete: 'off', enterkeyhint: 'search' });
  const sourceBtn = h('button.chip.source-chip', { type: 'button', data: { focus: true } });
  const viewBtn = h('button.icon-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Ansicht' });
  const sortBtn = h('button.icon-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Sortierung', title: 'Sortierung' }, icon('sort'));
  const addBtn = h('button.icon-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Playlist hinzufügen', title: 'Playlist hinzufügen' }, icon('plus'));
  const chips = h('div.chips', { data: { focusGroup: true } });
  const grid = h('div.channel-grid', { data: { focusGroup: true } });
  const info = h('div.list-info.muted');

  el.append(
    h('header.view-head', h('h1', 'Live-TV'), h('div.head-actions', { data: { focusGroup: true } }, sourceBtn, search, sortBtn, viewBtn, addBtn)),
    chips,
    info,
    grid,
  );

  let playlist = null;
  let favs = new Set();
  let list = [];
  let batch = null;

  const renderHead = () => {
    sourceBtn.replaceChildren(...[icon('folder'), h('span', source.name), iptv.getSources().length > 1 ? icon('down') : null].filter(Boolean));
    viewBtn.replaceChildren(icon(state.view === 'grid' ? 'list' : 'grid'));
    viewBtn.title = state.view === 'grid' ? 'Listenansicht' : 'Kachelansicht';
  };

  const renderChips = () => {
    const groups = [{ id: '__all', name: 'Alle', count: playlist.channels.length }, { id: '__favorites', name: '★ Favoriten', count: null }].concat(playlist.groups.map((g) => ({ id: g.name, name: g.name, count: g.count })));
    if (!groups.some((g) => g.id === state.group)) state.group = '__all';
    chips.replaceChildren(
      ...groups.map((g) => {
        const chip = h(
          'button.chip' + (g.id === state.group ? '.active' : ''),
          { type: 'button', data: { focus: true } },
          h('span', g.name),
          g.count !== null ? h('span.chip-count', String(g.count)) : null,
        );
        chip.addEventListener('click', () => {
          state.group = g.id;
          store.set('iptv.lastGroup', g.id);
          for (const c of chips.children) c.classList.toggle('active', c === chip);
          renderList();
        });
        return chip;
      }),
    );
  };

  const renderList = () => {
    list = iptv.selectChannels(playlist, { group: state.group, query: state.query, favs, sort: state.sort, sourceId: source.id });
    grid.classList.toggle('as-list', state.view === 'list');
    info.textContent = `${list.length} Sender` + (state.query ? ` für „${state.query}“` : '');
    if (batch) batch.destroy();
    if (!list.length) {
      grid.replaceChildren(emptyState({ iconName: state.group === '__favorites' ? 'star' : 'search', title: state.group === '__favorites' ? 'Noch keine Favoriten' : 'Keine Sender gefunden', text: state.group === '__favorites' ? 'OK gedrückt halten bzw. lange auf einen Sender tippen → „Zu Favoriten hinzufügen“.' : null }));
      return;
    }
    batch = batchedList(grid, list, (ch, i) =>
      channelCard(ch, {
        list: state.view === 'list',
        favorite: favs.has(iptv.channelKey(source.id, ch)),
        onClick: () => playChannel(source.id, list, i),
        onLongPress: () => channelContextMenu(source.id, ch, async () => {
          favs = new Set(await iptv.favoriteKeys());
          preserveFocus(grid, renderList);
        }),
      }),
    );
  };

  const load = async () => {
    source = iptv.getActiveSource();
    if (!source) return refreshView();
    renderHead();
    grid.replaceChildren(loading('Senderliste wird geladen …'));
    try {
      playlist = await iptv.getPlaylist(source.id);
      if (!playlist) throw new Error('Diese Datei-Quelle ist leer – bitte erneut hochladen.');
      favs = new Set(await iptv.favoriteKeys());
      renderChips();
      renderList();
    } catch (e) {
      grid.replaceChildren(
        emptyState({
          iconName: 'info',
          title: 'Playlist konnte nicht geladen werden',
          text: e.message,
          actions: [button('Erneut versuchen', load, { icon: 'refresh', variant: 'primary' }), button('Datei hochladen', () => uploadPlaylistFlow(), { icon: 'upload' })],
        }),
      );
    }
  };

  sourceBtn.addEventListener('click', async () => {
    const sources = iptv.getSources();
    const v = await pickOption(
      'Senderliste',
      sources
        .map((s) => ({ value: s.id, label: s.name, description: `${s.count || 0} Sender · ${s.type === 'file' ? 'Datei' : 'URL'}` }))
        .concat([{ value: '__upload', label: '+ Datei hochladen' }, { value: '__url', label: '+ Adresse hinzufügen' }, { value: '__manage', label: 'Quellen verwalten …' }]),
      source.id,
    );
    if (!v) return;
    if (v === '__upload') return uploadPlaylistFlow();
    if (v === '__url') return addUrlFlow();
    if (v === '__manage') return navigate('/settings/iptv');
    iptv.setActiveSource(v);
  });
  viewBtn.addEventListener('click', () => {
    state.view = state.view === 'grid' ? 'list' : 'grid';
    store.set('iptv.view', state.view);
    renderHead();
    renderList();
  });
  sortBtn.addEventListener('click', async () => {
    const v = await pickOption('Sortierung', [
      { value: 'default', label: 'Wie in der Playlist' },
      { value: 'number', label: 'Nach Nummer' },
      { value: 'name', label: 'A – Z' },
    ], state.sort);
    if (v) {
      state.sort = v;
      store.set('iptv.sort', v);
      renderList();
    }
  });
  addBtn.addEventListener('click', async () => {
    const v = await pickOption('Hinzufügen', [
      { value: 'file', label: 'M3U-Datei hochladen', description: 'Aus Dateien, iCloud Drive, Downloads' },
      { value: 'any', label: 'Datei hochladen (alle Dateitypen)', description: 'Falls die Datei im Auswahldialog ausgegraut ist' },
      { value: 'url', label: 'Playlist-Adresse eingeben' },
      { value: 'stream', label: 'Einzelnen Stream abspielen' },
      { value: 'refresh', label: 'Aktuelle Liste neu laden' },
    ]);
    if (v === 'file') uploadPlaylistFlow();
    else if (v === 'any') uploadPlaylistFlow({ any: true });
    else if (v === 'url') addUrlFlow();
    else if (v === 'stream') playSingleStreamFlow();
    else if (v === 'refresh') {
      try {
        await iptv.refreshSource(source.id);
        toast('Liste aktualisiert', { kind: 'success' });
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    }
  });
  search.addEventListener(
    'input',
    debounce(() => {
      state.query = search.value.trim();
      renderList();
    }, 200),
  );

  const offs = [
    bus.on('iptv:changed', () => load()),
    bus.on('iptv:favorites', async () => {
      favs = new Set(await iptv.favoriteKeys());
      if (state.group === '__favorites') renderList();
    }),
  ];
  await load();
  iptv.refreshStale();
  return {
    unmount() {
      offs.forEach((o) => o());
      if (batch) batch.destroy();
    },
  };
}

function refreshView() {
  router.refresh();
}
