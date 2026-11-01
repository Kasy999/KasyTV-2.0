# EPG-Adressen aus Playlists

Jede `.txt`-Datei hier enthält eine EPG-Adresse (url-tvg) aus einer M3U, die der Anbieter Web-Apps nicht laden lässt (CORS).
Der GitHub-Workflow spiegelt sie alle 6 Stunden nach `./epg/m3u/<hash>.xml.gz`. Kasy TV lädt das EPG dann von dort.

Hinzufügen geht am einfachsten in der App: Einstellungen → IPTV-Quellen → „EPG der Playlist freischalten“.
Dort öffnet sich GitHub mit der fertig ausgefüllten Datei, „Commit changes“ genügt.

Bitte keine Adressen mit persönlichen Zugangsdaten (Token, Passwort) eintragen – das Repository ist öffentlich.
