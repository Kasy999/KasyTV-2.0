# Kasy TV – PWA (Streaming-Hub)

Das Streaming-Modul von Kasy TV (Android-Projekt „NexusTV“) als **Progressive Web App** für iPhone/iPad,
Desktop-Browser, Smart-TVs (LG/Samsung-Browser) und den Xiaomi TV Stick 4K.

Bewusst **nicht** übernommen (in einer Web-App nicht möglich): App-Drawer, Launcher-Oberfläche, Home-Taste,
Datei-Manager, Tools/Trimmer, ADB, Sprachsteuerung, externe Player.

Kein Framework: modulares Vanilla-JavaScript (ES-Module) mit Vite als Build-Werkzeug. Das hält die App klein und
schnell genug für TV-Sticks. Die Quellen laufen auch **ohne Build**.

---

## Schnellstart

```bash
cd pwa
npm install          # holt Vite, hls.js, mpegts.js und kopiert die Player-Libs nach public/vendor
npm run dev          # Entwicklungsserver: http://localhost:5173 (auch im Heimnetz erreichbar)
npm run build        # fertige App in dist/
npm run serve        # dist/ ausliefern + CORS-Proxy: http://<PC-IP>:8080
npm test             # Tests (M3U-Parser, EPG/Archiv, Segment-Skipper)
```

Ohne `npm install` (nur Node 18+): `node tools/serve.mjs .` startet die Quellen direkt. Die Player-Bibliotheken
kommen dann von jsDelivr (feste Versionen) und werden vom Service Worker zwischengespeichert.

## Veröffentlichen / auf das iPhone bringen

Service Worker (Offline-Start) und „Zum Home-Bildschirm“ als Vollbild-App brauchen **HTTPS**.

1. `npm run build`
2. Den Inhalt von `dist/` auf einen HTTPS-Webspace legen – z. B. GitHub Pages, Netlify, Cloudflare Pages oder ein
   eigener Server (nginx/Caddy). Die App nutzt relative Pfade und funktioniert auch in einem Unterordner.
3. Auf dem iPhone in **Safari** öffnen → „Teilen“ → **„Zum Home-Bildschirm“**.
4. In der App: *Einstellungen → Speicher & Backup → Exportieren* (siehe „Backup“ unten).

**Wichtig – HTTPS und Heimnetz:** Eine HTTPS-App darf keine `http://`-Adressen laden (Mixed Content). Das betrifft
Jellyfin im Heimnetz (`http://192.168…:8096`), HTTP-Playlists und HTTP-Streams. Lösungen:

* Jellyfin per HTTPS erreichbar machen (Reverse-Proxy, z. B. Caddy/Nginx Proxy Manager), oder
* die App im Heimnetz per HTTP öffnen (`npm run serve` → `http://<PC-IP>:8080`) – funktioniert, aber ohne
  Offline-Start, oder
* für Playlists/Streams den eingebauten **Proxy** von `tools/serve.mjs` eintragen (siehe unten).


### Spulen überall

- **Archiv-Sendungen:** Der Player nutzt eine eigene Zeitleiste mit der Sendungslänge aus dem EPG. Spulen und Springen fordern den Archiv-Stream ab der neuen Stelle an.
- **Live-Sender mit Archiv:** ◀◀ startet den Zeitversatz (laufende Sendung bzw. letzte 3 Stunden). ▶▶ bis zum Ende schaltet wieder live.
- **Jellyfin:** Kann der Weg zum Server nicht in der Datei springen (keine Range-Anfragen, z. B. durch einen Proxy), startet der Server die Datei an der Stelle und verpackt sie nur um (Bild und meist auch Ton kopiert). So funktionieren Fortsetzen, Spulen und „Intro überspringen“.
- Mehrfaches Drücken wird zusammengefasst, damit nur eine neue Anfrage entsteht.

### Russische Sender

