# Video-Downloader für Firefox

Erkennt Videos auf Webseiten, auch eingebettete Videos sowie HLS- und DASH-Streams. Lädt sie in bester Qualität herunter und setzt abgebrochene Downloads an der Abbruchstelle fort.

## Funktionen

### Videos finden
- **Netzwerk:** Jede geladene Videodatei und jede Stream-Playlist (HLS `.m3u8`, DASH `.mpd`) wird erkannt.
- **Seiteninhalt:** `<video>`/`<source>`, Links, `og:video`, `data-`-Attribute, Shadow-DOM und alle eingebetteten iframes werden durchsucht.
- **Tiefensuche:** Startet automatisch, wenn nichts gefunden wurde, oder per Button. Sie durchsucht alle Attribute, Skripte, JSON-Daten, den Quelltext und die geladenen Ressourcen aller Frames. Jeder Treffer wird anschließend geprüft.
- **Formate:** MP4, WebM, MKV, MOV, OGV, FLV, AVI, WMV, 3GP, MPEG, M2TS und weitere, dazu HLS- und DASH-Streams.

### Herunterladen
- **Beste Qualität:** Liegt ein Video in mehreren Versionen vor, wird automatisch die beste gewählt. Die anderen Versionen findest du unter „Weitere Versionen“.
- **Bild und Ton:** Getrennte Bild- und Tonspuren (bei DASH/HLS üblich) werden ohne Neukodierung zu einer MP4-Datei zusammengeführt.
- **Vorschau:** Jedes Video zeigt ein Miniaturbild mit Dauer, Qualität, Größe und einem Download-Button.
- **Rechtsklick** auf ein Video → „Video herunterladen (beste Qualität)“.

### Seitenleiste „Video-Downloads“
Zu öffnen über den 📋-Button im Popup, mit **Alt+Umschalt+V** oder über „Ansicht → Seitenleiste“. Sie öffnet sich auf Wunsch automatisch, sobald ein Download startet.

- **Anzeige:** Für jeden Download siehst du einen Fortschrittsbalken, Prozent, geladene und erwartete Größe, Geschwindigkeit und die Restzeit. Oben steht eine Gesamtübersicht.
- **Steuerung:** ⏸ Pausieren, ▶ Fortsetzen und ✕ Abbrechen (Abbrechen löscht die Teildaten, deshalb fragt der Button einmal nach). Nach einem Fehler oder Abbruch gibt es ↻ Neu starten. Fertige Downloads lassen sich direkt öffnen oder im Ordner anzeigen.
- **Sammelaktionen:** Alle pausieren, Alle fortsetzen, Erledigte entfernen.

### Abgebrochene Downloads fortsetzen
- **Streams (HLS/DASH):** Jedes geladene Teilstück wird sofort dauerhaft gespeichert. Nach einem Abbruch geht es genau an dieser Stelle weiter, auch nach einem Firefox-Neustart.
- **Direkte Dateien:** Firefox lädt diese selbst. Die Erweiterung setzt sie nach einem Abbruch an der abgebrochenen Stelle fort, sofern der Server das erlaubt.
- **Automatisch:** Bei Netzwerkfehlern wird es selbstständig wieder versucht, mit wachsenden Abständen von 5 Sekunden bis 5 Minuten. Sobald die Internetverbindung zurückkommt, geht es sofort weiter.
- **Abgelaufene Download-Adressen** (typisch bei Streams mit Zugangs-Token): Die Playlist wird neu eingelesen und es geht an derselben Stelle weiter.
- **Neu laden, wenn nötig:** Lässt sich ein Download nicht fortsetzen, weil der Server keine Teilanfragen erlaubt oder sich der Stream verändert hat, wird er automatisch neu gestartet. In der Seitenleiste steht dann ein entsprechender Hinweis.

### Updates
- Firefox sucht selbst regelmäßig nach neuen Versionen. Zusätzlich prüft die Erweiterung alle 6 Stunden und auf Knopfdruck („Nach Updates suchen“ unten in der Seitenleiste).
- Ein heruntergeladenes Update wird erst installiert, wenn keine Downloads mehr laufen. Mit „Jetzt installieren“ geht es sofort; unterbrochene Downloads laufen danach automatisch an derselben Stelle weiter.

## Einstellungen (⚙ im Popup)

| Einstellung | Bedeutung |
|---|---|
| Download-Ordner | Unterordner in deinem Firefox-Download-Ordner, z. B. `Videos` oder `Videos/Web`. Wird gespeichert. |
| Vor jedem Download nach dem Speicherort fragen | Ein-/ausschaltbar. |
| Tiefensuche automatisch | Startet die Tiefensuche, wenn beim Öffnen nichts gefunden wurde. |
| Alle Qualitätsstufen aufgeklappt | Zeigt auch die schwächeren Versionen immer an. |
| Abgebrochene Downloads automatisch fortsetzen | Auch nach einem Firefox-Neustart. |
| Seitenleiste beim Start eines Downloads öffnen | |
| Updates automatisch suchen und installieren | |
| Gleichzeitige Downloads | 1–6, Standard 2. Weitere warten in der Schlange. |
| Dateien kleiner als … ausblenden | Filtert Werbe-Clips und Mini-Schnipsel heraus. |

