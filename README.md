# Immich Album Manager 0.3.0

Kleine Docker-Webapp für schnelle Albumverwaltung in einer dichten Listenansicht, angelehnt an die Immich-Albumübersicht.

## Neu in 0.3.0

Der Merge-Workflow wurde komplett umgebaut:

- **Mehrere Quellalben direkt in der Liste auswählen** – Checkbox pro Zeile.
- **Zielalbum direkt in der Liste festlegen** – eigener Ziel-Button pro Zeile, kein Dropdown mehr.
- **Alle sichtbaren Alben als Quelle markieren** – Checkbox im Tabellenkopf; Suche/Filter werden dabei berücksichtigt.
- **Sticky Merge-Leiste** – zeigt Anzahl Quellen, grobe Asset-Summe und Zielalbum und startet den Merge zentral.
- Ein Album kann nie gleichzeitig Quelle und Ziel sein. Die UI löst widersprüchliche Auswahl automatisch auf.
- Die Quellzeilen und die Zielzeile werden visuell unterschiedlich hervorgehoben.
- Multi-Merge im Backend: Assets aller Quellen werden zuerst vollständig ins Ziel übernommen; erst danach beginnt das Löschen der Quellalben.
- Falls nach erfolgreichem Asset-Transfer einzelne Quellalben nicht gelöscht werden können, meldet die UI diese Cleanup-Fehler explizit und lädt den aktuellen Zustand neu.

## Bereits enthalten

- **Keine Pagination:** alle Alben / Treffer stehen in einer einzigen scrollbaren Liste.
- **Neuestes Item:** Thumbnail, Dateiname und exakter Zeitstempel des neuesten Assets im Album.
- **Ältestes Item:** Thumbnail, Dateiname und exakter Zeitstempel des ältesten Assets im Album.
- Sortierung nach neuestem oder ältestem Item in beide Richtungen.
- **Inline umbenennen:** Albumname direkt in der Liste bearbeiten; Enter oder Fokusverlust speichert.
- **Direkt löschen:** ein Klick auf `×` löscht das Album **ohne Rückfrage**.
- Suche, Scope-Filter und Sortierung.
- API-Key bleibt serverseitig und wird nicht an den Browser ausgeliefert.
- Optionaler HTTP-Basic-Auth für die Management-Oberfläche.

> Das Löschen eines Albums löscht in Immich nicht die Assets selbst, aber die Album-Zuordnung geht verloren. Diese App fragt absichtlich nicht nach einer Bestätigung.

## Merge-Bedienung

1. In der Spalte **Quelle** ein oder mehrere Alben markieren.
2. In der Spalte **Ziel** das gewünschte Zielalbum anklicken.
3. Die Merge-Leiste zeigt Quellenanzahl, Asset-Summe und Ziel.
4. **Merge starten** anklicken.
5. Nach erfolgreicher Übernahme aller Assets werden die Quellalben gelöscht.

Das Zielalbum kann nicht zugleich Quelle sein. Wird ein bereits als Quelle markiertes Album zum Ziel gemacht, wird es automatisch aus der Quellenauswahl entfernt. Wird umgekehrt ein Zielalbum als Quelle markiert, wird die Zielauswahl aufgehoben.

## Immich-Kompatibilität

Gebaut gegen die Immich-v3-API und den Stand von v3.2.x. Seit v3 liefert `GET /albums/:id` keine Assetliste mehr. Der Merge holt die Asset-IDs deshalb paginiert über `POST /search/metadata`.

Für **Neuestes Item** und **Ältestes Item** wird je Album die Search-API mit `size: 1` und `order: desc/asc` verwendet. Falls diese Rand-Item-Abfrage fehlschlägt, zeigt die UI `startDate`/`endDate` als Fallback.

Der Multi-Merge verwendet für jedes Quellalbum die vollständige Assetliste, vereinigt die IDs, überträgt sie in Batches ins Zielalbum und toleriert Assets, die dort bereits vorhanden sind.

## Benötigte API-Key-Rechte

Für alle Funktionen sollte der Immich API Key mindestens passende Rechte für folgende Operationen besitzen:

- Album lesen
- Album ändern / update
- Album löschen
- Assets zu Album hinzufügen
- Assets lesen / suchen
- Assets teilen, soweit von Immich beim Hinzufügen zu einem Album verlangt
- Asset-Thumbnail ansehen

## Start

```bash
cp .env.example .env
# IMMICH_URL und IMMICH_API_KEY in .env setzen
docker compose up -d --build
```

Danach: `http://<docker-host>:3473`

### Wenn Immich im selben Docker-Compose läuft

Am saubersten beide Services in dasselbe Docker-Netz hängen und z. B. verwenden:

```env
IMMICH_URL=http://immich_server:2283
```

Wenn diese App separat läuft, funktioniert auf vielen Setups:

```env
IMMICH_URL=http://host.docker.internal:2283
```

`docker-compose.yml` enthält dafür unter Linux bereits `host-gateway`.

## Performance

```env
MERGE_PAGE_SIZE=1000
MERGE_CHUNK_SIZE=1000
MERGE_SOURCE_CONCURRENCY=3
EXTREMA_CONCURRENCY=6
EXTREMA_CACHE_TTL_MS=120000
```

`MERGE_SOURCE_CONCURRENCY` begrenzt, wie viele Quellalben beim Einlesen eines Multi-Merge gleichzeitig abgefragt werden. `EXTREMA_CONCURRENCY` begrenzt die parallelen Rand-Item-Abfragen der Listenansicht.

## Sicherheit

Diese App besitzt absichtlich sehr direkte Verwaltungsaktionen. Wenn Port 3473 nicht ausschließlich lokal erreichbar ist, `APP_USERNAME` und `APP_PASSWORD` setzen und idealerweise zusätzlich hinter einen Reverse Proxy mit TLS/SSO stellen. Der Immich API Key wird nur im Backend verwendet.

Mutierende Requests benötigen zusätzlich den nicht-standardmäßigen Header `x-album-manager-action: 1`.

## Technischer Ablauf des Multi-Merge

1. Ziel und alle Quellen via Immich prüfen/lesen.
2. Asset-IDs aller Quellen paginiert suchen.
3. Doppelte Asset-IDs zwischen mehreren Quellen entfernen.
4. Alle eindeutigen Asset-IDs in Batches zum Zielalbum hinzufügen.
5. `duplicate` gilt als erfolgreich, weil das Asset bereits im Ziel vorhanden ist.
6. Bei einem anderen Add-Fehler: Abbruch; **kein Quellalbum wird gelöscht**.
7. Erst wenn sämtliche Asset-Batches erfolgreich waren, werden alle Quellalben gelöscht.
8. Fehler beim abschließenden Löschen einzelner Quellen werden separat gemeldet.

## Hinweis zur Search-API

Immich entwickelt die API aktiv weiter. In Immich 3.2 wurde bereits eine neue Search API v2 eingeführt. Die App verwendet für die vorhandene v3-Kompatibilität weiterhin den funktionierenden Metadata-Search-Endpunkt; bei einem späteren v4-Upgrade sollte dieser Teil erneut geprüft werden.