Freies Kasy-EPG mit russischen Quellen: iptvx.one, it999/Edem, epg.one und epgshare01, einzeln oder kombiniert („Russland – alle Quellen“, „Russland + Deutschland“). Kyrillische Sendernamen werden zugeordnet (z. B. „Первый канал HD“ ↔ „Первый канал“).

### EPG aus der M3U

Kasy TV lädt das EPG aus der Adresse im Kopf der M3U (`url-tvg`, `x-tvg-url`) bzw. aus der für die Quelle eingetragenen Adresse. Dafür probiert die App der Reihe nach:

1. direkt,
2. bei HTTP-Adressen die HTTPS-Variante,
3. den eingetragenen CORS-Proxy,
4. den Kasy-Spiegel dieser Adresse.

Viele Anbieter sperren den Abruf durch Web-Apps (CORS). Dann zeigt Einstellungen → IPTV-Quellen den Knopf „Freischalten“: GitHub öffnet sich mit einer fertigen Datei in `epg-urls/`. Nach „Commit changes“ lädt der Workflow das EPG alle 6 Stunden nach `./epg/m3u/` (gleiche Herkunft wie die App, keine Sperre). Das freie Kasy-EPG (DE/AT/CH) ist nur noch Ersatz.

### Wiedergabe fortsetzen

- Filme, Folgen und Archiv-Sendungen laufen dort weiter, wo sie aufgehört haben. Der Player blendet „Fortgesetzt bei … · Von vorn“ ein, außerdem gibt es „Von vorn beginnen“ unter Optionen.
- Die Position wird alle 10 s gespeichert, beim Pausieren, Schließen und wenn die App in den Hintergrund geht (TV aus, App-Wechsel).
- Jellyfin: Die Position kommt frisch vom Server (gilt auch geräteübergreifend). Eine lokale Kopie springt ein, falls der Server die letzte Meldung nicht mehr bekam.
- Startseite: Knopf „Fortsetzen: …“ für die letzte Wiedergabe (auch Live-Sender). „Weiterschauen“ zeigt Jellyfin und Playlist-Filme gemeinsam, langes Drücken entfernt einen Eintrag.
- Einstellungen → Player: direkt fortsetzen oder vorher fragen, optional beim App-Start sofort fortsetzen.

### Nächste Folge

- Im Player erscheinen bei Serienfolgen (Jellyfin) und bei Filmen/Folgen aus derselben Gruppe einer VOD-Playlist die Knöpfe „Vorherige Folge“ und „Nächste Folge“.
- Beim Abspann (Jellyfin-Segment „Outro“) oder 30 s vor Ende erscheint „Als Nächstes“ mit Vorschaubild und Countdown. Mit „Abspann ansehen“ lässt sich das abbrechen, Pause hält den Countdown an.
- Die Medientasten ⏭/⏮ der Fernbedienung, Kopfhörer und Sperrbildschirm wechseln die Folge.
- Einstellbar unter Einstellungen → Player: automatisch weiter, Einblendezeit und Countdown.

### MKV-Decoder (ohne Umwandlung)

MKV-Filme und -Serien von Jellyfin (und `.mkv`-Links in Playlists) spielt Kasy TV direkt ab, ohne dass der Server etwas umwandelt:

- `src/player/mkv/demuxer.js`: Ein Matroska-Demuxer liest die Datei während des Downloads. Er versteht SeekHead, Cues, Lacing, Header-Stripping und Cluster unbekannter Größe.
- `src/player/mkv/mp4.js`: Die Frames werden unverändert in fragmentiertes MP4 umverpackt.
- `src/player/mkv/mkv-source.js`: Über Media Source Extensions dekodiert der Hardware-Decoder des Geräts. Spulen läuft über den Cues-Index oder, ohne Index, über einen Positions-Sprung mit Nachsuchen.
- **Bild:** H.264, H.265/HEVC (wo das Gerät es kann), AV1, VP9.
- **Ton:** AAC, Opus, FLAC, AC-3, E-AC-3 und MP3, soweit der Browser sie kann.
- `src/player/mkv/external-audio.js`: Für DTS, TrueHD & Co. wandelt Jellyfin nur den Ton um (MP3 Stereo, synchron gehalten), das Bild bleibt direkt.
- Abschaltbar unter Einstellungen → Player → „MKV-Decoder“.

