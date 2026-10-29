/** Videothek (Jellyfin): login, library home, browse grid, search, detail page with seasons/episodes. */
import { h, icon, button, img } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate, router } from '../core/router.js';
import { focusFirst } from '../core/focus.js';
import { inputMode } from '../core/input-mode.js';
import { debounce, isMixedContent, normalizeServerUrl } from '../core/util.js';
import { row, posterCard, emptyState, loading } from '../components/cards.js';
import { pickOption } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import * as jf from '../services/jellyfin.js';
import { youtubeId } from '../services/sponsorblock.js';
import { playJellyfin, playYouTube } from '../player/player.js';

function itemSubtitle(it) {
  if (it.Type === 'Episode') return `S${it.ParentIndexNumber || '?'}E${it.IndexNumber || '?'} · ${it.Name}`;
  if (it.Type === 'Series') return [it.ProductionYear, it.ChildCount ? it.ChildCount + ' Staffeln' : null].filter(Boolean).join(' · ');
  return it.ProductionYear ? String(it.ProductionYear) : '';
}

function itemCard(it, { wide = false } = {}) {
  const ud = it.UserData || {};
  return posterCard({
    title: it.Type === 'Episode' ? it.SeriesName || it.Name : it.Name,
    subtitle: itemSubtitle(it),
    image: wide ? jf.thumbUrl(it) : jf.posterUrl(it),
    wide,
    progress: ud.PlayedPercentage ? ud.PlayedPercentage / 100 : 0,
    badge: ud.Played ? '✓' : ud.UnplayedItemCount ? String(ud.UnplayedItemCount) : null,
    onClick: () => (it.Type === 'Episode' || (wide && ud.PlaybackPositionTicks) ? playJellyfin(it) : navigate('/library/item/' + it.Id)),
    onLongPress: () => navigate('/library/item/' + (it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id)),
  });
}

/** Login form – also used by the settings page. */
export function jellyfinLoginForm({ onDone } = {}) {
  const cfg = store.get('jellyfin');
  const server = h('input.input', { type: 'url', placeholder: 'http://192.168.1.10:8096', value: cfg.server, data: { focus: true }, autocomplete: 'url', autocapitalize: 'off', spellcheck: 'false' });
  const user = h('input.input', { type: 'text', placeholder: 'Benutzername', value: cfg.userName, data: { focus: true }, autocomplete: 'username', autocapitalize: 'off' });
  const pass = h('input.input', { type: 'password', placeholder: 'Passwort', data: { focus: true }, autocomplete: 'current-password' });
  const status = h('p.form-status');
  const submit = async () => {
    status.textContent = 'Verbinde …';
    status.className = 'form-status';
    try {
      const u = await jf.login(server.value, user.value.trim(), pass.value);
      status.textContent = `Angemeldet als ${u.Name}`;
      status.classList.add('ok');
      toast('Jellyfin verbunden', { kind: 'success' });
      if (onDone) onDone();
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
    }
  };
  const test = async () => {
    status.textContent = 'Prüfe Server …';
    status.className = 'form-status';
    try {
      const info = await jf.publicInfo(server.value);
      status.textContent = `Gefunden: ${info.ServerName} (Jellyfin ${info.Version})`;
      status.classList.add('ok');
    } catch (e) {
      status.textContent = e.message;
      status.classList.add('error');
    }
  };
  pass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  const warn = h('p.hint');
  const updateWarn = () => {
    const u = normalizeServerUrl(server.value);
    warn.textContent = u && isMixedContent(u) ? 'Achtung: Diese App läuft über HTTPS, der Server über HTTP. Browser blockieren das – Jellyfin per HTTPS erreichbar machen (z. B. Reverse-Proxy) oder die App im Heimnetz per HTTP öffnen.' : '';
  };
  server.addEventListener('input', updateWarn);
  updateWarn();
  return h(
    'form.form.login-form',
    { onSubmit: (e) => (e.preventDefault(), submit()), data: { focusGroup: true } },
    h('label.field-label', 'Server-Adresse'),
    server,
    warn,
    h('label.field-label', 'Benutzer'),
    user,
    h('label.field-label', 'Passwort'),
    pass,
    h('div.form-actions', button('Anmelden', submit, { variant: 'primary', icon: 'user' }), button('Server testen', test, { icon: 'search' })),
    status,
  );
}

