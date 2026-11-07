import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp, TARGET } from '../src/app.js';

let server, base, dir;
const CODE = 'geheim123';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emilapp-'));
  server = createApp({ uploadCode: CODE, dataDir: dir }).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function png(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#3366cc' } }).png().toBuffer();
}
function form(buf, by) {
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: 'image/png' }), 'x.png');
  if (by) fd.append('by', by);
  return fd;
}

test('vor dem Upload: 404 und Version 0', async () => {
  assert.equal((await fetch(`${base}/bg.jpg`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/current`)).json(), { version: 0 });
});

test('falscher Code wird abgelehnt', async () => {
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-upload-code': 'falsch' }, body: form(await png(100, 100)) });
  assert.equal(r.status, 401);
});

test('Upload skaliert aufs Handy-Hochformat und erhöht die Version', async () => {
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-upload-code': CODE }, body: form(await png(4000, 3000), 'Test') });
  assert.equal(r.status, 200);
  const meta = await r.json();
  assert.equal(meta.version, 1);
  assert.equal(meta.by, 'Test');

  const img = await fetch(`${base}/bg.jpg`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const info = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(info.width, TARGET.width);
  assert.equal(info.height, TARGET.height);

  const r2 = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-upload-code': CODE }, body: form(await png(500, 900)) });
  assert.equal((await r2.json()).version, 2);
});

test('Nicht-Bild wird mit 400 abgelehnt', async () => {
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-upload-code': CODE }, body: form(Buffer.from('kein bild')) });
  assert.equal(r.status, 400);
});

test('zu viele Fehlversuche sperren (429)', async () => {
  let last;
  for (let i = 0; i < 12; i++) {
    last = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'x-upload-code': 'x' }, body: form(await png(10, 10)) });
  }
  assert.equal(last.status, 429);
});
