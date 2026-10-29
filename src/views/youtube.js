/**
 * YouTube as a full section of the app – browsing like a YouTube client, playback without ads:
 *   /youtube                 Start: Angesagt, Musik, Gaming, Filme · Abos · Später · Verlauf
 *   /youtube/search?q=       Search (videos + channels) with suggestions while typing
 *   /youtube/watch/:id       Video page: player starts at once; details, channel, related videos
 *   /youtube/channel/:id     Channel: banner, subscribe (locally), newest videos
 * Data comes from an Invidious instance (services/youtube.js); videos play in the Kasy player with
 * SponsorBlock, the ad blocker and the subtitle styles.
 */
import { h, icon, img, button } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { focusFirst, preserveFocus } from '../core/focus.js';
import { inputMode } from '../core/input-mode.js';
import { debounce } from '../core/util.js';
import { emptyState, loading } from '../components/cards.js';
import { pickOption, confirmDialog } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import { playYouTube, isPlayerOpen } from '../player/player.js';
import * as yt from '../services/youtube.js';

// ------------------------------------------------------------------ building blocks

function videoCard(v, { list } = {}) {
  const sub = [v.author, v.views ? yt.formatViews(v.views) : null, v.published ? yt.ago(v.published) : v.publishedText || null].filter(Boolean).join(' · ');
  const el = h(
    'button.card.poster.wide.yt-card',
    { type: 'button', data: { focus: true, longpress: true }, title: v.title, onClick: () => openVideo(v, list) },
    h(
      'div.card-media',
      img(v.thumb || yt.ytThumb(v.id), v.title, 'cover', v.title),
      v.live ? h('span.yt-badge.live', 'LIVE') : v.duration ? h('span.yt-badge', yt.formatDuration(v.duration)) : null,
    ),
    h('div.card-text', h('div.card-title.two-lines', v.title), h('div.card-sub', sub)),
  );
  el.addEventListener('longpress', () => videoMenu(v));
  return el;
}

function channelCard(c) {
  return h(
    'button.card.yt-channel',
    { type: 'button', data: { focus: true }, title: c.name, onClick: () => navigate('/youtube/channel/' + c.id) },
    h('div.yt-avatar', img(c.thumb, c.name, 'cover', c.name)),
    h('div.card-title', c.name),
    c.subs ? h('div.card-sub', formatSubs(c.subs)) : null,
  );
}

function formatSubs(n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' Mio. Abonnenten';
  if (n >= 1e3) return Math.round(n / 1e3) + ' Tsd. Abonnenten';
  return n + ' Abonnenten';
}

function grid(items, list) {
  return h(
    'div.poster-grid.wide.yt-grid',
    { data: { focusGroup: true } },
    items.map((x) => (x.type === 'channel' ? channelCard(x) : videoCard(x, list))),
  );
}

function row(title, items, more) {
  if (!items || !items.length) return null;
  return h(
    'section.row',
    h('div.row-head', h('h2.row-title', title), more ? h('button.link-btn', { type: 'button', data: { focus: true }, onClick: more.onClick }, more.label, icon('next')) : null),
    h('div.row-scroller', { data: { focusGroup: true } }, items.map((v) => videoCard(v, items))),
  );
}

function openVideo(v) {
  navigate('/youtube/watch/' + v.id + '?play=1');
}

async function videoMenu(v) {
  const later = (await yt.watchLater()).some((x) => x.id === v.id);
  const choice = await pickOption(v.title, [
    { value: 'play', label: 'Abspielen' },
    { value: 'later', label: later ? 'Aus „Später ansehen“ entfernen' : 'Später ansehen' },
    v.authorId ? { value: 'channel', label: 'Zum Kanal: ' + v.author } : null,
    { value: 'embed', label: 'Im offiziellen YouTube-Player öffnen' },
  ].filter(Boolean));
  if (choice === 'play') openVideo(v);
  else if (choice === 'later') toast((await yt.toggleWatchLater(v)) ? 'Zu „Später ansehen“ hinzugefügt' : 'Entfernt');
  else if (choice === 'channel') navigate('/youtube/channel/' + v.authorId);
  else if (choice === 'embed') playYouTube(v.id, { title: v.title, forceEmbed: true });
}

