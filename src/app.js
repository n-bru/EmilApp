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
const MAX_RECIPIENTS = 50;
const ALL = 'all'; // gemeinsames Bild unter /bg.jpg

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createApp({ uploadCode, dataDir }) {
  const app = express();
  const recipientsPath = path.join(dataDir, 'recipients.json');
  const fails = new Map(); // ip -> { count, since }
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // hinter Hosting-Proxy: echte Client-IP für Rate-Limit
  app.use(express.json({ limit: '4kb' }));

  // --- Speicher: ein "Slot" pro Empfänger:in plus der gemeinsame Slot "all" ---
  const slotPaths = key =>
    key === ALL
      ? { img: path.join(dataDir, 'current.jpg'), meta: path.join(dataDir, 'meta.json') }
      : { img: path.join(dataDir, 'r', `${key}.jpg`), meta: path.join(dataDir, 'r', `${key}.json`) };

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return fallback;
    }
  }
  const readMeta = key => readJson(slotPaths(key).meta, null);
  const readRecipients = () => readJson(recipientsPath, []);
  const writeRecipients = async list => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(recipientsPath, JSON.stringify(list));
  };

  async function writeSlot(key, buf, by) {
    const { img, meta } = slotPaths(key);
    const prev = await readMeta(key);
    const m = { version: (prev?.version ?? 0) + 1, updatedAt: new Date().toISOString(), by: by || null };
    await fs.mkdir(path.dirname(img), { recursive: true });
    // Atomar schreiben, damit ein gleichzeitiger Abruf nie eine halbe Datei bekommt.
    const tmp = `${img}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, img);
    await fs.writeFile(meta, JSON.stringify(m));
    return m;
  }

  function sendSlot(key, res) {
    return fs.access(slotPaths(key).img).then(
      () => {
        res.set('Cache-Control', 'no-cache'); // Automationen sollen immer das neue Bild holen
        res.type('jpeg').sendFile(path.resolve(slotPaths(key).img));
      },
      () => res.status(404).type('text').send('Noch kein Bild hochgeladen.'),
    );
  }

  // --- Zugriffsschutz mit Rate-Limit ---
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
  function requireCode(req, res, next) {
    if (tooManyFails(req.ip)) {
      return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte später erneut versuchen.' });
    }
    if (!safeEqual(req.get('x-upload-code') ?? '', uploadCode)) {
      noteFail(req.ip);
      return res.status(401).json({ error: 'Falscher Code.' });
    }
    next();
  }

  const tokenOk = t => /^[0-9a-f]{32}$/.test(t);
  async function byToken(token) {
    if (!tokenOk(token)) return null;
    return (await readRecipients()).find(r => r.token === token) ?? null;
  }

  // --- Abruf (öffentlich; persönliche URLs sind unratbar) ---
  app.get('/bg.jpg', (req, res) => sendSlot(ALL, res));

  app.get('/p/:token.jpg', async (req, res) => {
    const r = await byToken(req.params.token);
    if (!r) return res.status(404).type('text').send('Unbekannter Link.');
    sendSlot(r.id, res);
  });

  app.get('/api/current', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json((await readMeta(ALL)) ?? { version: 0 });
  });

  app.get('/api/p/:token', async (req, res) => {
    const r = await byToken(req.params.token);
    if (!r) return res.status(404).json({ error: 'Unbekannter Link.' });
    res.set('Cache-Control', 'no-store');
    res.json((await readMeta(r.id)) ?? { version: 0 });
  });

  // --- Empfänger:innen verwalten (Gruppen-Code nötig) ---
  app.get('/api/recipients', requireCode, async (req, res) => {
    const list = await readRecipients();
    const out = await Promise.all(
      list.map(async r => ({ ...r, ...((await readMeta(r.id)) ?? { version: 0 }) })),
    );
    res.set('Cache-Control', 'no-store');
    res.json(out);
  });

  app.post('/api/recipients', requireCode, async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Bitte einen Namen angeben.' });
    const list = await readRecipients();
    if (list.length >= MAX_RECIPIENTS) return res.status(400).json({ error: 'Zu viele Personen.' });
    const r = {
      id: crypto.randomBytes(4).toString('hex'),
      name,
      token: crypto.randomBytes(16).toString('hex'),
    };
    list.push(r);
    await writeRecipients(list);
    res.status(201).json(r);
  });

  app.delete('/api/recipients/:id', requireCode, async (req, res) => {
    const list = await readRecipients();
    const r = list.find(x => x.id === req.params.id);
    if (!r) return res.status(404).json({ error: 'Unbekannte Person.' });
    await writeRecipients(list.filter(x => x !== r));
    const { img, meta } = slotPaths(r.id);
    await Promise.all([fs.rm(img, { force: true }), fs.rm(meta, { force: true })]);
    res.json({ ok: true });
  });

  // --- Upload an eine oder mehrere Personen (Feld "to", mehrfach) oder "all" ---
  app.post('/api/upload', requireCode, upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild erhalten.' });

    const raw = req.body?.to ?? ALL;
    const targets = [...new Set(Array.isArray(raw) ? raw : [raw])];
    const known = new Set((await readRecipients()).map(r => r.id));
    if (!targets.length || targets.some(t => t !== ALL && !known.has(t))) {
      return res.status(400).json({ error: 'Unbekannte Person ausgewählt.' });
    }

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
    const results = {};
    for (const t of targets) results[t] = await writeSlot(t, out, by);
    // Rückwärtskompatibel: Antwort bei einem Ziel wie bisher, plus Details je Ziel.
    res.json({ ...results[targets[0]], targets: results });
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Bild zu groß (max. 15 MB).' });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage.' });
    console.error(err);
    res.status(500).json({ error: 'Serverfehler.' });
  });

  return app;
}
