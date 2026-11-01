/** Einstellungen – all configuration, incl. Zeichen-Typ-Bereich and backup. */
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
import * as iptv from '../services/iptv.js';
import * as jf from '../services/jellyfin.js';
import * as epg from '../services/epg.js';
import { exportBackup, importBackup, daysSinceBackup } from '../services/backup.js';
import { jellyfinLoginForm } from './library.js';
import { uploadPlaylistFlow, addUrlFlow, pickPlaylistFile } from './live.js';

export const APP_VERSION = '2.0.0';

const SECTIONS = [
  { id: 'general', label: 'Allgemein', icon: 'settings' },
  { id: 'iptv', label: 'IPTV-Quellen', icon: 'tv' },
  { id: 'jellyfin', label: 'Jellyfin', icon: 'film' },
  { id: 'player', label: 'Player', icon: 'play' },
  { id: 'text', label: 'Zeichen & Untertitel', icon: 'text' },
  { id: 'lampa', label: 'Lampa', icon: 'lamp' },
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
    content.replaceChildren(h('h2.settings-heading', SECTIONS.find((s) => s.id === active).label), ...(await builder(render, offs)).filter(Boolean));
    if (focusedIdx >= 0) {
      const again = content.querySelectorAll('[data-focus]')[focusedIdx];
      if (again) again.focus({ preventScroll: true });
    }
  };
  await render();
  return { unmount: () => offs.forEach((o) => o()) };
}

// --------------------------------------------------------------------------------------------- sections

