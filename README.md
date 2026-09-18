# Immich Album Manager

Kleine Docker-Webapp für schnelle Albumverwaltung in einer Listenansicht, angelehnt an die Immich-Albumübersicht.

## Funktionen

- Albumliste mit Thumbnail, Asset-Anzahl, Zeitraum und Freigabestatus
- Suche, Scope-Filter und Sortierung
- **Inline umbenennen:** Albumname direkt in der Liste bearbeiten; Enter oder Fokusverlust speichert
- **Direkt löschen:** ein Klick auf `×` löscht das Album **ohne Rückfrage**
- **Merge:** Quellalbum auswählen, Zielalbum setzen und mergen; alle Assets werden ins Zielalbum übernommen, danach wird das Quellalbum gelöscht
- API-Key bleibt serverseitig und wird nicht an den Browser ausgeliefert
- Optionaler HTTP-Basic-Auth für die Management-Oberfläche

> Das Löschen eines Albums löscht in Immich nicht die Assets selbst, aber die Album-Zuordnung geht verloren. Diese App fragt absichtlich nicht nach einer Bestätigung.

## Immich-Kompatibilität

Gebaut gegen die aktuelle Immich-v3-API (Stand v3.2.x). Seit v3 liefert `GET /albums/:id` keine Assetliste mehr. Der Merge holt die Asset-IDs deshalb paginiert über `POST /search/metadata` und fügt sie in Batches mit `PUT /albums/:id/assets` ins Zielalbum ein.

Der Merge ist fehlertolerant gegenüber Assets, die bereits im Zielalbum vorhanden sind. Das Quellalbum wird **erst** gelöscht, nachdem alle Add-Batches ohne nicht-duplicate Fehler abgeschlossen wurden. Bei einem Teilfehler bleibt das Quellalbum erhalten; bereits hinzugefügte Assets im Ziel sind unkritisch und ein erneuter Merge ist idempotent.

## Benötigte API-Key-Rechte

Für alle Funktionen sollte der Immich API Key mindestens diese Berechtigungen haben (Bezeichnungen können je nach Immich-Version leicht variieren):

- Album lesen
- Album ändern / update
- Album löschen
- Assets zu Album hinzufügen (`album.asset.create`)
- Assets lesen / suchen
- Assets teilen (`asset.share`) – wird von Immich beim Hinzufügen zu einem Album geprüft
- Asset-Thumbnail ansehen (`asset.view`) für Vorschaubilder

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

## Sicherheit

Diese App besitzt absichtlich sehr direkte Verwaltungsaktionen. Wenn Port 3473 nicht ausschließlich lokal erreichbar ist, `APP_USERNAME` und `APP_PASSWORD` setzen und idealerweise zusätzlich hinter einen Reverse Proxy mit TLS/SSO stellen. Der Immich API Key wird nur im Backend verwendet.

Mutierende Requests benötigen zusätzlich einen nicht-standardmäßigen `x-album-manager-action` Header. Damit können fremde Webseiten die Delete/Merge-Endpunkte nicht als einfache Cross-Origin-Requests auslösen.

## Technischer Ablauf des Merge

1. Quelle und Ziel via Immich lesen.
2. Asset-IDs der Quelle paginiert mit bis zu 1000 Einträgen pro Seite suchen.
3. Asset-IDs in Batches zum Zielalbum hinzufügen.
4. `duplicate` gilt als erfolgreich, weil das Asset bereits im Ziel vorhanden ist.
5. Bei jedem anderen Bulk-Fehler: Abbruch, Quelle bleibt bestehen.
6. Erst nach vollständigem Erfolg: Quellalbum löschen.

## Hinweise

Immich entwickelt die API aktiv weiter. Bei einem späteren v4-Release kann insbesondere die aktuell noch vorhandene flache Form von `/search/metadata` entfallen; dann muss der Search-Request auf die neue Filter-Struktur angepasst werden.