/** Search field with live suggestions (also accepts pasted YouTube links). */
function searchBar(initial = '') {
  const input = h('input.input.search', {
    type: 'search',
    value: initial,
    placeholder: 'YouTube durchsuchen …',
    data: { focus: true },
    enterkeyhint: 'search',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const box = h('div.yt-suggest', { data: { focusGroup: true } });
  const submit = (q) => {
    q = (q || input.value).trim();
    if (!q) return;
    box.replaceChildren();
    const id = yt.youtubeId(q);
    if (id && (q.includes('/') || q.length === 11)) navigate('/youtube/watch/' + id + '?play=1');
    else navigate('/youtube/search?q=' + encodeURIComponent(q));
  };
  let lastQ = '';
  input.addEventListener(
    'input',
    debounce(async () => {
      const q = input.value.trim();
      lastQ = q;
      const list = await yt.suggestions(q);
      if (lastQ !== q) return;
      box.replaceChildren(
        ...list.map((s) =>
          h('button.yt-suggestion', { type: 'button', data: { focus: true }, onClick: () => ((input.value = s), submit(s)) }, icon('search'), h('span', s)),
        ),
      );
    }, 220),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (!box.contains(document.activeElement)) box.replaceChildren();
  }, 200));
  const bar = h(
    'div.yt-searchbar',
    h('div.yt-searchwrap', input, box),
    h('button.icon-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Suchen', onClick: () => submit() }, icon('search')),
  );
  return { bar, input };
}

function header(extra) {
  const sb = store.get('blocker.sponsorblock.enabled');
  const { bar } = searchBar(extra && extra.query);
  return h(
    'header.view-head.yt-head',
    extra && extra.back ? h('button.icon-btn.back-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Zurück', onClick: () => history.back() }, icon('back')) : null,
    h('h1', 'YouTube'),
    h('span.pill.ok', icon('shield'), 'werbefrei' + (sb ? ' · SponsorBlock' : '')),
    bar,
  );
}

function errorState(e, retry) {
  return emptyState({
    iconName: 'info',
    title: 'YouTube gerade nicht erreichbar',
    text: e.message,
    actions: [
      button('Erneut versuchen', retry, { icon: 'refresh', variant: 'primary' }),
      button('Andere Instanz', () => navigate('/settings/youtube'), { icon: 'settings' }),
    ],
  });
}

// ------------------------------------------------------------------ views

const TABS = [
  { id: 'home', label: 'Start' },
  { id: 'subs', label: 'Abos' },
  { id: 'later', label: 'Später ansehen' },
  { id: 'history', label: 'Verlauf' },
];

export async function youtubeView(el, { query }) {
  // Deep link: #/youtube?v=ID
  if (query.v) {
    navigate('/youtube/watch/' + query.v + '?play=1', { replace: true });
    return null;
  }
  let tab = query.tab || sessionStorage.getItem('kasy.yt.tab') || 'home';
  let category = '';
  const tabs = h('div.chips', { data: { focusGroup: true } });
  const body = h('div.rows');
  el.append(header(), tabs, body);
  let alive = true;

  const renderTabs = () => {
    tabs.replaceChildren(
      ...TABS.map((t) => {
        const b = h('button.chip' + (t.id === tab ? '.active' : ''), { type: 'button', data: { focus: true } }, h('span', t.label));
        b.addEventListener('click', () => {
          tab = t.id;
          sessionStorage.setItem('kasy.yt.tab', tab);
          renderTabs();
          render();
        });
        return b;
      }),
    );
  };

  const render = async () => {
    body.replaceChildren(loading());
    try {
      let parts = [];
      if (tab === 'home') {
        const cats = h(
          'div.chips.small',
          { data: { focusGroup: true } },
          yt.CATEGORIES.map((c) => {
            const b = h('button.chip' + (c.id === category ? '.active' : ''), { type: 'button', data: { focus: true } }, h('span', c.label));
            b.addEventListener('click', () => {
              category = c.id;
              render();
            });
            return b;
          }),
        );
        const [vids, hist] = await Promise.all([yt.trending(category), yt.ytHistory()]);
        parts = [
          hist.length && !category ? row('Weiterschauen & zuletzt gesehen', hist.slice(0, 20), { label: 'Verlauf', onClick: () => ((tab = 'history'), renderTabs(), render()) }) : null,
          cats,
          vids.length ? grid(vids, vids) : emptyState({ iconName: 'youtube', title: 'Keine Videos' }),
        ];
      } else if (tab === 'subs') {
        const subs = await yt.subscriptions();
        if (!subs.length) {
          parts = [emptyState({ iconName: 'user', title: 'Noch keine Abos', text: 'Öffne einen Kanal und tippe auf „Abonnieren“. Abos werden nur auf diesem Gerät gespeichert (im Backup enthalten) – kein Google-Konto nötig.' })];
        } else {
          const avatars = h('div.row-scroller.yt-subs', { data: { focusGroup: true } }, subs.map((c) => channelCard(c)));
          const feed = await yt.subscriptionFeed();
          parts = [avatars, h('div.row-head', h('h2.row-title', 'Neueste Videos'), h('button.link-btn', { type: 'button', data: { focus: true }, onClick: async () => { body.replaceChildren(loading()); await yt.subscriptionFeed({ force: true }); render(); } }, icon('refresh'), 'Aktualisieren')), feed.length ? grid(feed, feed) : emptyState({ iconName: 'info', title: 'Keine neuen Videos' })];
        }
      } else if (tab === 'later') {
        const list = await yt.watchLater();
        parts = [list.length ? grid(list, list) : emptyState({ iconName: 'save', title: 'Leer', text: 'Lange auf ein Video tippen bzw. OK gedrückt halten → „Später ansehen“.' })];
      } else {
        const list = await yt.ytHistory();
        parts = list.length
          ? [
              h('div.row-head', h('span.muted', list.length + ' Videos'), h('button.link-btn', { type: 'button', data: { focus: true }, onClick: async () => {
                if (await confirmDialog('Verlauf löschen?', 'Alle zuletzt gesehenen YouTube-Videos werden entfernt.', { okLabel: 'Löschen', danger: true })) {
                  await yt.clearYtHistory();
                  render();
                }
              } }, icon('trash'), 'Löschen')),
              grid(list, list),
            ]
          : [emptyState({ iconName: 'youtube', title: 'Noch nichts angesehen' })];
      }
      if (!alive) return;
      await preserveFocus(el, () => body.replaceChildren(...parts.filter(Boolean)));
      if (inputMode.isTV() && !el.contains(document.activeElement)) focusFirst(tabs);
    } catch (e) {
      if (alive) body.replaceChildren(errorState(e, render));
    }
  };

  renderTabs();
  await render();
  const off = bus.on('player:closed', () => tab === 'history' && render());
  return {
    unmount() {
      alive = false;
      off();
    },
  };
}