/** EPG settings of the active playlist (address, time shift, reload). */
function epgSection(render) {
  const src = iptv.getActiveSource();
  if (!src) return null;
  const status = h('p.form-status');
  const st = epg.epgStatus(src.id);
  const describe = (d) =>
    `${d.channels}${d.total ? ' von ' + d.total : ''} Sendern mit Programm · ${d.count} Sendungen · Stand ${formatDate(d.updatedAt)}` +
    (d.sources && d.sources.length ? ` · Quelle: ${d.sources.map((u) => (u.includes('/epg/') ? 'Kasy-EPG' : new URL(u).hostname)).join(', ')}` : '') +
    (d.primaryFailed ? ` · Playlist-EPG nicht ladbar (${d.primaryFailed})` : '');
  if (st) status.textContent = describe(st);
  const arch = src.archive || { type: 'auto', days: 7 };
  const archType = h('button.select-btn', { type: 'button', data: { focus: true } });
  const ARCH = [
    { value: 'auto', label: 'Aus der Playlist', description: 'catchup-Angaben der M3U (Standard)' },
    { value: 'SHIFT', label: 'Shift (?utc=…)', description: 'Viele Anbieter, z. B. Antifriz, Ottclub' },
    { value: 'XTREAM', label: 'Xtream Codes', description: '/timeshift/user/pass/…' },
    { value: 'FLUSSONIC', label: 'Flussonic', description: 'index-START-DAUER.m3u8' },
    { value: 'APPEND', label: 'Anhängen (catchup-source)', description: 'Vorlage wird an die Stream-Adresse gehängt' },
    { value: 'DEFAULT', label: 'Eigene Vorlage', description: 'Vollständige Adresse mit {utc} {utcend} …' },
  ];
  const syncArch = () => archType.replaceChildren(h('span.select-value', (ARCH.find((a) => a.value === arch.type) || ARCH[0]).label), icon('next'));
  syncArch();
  archType.addEventListener('click', async () => {
    const v = await pickOption('Archiv-Typ', ARCH, arch.type);
    if (!v) return;
    let template = arch.source || '';
    if (v === 'DEFAULT' || v === 'APPEND') {
      const t = await promptDialog('Archiv-Vorlage', { value: template, placeholder: v === 'APPEND' ? '?utc={utc}&lutc={lutc}' : 'http://anbieter/…/archive-{utc}-{duration}.m3u8', hint: 'Platzhalter: {utc} {utcend} {lutc} {duration} {offset} {Y}{m}{d}{H}{M}{S}' });
      if (t === null) return;
      template = t.trim();
    }
    let days = arch.days || 7;
    if (v !== 'auto') {
      const d = await pickOption('Archiv-Tiefe', [1, 2, 3, 4, 5, 7, 10, 14].map((n) => ({ value: n, label: n + (n === 1 ? ' Tag' : ' Tage') })), days);
      if (!d) return;
      days = d;
    }
    iptv.setSourceArchive(src.id, { type: v, days, source: template || null });
    await epg.clearEpg(src.id);
    render();
  });
  const urlBtn = h('button.select-btn.text', { type: 'button', data: { focus: true } }, h('span.select-value', src.epgUrl || 'aus der Playlist (url-tvg)'), icon('next'));
  urlBtn.addEventListener('click', async () => {
    const v = await promptDialog('EPG-Adresse', { value: src.epgUrl || '', placeholder: 'https://…/epg.xml.gz', type: 'url', hint: 'XMLTV, auch .gz. Leer lassen = Adresse aus der Playlist (url-tvg). Mehrere Adressen mit Leerzeichen trennen.' });
    if (v === null) return;
    iptv.setSourceEpg(src.id, v.trim());
    await epg.clearEpg(src.id);
    render();
  });
  return section(
    'TV-Programm (EPG) & Archiv – ' + src.name,
    h('div.set-row', h('div.set-text', h('div.set-label', 'EPG-Adresse'), h('div.set-desc', 'Programmdaten für Programmführer und Archiv')), h('div.set-control', urlBtn)),
    selectRow('Freies Kasy-EPG', 'Wird genutzt, wenn die Playlist kein EPG hat oder der Anbieter den Abruf sperrt (CORS). Alle 6 Stunden aktualisiert.', 'iptv.epgMirror', [
      ...epg.MIRRORS,
      { value: 'off', label: 'Aus' },
    ], { onChange: () => epg.clearEpg(src.id).then(render) }),
    h('div.set-row', h('div.set-text', h('div.set-label', 'Archiv'), h('div.set-desc', arch.type === 'auto' ? 'Wie in der Playlist angegeben' : `Erzwungen: ${(ARCH.find((a) => a.value === arch.type) || {}).label}, ${arch.days} Tage – für Sender ohne eigene catchup-Angaben`)), h('div.set-control', archType)),
    stepperRow('Zeitverschiebung', 'Falls die Sendezeiten im EPG versetzt sind', 'iptv.epgShift', { min: -12, max: 12, step: 0.5, format: (v) => (v > 0 ? '+' : '') + v + ' h' }),
    actionRow('EPG jetzt laden', 'Wird sonst alle 12 Stunden automatisch aktualisiert', 'Laden', async () => {
      status.className = 'form-status';
      status.textContent = 'Lädt …';
      const off = bus.on('epg:progress', ({ bytes }) => (status.textContent = `Lädt … ${(bytes / 1048576).toFixed(1)} MB`));
      try {
        const d = await epg.refreshEpg(src.id);
        status.textContent = describe(d);
        status.classList.add('ok');
      } catch (e) {
        status.textContent = e.message;
        status.classList.add('error');
      } finally {
        off();
      }
    }, { iconName: 'refresh' }),
    status,
    h('p.hint', 'Archiv: Sender mit catchup-Angaben in der Playlist (catchup, catchup-source, catchup-days, Xtream, Flussonic …) lassen sich im TV-Programm zurückschauen.'),
  );
}

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
        'Ansicht',
        toggleRow('Vorschau des markierten Senders', 'Fernbedienung: der markierte Sender läuft nach kurzer Pause in der Vorschau. Touch: erster Tipp = Vorschau, zweiter Tipp = Vollbild.', 'iptv.preview'),
        toggleRow('Ton in der Vorschau', null, 'iptv.previewSound'),
      ),
      epgSection(render),
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
        toggleRow(
          'MKV-Decoder (ohne Umwandlung)',
          'Spielt MKV-Filme und -Serien von Jellyfin direkt: Die Datei wird im Browser umverpackt und vom Hardware-Decoder des Geräts abgespielt – der Server muss nichts umwandeln. Bei Tonformaten wie DTS oder TrueHD wandelt der Server nur den Ton um.',
          'player.mkvDecoder',
        ),
      ),
      section(
        'Verhalten',
        toggleRow('Wiedergabe fortsetzen', 'Filme und Folgen an der letzten Stelle fortsetzen', 'player.resume'),
        toggleRow('Nächste Folge automatisch', 'Spielt die nächste Folge nach einem Countdown von selbst ab.', 'player.autoplayNext'),
        stepperRow('„Nächste Folge“ einblenden', 'So lange vor dem Ende – beim Abspann (Jellyfin-Segmente) schon dort', 'player.upNextSeconds', { min: 10, max: 180, step: 10, format: (v) => v + ' s vor Ende' }),
        stepperRow('Countdown bis zur nächsten Folge', null, 'player.nextCountdown', { min: 3, max: 30, step: 1, format: (v) => v + ' s' }),
        selectRow('Bildformat', null, 'player.aspect', [
          { value: 'contain', label: 'Einpassen' },
          { value: 'cover', label: 'Zoomen (füllen)' },
          { value: 'fill', label: 'Strecken' },
        ]),
        stepperRow('Sprungweite', '◀ ▶ auf der Fernbedienung, Doppeltipp am Rand', 'player.seekStep', { min: 5, max: 60, step: 5, format: (v) => v + ' s' }),
        stepperRow('Bedienleiste ausblenden nach', null, 'player.osdTimeout', { min: 2, max: 15, step: 1, format: (v) => v + ' s' }),
      ),
      section(
        'Intro & Abspann (Jellyfin)',
        h('p.hint', 'Nutzt die Segmente von Jellyfin 10.10 (Media Segments) bzw. des Intro-Skipper-Plugins.'),
        ...[
          ['Intro', 'Intro'],
          ['Outro', 'Abspann'],
          ['Recap', 'Rückblick'],
          ['Preview', 'Vorschau'],
          ['Commercial', 'Werbeblock'],
        ].map(([k, label]) =>
          selectRow(label, null, 'player.skipSegments.' + k, [
            { value: 'skip', label: 'Automatisch überspringen' },
            { value: 'button', label: 'Knopf „Überspringen“ zeigen' },
            { value: 'off', label: 'Ignorieren' },
          ]),
        ),
      )
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
      section(null, h('p.hint', 'Bibliotheken: hls.js (Apache-2.0), mpegts.js (Apache-2.0), dash.js (BSD-3). Lampa: github.com/yumata/lampa (GPL-2.0). Schriften: SIL Open Font License.')),
    ];
  },
};
