/** Einstellungen – all configuration, incl. Zeichen-Typ-Bereich, Werbeblocker/SponsorBlock and backup. */
import { h, icon, button } from '../core/dom.js';
import { store } from '../core/store.js';
import { bus } from '../core/events.js';
import { navigate, router } from '../core/router.js';
import { perf } from '../core/performance.js';
import { inputMode } from '../core/input-mode.js';
import { storageInfo, requestPersistence, db } from '../core/db.js';
import { formatBytes, formatDate, isIOS, isStandalone } from '../core/util.js';
import { toggleRow, selectRow, stepperRow, colorRow, textRow, actionRow, infoRow, section } from '../components/controls.js';
import { confirmDialog, dialog, promptDialog, pickOption } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import { FONTS, EDGE_STYLES, COLORS, ACCENTS } from '../services/text-style.js';
import { SB_CATEGORIES } from '../services/sponsorblock.js';
import { DEFAULT_HOSTS, blockedTotal } from '../services/adblock.js';
import * as iptv from '../services/iptv.js';
import * as jf from '../services/jellyfin.js';
import * as yt from '../services/youtube.js';
import { exportBackup, importBackup, daysSinceBackup } from '../services/backup.js';
import { jellyfinLoginForm } from './library.js';
import { uploadPlaylistFlow, addUrlFlow, pickPlaylistFile } from './live.js';

export const APP_VERSION = '2.0.0';

const SECTIONS = [
  { id: 'general', label: 'Allgemein', icon: 'settings' },
  { id: 'iptv', label: 'IPTV-Quellen', icon: 'tv' },
  { id: 'jellyfin', label: 'Jellyfin', icon: 'film' },
  { id: 'player', label: 'Player', icon: 'play' },
  { id: 'blocker', label: 'Werbeblocker & SponsorBlock', icon: 'shield' },
  { id: 'text', label: 'Zeichen & Untertitel', icon: 'text' },
  { id: 'lampa', label: 'Lampa', icon: 'lamp' },
  { id: 'youtube', label: 'YouTube', icon: 'youtube' },
  { id: 'backup', label: 'Speicher & Backup', icon: 'save' },
  { id: 'about', label: 'Über', icon: 'info' },
];

export async function settingsView(el, { params }) {
  const wide = window.matchMedia('(min-width: 900px)').matches || inputMode.isTV();
  const active = params.section || (wide ? 'general' : null);
  const nav = h(
    'nav.settings-nav',
    { data: { focusGroup: true } },
    SECTIONS.map((s) =>
      h(
        'button.settings-link' + (s.id === active ? '.active' : ''),
        { type: 'button', data: { focus: true, focusDefault: s.id === active || undefined }, onClick: () => navigate('/settings/' + s.id, { replace: !!params.section && wide }) },
        icon(s.icon),
        h('span', s.label),
        icon('next', 'chev'),
      ),
    ),
  );
  const content = h('div.settings-content');
  el.classList.toggle('has-section', !!active);
  el.append(
    h('header.view-head', active && !wide ? h('button.icon-btn.back-btn', { type: 'button', data: { focus: true }, 'aria-label': 'Zurück', onClick: () => history.back() }, icon('back')) : null, h('h1', active && !wide ? SECTIONS.find((s) => s.id === active).label : 'Einstellungen')),
    h('div.settings-layout', nav, content),
  );
  if (!active) return null;

  const offs = [];
  const render = async () => {
    const builder = BUILDERS[active];
    if (!builder) return;
    const focusedIdx = Array.prototype.indexOf.call(content.querySelectorAll('[data-focus]'), document.activeElement);
    content.replaceChildren(h('h2.settings-heading', SECTIONS.find((s) => s.id === active).label), ...(await builder(render, offs)));
    if (focusedIdx >= 0) {
      const again = content.querySelectorAll('[data-focus]')[focusedIdx];
      if (again) again.focus({ preventScroll: true });
    }
  };
  await render();
  return { unmount: () => offs.forEach((o) => o()) };
}

// --------------------------------------------------------------------------------------------- sections