## Xiaomi TV Stick 4K / Android TV / Smart-TVs

* Xiaomi-Stick: einen Browser mit Fernbedienungs-Unterstützung installieren (z. B. *TV Bro*) und die App-Adresse
  öffnen. Die App erkennt das Gerät (User-Agent `MiTV`, Android ohne Touchscreen), schaltet in den
  **Fernbedienungs-Modus** und in den **Performance-Modus**.
* LG/Samsung: im TV-Browser öffnen. (Für installierbare TV-Pakete gibt es weiterhin `../smarttv`.)
* Manuell umschalten: Einstellungen → Allgemein → *Steuerung* bzw. *Performance-Modus*, oder das
  Touch/Fernbedienung-Symbol unten in der Navigation.

## Bedienung

| | Touch | Fernbedienung / Tastatur |
|---|---|---|
| Navigation | Tippen, Wischen | Pfeiltasten, OK/Enter, Zurück (Esc/Backspace/Tizen 10009/webOS 461) |
| Kontextmenü (Sender: Favorit, Details) | lange tippen | OK gedrückt halten oder Menü-Taste |
| Player: Bedienleiste | Tippen | OK |
| Player: Spulen | Doppeltipp links/rechts, waagerecht ziehen | ◀ ▶ (gedrückt halten = schneller) |
| Player: Sender wechseln | senkrecht wischen | ▲ ▼, CH+/CH−, Ziffern = Sendernummer |
| Player: Senderliste | Listen-Symbol | ◀ (Live) oder ROT |
| Player: Optionen / Untertitel / Ton | Symbole | GRÜN / GELB / BLAU |
| Lampa verlassen | Navigation antippen | Zurück 2× schnell oder gedrückt halten |

## Funktionen

### IPTV (M3U / M3U8)
* Parser (Port von `M3uParser.kt`): `#EXTM3U`-Kopf (EPG-URL, Catchup), `#EXTINF`-Attribute, `#EXTGRP`,
  `#EXTVLCOPT`/`#EXTHTTP`/`|Header`, relative URLs, einfache URL-Listen, Windows-1251/1252-Dateien.
  Große Listen (50 000 Sender < 0,5 s) werden in einem Web Worker gelesen.
* **Datei-Upload** (`<input type="file" accept=".m3u,.m3u8,…">`) – auf dem iPhone aus „Dateien“, iCloud Drive,
  Downloads. Falls iOS die Datei ausgraut: „Alle Dateitypen“ wählen.
* **Live-Vorschau** des markierten Senders neben der Liste (Fernbedienung: Sender markieren → läuft nach kurzer
  Pause; Touch: erster Tipp = Vorschau, zweiter Tipp = Vollbild). Stoppt automatisch, wenn der Vollbild-Player
  läuft, damit TV-Sticks nie zwei Streams gleichzeitig dekodieren.
* **TV-Programm (EPG) mit Archiv:** XMLTV aus der Playlist (url-tvg) oder eigene Adresse, auch `.gz`, wird
  gestreamt gelesen. Fehlt das EPG, sperrt der Anbieter den Abruf (CORS) oder passt es auf fast keinen Sender,
  nutzt die App das **freie Kasy-EPG**: Der GitHub-Workflow spiegelt alle 6 Stunden freie XMLTV-Daten
  (Deutschland/Österreich/Schweiz, Quellen in `epg-sources.json`) nach `./epg/` auf derselben Seite. Die
  Zuordnung versteht tvg-id, iptv-org-IDs (`3sat.de@SD`) und Sendernamen („BR Fernsehen (720p)“ ↔ „BR“).
  **Archiv erzwingen** (Einstellungen → IPTV-Quellen): für Anbieter, die Archiv bieten, es aber nicht in die
  Playlist schreiben (Shift, Xtream, Flussonic oder eigene Vorlage). Programmführer mit Senderliste, Tagen (so weit zurück wie das Archiv des Anbieters reicht),
  laufender Sendung mit Fortschritt. Vergangene Sendungen spielen **aus dem Archiv** (catchup default/append/shift,
  Flussonic, Xtream, catchup-source mit Platzhaltern), die laufende Sendung „Live“ oder „Von Anfang“. Jetzt/Danach
  in der Vorschau, in der Listenansicht und im Player; im Player öffnet die Taste GUIDE bzw. das Programm-Symbol den
  Programmführer. Zeitverschiebung und EPG-Adresse unter Einstellungen → IPTV-Quellen.
