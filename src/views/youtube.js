/** YouTube: open links/IDs, optional search (own API key), history – playback with SponsorBlock. */
import { h, icon, button } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { row, posterCard, emptyState, loading } from '../components/cards.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/dialog.js';
import { playYouTube } from '../player/player.js';
import * as yt from '../services/youtube.js';

export async function youtubeView(el) {
  const input = h('input.input.search', { type: 'search', placeholder: store.get('youtube.apiKey') ? 'Suchen oder Link einfügen …' : 'YouTube-Link oder Video-ID einfügen …', data: { focus: true, focusDefault: true }, enterkeyhint: 'go', autocomplete: 'off' });
  const goBtn = button('Öffnen', () => submit(), { variant: 'primary', icon: 'play' });
  const pasteBtn = navigator.clipboard && navigator.clipboard.readText ? button('Einfügen', async () => {
    try {
      input.value = await navigator.clipboard.readText();
      submit();
    } catch {
      toast('Zwischenablage nicht lesbar');
    }
  }, { icon: 'link' }) : null;
  const results = h('div.rows');
  const sb = store.get('blocker.sponsorblock.enabled');
  el.append(
    h('header.view-head', h('h1', 'YouTube'), h('span.pill' + (sb ? '.ok' : ''), icon('shield'), sb ? 'SponsorBlock aktiv' : 'SponsorBlock aus')),
    h('div.search-bar', { data: { focusGroup: true } }, input, goBtn, pasteBtn),
    results,
  );

  const card = (v) =>
    posterCard({
      title: v.title,
      subtitle: v.channel,
      image: v.thumb || yt.ytThumb(v.id),
      wide: true,
      onClick: () => playYouTube(v.id, { title: v.title }),
    });

  const renderHistory = async () => {
    const hist = await yt.ytHistory();
    const parts = [];
    if (hist.length) {
      parts.push(row('Zuletzt angesehen', hist.map(card), { more: { label: 'Verlauf löschen', onClick: async () => {
        if (await confirmDialog('Verlauf löschen?', 'Die Liste der zuletzt angesehenen YouTube-Videos wird gelöscht.', { okLabel: 'Löschen', danger: true })) {
          await yt.clearYtHistory();
          renderHistory();
        }
      } } }));
    } else {
      parts.push(
        emptyState({
          iconName: 'youtube',
          title: 'YouTube mit SponsorBlock',
          text: 'Link aus der YouTube-App teilen/kopieren und hier einfügen. Gesponserte Abschnitte, Intros und Eigenwerbung werden automatisch übersprungen.' + (store.get('youtube.apiKey') ? '' : ' Für die Suche einen eigenen API-Schlüssel in den Einstellungen hinterlegen.'),
          actions: [button('SponsorBlock-Einstellungen', () => navigate('/settings/blocker'), { icon: 'shield' })],
        }),
      );
    }
    results.replaceChildren(...parts.filter(Boolean));
  };

  async function submit() {
    const q = input.value.trim();
    if (!q) return;
    const id = yt.youtubeId(q);
    if (id) {
      const meta = await yt.ytTitle(id);
      playYouTube(id, { title: meta.title });
      return;
    }
    results.replaceChildren(loading('Suche …'));
    try {
      const list = await yt.ytSearch(q);
      results.replaceChildren(list.length ? h('div.poster-grid.wide', { data: { focusGroup: true } }, list.map(card)) : emptyState({ iconName: 'search', title: 'Keine Treffer' }));
    } catch (e) {
      results.replaceChildren(emptyState({ iconName: 'info', title: 'Suche nicht möglich', text: e.message, actions: [button('API-Schlüssel eintragen', () => navigate('/settings/youtube'), { icon: 'settings' })] }));
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  // Share target / deep link: #/youtube?v=ID
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(location.hash);
  if (m) playYouTube(m[1]);

  const off = bus.on('player:closed', renderHistory);
  await renderHistory();
  return { unmount: off };
}