export async function youtubeSearchView(el, { query }) {
  const q = query.q || '';
  const body = h('div.rows', loading('Suche …'));
  const more = h('div.load-more');
  el.append(header({ back: true, query: q }), h('h2.row-title', `Ergebnisse für „${q}“`), body, more);
  let page = 1;
  let items = [];
  const load = async () => {
    try {
      const res = await yt.search(q, page);
      items = items.concat(res);
      const videos = items.filter((x) => x.type === 'video');
      body.replaceChildren(items.length ? grid(items, videos) : emptyState({ iconName: 'search', title: 'Keine Treffer' }));
      more.replaceChildren(res.length ? button('Mehr laden', () => (page++, load()), { icon: 'down' }) : '');
      if (page === 1 && inputMode.isTV()) focusFirst(body);
    } catch (e) {
      body.replaceChildren(errorState(e, load));
    }
  };
  await load();
  return null;
}

export async function youtubeWatchView(el, { params, query }) {
  const id = params.id;
  const page = h('div.yt-watch', loading());
  el.append(header({ back: true }), page);
  let details = null;
  let alive = true;

  const play = (startSeconds) => playYouTube(id, { title: details ? details.title : undefined, details, startSeconds });

  const render = async () => {
    try {
      details = await yt.videoDetails(id);
    } catch (e) {
      // No details (instance down): still play – the player falls back to the official player.
      page.replaceChildren(
        h(
          'div.yt-hero',
          h('div.yt-hero-media', img(yt.ytThumb(id, 'hqdefault'), '', 'cover', '')),
          h('div.yt-hero-info', h('p.muted', 'Details nicht verfügbar: ' + e.message), button('Abspielen', () => play(), { variant: 'primary', icon: 'play', default: true })),
        ),
      );
      return;
    }
    if (!alive) return;
    const d = details;
    const subscribed = await yt.isSubscribed(d.authorId);
    const later = (await yt.watchLater()).some((x) => x.id === id);
    const subBtn = button(subscribed ? 'Abonniert' : 'Abonnieren', async () => {
      const on = await yt.toggleSubscription({ id: d.authorId, name: d.author, thumb: d.authorThumb });
      subBtn.querySelector('.btn-label').textContent = on ? 'Abonniert' : 'Abonnieren';
      subBtn.classList.toggle('active', on);
    }, { icon: 'user', class: subscribed ? 'active' : '' });
    const laterBtn = button(later ? 'Gemerkt' : 'Später ansehen', async () => {
      const on = await yt.toggleWatchLater({ id, title: d.title, author: d.author, authorId: d.authorId, duration: d.duration, thumb: yt.ytThumb(id) });
      laterBtn.querySelector('.btn-label').textContent = on ? 'Gemerkt' : 'Später ansehen';
    }, { icon: 'save' });
    const desc = h('p.yt-desc', d.description);
    const descToggle = d.description && d.description.length > 280
      ? h('button.link-btn', { type: 'button', data: { focus: true }, onClick: (e) => { desc.classList.toggle('open'); e.currentTarget.textContent = desc.classList.contains('open') ? 'Weniger' : 'Mehr anzeigen'; } }, 'Mehr anzeigen')
      : null;
    page.replaceChildren(
      h(
        'div.yt-hero',
        h(
          'button.yt-hero-media',
          { type: 'button', data: { focus: true, focusDefault: true }, 'aria-label': 'Abspielen', onClick: () => play() },
          img(d.thumb, d.title, 'cover', d.title),
          h('span.yt-play', icon('play')),
          d.live ? h('span.yt-badge.live', 'LIVE') : d.duration ? h('span.yt-badge', yt.formatDuration(d.duration)) : null,
        ),
        h(
          'div.yt-hero-info',
          h('h1.yt-title', d.title),
          h('div.detail-meta', [d.views ? yt.formatViews(d.views) : null, d.published ? yt.ago(d.published) : d.publishedText, d.likes ? '👍 ' + d.likes.toLocaleString('de-DE') : null].filter(Boolean).map((t) => h('span', t))),
          h(
            'button.yt-author',
            { type: 'button', data: { focus: true }, onClick: () => navigate('/youtube/channel/' + d.authorId) },
            h('div.yt-avatar.small', img(d.authorThumb, d.author, 'cover', d.author)),
            h('div', h('div.card-title', d.author), d.subCount ? h('div.card-sub', d.subCount + ' Abonnenten') : null),
          ),
          h(
            'div.detail-actions',
            { data: { focusGroup: true } },
            button('Abspielen', () => play(), { variant: 'primary', icon: 'play' }),
            subBtn,
            laterBtn,
            button('Offizieller Player', () => playYouTube(id, { title: d.title, forceEmbed: true }), { icon: 'external' }),
          ),
          d.description ? h('div.yt-desc-wrap', desc, descToggle) : null,
        ),
      ),
      d.related.length ? h('h2.row-title', 'Ähnliche Videos') : null,
      d.related.length ? grid(d.related, d.related) : null,
    );
    if (inputMode.isTV() && !isPlayerOpen()) focusFirst(page);
  };

  await render();
  if (query.play === '1' && alive) {
    // Replace ?play=1 so Back from the player lands on this page without starting again.
    history.replaceState(history.state, '', '#/youtube/watch/' + id);
    play();
  }
  return {
    unmount() {
      alive = false;
    },
  };
}