* Mehrere Quellen (URL oder Datei), Kategorien, Suche, Favoriten, zuletzt gesehen, Kachel-/Listenansicht,
  Sortierung, automatische Aktualisierung von URL-Quellen.
* Player: **hls.js** (Android TV, Xiaomi-Stick, Chrome, Smart-TVs), natives HLS (iOS/Safari), **mpegts.js** für
  reine TS-Streams, MP4/WebM nativ. Unbekannte URLs werden der Reihe nach probiert.

### Jellyfin
Anmeldung, Bibliotheken, Weiterschauen, Nächste Folgen, Neu hinzugefügt, Suche, Favoriten, Detailseite mit
Staffeln/Folgen, Poster/Backdrops in Gerätegröße, Wiedergabe als Direct Play oder HLS-Transcoding (Geräteprofil
aus den Codecs, die der Browser wirklich kann), Ton- und Untertitelspuren (Bild-Untertitel werden eingebrannt),
Fortschritt-Meldung an den Server, nächste Folge, Intro/Abspann über Jellyfin 10.10 *Media Segments* oder das
Intro-Skipper-Plugin.

### Lampa
Lampa (oder ein Wampa-/eigener Lampa-Server) läuft als integriertes Modul: die Seite wird geladen und mit einem
Hook in einen Rahmen gleicher Herkunft geschrieben und füllt den ganzen Inhaltsbereich; die Kasy-Navigation bleibt
sichtbar (Seitenleiste bzw. Tab-Leiste), ohne Lampa zu überdecken. Zur Navigation (Fernbedienung):
Zurück zweimal schnell oder gedrückt halten oder Lampas „Beenden?“-Frage. Erlaubt der Lampa-Server das Laden nicht (CORS),
läuft Lampa als normales iframe. Zustand bleibt beim Tab-Wechsel erhalten.
Lokal mitliefern: den Lampa-Build (github.com/yumata/lampa) nach `public/lampa/` kopieren und unter
Einstellungen → Lampa die Quelle „Lokal“ wählen.

### Zeichen-Typ-Bereich (Einstellungen → Zeichen & Untertitel)
Untertitel: Schrift (7 Schriften der Android-App + System), Größe, Stärke, Kursiv, Großbuchstaben, Text-/
Hintergrundfarbe, Deckkraft, Kante (Kontur/Schatten/erhaben/vertieft), Kantenfarbe, Position, Zeilenhöhe.
OSD: Schrift, Größe, Deckkraft, Uhr. App: Schrift, Textgröße, Stärke, Zeichenabstand. Mit Live-Vorschau.
Alle Untertitel werden von der App selbst gezeichnet – die Einstellungen gelten daher auch auf iOS.

### Speicherung & Backup
* Einstellungen in `localStorage` + Spiegel in IndexedDB; Senderlisten, Favoriten, Verläufe, Resume-Positionen in
  IndexedDB. Bei installierter App wird *dauerhafter Speicher* angefragt.
* **Export/Import als JSON** (Einstellungen → Speicher & Backup). Auf iOS öffnet der Export das Teilen-Menü →
  „In Dateien sichern“. Optional ohne Zugangsdaten. Erinnerung, wenn die letzte Sicherung > 14 Tage alt ist –
  Safari löscht Daten von Web-Apps, die lange nicht geöffnet wurden.

