// @ts-check
// Proxy: expone una web de chat (chat.z.ai por defecto) como endpoint OpenAI /v1/chat/completions para grok-build.
// Uso: pnpm start  →  base_url = http://127.0.0.1:8787/v1      Otra web: SITE=copilot pnpm start (ver sites/)
// ponytail: un solo hilo de chat, un solo navegador, peticiones en serie. Si necesitas paralelismo, no es esta herramienta.
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 8787;
const SITE = process.env.SITE || 'zai';
const PROFILE = process.env.ZAI_PROFILE || `${os.homedir()}/.zai-proxy-profile`;
const REPLY_TIMEOUT_MS = 15 * 60_000; // incluye tiempo para resolver captchas a mano
const MAX_TURNS = Number(process.env.ZAI_MAX_TURNS) || 50; // turnos por chat antes de abrir uno nuevo con el historial completo
const THINKING = process.env.ZAI_THINKING === '1'; // razonamiento extendido (lento); apagado por defecto

/**
 * @typedef {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }} Usage
 * @typedef {{ id: string, type: 'function', function: { name: string, arguments: string } }} ToolCall
 * @typedef {{ role: string, content?: string | { text?: string }[] | null, name?: string, tool_call_id?: string, tool_calls?: ToolCall[] }} Msg
 * @typedef {{ messages: Msg[], tools?: { function: object }[], stream?: boolean }} ChatRequest
 * @typedef {(chunk: string | null) => void} StreamFeeder
 * @typedef {{
 *   name: string, url: string, input: string, send: string, streamUrl: string, captchaText?: string,
 *   makeParser: (onAnswer: (text: string) => void, onDone: (text: string, usage?: Usage) => void, onLoop?: () => void) => StreamFeeder,
 *   onFreshChat?: (page: import('playwright').Page, thinking: boolean) => Promise<void>,
 * }} Site
 */

// ---------- protocolo de tools (el modelo web no emite tool_calls nativos) ----------
/** @param {{ function: object }[]} tools */
const toolPrompt = (tools) => `Tienes estas herramientas (JSON schema):
${JSON.stringify(tools.map((t) => t.function))}

Para usar herramientas responde SOLO con un bloque:
\`\`\`json
{"tool_calls":[{"name":"<nombre>","arguments":{...}}]}
\`\`\`
Reglas:
- Si necesitas una herramienta, el bloque JSON va en ESTA misma respuesta. Nunca anuncies lo que vas a hacer sin hacerlo.
- Recibirás los resultados como "TOOL RESULT <nombre>:". Después, sigue con la siguiente herramienta o responde en texto normal sin bloque.`;