const BUILDERS = {
  async general(render, offs) {
    offs.push(bus.on('perfmode', render));
    const reasons = perf.reasons;
    return [
      section(
        'Bedienung',
        selectRow('Steuerung', 'Automatisch erkennt TV-Geräte und wechselt bei Pfeiltasten/Touch selbst.', 'ui.inputMode', [
          { value: 'auto', label: 'Automatisch', description: 'Erkannt: ' + (inputMode.detected === 'tv' ? 'Fernseher / Fernbedienung' : 'Touch / Maus') },
          { value: 'touch', label: 'Touch', description: 'Smartphone, Tablet, Maus' },
          { value: 'tv', label: 'Fernbedienung (D-Pad)', description: 'TV, Beamer, Tastatur – Fokusrahmen und Pfeiltasten' },
        ]),
        selectRow('Startansicht', null, 'ui.startView', [
          { value: 'home', label: 'Start' },
          { value: 'live', label: 'Live-TV' },
          { value: 'library', label: 'Videothek' },
          { value: 'lampa', label: 'Lampa' },
        ]),
        toggleRow('Uhr anzeigen', null, 'ui.showClock'),
      ),
      section(
        'Leistung',
        selectRow('Performance-Modus', 'Niedrig: keine Unschärfe, Schatten und Animationen – flüssig auf TV-Sticks (Xiaomi TV Stick, Fire TV).', 'ui.perfMode', [
          { value: 'auto', label: 'Automatisch', description: 'Schwache Geräte werden beim Start erkannt' },
          { value: 'high', label: 'Hoch', description: 'Alle Effekte (Glas, Leuchten, Animationen)' },
          { value: 'low', label: 'Niedrig', description: 'Maximale Flüssigkeit' },
        ]),
        infoRow('Aktuell', (perf.low ? 'Niedrig' : 'Hoch') + (reasons.length ? ' – ' + reasons.join(', ') : '')),
        actionRow('Gerät neu messen', 'Misst die Bildrate erneut (nur im Automatik-Modus).', 'Messen', () => {
          perf.resetProbe();
          toast('Messung läuft …');
          setTimeout(render, 4000);
        }, { iconName: 'gauge' }),
      ),
      section('Design', colorRow('Akzentfarbe', null, 'ui.accent', ACCENTS), colorRow('Zweite Akzentfarbe', 'Für Verläufe', 'ui.accent2', ACCENTS)),
      section(
        'Bereiche',
        toggleRow('Live-TV', null, 'ui.modules.live'),
        toggleRow('Videothek (Jellyfin)', null, 'ui.modules.library'),
        toggleRow('Lampa', null, 'ui.modules.lampa'),
        toggleRow('YouTube', null, 'ui.modules.youtube'),
      ),
      section(
        'Startseite',
        toggleRow('Weiterschauen', null, 'ui.homeRows.continue'),
        toggleRow('Zuletzt gesehene Sender', null, 'ui.homeRows.recentChannels'),
        toggleRow('Favoriten', null, 'ui.homeRows.favorites'),
        toggleRow('Neu in der Videothek', null, 'ui.homeRows.latest'),
      ),
    ];
  },

  async iptv(render, offs) {
    offs.push(bus.on('iptv:changed', render));
    const sources = iptv.getSources();
    const activeId = (iptv.getActiveSource() || {}).id;
    const list = sources.length
      ? sources.map((s) =>
          h(
            'div.source' + (s.id === activeId ? '.active' : ''),
            h(
              'div.source-text',
              h('div.set-label', s.name, s.id === activeId ? h('span.badge', 'aktiv') : null),
              h('div.set-desc', `${s.type === 'file' ? 'Datei: ' + (s.fileName || '') : s.url} · ${s.count || 0} Sender · ${formatDate(s.updatedAt)}`),
              s.error ? h('div.set-desc.error', s.error) : null,
            ),
            h(
              'div.source-actions',
              { data: { focusGroup: true } },
              s.id !== activeId ? button('Aktivieren', () => iptv.setActiveSource(s.id), { variant: 'small' }) : null,
              button('', async () => {
                if (s.type === 'file') {
                  const f = await pickPlaylistFile({ any: true });
                  if (!f) return;
                  try {
                    await iptv.replaceFileSource(s.id, f);
                    toast('Datei ersetzt', { kind: 'success' });
                  } catch (e) {
                    toast(e.message, { kind: 'error' });
                  }
                  return;
                }
                const done = toast('Wird aktualisiert …', { duration: 60000 });
                try {
                  await iptv.refreshSource(s.id);
                  done && done();
                  toast('Aktualisiert', { kind: 'success' });
                } catch (e) {
                  done && done();
                  toast(e.message, { kind: 'error', duration: 6000 });
                }
              }, { icon: s.type === 'file' ? 'upload' : 'refresh', title: s.type === 'file' ? 'Neue Datei hochladen' : 'Neu laden', class: 'icon-only' }),
              button('', async () => {
                const name = await promptDialog('Umbenennen', { value: s.name });
                if (name) iptv.renameSource(s.id, name.trim());
              }, { icon: 'text', title: 'Umbenennen', class: 'icon-only' }),
              button('', async () => {
                if (await confirmDialog('Quelle entfernen?', `„${s.name}“ und ihre Senderliste werden gelöscht.`, { okLabel: 'Entfernen', danger: true })) await iptv.removeSource(s.id);
              }, { icon: 'trash', title: 'Entfernen', class: 'icon-only', variant: 'danger' }),
            ),
          ),
        )
      : [h('p.muted', 'Noch keine Quelle. Lade eine M3U/M3U8-Datei hoch oder gib eine Adresse ein.')];
    return [
      section(
        'Senderlisten',
        ...list,
        h(
          'div.form-actions',
          { data: { focusGroup: true } },
          button('M3U-Datei hochladen', () => uploadPlaylistFlow(), { variant: 'primary', icon: 'upload' }),
          button('Alle Dateitypen', () => uploadPlaylistFlow({ any: true }), { icon: 'folder' }),
          button('Adresse hinzufügen', () => addUrlFlow(), { icon: 'link' }),
        ),
        h('p.hint', 'iPhone/iPad: „Datei hochladen“ öffnet die Dateien-App (iCloud Drive, Downloads, „Auf meinem iPhone“). Ist die Datei ausgegraut, „Alle Dateitypen“ verwenden.'),
      ),
      section(
        'Netzwerk',
        textRow('CORS-Proxy', 'Für Anbieter, die Web-Apps den Abruf nicht erlauben. {url} wird durch die Adresse ersetzt.', 'iptv.corsProxy', {
          placeholder: 'http://192.168.1.10:8080/proxy?url={url}',
          hint: 'z. B. „node tools/serve.mjs“ aus diesem Projekt oder smarttv/tools/kasy-server.ps1 – beide bieten /proxy?url=…',
        }),
        toggleRow('Streams über den Proxy laden', 'Hilft bei HTTP-Streams in der HTTPS-App und bei Streams ohne CORS (hls.js). Belastet den Proxy-Rechner.', 'iptv.proxyStreams'),
        selectRow('Automatisch aktualisieren', 'URL-Quellen beim Öffnen von Live-TV neu laden', 'iptv.autoRefreshHours', [
          { value: 0, label: 'Nie' },
          { value: 6, label: 'Alle 6 Stunden' },
          { value: 12, label: 'Alle 12 Stunden' },
          { value: 24, label: 'Täglich' },
          { value: 168, label: 'Wöchentlich' },
        ]),
      ),
    ];
  },

  async jellyfin(render, offs) {
    offs.push(bus.on('jellyfin:changed', render));
    const c = store.get('jellyfin');
    if (!jf.isConnected()) return [section('Anmelden', jellyfinLoginForm())];
    return [
      section(
        'Verbindung',
        infoRow('Server', `${c.serverName || ''} ${c.server}`),
        infoRow('Benutzer', c.userName),
        actionRow('Abmelden', 'Entfernt das Zugangs-Token von diesem Gerät.', 'Abmelden', async () => {
          if (await confirmDialog('Abmelden?', 'Die Verbindung zu Jellyfin wird getrennt.', { okLabel: 'Abmelden', danger: true })) await jf.logout();
        }, { iconName: 'user', variant: 'danger' }),
      ),
      section(
        'Wiedergabe',
        toggleRow('Direkte Wiedergabe bevorzugen', 'Originaldatei abspielen, wenn das Gerät das Format kann – sonst wandelt der Server um.', 'jellyfin.preferDirectPlay'),
        selectRow('Max. Bitrate', 'Bei langsamer Verbindung niedriger wählen', 'jellyfin.maxBitrate', [120e6, 60e6, 40e6, 20e6, 10e6, 8e6, 4e6, 2e6].map((b) => ({ value: b, label: b / 1e6 + ' Mbit/s' }))),
      ),
    ];
  },

  async player() {
    return [
      section(
        'Technik',
        selectRow('HLS-Wiedergabe', 'Automatisch: nativ auf iPhone/iPad/Safari, hls.js auf Android-TV, Xiaomi-Stick, Smart-TVs und Desktop.', 'player.engine', [
          { value: 'auto', label: 'Automatisch' },
          { value: 'hlsjs', label: 'hls.js (Media Source Extensions)' },
          { value: 'native', label: 'Nativ (Browser/System)' },
        ]),
        selectRow('Puffer', 'Größerer Puffer = weniger Ruckler, mehr Speicher', 'player.bufferSeconds', [10, 20, 30, 60, 90].map((s) => ({ value: s, label: s + ' Sekunden' }))),
        toggleRow('Niedrige Latenz bei Live', 'Bleibt näher am Live-Signal (kann bei schwachem Netz ruckeln).', 'player.lowLatencyLive'),
      ),
      section(
        'Verhalten',
        toggleRow('Wiedergabe fortsetzen', 'Filme und Folgen an der letzten Stelle fortsetzen', 'player.resume'),
        toggleRow('Nächste Folge automatisch', null, 'player.autoplayNext'),
        selectRow('Bildformat', null, 'player.aspect', [
          { value: 'contain', label: 'Einpassen' },
          { value: 'cover', label: 'Zoomen (füllen)' },
          { value: 'fill', label: 'Strecken' },
        ]),
        stepperRow('Sprungweite', '◀ ▶ auf der Fernbedienung, Doppeltipp am Rand', 'player.seekStep', { min: 5, max: 60, step: 5, format: (v) => v + ' s' }),
        stepperRow('Bedienleiste ausblenden nach', null, 'player.osdTimeout', { min: 2, max: 15, step: 1, format: (v) => v + ' s' }),
      ),
    ];
  },

  async blocker(render) {
    const cats = store.get('blocker.sponsorblock.categories');
    const segActions = [
      { value: 'skip', label: 'Automatisch überspringen' },
      { value: 'button', label: 'Knopf „Überspringen“ zeigen' },
      { value: 'mute', label: 'Stummschalten' },
      { value: 'off', label: 'Ignorieren' },
    ];
    const rulesCount = (store.get('blocker.customRules') || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('!')).length;
    return [
      section(
        'Werbeblocker',
        toggleRow('Werbeblocker aktiv', `Sperrt ${DEFAULT_HOSTS.length}+ Werbe- und Tracking-Server für die App und das integrierte Lampa. Bisher blockiert: ${blockedTotal()} Anfragen in dieser Sitzung.`, 'blocker.enabled'),
        toggleRow('Werbepausen in Streams', 'VOD: markierte Werbeblöcke (CUE-OUT/SCTE-35) werden entfernt. Live: Werbepausen werden stummgeschaltet und abgedeckt.', 'blocker.hlsAdFilter'),
        actionRow('Eigene Filterregeln', `${rulesCount} eigene Regeln. Formate: „||host.tld^“, „host.tld“, Hosts-Datei-Zeilen oder Textteile wie „/ads/“.`, 'Bearbeiten', async () => {
          const ta = h('textarea.input.code', { rows: 10, data: { focus: true }, spellcheck: 'false', autocapitalize: 'off', placeholder: '||werbung.example.com^\ntracker.example.net\n/ads/' });
          ta.value = store.get('blocker.customRules') || '';
          const ok = await dialog({ title: 'Eigene Filterregeln', wide: true, body: h('div.form', ta, h('p.hint', 'Eine Regel pro Zeile. Zeilen mit ! sind Kommentare.')), actions: [{ label: 'Abbrechen', value: false }, { label: 'Speichern', value: true, primary: true }] });
          if (ok) {
            store.set('blocker.customRules', ta.value);
            render();
          }
        }, { iconName: 'text' }),
        h('p.hint', 'Grenzen: Werbung innerhalb fremder Rahmen (YouTube-Player, Lampa ohne Integration) kann eine Web-App nicht entfernen.'),
      ),
      section(
        'SponsorBlock (YouTube)',
        toggleRow('SponsorBlock aktiv', 'Überspringt gesponserte Abschnitte & Co. in YouTube-Videos – Daten der Community (sponsor.ajay.app), Abfrage anonym per Hash-Präfix.', 'blocker.sponsorblock.enabled'),
        toggleRow('Hinweis beim Überspringen', null, 'blocker.sponsorblock.notify'),
        ...SB_CATEGORIES.map((c) => selectRow(c.label, c.desc, 'blocker.sponsorblock.categories.' + c.id, segActions.filter((a) => a.value !== 'mute' || c.id === 'sponsor' || c.id === 'selfpromo' || c.id === 'music_offtopic'))),
        textRow('Server', 'Eigene SponsorBlock-Instanz (optional)', 'blocker.sponsorblock.server', { placeholder: 'https://sponsor.ajay.app' }),
        h('p.hint', `Aktuell überspringen: ${Object.keys(cats).filter((k) => cats[k] === 'skip').length} Kategorien.`),
      ),
      section(
        'Intro & Abspann (Jellyfin)',
        h('p.hint', 'Nutzt die Segmente von Jellyfin 10.10 (Media Segments) bzw. des Intro-Skipper-Plugins.'),
        ...[
          ['Intro', 'Intro'],
          ['Outro', 'Abspann'],
          ['Recap', 'Rückblick'],
          ['Preview', 'Vorschau'],
          ['Commercial', 'Werbung'],
        ].map(([k, label]) => selectRow(label, null, 'blocker.mediaSegments.' + k, segActions.filter((a) => a.value !== 'mute'))),
      ),
    ];
  },

  async text(render, offs) {
    const fonts = FONTS.map((f) => ({ value: f.value, label: f.label }));
    // Live preview: a fake video frame with OSD and subtitle.
    const preview = h(
      'div.text-preview',
      { 'aria-hidden': 'true' },
      h('div.tp-video'),
      h('div.tp-osd', h('div.tp-title', 'Das Erste HD'), h('div.tp-sub', '21:15 · Tagesthemen'), h('div.tp-bar', h('span'))),
      h('div.sub-layer.static', h('div.sub-cue', { html: 'Dies ist eine Untertitel-Vorschau.<br><i>Mit zweiter Zeile in kursiv.</i>' })),
    );
    return [
      h('div.sticky-preview', preview),
      section(
        'Untertitel',
        selectRow('Schriftart', null, 'text.subtitle.font', fonts),
        stepperRow('Schriftgröße', null, 'text.subtitle.size', { min: 50, max: 250, step: 10, format: (v) => v + ' %' }),
        selectRow('Schriftstärke', null, 'text.subtitle.weight', [
          { value: 400, label: 'Normal' },
          { value: 500, label: 'Mittel' },
          { value: 600, label: 'Halbfett' },
          { value: 700, label: 'Fett' },
          { value: 800, label: 'Extra fett' },
        ]),
        toggleRow('Kursiv', null, 'text.subtitle.italic'),
        selectRow('Schreibweise', null, 'text.subtitle.transform', [
          { value: 'none', label: 'Normal' },
          { value: 'uppercase', label: 'GROSSBUCHSTABEN' },
        ]),
        colorRow('Textfarbe', null, 'text.subtitle.color', COLORS),
        colorRow('Hintergrundfarbe', null, 'text.subtitle.background', ['#000000', '#1F2937', '#0B0E14', '#1E3A8A', '#FFFFFF']),
        stepperRow('Hintergrund-Deckkraft', null, 'text.subtitle.backgroundOpacity', { min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + ' %' }),
        selectRow('Kante / Schatten', null, 'text.subtitle.edge', EDGE_STYLES),
        colorRow('Kantenfarbe', null, 'text.subtitle.edgeColor', ['#000000', '#1F2937', '#FFFFFF', '#3D8BFF']),
        stepperRow('Abstand vom unteren Rand', null, 'text.subtitle.position', { min: 0, max: 40, step: 1, format: (v) => v + ' %' }),
        stepperRow('Zeilenhöhe', null, 'text.subtitle.lineHeight', { min: 1, max: 2, step: 0.05, format: (v) => v.toFixed(2) }),
      ),
      section(
        'Player-Einblendungen (OSD)',
        selectRow('Schriftart', null, 'text.osd.font', [{ value: 'inherit', label: 'Wie die App' }].concat(fonts)),
        stepperRow('Größe', null, 'text.osd.scale', { min: 70, max: 160, step: 5, format: (v) => v + ' %' }),
        stepperRow('Hintergrund-Deckkraft', null, 'text.osd.backgroundOpacity', { min: 0.2, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + ' %' }),
        toggleRow('Uhrzeit im Player', null, 'text.osd.showClock'),
      ),
      section(
        'App-Schrift',
        selectRow('Schriftart', null, 'text.ui.font', fonts),
        stepperRow('Textgröße', 'Skaliert die gesamte Oberfläche', 'text.ui.scale', { min: 80, max: 150, step: 5, format: (v) => v + ' %' }),
        selectRow('Schriftstärke', null, 'text.ui.weight', [
          { value: 300, label: 'Leicht' },
          { value: 400, label: 'Normal' },
          { value: 500, label: 'Mittel' },
          { value: 600, label: 'Halbfett' },
        ]),
        stepperRow('Zeichenabstand', null, 'text.ui.letterSpacing', { min: -2, max: 10, step: 1, format: (v) => (v / 100).toFixed(2) + ' em' }),
      ),
      section(
        null,
        actionRow('Zurücksetzen', 'Alle Text- und Untertitel-Einstellungen auf Standard', 'Zurücksetzen', async () => {
          if (await confirmDialog('Zurücksetzen?', 'Schriften, Größen und Farben auf Standard setzen?', { okLabel: 'Zurücksetzen' })) {
            const { DEFAULTS } = await import('../core/store.js');
            store.set('text', DEFAULTS.text);
            render();
          }
        }, { iconName: 'refresh' }),
      ),
    ];
  },

  async lampa() {
    return [
      section(
        'Quelle',
        selectRow('Lampa laden von', null, 'lampa.source', [
          { value: 'remote', label: 'Server (Adresse)', description: 'z. B. lampa.mx oder eigener Lampa/Wampa-Server' },
          { value: 'local', label: 'Lokal mitgeliefert', description: 'Lampa-Build in public/lampa/ (gleiche Herkunft, voll integriert)' },
        ]),
        textRow('Adresse', 'Lampa- oder Wampa-Instanz. Standard: offizieller HTTPS-Build (yumata.github.io/lampa)', 'lampa.url', { placeholder: 'https://yumata.github.io/lampa/' }),
        h('p.hint', 'Lampa läuft direkt in der App (kein neuer Tab). HTTP-Adressen sind in der HTTPS-App gesperrt – dann wird automatisch der offizielle HTTPS-Build verwendet.'),
      ),
    ];
  },

  async youtube(render) {
    const status = h('p.form-status');
    const cur = yt.currentInstance();
    return [
      section(
        'Werbefreie Wiedergabe',
        h('p.set-desc', 'YouTube läuft über eine Invidious-Instanz (Open-Source-Frontend): keine YouTube-Werbung, kein Google-Konto, Videos im Kasy-Player mit SponsorBlock und Untertitel-Stilen. Abos, „Später ansehen“ und Verlauf bleiben auf diesem Gerät.'),
        selectRow('Server', null, 'youtube.backend', [
          { value: 'auto', label: 'Automatisch', description: 'Öffentliche Instanzen, Wechsel bei Ausfall' },
          { value: 'custom', label: 'Eigene Instanz', description: 'Am zuverlässigsten (selbst gehostet)' },
        ], { onChange: () => (yt.resetInstances(), render()) }),
        textRow('Eigene Instanz', 'z. B. https://invidious.meine-domain.de – wird bei „Automatisch“ zuerst versucht', 'youtube.instance', { placeholder: 'https://…', type: 'url', onChange: () => (yt.resetInstances(), render()) }),
        infoRow('Aktuell verbunden', cur || 'noch keine Anfrage'),
        actionRow('Verbindung testen', null, 'Testen', async () => {
          status.textContent = 'Teste …';
          status.className = 'form-status';
          try {
            yt.resetInstances();
            const n = (await yt.trending()).length;
            status.textContent = `OK – ${n} Videos von ${yt.currentInstance()}`;
            status.classList.add('ok');
          } catch (e) {
            status.textContent = e.message;
            status.classList.add('error');
          }
        }, { iconName: 'refresh' }),
        status,
      ),
      section(
        'Wiedergabe',
        toggleRow('Hohe Qualität (DASH)', 'HD bis 4K mit dash.js auf Android TV, Xiaomi-Stick, Desktop; sonst MP4 bis 720p/360p.', 'youtube.highQuality'),
        toggleRow('Nächstes Video automatisch', 'Nach dem Ende startet ein ähnliches Video (10 s Countdown)', 'youtube.autoplayNext'),
        toggleRow('Ersatz: offizieller Player', 'Wenn kein werbefreier Stream verfügbar ist, im offiziellen YouTube-Player abspielen (SponsorBlock bleibt aktiv).', 'youtube.fallbackEmbed'),
        toggleRow('Datenschutzmodus im offiziellen Player', 'youtube-nocookie.com', 'youtube.noCookie'),
      ),
      section(
        'Inhalte',
        toggleRow('Shorts ausblenden', null, 'youtube.hideShorts'),
        selectRow('Region für Trends', null, 'youtube.region', [
          { value: 'DE', label: 'Deutschland' },
          { value: 'AT', label: 'Österreich' },
          { value: 'CH', label: 'Schweiz' },
          { value: 'US', label: 'USA' },
          { value: 'GB', label: 'Großbritannien' },
          { value: 'RU', label: 'Russland' },
          { value: 'UA', label: 'Ukraine' },
          { value: 'FR', label: 'Frankreich' },
          { value: 'ES', label: 'Spanien' },
        ]),
        actionRow('SponsorBlock-Kategorien', 'Sponsoren, Intros, Eigenwerbung …', 'Öffnen', () => navigate('/settings/blocker'), { iconName: 'shield' }),
      ),
    ];
  },

  async backup(render) {
    const info = await storageInfo();
    const days = daysSinceBackup();
    const status = h('p.hint');
    return [
      section(
        'Sicherung',
        h('p.set-desc', 'Safari löscht die Daten von Web-Apps, die längere Zeit nicht geöffnet wurden. Sichere deine Einstellungen (Quellen, Jellyfin-Zugang, Favoriten, Blocker- und Schrift-Einstellungen) als JSON-Datei in „Dateien“ bzw. iCloud Drive.'),
        infoRow('Letzte Sicherung', days === Infinity ? 'noch nie' : formatDate(store.get('backup.lastExport'))),
        h(
          'div.form-actions',
          { data: { focusGroup: true } },
          button('Exportieren', async () => {
            const v = await pickOption('Was soll gesichert werden?', [
              { value: 'full', label: 'Alles', description: 'inkl. hochgeladener Playlists und Jellyfin-Token' },
              { value: 'nocred', label: 'Ohne Zugangsdaten', description: 'Jellyfin-Token und API-Schlüssel weglassen' },
              { value: 'small', label: 'Nur Einstellungen', description: 'ohne hochgeladene Playlist-Dateien' },
            ]);
            if (!v) return;
            try {
              const how = await exportBackup({ includePlaylists: v !== 'small', includeCredentials: v === 'full' });
              if (how !== 'cancelled') toast(how === 'shared' ? 'Sicherung geteilt' : 'Sicherung heruntergeladen', { kind: 'success' });
              render();
            } catch (e) {
              toast('Export fehlgeschlagen: ' + e.message, { kind: 'error' });
            }
          }, { variant: 'primary', icon: 'download' }),
          button('Importieren', async () => {
            const input = h('input', { type: 'file', accept: '.json,application/json', style: { position: 'fixed', left: '-9999px' } });
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
              const f = input.files && input.files[0];
              input.remove();
              if (!f) return;
              if (!(await confirmDialog('Sicherung einspielen?', `„${f.name}“ ersetzt die aktuellen Einstellungen.`, { okLabel: 'Einspielen' }))) return;
              try {
                const r = await importBackup(f);
                toast(`Sicherung vom ${r.exportedAt ? formatDate(r.exportedAt) : '?'} eingespielt`, { kind: 'success' });
                router.refresh();
              } catch (e) {
                toast(e.message, { kind: 'error', duration: 6000 });
              }
            });
            input.click();
          }, { icon: 'upload' }),
        ),
        toggleRow('An Sicherung erinnern', 'Hinweis, wenn die letzte Sicherung älter als 14 Tage ist', 'backup.remind'),
        status,
      ),
      section(
        'Speicher',
        infoRow('Belegt', info.usage != null ? `${formatBytes(info.usage)} von ${formatBytes(info.quota)}` : 'unbekannt'),
        infoRow('Dauerhafter Speicher', info.persisted ? 'gewährt – Browser löscht nicht automatisch' : 'nicht gewährt'),
        infoRow('IndexedDB', db.isMemoryOnly ? 'nicht verfügbar (nur Arbeitsspeicher!)' : 'aktiv'),
        !info.persisted
          ? actionRow('Dauerhaft speichern', isIOS() && !isStandalone() ? 'Auf iPhone/iPad zuerst „Zum Home-Bildschirm“ hinzufügen.' : 'Browser um dauerhaften Speicher bitten', 'Anfragen', async () => {
              const ok = await requestPersistence();
              toast(ok ? 'Dauerhafter Speicher gewährt' : 'Browser hat abgelehnt – regelmäßig sichern!', { kind: ok ? 'success' : 'warn' });
              render();
            }, { iconName: 'save' })
          : null,
        actionRow('Bild-Cache leeren', 'Gespeicherte Poster und Senderlogos löschen', 'Leeren', async () => {
          if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_RUNTIME' });
          toast('Cache geleert');
        }, { iconName: 'trash' }),
        actionRow('Alles zurücksetzen', 'Löscht alle Einstellungen, Quellen, Favoriten und Verläufe auf diesem Gerät.', 'Zurücksetzen', async () => {
          if (!(await confirmDialog('Wirklich alles löschen?', 'Tipp: vorher exportieren. Dieser Schritt kann nicht rückgängig gemacht werden.', { okLabel: 'Alles löschen', danger: true }))) return;
          await db.clearAll();
          store.reset();
          toast('Zurückgesetzt');
          navigate('/home', { replace: true });
          setTimeout(() => location.reload(), 300);
        }, { iconName: 'trash', variant: 'danger' }),
      ),
    ];
  },

  async about() {
    let sw = 'nicht aktiv';
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      sw = reg && reg.active ? 'aktiv (offline-fähig)' : window.isSecureContext ? 'wird eingerichtet' : 'nicht möglich (kein HTTPS)';
    }
    return [
      section(
        'Kasy TV',
        infoRow('Version', APP_VERSION + ' (PWA)'),
        infoRow('Installiert', isStandalone() ? 'ja (Home-Bildschirm)' : 'nein – im Browser'),
        infoRow('Service Worker', sw),
        infoRow('Steuerung', inputMode.isTV() ? 'Fernbedienung' : 'Touch'),
        infoRow('Performance', perf.low ? 'Niedrig (sparsam)' : 'Hoch'),
        infoRow('Media Source Extensions', window.MediaSource || window.ManagedMediaSource ? 'ja (hls.js/mpegts.js)' : 'nein (nur native Wiedergabe)'),
        infoRow('Natives HLS', document.createElement('video').canPlayType('application/vnd.apple.mpegurl') ? 'ja' : 'nein'),
        infoRow('Gerät', navigator.userAgent),
      ),
      section(
        'Zum Home-Bildschirm',
        h(
          'ol.steps',
          h('li', 'iPhone/iPad: in Safari auf „Teilen“ tippen → „Zum Home-Bildschirm“.'),
          h('li', 'Android/Xiaomi: Browser-Menü → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.'),
          h('li', 'Desktop (Chrome/Edge): Installieren-Symbol in der Adressleiste.'),
        ),
      ),
      section(null, h('p.hint', 'Bibliotheken: hls.js (Apache-2.0), mpegts.js (Apache-2.0). SponsorBlock-Daten: sponsor.ajay.app (CC BY-NC-SA 4.0). Schriften: SIL Open Font License.')),
    ];
  },
};
