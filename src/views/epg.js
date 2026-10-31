/**
 * TV-Programm (EPG) with archive: #/live/epg?ch=<channelId>&g=<group>
 *
 *  - left: channels of the current category (remote: ▲▼ changes the channel, ▶ goes to its programmes)
 *  - top: days – as many days back as the provider keeps an archive, today, tomorrow
 *  - programmes: past ones with archive are played from the archive (catch-up), the running one live or
 *    "von Anfang", future ones show their description.
 */
import { h, icon, img, button } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { focus } from '../core/focus.js';
import { inputMode } from '../core/input-mode.js';
import { emptyState, loading } from '../components/cards.js';
import { dialog, pickOption } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import * as iptv from '../services/iptv.js';
import * as epg from '../services/epg.js';
import { hasArchive, isAvailable, buildArchiveUrl } from '../services/catchup.js';
import { playChannel, playUrl } from '../player/player.js';

const DAY = 86400000;

function dayStart(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offset * DAY;
}

function dayLabel(offset) {
  if (offset === 0) return 'Heute';
  if (offset === -1) return 'Gestern';
  if (offset === 1) return 'Morgen';
  return new Date(dayStart(offset)).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

/** Plays a programme from the archive (or "from the beginning" for the running one). */
export function playArchive(channel, prog) {
  const url = buildArchiveUrl(channel, prog.start, prog.stop);
  if (!url) {
    toast('Dieser Sender hat kein Archiv', { kind: 'warn' });
    return;
  }
  const when = new Date(prog.start).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  playUrl(url, { title: prog.title, subtitle: `${channel.name} · Archiv · ${when}`, live: false });
}

export async function epgView(el, { query }) {
  const source = iptv.getActiveSource();
  if (!source) {
    el.append(h('header.view-head', h('h1', 'TV-Programm')), emptyState({ iconName: 'tv', title: 'Keine Senderliste', text: 'Zuerst unter Live-TV eine Playlist laden.' }));
    return null;
  }
  const playlist = await iptv.getPlaylist(source.id);
  const favs = await iptv.favoriteKeys();
  const group = query.g || store.get('iptv.lastGroup') || '__all';
  let channels = iptv.selectChannels(playlist, { group, favs, sort: store.get('iptv.sort'), sourceId: source.id });
  if (!channels.length) channels = playlist.channels;
  let current = channels.find((c) => c.id === query.ch) || channels[0];

  const maxBack = Math.min(14, Math.max(0, ...channels.map((c) => (hasArchive(c) ? c.catchup.days : 0))));
  let dayOffset = 0;

  const status = h('span.muted.epg-status');
  const chBtn = h('button.chip.epg-channel-picker', { type: 'button', data: { focus: true } });
  const refreshBtn = h('button.icon-btn', { type: 'button', data: { focus: true }, title: 'EPG neu laden', 'aria-label': 'EPG neu laden' }, icon('refresh'));
  const days = h('div.chips.small.epg-days', { data: { focusGroup: true } });
  const chList = h('div.epg-channels', { data: { focusGroup: true } });
  const progList = h('div.epg-programmes', { data: { focusGroup: true } });
  const head = h('div.epg-chhead');

  el.append(
    h(
      'header.view-head',
      h('button.icon-btn.back-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Zurück', onClick: () => history.back() }, icon('back')),
      h('h1', 'TV-Programm'),
      status,
      h('div.head-actions', { data: { focusGroup: true } }, chBtn, refreshBtn),
    ),
    days,
    h('div.epg-layout', chList, h('div.epg-main', head, progList)),
  );

  let data = null;

  const renderDays = () => {
    days.replaceChildren(
      ...Array.from({ length: maxBack + 2 }, (_, i) => i - maxBack).map((off) => {
        const b = h('button.chip' + (off === dayOffset ? '.active' : ''), { type: 'button', data: { focus: true } }, h('span', dayLabel(off)), off < 0 ? icon('rewind', 'tiny') : null);
        b.addEventListener('click', () => {
          dayOffset = off;
          renderDays();
          renderProgrammes(true);
        });
        return b;
      }),
    );
    const active = days.querySelector('.chip.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  };

  const renderChannels = () => {
    chList.replaceChildren(
      ...channels.slice(0, 600).map((ch) => {
        const nn = data ? epg.nowNext(data, ch) : { now: null };
        const b = h(
          'button.epg-ch' + (ch === current ? '.active' : ''),
          { type: 'button', data: { focus: true } },
          h('span.panel-num', String(ch.number || '')),
          img(ch.logo, ch.name, 'panel-logo', ch.name),
          h('span.epg-ch-text', h('span.epg-ch-name', ch.name, hasArchive(ch) ? h('span.archive-dot', { title: 'Archiv' }) : null), h('span.epg-ch-now', nn.now ? nn.now.title : '')),
        );
        b.addEventListener('click', () => selectChannel(ch, true));
        // Remote: ▲▼ through the channels shows their programme right away.
        b.addEventListener('focus', () => {
          if (inputMode.isTV() && ch !== current) selectChannel(ch, false);
        });
        return b;
      }),
    );
  };

  const selectChannel = (ch, moveFocus) => {
    current = ch;
    const idx = channels.indexOf(ch);
    Array.prototype.forEach.call(chList.children, (b, i) => b.classList.toggle('active', i === idx));
    history.replaceState(history.state, '', `#/live/epg?ch=${encodeURIComponent(ch.id)}&g=${encodeURIComponent(group)}`);
    renderProgrammes(moveFocus);
  };

  const renderHeadInfo = () => {
    const nn = data ? epg.nowNext(data, current) : { now: null };
    chBtn.replaceChildren(icon('tv'), h('span', current.name), icon('down'));
    head.replaceChildren(
      ...[
      img(current.logo, current.name, 'epg-logo', current.name),
      h('div.epg-chhead-text', h('h2', current.name), h('div.muted', [current.group, hasArchive(current) ? `Archiv: ${current.catchup.days} Tage` : 'kein Archiv'].filter(Boolean).join(' · '))),
      button('Live', () => playChannel(source.id, channels, channels.indexOf(current)), { variant: 'primary', icon: 'play' }),
      nn.now && hasArchive(current) ? button('Von Anfang', () => playArchive(current, nn.now), { icon: 'restart' }) : null,
      ].filter(Boolean),
    );
  };

  const renderProgrammes = (moveFocus) => {
    renderHeadInfo();
    if (!data) return;
    const all = epg.programmesFor(data, current);
    const from = dayStart(dayOffset);
    const to = from + DAY;
    const list = all.filter((p) => p.stop > from && p.start < to);
    const now = Date.now();
    if (!list.length) {
      progList.replaceChildren(emptyState({ iconName: 'info', title: all.length ? 'Keine Sendungen an diesem Tag' : 'Kein Programm für diesen Sender', text: all.length ? null : 'Das EPG enthält diesen Sender nicht (tvg-id/Name passt nicht).' }));
      return;
    }
    let currentRow = null;
    progList.replaceChildren(
      ...list.map((p) => {
        const running = p.start <= now && p.stop > now;
        const past = p.stop <= now;
        const archive = (past || running) && isAvailable(current, p.start, now);
        const row = h(
          'button.epg-prog' + (running ? '.running' : past ? '.past' : '') + (archive ? '.has-archive' : ''),
          { type: 'button', data: { focus: true, longpress: true } },
          h('span.epg-time', epg.formatHm(p.start)),
          h(
            'span.epg-prog-text',
            h('span.epg-title', p.title),
            p.desc || p.cat ? h('span.epg-desc', [p.cat, p.desc].filter(Boolean).join(' · ')) : null,
            running ? h('span.epg-progress', h('span', { style: { width: Math.round(((now - p.start) / (p.stop - p.start)) * 100) + '%' } })) : null,
          ),
          running ? h('span.epg-badge.live', 'LIVE') : archive ? h('span.epg-badge.archive', icon('play'), 'Archiv') : null,
        );
        row.addEventListener('click', () => openProgramme(p, { running, past, archive }));
        row.addEventListener('longpress', () => programmeInfo(p, { running, past, archive }));
        if (running) currentRow = row;
        return row;
      }),
    );
    const target = currentRow || (dayOffset < 0 ? progList.lastElementChild : progList.firstElementChild);
    if (target) {
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'center' });
        if (moveFocus && inputMode.isTV()) focus(target, { scroll: false });
      });
    }
  };

  const openProgramme = async (p, st) => {
    if (st.running) {
      if (!st.archive) return playChannel(source.id, channels, channels.indexOf(current));
      const v = await pickOption(p.title, [
        { value: 'live', label: 'Live ansehen' },
        { value: 'start', label: 'Von Anfang ansehen', description: 'aus dem Archiv, ab ' + epg.formatHm(p.start) },
        { value: 'info', label: 'Beschreibung' },
      ]);
      if (v === 'live') playChannel(source.id, channels, channels.indexOf(current));
      else if (v === 'start') playArchive(current, p);
      else if (v === 'info') programmeInfo(p, st);
      return;
    }
    if (st.archive) return playArchive(current, p);
    programmeInfo(p, st);
  };

  const programmeInfo = (p, st) => {
    const when = `${new Date(p.start).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' })}, ${epg.formatHm(p.start)}–${epg.formatHm(p.stop)}`;
    const actions = [];
    if (st.archive) actions.push({ label: st.running ? 'Von Anfang' : 'Aus dem Archiv abspielen', primary: true, icon: 'play', onClick: () => playArchive(current, p) });
    if (st.running) actions.push({ label: 'Live', icon: 'tv', onClick: () => playChannel(source.id, channels, channels.indexOf(current)) });
    actions.push({ label: 'Schließen', value: null });
    let hint = null;
    if (st.past && !st.archive) hint = hasArchive(current) ? 'Nicht mehr im Archiv (älter als ' + current.catchup.days + ' Tage).' : 'Dieser Sender bietet kein Archiv an.';
    if (!st.past && !st.running) hint = 'Läuft ' + when.split(', ')[0] + ' um ' + epg.formatHm(p.start) + ' Uhr.';
    dialog({
      title: p.title,
      body: h('div.form', h('div.muted', current.name + ' · ' + when), p.cat ? h('div.badge', p.cat) : null, p.desc ? h('p.epg-full-desc', p.desc) : h('p.muted', 'Keine Beschreibung.'), hint ? h('p.hint', hint) : null),
      actions,
    });
  };

  chBtn.addEventListener('click', async () => {
    const v = await pickOption('Sender', channels.slice(0, 500).map((c) => ({ value: c.id, label: `${c.number ? c.number + '. ' : ''}${c.name}`, description: hasArchive(c) ? 'Archiv ' + c.catchup.days + ' Tage' : undefined })), current.id);
    const ch = channels.find((c) => c.id === v);
    if (ch) {
      selectChannel(ch, true);
      renderChannels();
    }
  });

  const load = async (force) => {
    progList.replaceChildren(loading('Programm wird geladen …'));
    status.textContent = '';
    try {
      data = force ? await epg.refreshEpg(source.id) : await epg.getEpg(source.id);
      if (!data) throw new Error('Kein EPG verfügbar');
      status.textContent = `${data.channels} Sender · Stand ${epg.formatHm(data.updatedAt)}`;
      renderChannels();
      renderProgrammes(true);
      const activeCh = chList.querySelector('.epg-ch.active');
      if (activeCh) activeCh.scrollIntoView({ block: 'center' });
    } catch (e) {
      progList.replaceChildren(
        emptyState({
          iconName: 'info',
          title: 'Programm nicht verfügbar',
          text: e.message,
          actions: [button('Erneut versuchen', () => load(true), { icon: 'refresh', variant: 'primary' })],
        }),
      );
      renderHeadInfo();
      renderChannels();
    }
  };

  refreshBtn.addEventListener('click', () => load(true));
  const progressOff = bus.on('epg:progress', ({ sourceId, bytes }) => {
    if (sourceId === source.id) status.textContent = `EPG wird geladen … ${(bytes / 1048576).toFixed(1)} MB`;
  });
  const tick = setInterval(() => data && renderHeadInfo(), 60000);

  renderDays();
  renderHeadInfo();
  await load(false);
  return {
    unmount() {
      progressOff();
      clearInterval(tick);
    },
  };
}