// Busca `{"tool_calls":[...]}` en el texto respetando strings JSON (los argumentos pueden traer llaves, p.ej. código).
/** @param {string} text */
function extractToolJson(text) {
  const start = text.indexOf('{"tool_calls"');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** @param {string} text @returns {{ content: string | null, tool_calls?: ToolCall[] }} */
export function parseToolCalls(text) {
  const raw = extractToolJson(text);
  if (raw) {
    try {
      /** @type {{ tool_calls?: { name: string, arguments?: object }[] }} */
      const j = JSON.parse(raw);
      if (Array.isArray(j.tool_calls)) {
        const tool_calls = j.tool_calls.map((c, i) => /** @type {ToolCall} */ ({
          id: `call_${Date.now()}_${i}`, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
        const content = text.replace(raw, '').replace(/```\w*\s*```/g, '').replace(/^\s*json\s*$/m, '').trim();
        return { content: content || null, tool_calls };
      }
    } catch { /* JSON roto: se devuelve como texto */ }
  }
  return { content: text, tool_calls: undefined };
}

// Prefijo del texto que se puede emitir en streaming sin riesgo de filtrar el bloque de tool_calls.
/** @param {string} text */
export const safePrefix = (text) => {
  const cut = [text.indexOf('```'), text.indexOf('{"tool_calls"')].filter((i) => i >= 0);
  return cut.length ? text.slice(0, Math.min(...cut)) : text;
};

/** @param {Msg['content']} c */
const partsToText = (c) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('\n'));

/** @param {Msg} m */
export function renderMessage(m) {
  if (m.role === 'system') return `SYSTEM:\n${partsToText(m.content)}`;
  if (m.role === 'tool') return `TOOL RESULT ${m.name ?? m.tool_call_id}:\n${partsToText(m.content)}`;
  if (m.role === 'assistant') {
    const calls = m.tool_calls?.map((c) => ({ name: c.function.name, arguments: JSON.parse(c.function.arguments || '{}') }));
    return `ASSISTANT:\n${partsToText(m.content)}${calls ? `\n\`\`\`json\n${JSON.stringify({ tool_calls: calls })}\n\`\`\`` : ''}`;
  }
  return partsToText(m.content);
}

// ---------- delta de conversación ----------
// ponytail: grok reenvía todo el historial; solo mandamos lo nuevo. Clave por rol + contenido de user/tool
// (assistant/system se comparan solo por rol: grok puede reformatear lo que nosotros generamos).
/** @param {Msg} m */
const key = (m) => m.role + (m.role === 'user' || m.role === 'tool' ? ':' + partsToText(m.content) : '');
/** @param {string[]} sentKeys @param {Msg[]} messages */
export function delta(sentKeys, messages) {
  const keys = messages.map(key);
  const isPrefix = sentKeys.length > 0 && sentKeys.length < keys.length && sentKeys.every((k, i) => k === keys[i]);
  return isPrefix ? { fresh: false, msgs: messages.slice(sentKeys.length), keys } : { fresh: true, msgs: messages, keys };
}

// ponytail: grok manda peticiones internas (título de sesión, línea de dashboard) como un <system-reminder> final.
// Se contestan localmente con la última respuesta del asistente; así no gastan navegador ni rompen el hilo.
/** @param {Msg[]} messages */
export function metaReply(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'user' || !/^\s*<system-reminder>/.test(partsToText(last.content))) return null;
  const prev = [...messages].reverse().find((m) => m.role === 'assistant' && partsToText(m.content));
  return (partsToText(prev?.content) || 'Sesión').split('\n')[0].slice(0, 80);
}

// ---------- navegador ----------
// Cualquier navegador Chromium sirve (Brave, Edge, Chrome, Vivaldi, Arc, Chromium). Firefox y Safari no.
function findBrowsers() {
  const home = os.homedir();
  /** @param {string} app @param {string} bin */
  const mac = (app, bin) => [`/Applications/${app}.app/Contents/MacOS/${bin}`, `${home}/Applications/${app}.app/Contents/MacOS/${bin}`];
  /** @param {string} rel */
  const win = (rel) => ['C:\\Program Files', 'C:\\Program Files (x86)', `${process.env.LOCALAPPDATA ?? ''}`].map((d) => `${d}\\${rel}`);
  /** @type {Record<string, string[]>} */
  const byOs = {
    darwin: [...mac('Brave Browser', 'Brave Browser'), ...mac('Google Chrome', 'Google Chrome'), ...mac('Microsoft Edge', 'Microsoft Edge'), ...mac('Vivaldi', 'Vivaldi'), ...mac('Arc', 'Arc'), ...mac('Chromium', 'Chromium')],
    win32: [...win('BraveSoftware\\Brave-Browser\\Application\\brave.exe'), ...win('Google\\Chrome\\Application\\chrome.exe'), ...win('Microsoft\\Edge\\Application\\msedge.exe'), ...win('Vivaldi\\Application\\vivaldi.exe')],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/vivaldi', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  };
  return (byOs[process.platform] ?? []).filter((p) => fs.existsSync(p));
}

/** @param {string} [profile] */
export async function launchBrowser(profile = PROFILE) {
  const opts = { headless: false, viewport: null, args: ['--disable-blink-features=AutomationControlled'] };
  const b = process.env.ZAI_BROWSER; // canal ('msedge', 'chrome') o ruta al binario
  /** @type {{ executablePath?: string, channel?: string }[]} */
  const candidates = b ? [b.includes('/') || b.includes('\\') ? { executablePath: b } : { channel: b }]
    : [...findBrowsers().map((executablePath) => ({ executablePath })), { channel: 'chrome' }, { channel: 'msedge' }, {}];
  for (const c of candidates) {
    const ctx = await chromium.launchPersistentContext(profile, { ...opts, ...c }).catch(() => null);
    if (ctx) { console.log('[proxy] navegador:', c.channel ?? c.executablePath ?? 'chromium'); return ctx; }
  }
  throw new Error('no encontré ningún navegador Chromium; indica uno con ZAI_BROWSER=/ruta/al/binario');
}

/** @type {Site} */
const site = (await import(`./sites/${SITE}.mjs`)).default;
/** @type {import('playwright').Page | undefined} */
let page;
/** @type {string | undefined} */
let threadUrl;
/** @type {StreamFeeder} */
let onChunk = () => {};
const abortCurrent = () => page?.evaluate(() => /** @type {{ __zaiAbort?: () => void }} */ (window).__zaiAbort?.()).catch(() => {});

async function browser() {
  if (page) return page;
  const ctx = await launchBrowser();
  page = ctx.pages()[0] ?? (await ctx.newPage());
  // El fetch de la web se envuelve para copiar el stream de la respuesta hacia Node en tiempo real.
  await page.exposeFunction('__zaiChunk', /** @param {string | null} s */ (s) => onChunk(s));
  await page.addInitScript((streamUrl) => {
    /** @type {{ __zaiChunk: (s: string | null) => void, __zaiAbort?: () => void, fetch: typeof fetch }} */
    const w = /** @type {never} */ (window);
    const orig = w.fetch;
    w.fetch = async (...args) => {
      const res = await orig(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
      if (!url.includes(streamUrl) || !res.body) return res;
      const [a, b] = res.body.tee();
      const ra = a.getReader(), rb = b.getReader();
      // __zaiAbort cancela ambas ramas: se aborta la petición de red y la web ve el stream cerrado normalmente.
      w.__zaiAbort = () => { ra.cancel().catch(() => {}); rb.cancel().catch(() => {}); };
      (async () => {
        const dec = new TextDecoder();
        try { for (;;) { const { value, done } = await rb.read(); if (done) break; w.__zaiChunk(dec.decode(value, { stream: true })); } } catch { /* abortado */ }
        w.__zaiChunk(null);
      })();
      const wrapped = new ReadableStream({
        async pull(c) { try { const { value, done } = await ra.read(); done ? c.close() : c.enqueue(value); } catch { c.close(); } },
        cancel() { w.__zaiAbort?.(); },
      });
      return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  }, site.streamUrl);
  await page.goto(site.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(site.input, { timeout: 0 });
  console.log(`[proxy] ${site.name} listo. Si no has iniciado sesión, hazlo en la ventana (perfil: ${PROFILE})`);
  return page;
}

/**
 * @param {boolean} fresh @param {string} prompt @param {(text: string) => void} onPartial @param {boolean} [side] petición aparte: no toca el hilo principal
 * @returns {Promise<{ text: string, usage?: Usage }>}
 */
async function ask(fresh, prompt, onPartial, side = false) {
  const p = await browser();
  const target = fresh || !threadUrl ? site.url : threadUrl;
  if (fresh || p.url() !== target) { await p.goto(target, { waitUntil: 'domcontentloaded' }); await p.waitForSelector(site.input); }
  if (fresh) await site.onFreshChat?.(p, THINKING).catch(() => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onChunk = () => {}; reject(new Error(`timeout esperando respuesta de ${site.name}`)); }, REPLY_TIMEOUT_MS);
    const captcha = setTimeout(async () => { if (site.captchaText && (await p.getByText(site.captchaText).count())) console.log('[proxy] captcha: resuélvelo en la ventana del navegador'); }, 5000);
    onChunk = site.makeParser(onPartial, (text, usage) => {
      clearTimeout(timer); clearTimeout(captcha); onChunk = () => {};
      if (!side) threadUrl = p.url();
      resolve({ text: text.trim(), usage });
    }, abortCurrent);
    p.fill(site.input, prompt).then(() => p.click(site.send)).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------- servidor ----------
/** @type {string[]} */
let sentKeys = [];
let turns = 0;
/** @type {Promise<unknown>} */
let queue = Promise.resolve(); // ponytail: lock global, una petición a la vez

/**
 * @param {ChatRequest} body @param {(text: string) => void} onPartial
 * @returns {Promise<{ msg: { role: 'assistant', content: string | null, tool_calls?: ToolCall[] }, finish_reason: string, usage?: Usage }>}
 */
async function complete(body, onPartial) {
  const meta = metaReply(body.messages);
  if (meta) return { msg: { role: 'assistant', content: meta }, finish_reason: 'stop' };
  const d = delta(sentKeys, body.messages);
  // ponytail: peticiones internas de grok sin tools que no continúan el hilo (p.ej. extracción de memoria) van a un chat aparte
  // sin tocar el estado del hilo principal.
  if (d.fresh && !body.tools?.length && sentKeys.length) {
    console.log('[proxy] petición aparte, no toca el hilo');
    const r = await ask(true, body.messages.map(renderMessage).join('\n\n'), onPartial, true);
    return { msg: { role: 'assistant', content: r.text }, finish_reason: 'stop', usage: r.usage };
  }
  const fresh = d.fresh || turns >= MAX_TURNS;
  const { keys } = d, msgs = fresh ? body.messages : d.msgs;
  turns = fresh ? 1 : turns + 1;
  console.log(`[proxy] ${fresh ? 'chat nuevo' : 'sigue en el chat'} (+${msgs.length} mensajes, turno ${turns})`);
  const parts = msgs.map(renderMessage);
  if (fresh && body.tools?.length) parts.unshift(toolPrompt(body.tools));
  let r = await ask(fresh, parts.join('\n\n'), onPartial);
  let parsed = parseToolCalls(r.text);
  // ponytail: si el modelo narra ("voy a revisar…") en vez de llamar la herramienta, se le empuja una vez.
  if (body.tools?.length && !parsed.tool_calls && /^\s*(voy a|primero|déjame|dejame|ahora|let me|i'?ll|i will|first)\b/i.test(r.text)) {
    console.log('[proxy] narró sin llamar herramienta, le insisto');
    const r2 = await ask(false, 'Hazlo ahora: responde SOLO con el bloque JSON de tool_calls.', () => {});
    const p2 = parseToolCalls(r2.text);
    if (p2.tool_calls) { parsed = { content: [r.text, p2.content].filter(Boolean).join('\n'), tool_calls: p2.tool_calls }; r = { text: r.text + r2.text, usage: r2.usage }; }
  }
  if (r.text) sentKeys = [...keys, 'assistant']; // respuesta vacía: el reintento de grok reenvía lo mismo en este chat
  const msg = { role: /** @type {const} */ ('assistant'), ...parsed };
  return { msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop', usage: r.usage };
}

/** @param {http.ServerResponse} res @param {number} code @param {object} obj */
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; // inspect.mjs importa este módulo sin arrancar nada
if (isMain && !process.argv.includes('--test')) {
  http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'zai-web', object: 'model', created: 0, owned_by: 'zai-proxy' }] });
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return json(res, 404, { error: 'not found' });
    let raw = ''; for await (const c of req) raw += c;
    /** @type {ChatRequest} */
    const body = JSON.parse(raw);
    console.log(`[proxy] <- ${body.messages.map((m) => m.role).join(',')} stream=${!!body.stream} tools=${body.tools?.length ?? 0}`);
    const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: 'zai-web' };
    /** @param {Usage} [u] */
    const toUsage = (u) => ({ prompt_tokens: u?.prompt_tokens ?? 0, completion_tokens: u?.completion_tokens ?? 0, total_tokens: u?.total_tokens ?? 0 });
    let headersSent = false, streamed = '', finished = false;
    /** @param {object} d @param {string | null} [fr] @param {object} [usage] */
    const chunk = (d, fr = null, usage) => {
      if (res.destroyed) return;
      if (!headersSent) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); headersSent = true; }
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: fr, logprobs: null }], ...(usage && { usage }) })}\n\n`);
    };
    /** @type {(text: string) => void} */
    const onPartial = !body.stream ? () => {} : (text) => {
      const safe = safePrefix(text);
      if (safe.length > streamed.length) { chunk({ role: streamed ? undefined : 'assistant', content: safe.slice(streamed.length) }); streamed = safe; }
    };
    res.on('close', () => { if (!finished) { console.log('[proxy] cliente canceló, corto la generación'); abortCurrent(); } });
    try {
      const run = () => complete(body, onPartial);
      const { msg, finish_reason, usage } = await (queue = queue.then(run, run));
      finished = true;
      console.log(`[proxy] -> ${finish_reason} ${msg.tool_calls ? msg.tool_calls.map((c) => c.function.name).join(',') : JSON.stringify((msg.content ?? '').slice(0, 80))}`);
      if (!body.stream) return json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: msg, finish_reason, logprobs: null }], usage: toUsage(usage) });
      const final = msg.content ?? '';
      const rest = final.startsWith(streamed) ? final.slice(streamed.length) : '';
      chunk({ role: streamed ? undefined : 'assistant', content: rest, tool_calls: msg.tool_calls?.map((c, index) => ({ index, ...c })) });
      chunk({}, finish_reason, toUsage(usage));
      res.end('data: [DONE]\n\n');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[proxy]', message);
      if (res.destroyed) return;
      if (headersSent) res.end('data: [DONE]\n\n'); else json(res, 500, { error: { message } });
    }
  }).listen(PORT, '127.0.0.1', () => console.log(`[proxy] http://127.0.0.1:${PORT}/v1  (Ctrl+C para salir)`));
  browser().catch((e) => { console.error('[proxy] no pude abrir el navegador:', e instanceof Error ? e.message : e); process.exit(1); });
}