export async function libraryView(el) {
  if (!jf.isConnected()) {
    el.append(h('header.view-head', h('h1', 'Videothek')), h('div.panel-card', h('h2', 'Mit Jellyfin verbinden'), h('p.muted', 'Melde dich an deinem Jellyfin-Server an, um Filme und Serien zu sehen.'), jellyfinLoginForm()));
    const off = bus.on('jellyfin:changed', () => router.refresh());
    return { unmount: off };
  }

  const search = h('input.input.search', { type: 'search', placeholder: 'Filme & Serien suchen …', data: { focus: true }, enterkeyhint: 'search', autocomplete: 'off' });
  const chips = h('div.chips', { data: { focusGroup: true } });
  const body = h('div.rows', loading());
  el.append(h('header.view-head', h('h1', 'Videothek'), h('div.head-actions', { data: { focusGroup: true } }, search)), chips, body);

  let alive = true;
  let homeParts = null;
  const renderHome = async () => {
    try {
      const views = await jf.views();
      chips.replaceChildren(
        h('button.chip', { type: 'button', data: { focus: true }, onClick: () => navigate('/library/view/favorites') }, icon('star'), h('span', 'Favoriten')),
        ...views.map((v) => h('button.chip', { type: 'button', data: { focus: true }, onClick: () => navigate('/library/view/' + v.Id) }, h('span', v.Name))),
      );
      const [resumeItems, nextUpItems, ...latest] = await Promise.all([jf.resume(20), jf.nextUp(20).catch(() => []), ...views.slice(0, 6).map((v) => jf.latest(v.Id, 20).catch(() => []))]);
      if (!alive) return;
      homeParts = [
        row('Weiterschauen', resumeItems.map((it) => itemCard(it, { wide: true }))),
        row('Nächste Folgen', nextUpItems.map((it) => itemCard(it, { wide: true }))),
        ...views.slice(0, 6).map((v, i) => row('Neu: ' + v.Name, latest[i].map((it) => itemCard(it)), { more: { label: 'Alle', onClick: () => navigate('/library/view/' + v.Id) } })),
      ].filter(Boolean);
      body.replaceChildren(...(homeParts.length ? homeParts : [emptyState({ iconName: 'film', title: 'Keine Inhalte', text: 'Die Bibliotheken sind leer.' })]));
      if (inputMode.isTV() && !el.contains(document.activeElement)) focusFirst(el);
    } catch (e) {
      body.replaceChildren(emptyState({ iconName: 'info', title: 'Jellyfin nicht erreichbar', text: e.message, actions: [button('Erneut versuchen', renderHome, { icon: 'refresh', variant: 'primary' }), button('Einstellungen', () => navigate('/settings/jellyfin'), { icon: 'settings' })] }));
    }
  };

  search.addEventListener(
    'input',
    debounce(async () => {
      const q = search.value.trim();
      if (!q) {
        if (homeParts) body.replaceChildren(...homeParts);
        return;
      }
      body.replaceChildren(loading('Suche …'));
      try {
        const r = await jf.items({ search: q, limit: 60, types: 'Movie,Series,Episode', sort: 'SortName' });
        if (search.value.trim() !== q) return;
        body.replaceChildren(r.items.length ? h('div.poster-grid', { data: { focusGroup: true } }, r.items.map((it) => itemCard(it))) : emptyState({ iconName: 'search', title: 'Nichts gefunden' }));
      } catch (e) {
        body.replaceChildren(emptyState({ iconName: 'info', title: 'Suche fehlgeschlagen', text: e.message }));
      }
    }, 350),
  );

  const off = bus.on('jellyfin:unauthorized', () => toast('Jellyfin-Anmeldung abgelaufen – bitte neu anmelden', { kind: 'warn' }));
  await renderHome();
  return {
    unmount() {
      alive = false;
      off();
    },
  };
}

const SORTS = [
  { value: 'SortName|Ascending', label: 'Titel A–Z' },
  { value: 'DateCreated|Descending', label: 'Zuletzt hinzugefügt' },
  { value: 'PremiereDate|Descending', label: 'Erscheinungsdatum' },
  { value: 'CommunityRating|Descending', label: 'Bewertung' },
  { value: 'Random|Ascending', label: 'Zufällig' },
];