export async function youtubeChannelView(el, { params }) {
  const id = params.id;
  const top = h('div.yt-channel-head', loading());
  const body = h('div.rows');
  const more = h('div.load-more');
  el.append(header({ back: true }), top, body, more);
  let continuation = null;
  let videos = [];
  const loadVideos = async () => {
    try {
      const res = await yt.channelVideos(id, continuation);
      continuation = res.continuation;
      videos = videos.concat(res.videos);
      body.replaceChildren(videos.length ? grid(videos, videos) : emptyState({ iconName: 'youtube', title: 'Keine Videos' }));
      more.replaceChildren(continuation ? button('Mehr laden', loadVideos, { icon: 'down' }) : '');
    } catch (e) {
      body.replaceChildren(errorState(e, loadVideos));
    }
  };
  try {
    const c = await yt.channelInfo(id);
    const subscribed = await yt.isSubscribed(id);
    const subBtn = button(subscribed ? 'Abonniert' : 'Abonnieren', async () => {
      const on = await yt.toggleSubscription(c);
      subBtn.querySelector('.btn-label').textContent = on ? 'Abonniert' : 'Abonnieren';
      subBtn.classList.toggle('active', on);
      toast(on ? `„${c.name}“ abonniert` : 'Abo entfernt', { iconName: 'user' });
    }, { icon: 'user', variant: subscribed ? '' : 'primary', class: subscribed ? 'active' : '', default: true });
    top.replaceChildren(
      c.banner ? h('div.yt-banner', { style: { backgroundImage: `url("${c.banner}")` } }) : null,
      h(
        'div.yt-channel-info',
        h('div.yt-avatar.big', img(c.thumb, c.name, 'cover', c.name)),
        h('div', h('h1', c.name), h('div.muted', [formatSubs(c.subs), c.videos ? c.videos + ' Videos' : null].filter(Boolean).join(' · '))),
        h('div.detail-actions', subBtn),
      ),
    );
  } catch (e) {
    top.replaceChildren(h('p.muted', 'Kanal-Infos nicht verfügbar: ' + e.message));
  }
  await loadVideos();
  if (inputMode.isTV()) focusFirst(el);
  return null;
}

