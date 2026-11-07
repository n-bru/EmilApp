import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Zielformat: Hochformat, passt auf aktuelle iPhones/Androids (cover-Zuschnitt)
export const TARGET = { width: 1290, height: 2796, quality: 85 };
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ uploadCode, dataDir }) {
  const app = express();
  const imgPath = path.join(dataDir, 'current.jpg');
  const metaPath = path.join(dataDir, 'meta.json');
  const fails = new Map(); // ip -> { count, since }
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // hinter Hosting-Proxy: echte Client-IP für Rate-Limit

  async function readMeta() {
    try {
      return JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function tooManyFails(ip) {
    const f = fails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > FAIL_WINDOW_MS) {
      fails.delete(ip);
      return false;
    }
    return f.count >= MAX_FAILS;
  }

  function noteFail(ip) {
    const f = fails.get(ip);
    if (!f || Date.now() - f.since > FAIL_WINDOW_MS) fails.set(ip, { count: 1, since: Date.now() });
    else f.count++;
  }

  // Aktuelles Bild unter fester URL. Kein Caching, damit Automationen immer das neue Bild holen.
  app.get('/bg.jpg', async (req, res) => {
    try {
      await fs.access(imgPath);
    } catch {
      return res.status(404).type('text').send('Noch kein Bild hochgeladen.');
    }
    res.set('Cache-Control', 'no-cache');
    res.type('jpeg').sendFile(path.resolve(imgPath));
  });

  // Metadaten: Automationen können per Version prüfen, ob sich etwas geändert hat.
  app.get('/api/current', async (req, res) => {
    const meta = await readMeta();
    res.set('Cache-Control', 'no-store');
    res.json(meta ?? { version: 0 });
  });

  app.post('/api/upload', upload.single('image'), async (req, res) => {
    const ip = req.ip;
    if (tooManyFails(ip)) {
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte später erneut versuchen.' });
    }
    const code = req.get('x-upload-code') ?? '';
    if (!safeEqual(code, uploadCode)) {
      noteFail(ip);
      return res.status(401).json({ error: 'Falscher Code.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Kein Bild erhalten.' });

    let out;
    try {
      // rotate() liest EXIF-Ausrichtung (Handyfotos), danach wird auf Hochformat zugeschnitten.
      out = await sharp(req.file.buffer, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize(TARGET.width, TARGET.height, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: TARGET.quality, mozjpeg: true })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: 'Das ist kein lesbares Bild.' });
    }

    const by = String(req.body?.by ?? '').trim().slice(0, 30);
    const prev = await readMeta();
    const meta = {
      version: (prev?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      by: by || null,
    };
    await fs.mkdir(dataDir, { recursive: true });
    // Atomar schreiben, damit ein gleichzeitiger Abruf nie eine halbe Datei bekommt.
    const tmp = `${imgPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, out);
    await fs.rename(tmp, imgPath);
    await fs.writeFile(metaPath, JSON.stringify(meta));
    res.json(meta);
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));

  // Fehler von multer (z. B. zu große Datei) als JSON
  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Bild zu groß (max. 15 MB).' });
    }
    console.error(err);
    res.status(500).json({ error: 'Serverfehler.' });
  });

  return app;
}