export async function libraryBrowseView(el, { params }) {
  const isFav = params.id === 'favorites';
  let sort = store.get('jellyfin.browseSort') || 'SortName|Ascending';
  const title = h('h1', isFav ? 'Favoriten' : 'Bibliothek');
  const sortBtn = h('button.chip', { type: 'button', data: { focus: true } });
  const grid = h('div.poster-grid', { data: { focusGroup: true } });
  const sentinel = h('div.sentinel');
  const info = h('div.list-info.muted');
  el.append(
    h('header.view-head', h('button.icon-btn.back-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Zurück', onClick: () => history.back() }, icon('back')), title, h('div.head-actions', sortBtn)),
    info,
    grid,
    sentinel,
  );
  if (!isFav) {
    jf.views()
      .then((v) => {
        const view = v.find((x) => x.Id === params.id);
        if (view) title.textContent = view.Name;
      })
      .catch(() => {});
  }

  let start = 0;
  let total = Infinity;
  let busy = false;
  let alive = true;
  const PAGE = 60;
  const loadMore = async () => {
    if (busy || start >= total || !alive) return;
    busy = true;
    try {
      const [by, order] = sort.split('|');
      const r = await jf.items({ parentId: isFav ? undefined : params.id, favorites: isFav, start, limit: PAGE, sort: by, order, types: isFav ? 'Movie,Series,Episode' : 'Movie,Series,Video,MusicVideo' });
      if (!alive) return;
      total = r.total;
      start += r.items.length;
      info.textContent = `${total} Titel`;
      for (const it of r.items) grid.appendChild(itemCard(it));
      if (!r.items.length) total = start;
      if (start === r.items.length && !r.items.length) grid.replaceChildren(emptyState({ iconName: 'film', title: 'Keine Titel' }));
      if (start === r.items.length && inputMode.isTV()) focusFirst(el);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    } finally {
      busy = false;
    }
  };
  const reset = () => {
    start = 0;
    total = Infinity;
    grid.replaceChildren();
    sortBtn.replaceChildren(icon('list'), h('span', SORTS.find((s) => s.value === sort).label));
    loadMore();
  };
  sortBtn.addEventListener('click', async () => {
    const v = await pickOption('Sortierung', SORTS, sort);
    if (v) {
      sort = v;
      store.set('jellyfin.browseSort', v);
      reset();
    }
  });
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && loadMore(), { rootMargin: '800px' }) : null;
  if (io) io.observe(sentinel);
  grid.addEventListener('focusin', (e) => {
    const idx = Array.prototype.indexOf.call(grid.children, e.target);
    if (idx > grid.children.length - 20) loadMore();
  });
  reset();
  return {
    unmount() {
      alive = false;
      if (io) io.disconnect();
    },
  };
}

