# EmilApp – gemeinsames Handy-Hintergrundbild

Freund:innen laden auf einer Web-Seite ein Bild hoch. Das Bild liegt unter einer festen URL (`/bg.jpg`).
Auf jedem Handy holt eine selbst eingerichtete Automation (iOS: Kurzbefehle, Android: MacroDroid) das Bild ab und setzt es als Hintergrund.
Web-Apps dürfen den Hintergrund nicht selbst setzen, deshalb dieser Umweg.

## Stack
Node 20+ · Express 5 · multer · sharp. Kein Frontend-Build, kein Datenbank-Server. Das aktuelle Bild und `meta.json` liegen in `DATA_DIR`.

## Starten
```bash
npm install
UPLOAD_CODE=meinGruppenCode npm start      # http://localhost:3000
npm test
```

## Endpunkte
| Pfad | Zweck |
|---|---|
| `GET /` | Upload-Seite (handyfreundlich) |
| `POST /api/upload` | Multipart `image`, `to` (mehrfach: Personen-IDs oder `all`), optional `by`; Header `x-upload-code` |
| `GET /bg.jpg` | gemeinsames Bild für alle, 1290×2796 JPEG, nie gecacht |
| `GET /p/<token>.jpg` | persönliches Bild einer Person (Token = 32 Hex-Zeichen, unratbar) |
| `GET/POST /api/recipients`, `DELETE /api/recipients/:id` | Personen verwalten (Header `x-upload-code`) |
| `GET /api/current` | `{version, updatedAt, by}` |
| `GET /anleitung` | Einrichtung für iPhone und Android |

## Gezielt an Freund:innen senden
Auf der Upload-Seite legst du Personen an (Spitznamen). Jede Person bekommt eine eigene, unratbare Bild-URL.
Mit „Link“ kopierst du ihren Einrichtungs-Link (`/anleitung?t=…`), der die persönliche URL schon eingesetzt zeigt.
Beim Upload wählst du eine, mehrere oder „Alle“ (gemeinsames Bild unter `/bg.jpg`) als Ziel.
Personen und Links liegen in `DATA_DIR/recipients.json` (Volume sichern!).

## Hosting
Es braucht dauerhaften Speicher für die Bilddatei. Reine Serverless-Hosts (Vercel/Netlify-Functions) haben keinen; dort müsste `src/app.js` auf Blob-Storage umgestellt werden.
Einfach: Container mit Volume (Fly.io, Railway, Render mit Disk, eigener Pi) – `Dockerfile` liegt bei; `UPLOAD_CODE` als Umgebungsvariable setzen, Volume auf `/data`.

## Sicherheit / Datenschutz
- Upload nur mit Gruppen-Code (Env-Variable, nicht im Repo); nach 10 Fehlversuchen/15 min je IP gesperrt.
- `/bg.jpg` ist öffentlich lesbar (nötig für die Automationen) – keine privaten Bilder hochladen.
- Bilder werden neu kodiert (EXIF/GPS wird dabei entfernt).

## Offen / nächste Schritte
- Teilbarer iOS-Kurzbefehl (iCloud-Link) und MacroDroid-Export: müssen auf echten Geräten erstellt werden.
- Test mit je einem iPhone und Android.
- Optional: Verlauf der letzten Bilder, Widget-Variante.
