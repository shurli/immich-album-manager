# Immich Album Manager 0.2.0

Kleine Docker-Webapp für schnelle Albumverwaltung in einer dichten Listenansicht, angelehnt an die Immich-Albumübersicht.

## Neu in 0.2.0

- **Keine Pagination:** alle Alben / Treffer stehen in einer einzigen scrollbaren Liste.
- **Neuestes Item:** eigenes Thumbnail, Dateiname und exakter Zeitstempel des neuesten Assets im Album.
- **Ältestes Item:** eigenes Thumbnail, Dateiname und exakter Zeitstempel des ältesten Assets im Album.
- Sortierung nach neuestem oder ältestem Item in beide Richtungen.
- Die Rand-Items werden parallel mit begrenzter Concurrency geladen und kurz gecacht, damit größere Bibliotheken Immich nicht unnötig belasten.

## Funktionen

- Albumliste mit Thumbnail, Asset-Anzahl, neuestem/ältestem Item und Freigabestatus
- Suche, Scope-Filter und Sortierung
- **Inline umbenennen:** Albumname direkt in der Liste bearbeiten; Enter oder Fokusverlust speichert
- **Direkt löschen:** ein Klick auf `×` löscht das Album **ohne Rückfrage**
- **Merge:** Quelle in Zielalbum übernehmen; alle Assets werden ins Ziel übernommen, danach wird das Quellalbum gelöscht
- API-Key bleibt serverseitig und wird nicht an den Browser ausgeliefert
- Optionaler HTTP-Basic-Auth für die Management-Oberfläche

> Das Löschen eines Albums löscht in Immich nicht die Assets selbst, aber die Album-Zuordnung geht verloren. Diese App fragt absichtlich nicht nach einer Bestätigung.

## Immich-Kompatibilität

Gebaut gegen die Immich-v3-API, geprüft gegen den Stand von v3.2.x. Seit v3 liefert `GET /albums/:id` keine Assetliste mehr. Der Merge holt die Asset-IDs deshalb paginiert über `POST /search/metadata`.

Für **Neuestes Item** und **Ältestes Item** wird je Album die Search-API mit `size: 1` und `order: desc/asc` verwendet. Das ist absichtlich genauer als nur `startDate`/`endDate` aus der Albumantwort: diese Albumfelder werden serverseitig aktuell auf Tagesebene aggregiert und verlieren dadurch die Uhrzeit. Falls eine Rand-Item-Abfrage fehlschlägt, zeigt die UI `startDate`/`endDate` als Fallback.

Der Merge ist fehlertolerant gegenüber Assets, die bereits im Zielalbum vorhanden sind. Das Quellalbum wird **erst** gelöscht, nachdem alle Add-Batches ohne nicht-duplicate Fehler abgeschlossen wurden.

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

## Performance der neuesten/ältesten Items

Da Immich die exakten Rand-Assets nicht in `GET /albums` mitsendet, sind dafür zusätzliche Search-Requests nötig. Zwei Parameter steuern das Verhalten:

```env
EXTREMA_CONCURRENCY=6
EXTREMA_CACHE_TTL_MS=120000
```

`EXTREMA_CONCURRENCY` begrenzt die gleichzeitig laufenden Album-Abfragen. `EXTREMA_CACHE_TTL_MS` hält die Ergebnisse standardmäßig zwei Minuten im Backend-Cache. Nach Merge oder Delete werden die betroffenen Cache-Einträge verworfen.

## Sicherheit

Diese App besitzt absichtlich sehr direkte Verwaltungsaktionen. Wenn Port 3473 nicht ausschließlich lokal erreichbar ist, `APP_USERNAME` und `APP_PASSWORD` setzen und idealerweise zusätzlich hinter einen Reverse Proxy mit TLS/SSO stellen. Der Immich API Key wird nur im Backend verwendet.

Mutierende Requests benötigen zusätzlich den nicht-standardmäßigen Header `x-album-manager-action: 1`.

## Technischer Ablauf des Merge

1. Quelle und Ziel via Immich lesen.
2. Asset-IDs der Quelle paginiert mit bis zu 1000 Einträgen pro Seite suchen.
3. Asset-IDs in Batches zum Zielalbum hinzufügen.
4. `duplicate` gilt als erfolgreich, weil das Asset bereits im Ziel vorhanden ist.
5. Bei jedem anderen Bulk-Fehler: Abbruch, Quelle bleibt bestehen.
6. Erst nach vollständigem Erfolg: Quellalbum löschen.

## Hinweise

Immich entwickelt die API aktiv weiter. Die flache Form von `/search/metadata` ist in v3 weiterhin vorhanden, im Immich-Quellcode aber bereits als für v4 zu entfernende Legacy-Variante markiert. Bei einem späteren v4-Upgrade muss deshalb insbesondere die Search-Anfrage auf die neue Filterstruktur umgestellt werden.