export async function libraryDetailView(el, { params }) {
  el.append(loading());
  let it;
  try {
    it = await jf.item(params.id);
  } catch (e) {
    el.replaceChildren(emptyState({ iconName: 'info', title: 'Titel nicht gefunden', text: e.message, actions: [button('Zurück', () => history.back(), { icon: 'back' })] }));
    return null;
  }
  const backdrop = jf.backdropUrl(it);
  const ud = it.UserData || {};
  const resumeTicks = ud.PlaybackPositionTicks || 0;
  const meta = [it.ProductionYear, it.OfficialRating, jf.formatRuntime(it.RunTimeTicks), it.CommunityRating ? '★ ' + it.CommunityRating.toFixed(1) : null, (it.Genres || []).slice(0, 3).join(', ')].filter(Boolean);

  const actions = h('div.detail-actions', { data: { focusGroup: true } });
  const favBtn = button(ud.IsFavorite ? 'Favorit' : 'Merken', async () => {
    try {
      const now = !favBtn.classList.contains('active');
      await jf.setFavorite(it.Id, now);
      favBtn.classList.toggle('active', now);
      favBtn.querySelector('.btn-label').textContent = now ? 'Favorit' : 'Merken';
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }, { icon: 'star', class: ud.IsFavorite ? 'active' : '' });

  if (it.Type !== 'Series') {
    if (resumeTicks) actions.append(button('Fortsetzen ' + formatPos(resumeTicks), () => playJellyfin(it), { variant: 'primary', icon: 'play', default: true }), button('Von vorn', () => playJellyfin(it, { startMs: 0 }), { icon: 'refresh' }));
    else actions.append(button('Abspielen', () => playJellyfin(it, { startMs: 0 }), { variant: 'primary', icon: 'play', default: true }));
  }
  const trailer = (it.RemoteTrailers || []).map((t) => youtubeId(t.Url)).find(Boolean);
  if (trailer) actions.append(button('Trailer', () => playYouTube(trailer, { title: 'Trailer: ' + it.Name }), { icon: 'youtube' }));
  actions.append(favBtn);
  actions.append(
    button(ud.Played ? 'Gesehen ✓' : 'Als gesehen', async (e) => {
      try {
        const now = !ud.Played;
        await jf.setPlayed(it.Id, now);
        ud.Played = now;
        e.currentTarget.querySelector('.btn-label').textContent = now ? 'Gesehen ✓' : 'Als gesehen';
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    }, { icon: 'check' }),
  );

  const page = h(
    'div.detail',
    backdrop ? h('div.detail-backdrop', { style: { backgroundImage: `url("${backdrop}")` } }) : null,
    h(
      'div.detail-main',
      h('button.icon-btn.back-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Zurück', onClick: () => history.back() }, icon('back')),
      h(
        'div.detail-grid',
        h('div.detail-poster', img(jf.posterUrl(it), it.Name, 'cover', it.Name)),
        h(
          'div.detail-info',
          h('h1', it.Name),
          it.OriginalTitle && it.OriginalTitle !== it.Name ? h('div.muted', it.OriginalTitle) : null,
          h('div.detail-meta', meta.map((m) => h('span', m))),
          actions,
          it.Overview ? h('p.detail-overview', it.Overview) : null,
          (it.People || []).length ? h('p.detail-people.muted', 'Mit: ' + it.People.filter((p) => p.Type === 'Actor').slice(0, 8).map((p) => p.Name).join(', ')) : null,
        ),
      ),
    ),
  );
  el.replaceChildren(page);

  if (it.Type === 'Series') {
    const seasonChips = h('div.chips', { data: { focusGroup: true } });
    const epList = h('div.episode-list', { data: { focusGroup: true } });
    page.querySelector('.detail-main').append(h('h2.row-title', 'Staffeln'), seasonChips, epList);
    const seasons = await jf.seasons(it.Id).catch(() => []);
    const showSeason = async (s, chip) => {
      for (const c of seasonChips.children) c.classList.toggle('active', c === chip);
      epList.replaceChildren(loading());
      const eps = await jf.episodes(it.Id, s.Id).catch(() => []);
      epList.replaceChildren(
        ...eps.map((ep) => {
          const p = ep.UserData && ep.UserData.PlayedPercentage;
          return h(
            'button.episode',
            { type: 'button', data: { focus: true }, onClick: () => playJellyfin(ep) },
            h('div.episode-thumb', img(jf.imageUrl(ep, 'Primary', { width: 400 }) || jf.thumbUrl(ep), ep.Name, 'cover', ep.Name), p ? h('div.card-progress', h('span', { style: { width: p + '%' } })) : null),
            h(
              'div.episode-text',
              h('div.episode-title', `${ep.IndexNumber || ''}. ${ep.Name}`, ep.UserData && ep.UserData.Played ? h('span.badge', '✓') : null),
              h('div.muted', jf.formatRuntime(ep.RunTimeTicks)),
              ep.Overview ? h('p.episode-overview', ep.Overview) : null,
            ),
          );
        }),
      );
    };
    seasons.forEach((s, i) => {
      const chip = h('button.chip', { type: 'button', data: { focus: true } }, h('span', s.Name));
      chip.addEventListener('click', () => showSeason(s, chip));
      seasonChips.appendChild(chip);
      if (i === 0) showSeason(s, chip);
    });
  }
  if (inputMode.isTV()) requestAnimationFrame(() => focusFirst(actions.children.length ? actions : el));
  return null;
}

function formatPos(ticks) {
  const s = Math.floor(ticks / 1e7);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh ? `${hh}:${String(mm).padStart(2, '0')} h` : `${mm} min`;
}
