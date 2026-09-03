// @ts-check
// Inspector para añadir una web nueva: abre la URL en tu navegador, tú inicias sesión y mandas un mensaje a mano,
// y aquí se guarda todo lo necesario para escribir sites/<nombre>.mjs: campos de texto, botones, peticiones y streams.
// Uso: pnpm inspect https://m365.cloud.microsoft/chat   → escribe inspect.log; Ctrl+C cuando termine la respuesta.
import fs from 'node:fs';
import { launchBrowser } from './server.mjs';

const url = process.argv[2];
if (!url) { console.error('uso: pnpm inspect <url>'); process.exit(1); }
const out = fs.createWriteStream('inspect.log');
/** @param {string} s */
const log = (s) => { out.write(s + '\n'); console.log(s.slice(0, 160)); };

const ctx = await launchBrowser();
const p = ctx.pages()[0] ?? (await ctx.newPage());
p.on('request', (r) => {
  if (/\.(js|css|png|svg|woff2?|ico|gif)(\?|$)|analytics|collect|telemetry/.test(r.url())) return;
  log(`REQ ${r.resourceType()} ${r.method()} ${r.url()}${r.postData() ? `\n  BODY: ${r.postData()?.slice(0, 3000)}` : ''}`);
});
p.on('response', async (r) => {
  const ct = r.headers()['content-type'] ?? '';
  if (!/event-stream|ndjson|json/.test(ct) || /\.(js|css)/.test(r.url())) return;
  const t = await r.text().catch(() => '');
  if (t.length > 200) log(`RES ${r.status()} ${ct} ${r.url()}\n  HEAD: ${t.slice(0, 2500)}\n  TAIL: ${t.slice(-1500)}`);
});
p.on('websocket', (ws) => {
  log(`WS ${ws.url()}`);
  ws.on('framesent', (f) => log(`WS> ${String(f.payload).slice(0, 1500)}`));
  ws.on('framereceived', (f) => log(`WS< ${String(f.payload).slice(0, 1500)}`));
});
await p.goto(url, { waitUntil: 'domcontentloaded' });
console.log('\nInicia sesión si hace falta, escribe un mensaje corto y espera la respuesta completa. Luego Ctrl+C.\n');
setInterval(async () => {
  const els = await p.$$eval('textarea, [contenteditable="true"], button, [role=button], [role=textbox]', (els) =>
    els.filter((e) => e.getClientRects().length).slice(0, 60).map((e) => `${e.tagName}#${e.id} role=${e.getAttribute('role') ?? ''} aria="${e.getAttribute('aria-label') ?? ''}" ph="${e.getAttribute('placeholder') ?? ''}" testid="${e.getAttribute('data-testid') ?? ''}" txt="${(/** @type {HTMLElement} */ (e).innerText ?? '').trim().slice(0, 30)}"`)).catch(() => []);
  out.write(`\nDOM @${new Date().toISOString()} ${p.url()}\n${els.join('\n')}\n`);
}, 5000);