**Zum Ordner:** Firefox erlaubt Erweiterungen nur das Speichern innerhalb des Firefox-Download-Ordners. Einen ganz anderen Ort stellst du entweder dauerhaft in Firefox unter **Einstellungen → Allgemein → Dateien und Anwendungen → Downloads** ein oder pro Download, indem du die Nachfrage einschaltest.

## Installation

Normales Firefox installiert dauerhaft nur von Mozilla signierte Erweiterungen. Die Signierung ist kostenlos und läuft in diesem Repository automatisch, sobald einmalig zwei Schlüssel hinterlegt sind.

### Einmalige Einrichtung der automatischen Signierung
1. Bei https://addons.mozilla.org anmelden oder ein kostenloses Konto anlegen.
2. https://addons.mozilla.org/developers/addon/api/key/ öffnen und neue Zugangsdaten erzeugen („Generate new credentials“). Du erhältst einen **JWT-Aussteller** und ein **JWT-Geheimnis**.
3. Hier im Repository: **Settings → Secrets and variables → Actions → New repository secret**. Zwei Secrets anlegen:
   - `AMO_JWT_ISSUER` mit dem JWT-Aussteller
   - `AMO_JWT_SECRET` mit dem JWT-Geheimnis
4. **Actions → Release → Run workflow** anklicken. Nach einigen Minuten erscheint unter **Releases** die signierte Datei `video-downloader-<Version>.xpi`.
5. Die `.xpi` in Firefox öffnen und installieren. Alternativ: `about:addons` → Zahnrad → „Add-on aus Datei installieren…“.

Ab dann gilt: Jede neue Version, die in den Ordner `extension/` kommt (mit erhöhter Versionsnummer in `manifest.json`), wird automatisch signiert, als Release veröffentlicht und in `updates.json` eingetragen. Firefox installiert sie anschließend von selbst.

### Ohne Signierung (zum Ausprobieren)
- **Temporär:** `about:debugging#/runtime/this-firefox` → „Temporäres Add-on laden…“ → `manifest.json` aus dem Ordner `extension/` oder eine `.xpi` wählen. Die Erweiterung bleibt bis zum nächsten Neustart installiert; Updates und das Fortsetzen nach einem Neustart greifen so nicht.
- **Dauerhaft in Firefox Developer Edition, Nightly oder ESR:** In `about:config` `xpinstall.signatures.required` auf `false` setzen und die `.xpi` installieren. Die unsignierte `.xpi` gibt es nach jedem Lauf unter **Actions** als Artefakt.

## Grenzen

- **DRM-geschützte Inhalte** (Netflix, Disney+, Amazon Prime usw.) und **verschlüsselte Streams** werden erkannt und als „nicht möglich“ markiert. Sie werden bewusst nicht heruntergeladen.
- **Live-Streams** werden nicht unterstützt. **YouTube** funktioniert damit nicht zuverlässig.
- HLS-Streams im älteren TS-Format werden als `.ts` gespeichert (läuft in VLC, mpv und den meisten Playern). Umwandeln ohne Qualitätsverlust: `ffmpeg -i video.ts -c copy video.mp4`
- Wenn Bild und Ton ausnahmsweise nicht zusammengeführt werden können (z. B. bei WebM), entstehen zwei Dateien: `ffmpeg -i "video.webm" -i "video (Tonspur).weba" -c copy "video.mkv"`
- Stream-Teile werden bis zum Abschluss im Firefox-Profil zwischengespeichert. Dafür braucht es freien Platz in der Größe des Videos; nach dem Speichern wird er wieder freigegeben.
- Bitte nur Videos herunterladen, für die du die Rechte hast oder deren Download erlaubt ist.

## Aufbau

```
extension/                 die Erweiterung
  manifest.json            Beschreibung, Version, Update-Adresse
  background.js            Erkennung, Analyse, Qualitätsauswahl
  jobs.js                  Download-Aufträge: Warteschlange, Fortsetzen, Pause, Abbruch, Restzeit
  updater.js               Update-Prüfung und -Installation
  content.js               Seiten- und Frame-Analyse, Vorschaubilder, Tiefensuche
  lib/parsers.js           Formaterkennung, HLS- und DASH-Parser
  lib/mp4merge.js          Zusammenführen von Bild- und Tonspur
  lib/store.js             dauerhafter Zwischenspeicher (IndexedDB)
  popup/, sidebar/, options/, settings.js, ui-common.js   Oberfläche
updates.json               Update-Liste für Firefox (wird automatisch gepflegt)
.github/workflows/release.yml   automatische Signierung und Veröffentlichung
```
