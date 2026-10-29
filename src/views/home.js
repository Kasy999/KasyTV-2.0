/** HOME: continue watching (Jellyfin), recently watched channels, favourites, new in the library, setup hints. */
import { h, icon } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { preserveFocus } from '../core/focus.js';
import { row, posterCard, channelCard, actionCard } from '../components/cards.js';
import * as iptv from '../services/iptv.js';
import * as jf from '../services/jellyfin.js';
import { playChannel, playJellyfin } from '../player/player.js';
import { channelContextMenu } from './live.js';

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Gute Nacht';
  if (hr < 11) return 'Guten Morgen';
  if (hr < 17) return 'Hallo';
  if (hr < 22) return 'Guten Abend';
  return 'Gute Nacht';
}

export async function homeView(el) {
  const rows = h('div.rows');
  const name = store.get('jellyfin.userName');
  el.append(h('header.view-head.hero', h('div', h('h1', greeting() + (name ? ', ' + name : '')), h('p.muted', 'Live-TV, Videothek und Lampa an einem Ort.'))), rows);

  let alive = true;
  const render = async () => {
    const cfg = store.get('ui');
    const parts = [];
    const sources = iptv.getSources();
    const jfOn = cfg.modules.library && jf.isConnected();

    // Jellyfin – continue watching
    let resumeItems = [];
    let latestItems = [];
    if (jfOn) {
      try {
        [resumeItems, latestItems] = await Promise.all([
          cfg.homeRows.continue ? jf.resume(16) : [],
          cfg.homeRows.latest ? jf.views().then((v) => (v[0] ? jf.latest(v[0].Id, 16) : [])) : [],
        ]);
      } catch (e) {
        parts.push(h('p.notice', icon('info'), 'Jellyfin: ' + e.message));
      }
    }
    if (resumeItems.length) {
      parts.push(
        row(
          'Weiterschauen',
          resumeItems.map((it) =>
            posterCard({
              title: it.SeriesName || it.Name,
              subtitle: it.SeriesName ? `S${it.ParentIndexNumber}E${it.IndexNumber} · ${it.Name}` : it.ProductionYear,
              image: jf.thumbUrl(it),
              wide: true,
              progress: it.UserData && it.UserData.PlayedPercentage ? it.UserData.PlayedPercentage / 100 : 0,
              onClick: () => playJellyfin(it),
              onLongPress: () => navigate('/library/item/' + it.Id),
            }),
          ),
        ),
      );
    }

    // IPTV
    if (cfg.modules.live && sources.length) {
      if (cfg.homeRows.recentChannels) {
        const hist = await iptv.history();
        if (hist.length) {
          const list = hist.map((e) => e.channel);
          parts.push(
            row(
              'Zuletzt gesehen',
              hist.map((e, i) =>
                channelCard(e.channel, {
                  onClick: () => playChannel(e.sourceId, list, i),
                  onLongPress: () => channelContextMenu(e.sourceId, e.channel, render),
                }),
              ),
            ),
          );
        }
      }
      if (cfg.homeRows.favorites) {
        const favs = await iptv.channelsForKeys(Array.from(await iptv.favoriteKeys()));
        if (favs.length) {
          const bySource = favs.map((f) => f.channel);
          parts.push(
            row(
              'Favoriten',
              favs.map((f, i) =>
                channelCard(f.channel, {
                  favorite: true,
                  onClick: () => playChannel(f.sourceId, bySource, i),
                  onLongPress: () => channelContextMenu(f.sourceId, f.channel, render),
                }),
              ),
            ),
          );
        }
      }
    }

    if (latestItems.length) {
      parts.push(
        row(
          'Neu in der Videothek',
          latestItems.map((it) =>
            posterCard({
              title: it.Name,
              subtitle: it.ProductionYear,
              image: jf.posterUrl(it),
              onClick: () => navigate('/library/item/' + it.Id),
            }),
          ),
          { more: { label: 'Alle', onClick: () => navigate('/library') } },
        ),
      );
    }

    // Setup hints
    const hints = [];
    if (cfg.modules.live && !sources.length) hints.push(actionCard({ iconName: 'upload', title: 'IPTV-Playlist laden', text: 'M3U-Datei hochladen oder Adresse eingeben', onClick: () => navigate('/settings/iptv') }));
    if (cfg.modules.library && !jf.isConnected()) hints.push(actionCard({ iconName: 'film', title: 'Jellyfin verbinden', text: 'Filme und Serien vom eigenen Server', onClick: () => navigate('/settings/jellyfin') }));
    if (cfg.modules.lampa) hints.push(actionCard({ iconName: 'lamp', title: 'Lampa öffnen', text: 'Filme & Serien entdecken', onClick: () => navigate('/lampa') }));
    hints.push(actionCard({ iconName: 'save', title: 'Einstellungen sichern', text: 'Backup als JSON-Datei', onClick: () => navigate('/settings/backup') }));
    parts.push(row(sources.length || jf.isConnected() ? 'Schnellzugriff' : 'Los geht’s', hints));

    if (!alive) return;
    await preserveFocus(el, () => rows.replaceChildren(...parts.filter(Boolean)));
    bus.emit('route:mounted', { el });
  };

  const offs = [bus.on('iptv:changed', render), bus.on('iptv:favorites', render), bus.on('jellyfin:changed', render), bus.on('player:closed', render)];
  await render();
  return {
    unmount() {
      alive = false;
      offs.forEach((o) => o());
    },
  };
}