### Performance-Modus
Automatisch für TV-Sticks/Smart-TVs, ≤ 2 GB RAM, ≤ 2 Kerne, Datensparmodus – oder nach einer kurzen
Bildraten-Messung beim Start. Im Modus „Niedrig“ (`html.perf-low`, `src/styles/perf-low.css`): kein
`backdrop-filter`, keine großen Schatten/Leuchten, keine Übergänge/Animationen, keine Fokus-Skalierung, solide
Ersatzfarben, sofortiges Scrollen; dazu kleinere Poster, kleinerer Video-Puffer, Listen werden in Etappen gebaut
(`content-visibility`). Fokus bleibt durch eine einfache Kontur klar sichtbar.

## CORS-Proxy

Viele IPTV-Anbieter erlauben Web-Apps keinen Abruf (CORS). Dann:

* Playlist als **Datei hochladen** (kein Netzwerkabruf nötig), oder
* `npm run serve` (bzw. `node tools/serve.mjs dist`) auf einem PC im Heimnetz starten und in der App unter
  Einstellungen → IPTV → *CORS-Proxy* `http://<PC-IP>:8080/proxy?url={url}` eintragen. Optional „Streams über
  den Proxy laden“ – HLS-Playlists werden dabei umgeschrieben, sodass auch die Segmente über den Proxy laufen.
  Das alte `smarttv/tools/kasy-server.ps1` hat dasselbe `/proxy?url=`-Format.

Streams, die zwingend einen bestimmten User-Agent/Referer brauchen, funktionieren im Browser nur über den Proxy.

## Aufbau

```
pwa/
  index.html                 Einstieg (PWA-Meta-Tags, iOS-Homescreen)
  public/manifest.json       Web-App-Manifest
  public/sw.js               Service Worker (App-Shell offline, Bilder-Cache, Streams nie gecacht)
  public/icons/              App-Icons (aus dem Android-Launcher-Icon)
  public/vendor/             hls.js / mpegts.js (von npm install kopiert)
  public/lampa/              optional: lokaler Lampa-Build
  src/main.js                Start: Speicher, Eingabemodus, Performance, Service Worker
  src/app.js                 Shell: Navigationsleiste (Rail / Tab-Bar), Routen
  src/core/                  dom, store (localStorage), db (IndexedDB), router (Hash + Overlay-History),
                             focus (D-Pad-Raster), input-mode, performance, loader, util
  src/services/              m3u-parser (+ Worker), iptv, epg, catchup, jellyfin, segments,
                             backup, resume, text-style, net
  src/player/                player (OSD, Gesten, Tasten), engine (hls.js/mpegts/dash.js/nativ),
                             subtitles (eigener Renderer), youtube-engine (IFrame-API)
  src/components/            dialog, toast, cards, controls (Einstellungs-Zeilen)
  src/views/                 home, live, library (Jellyfin), lampa, youtube, settings
  src/styles/                tokens, base, layout, components, views, player, tv, perf-low
  src/assets/fonts/          die 7 Schriften der Android-App
  tools/serve.mjs            Static-Server + CORS-/Stream-Proxy ohne Abhängigkeiten
  tests/                     node --test
```

## Bekannte Grenzen

* iOS spielt kein reines MPEG-TS (`.ts`) – nur HLS. Viele Anbieter bieten beide Varianten an.
* Ältere TV-Browser (Chromium < 64) werden über den Legacy-Build von Vite (`@vitejs/plugin-legacy`) bedient;
  Layout-Details (z. B. Flex-`gap`) brauchen Chromium 84+. Für alte Fernseher bleibt `../smarttv` die bessere Wahl.
* EPG-Dateien ohne CORS-Freigabe brauchen den CORS-Proxy (Einstellungen → IPTV). Ob das Archiv eines Senders
  funktioniert, hängt von den catchup-Angaben der Playlist und vom Anbieter ab.