// ---------- self-check: pnpm test ----------
if (isMain && process.argv.includes('--test')) {
  const { isLooping } = await import('./sites/zai.mjs');
  const blk = '{"tool_calls":[{"name":"write","arguments":{"path":"a.ts","content":"if (x) { y(\\"}\\"); }"}}]}';
  const r = parseToolCalls(`voy a escribir\njson\n${blk}`);
  assert.ok(r.tool_calls);
  assert.equal(r.tool_calls[0].function.name, 'write');
  assert.equal(JSON.parse(r.tool_calls[0].function.arguments).content, 'if (x) { y("}"); }');
  assert.equal(r.content, 'voy a escribir');
  assert.equal(parseToolCalls('hola {"x":1}').tool_calls, undefined);
  assert.equal(safePrefix('hola\n```json\n{"tool_calls":[]}'), 'hola\n');
  assert.equal(safePrefix('sin bloque'), 'sin bloque');
  /** @type {Msg[]} */
  const conv = [{ role: 'system', content: 's' }, { role: 'user', content: 'hola' }];
  const d1 = delta([], conv); assert.equal(d1.fresh, true); assert.equal(d1.msgs.length, 2);
  const sent = [...d1.keys, 'assistant'];
  /** @type {Msg[]} */
  const conv2 = [...conv, { role: 'assistant', content: 'ok', tool_calls: [] }, { role: 'tool', name: 'read_file', content: 'x' }];
  const d2 = delta(sent, conv2); assert.equal(d2.fresh, false); assert.equal(d2.msgs.length, 1); assert.equal(d2.msgs[0].role, 'tool');
  assert.equal(delta(sent, [{ role: 'user', content: 'otra sesión' }]).fresh, true);
  assert.match(renderMessage(conv2[2]), /"tool_calls":\[\]/);
  assert.equal(metaReply([...conv2, { role: 'user', content: '<system-reminder>Generate a session title' }]), 'ok');
  assert.equal(metaReply(conv2), null);
  assert.equal(metaReply([{ role: 'user', content: '<user_query>\nhola\n</user_query>' }]), null);
  // parser SSE de Z.ai: ignora thinking, concatena answer, edit_content reemplaza y quita <details>, done cierra
  /** @type {string[]} */
  const seen = [];
  /** @type {{ t: string, u?: Usage } | undefined} */
  let done;
  const feed = site.makeParser((t) => seen.push(t), (t, u) => { done = { t, u }; });
  /** @param {object} d */
  const ev = (d) => `data: ${JSON.stringify({ type: 'chat:completion', data: d })}\n\n`;
  feed(ev({ delta_content: 'pensando', phase: 'thinking' }) + ev({ phase: 'other', usage: { total_tokens: 7 } }) + ev({ edit_content: '<details type="reasoning">x</details>\nho', phase: 'answer' }));
  feed(ev({ delta_content: 'la', phase: 'answer' }).slice(0, 20)); feed(ev({ delta_content: 'la', phase: 'answer' }).slice(20) + ev({ phase: 'done', done: true }));
  assert.deepEqual(seen, ['ho', 'hola']);
  assert.equal(done?.t, 'hola'); assert.equal(done?.u?.total_tokens, 7);
  const loopTxt = 'Cualquier texto incluido en el archivo debe coincidir exactamente con el contenido del archivo. '.repeat(8);
  assert.equal(isLooping(loopTxt), true);
  assert.equal(isLooping('texto normal sin repetición '.repeat(3)), false);
  let looped = 0; const lp = site.makeParser(() => {}, () => { looped++; }, () => { looped += 10; });
  lp(ev({ delta_content: loopTxt, phase: 'answer' })); lp(ev({ delta_content: 'más', phase: 'answer' }));
  assert.equal(looped, 11); // onLoop + onDone una sola vez, chunks posteriores ignorados
  console.log('self-check OK'); process.exit(0);
}
