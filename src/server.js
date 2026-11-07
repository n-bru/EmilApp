import { createApp } from './app.js';

const code = process.env.UPLOAD_CODE;
if (!code || code.length < 6) {
  console.error('UPLOAD_CODE fehlt oder ist zu kurz (mind. 6 Zeichen). Siehe .env.example');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const app = createApp({
  uploadCode: code,
  dataDir: process.env.DATA_DIR || './data',
});
app.listen(port, () => console.log(`EmilApp läuft auf http://localhost:${port}`));
