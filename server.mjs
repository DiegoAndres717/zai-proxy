// zai-proxy: expone chat.z.ai (web) como endpoint OpenAI /v1/chat/completions para grok-build.
// Uso: pnpm start  →  base_url = http://127.0.0.1:8787/v1
// ponytail: un solo hilo de chat, un solo navegador, peticiones en serie. Si necesitas paralelismo, no es esta herramienta.
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 8787;
const PROFILE = process.env.ZAI_PROFILE || `${os.homedir()}/.zai-proxy-profile`;
const REPLY_TIMEOUT_MS = 15 * 60_000; // incluye tiempo para resolver captchas a mano
const MAX_TURNS = Number(process.env.ZAI_MAX_TURNS) || 50; // turnos por chat de Z.ai antes de abrir uno nuevo con el historial completo
const THINKING = process.env.ZAI_THINKING === '1'; // razonamiento extendido de Z.ai (lento); apagado por defecto
const S = { input: '#chat-input', send: '#send-message-button' };

// ---------- protocolo de tools (el modelo web no emite tool_calls nativos) ----------
const toolPrompt = (tools) => `Tienes estas herramientas (JSON schema):
${JSON.stringify(tools.map((t) => t.function))}

Para usar herramientas responde SOLO con un bloque:
\`\`\`json
{"tool_calls":[{"name":"<nombre>","arguments":{...}}]}
\`\`\`
Recibirás los resultados como "TOOL RESULT <nombre>:". Cuando termines, responde en texto normal sin ese bloque.`;

// Busca `{"tool_calls":[...]}` en el texto respetando strings JSON (los argumentos pueden traer llaves, p.ej. código).
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

export function parseToolCalls(text) {
  const raw = extractToolJson(text);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j.tool_calls)) {
        const tool_calls = j.tool_calls.map((c, i) => ({
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
export const safePrefix = (text) => {
  const cut = [text.indexOf('```'), text.indexOf('{"tool_calls"')].filter((i) => i >= 0);
  return cut.length ? text.slice(0, Math.min(...cut)) : text;
};

const partsToText = (c) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('\n'));

export function renderMessage(m) {
  if (m.role === 'system') return `SYSTEM:\n${partsToText(m.content)}`;
  if (m.role === 'tool') return `TOOL RESULT ${m.name ?? m.tool_call_id}:\n${partsToText(m.content)}`;
  if (m.role === 'assistant') {
    const calls = m.tool_calls?.map((c) => ({ name: c.function.name, arguments: JSON.parse(c.function.arguments || '{}') }));
    return `ASSISTANT:\n${partsToText(m.content) ?? ''}${calls ? `\n\`\`\`json\n${JSON.stringify({ tool_calls: calls })}\n\`\`\`` : ''}`;
  }
  return partsToText(m.content);
}

// ---------- delta de conversación ----------
// ponytail: grok reenvía todo el historial; solo mandamos lo nuevo. Clave por rol + contenido de user/tool
// (assistant/system se comparan solo por rol: grok puede reformatear lo que nosotros generamos).
const key = (m) => m.role + (m.role === 'user' || m.role === 'tool' ? ':' + partsToText(m.content) : '');
export function delta(sentKeys, messages) {
  const keys = messages.map(key);
  const isPrefix = sentKeys.length > 0 && sentKeys.length < keys.length && sentKeys.every((k, i) => k === keys[i]);
  return isPrefix ? { fresh: false, msgs: messages.slice(sentKeys.length), keys } : { fresh: true, msgs: messages, keys };
}

// ponytail: grok manda peticiones internas (título de sesión, línea de dashboard) como un <system-reminder> final.
// Se contestan localmente con la última respuesta del asistente; así no gastan navegador ni rompen el hilo.
export function metaReply(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'user' || !/^\s*<system-reminder>/.test(partsToText(last.content))) return null;
  const prev = [...messages].reverse().find((m) => m.role === 'assistant' && partsToText(m.content));
  return (partsToText(prev?.content) || 'Sesión').split('\n')[0].slice(0, 80);
}

// ponytail: el modelo a veces entra en bucle repitiendo una frase. Si la cola del texto aparece 3+ veces en los últimos 2000 chars, cortamos.
export const isLooping = (text) => {
  if (text.length < 400) return false;
  const tail = text.slice(-120), win = text.slice(-2000);
  return win.split(tail).length - 1 >= 3;
};

// ---------- stream SSE de Z.ai ----------
// Eventos: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking|answer|other|done", "edit_content"?, "usage"?, "done"?}}
export function makeSseParser(onAnswer, onDone, onLoop = () => {}) {
  let buf = '', answer = '', usage, ended = false;
  const finish = () => { if (!ended) { ended = true; onDone(answer, usage); } };
  return (chunk) => {
    if (ended) return;
    if (chunk === null) { finish(); return; }
    buf += chunk;
    const events = buf.split('\n\n'); buf = events.pop() ?? '';
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let d; try { d = JSON.parse(line.slice(5)).data; } catch { continue; }
      if (!d) continue;
      if (d.usage) usage = d.usage;
      if (d.phase === 'answer') {
        if (typeof d.edit_content === 'string') answer = d.edit_content.replace(/<details[\s\S]*?<\/details>\s*/g, '');
        if (typeof d.delta_content === 'string') answer += d.delta_content;
        try { onAnswer(answer); } catch { /* el consumidor no debe romper el stream */ }
        if (isLooping(answer)) { console.log('[zai-proxy] bucle detectado, corto la generación'); onLoop(); finish(); return; }
      }
      if (d.phase === 'done' || d.done) { finish(); return; }
    }
  };
}

// ---------- navegador ----------
// Cualquier navegador Chromium sirve (Brave, Edge, Chrome, Vivaldi, Arc, Chromium). Firefox y Safari no.
function findBrowsers() {
  const home = os.homedir();
  const mac = (app, bin) => [`/Applications/${app}.app/Contents/MacOS/${bin}`, `${home}/Applications/${app}.app/Contents/MacOS/${bin}`];
  const win = (rel) => ['C:\\Program Files', 'C:\\Program Files (x86)', `${process.env.LOCALAPPDATA ?? ''}`].map((d) => `${d}\\${rel}`);
  const byOs = {
    darwin: [...mac('Brave Browser', 'Brave Browser'), ...mac('Google Chrome', 'Google Chrome'), ...mac('Microsoft Edge', 'Microsoft Edge'), ...mac('Vivaldi', 'Vivaldi'), ...mac('Arc', 'Arc'), ...mac('Chromium', 'Chromium')],
    win32: [...win('BraveSoftware\\Brave-Browser\\Application\\brave.exe'), ...win('Google\\Chrome\\Application\\chrome.exe'), ...win('Microsoft\\Edge\\Application\\msedge.exe'), ...win('Vivaldi\\Application\\vivaldi.exe')],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/vivaldi', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  };
  return (byOs[process.platform] ?? []).filter((p) => fs.existsSync(p));
}

let page, threadUrl, onChunk = () => {};
const abortCurrent = () => page?.evaluate(() => window.__zaiAbort?.()).catch(() => {});
async function browser() {
  if (page) return page;
  const opts = { headless: false, viewport: null, args: ['--disable-blink-features=AutomationControlled'] };
  const b = process.env.ZAI_BROWSER; // canal ('msedge', 'chrome') o ruta al binario
  const candidates = b ? [b.includes('/') || b.includes('\\') ? { executablePath: b } : { channel: b }]
    : [...findBrowsers().map((executablePath) => ({ executablePath })), { channel: 'chrome' }, { channel: 'msedge' }, {}];
  let ctx;
  for (const c of candidates) {
    ctx = await chromium.launchPersistentContext(PROFILE, { ...opts, ...c }).catch(() => null);
    if (ctx) { console.log('[zai-proxy] navegador:', c.channel ?? c.executablePath ?? 'chromium'); break; }
  }
  page = ctx.pages()[0] ?? (await ctx.newPage());
  // El fetch de la web se envuelve para copiar el stream de la respuesta hacia Node en tiempo real.
  await page.exposeFunction('__zaiChunk', (s) => onChunk(s));
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const res = await orig(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
      if (!url.includes('/api/v2/chat/completions') || !res.body) return res;
      const [a, b] = res.body.tee();
      const ra = a.getReader(), rb = b.getReader();
      // __zaiAbort cancela ambas ramas: se aborta la petición de red y la web ve el stream cerrado normalmente.
      window.__zaiAbort = () => { ra.cancel().catch(() => {}); rb.cancel().catch(() => {}); };
      (async () => {
        const dec = new TextDecoder();
        try { for (;;) { const { value, done } = await rb.read(); if (done) break; window.__zaiChunk(dec.decode(value, { stream: true })); } } catch { /* abortado */ }
        window.__zaiChunk(null);
      })();
      const wrapped = new ReadableStream({
        async pull(c) { try { const { value, done } = await ra.read(); done ? c.close() : c.enqueue(value); } catch { c.close(); } },
        cancel() { window.__zaiAbort(); },
      });
      return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  });
  await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(S.input, { timeout: 0 });
  console.log(`[zai-proxy] navegador listo. Si no has iniciado sesión, hazlo en la ventana (perfil: ${PROFILE})`);
  return page;
}

// ponytail: el interruptor "Deep Think" de la web no obedece al clic automatizado; solo se lee y se avisa. Apágalo a mano en la ventana.
async function checkThinking(p) {
  const menu = p.getByText('Deep Think', { exact: true }).first();
  if (!(await menu.count())) return;
  await menu.click(); await p.waitForTimeout(300);
  const on = (await p.locator('button[role=switch]').last().getAttribute('aria-checked').catch(() => null)) === 'true';
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  if (await p.locator('button[role=switch]').count()) await p.mouse.click(5, 5);
  if (on !== THINKING) console.log(`[zai-proxy] AVISO: Deep Think está ${on ? 'ENCENDIDO (lento). Apágalo en el menú "Deep Think" de la ventana' : 'apagado pero ZAI_THINKING=1'}`);
}

async function ask(fresh, prompt, onPartial) {
  const p = await browser();
  const target = fresh || !threadUrl ? 'https://chat.z.ai/' : threadUrl;
  if (fresh || p.url() !== target) { await p.goto(target, { waitUntil: 'domcontentloaded' }); await p.waitForSelector(S.input); }
  if (fresh) await checkThinking(p).catch(() => {});
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { onChunk = () => {}; reject(new Error('timeout esperando respuesta de chat.z.ai')); }, REPLY_TIMEOUT_MS);
    const captcha = setTimeout(async () => { if (await p.getByText('security verification').count()) console.log('[zai-proxy] captcha: resuélvelo en la ventana del navegador'); }, 5000);
    onChunk = makeSseParser(onPartial, (text, usage) => {
      clearTimeout(timer); clearTimeout(captcha); onChunk = () => {};
      threadUrl = p.url();
      resolve({ text: text.trim(), usage });
    }, abortCurrent);
    try { await p.fill(S.input, prompt); await p.click(S.send); } catch (e) { clearTimeout(timer); reject(e); }
  });
}

// ---------- servidor ----------
let sentKeys = [], turns = 0;
let queue = Promise.resolve(); // ponytail: lock global, una petición a la vez

async function complete(body, onPartial) {
  const meta = metaReply(body.messages);
  if (meta) return { msg: { role: 'assistant', content: meta }, finish_reason: 'stop' };
  const d = delta(sentKeys, body.messages);
  const fresh = d.fresh || turns >= MAX_TURNS;
  const { keys } = d, msgs = fresh ? body.messages : d.msgs;
  turns = fresh ? 1 : turns + 1;
  console.log(`[zai-proxy] ${fresh ? 'chat nuevo' : 'sigue en el chat'} (+${msgs.length} mensajes, turno ${turns})`);
  const parts = msgs.map(renderMessage);
  if (fresh && body.tools?.length) parts.unshift(toolPrompt(body.tools));
  const r = await ask(fresh, parts.join('\n\n'), onPartial);
  if (r.text) sentKeys = [...keys, 'assistant']; // respuesta vacía: el reintento de grok reenvía lo mismo en este chat
  const msg = { role: 'assistant', ...parseToolCalls(r.text) };
  return { msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop', usage: r.usage };
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'zai-web', object: 'model', created: 0, owned_by: 'zai-proxy' }] });
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return json(res, 404, { error: 'not found' });
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  console.log(`[zai-proxy] <- ${body.messages.map((m) => m.role).join(',')} stream=${!!body.stream} tools=${body.tools?.length ?? 0}`);
  const base = { id: `chatcmpl-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: 'zai-web' };
  const toUsage = (u) => ({ prompt_tokens: u?.prompt_tokens ?? 0, completion_tokens: u?.completion_tokens ?? 0, total_tokens: u?.total_tokens ?? 0 });
  let headersSent = false, streamed = '';
  const chunk = (d, fr = null, usage) => {
    if (res.destroyed) return;
    if (!headersSent) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); headersSent = true; }
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: fr, logprobs: null }], ...(usage && { usage }) })}\n\n`);
  };
  const onPartial = !body.stream ? () => {} : (text) => {
    const safe = safePrefix(text);
    if (safe.length > streamed.length) { chunk({ role: streamed ? undefined : 'assistant', content: safe.slice(streamed.length) }); streamed = safe; }
  };
  let finished = false;
  res.on('close', () => { if (!finished) { console.log('[zai-proxy] cliente canceló, corto la generación'); abortCurrent(); } });
  try {
    const run = () => complete(body, onPartial);
    const { msg, finish_reason, usage } = await (queue = queue.then(run, run));
    finished = true;
    console.log(`[zai-proxy] -> ${finish_reason} ${msg.tool_calls ? msg.tool_calls.map((c) => c.function.name).join(',') : JSON.stringify((msg.content ?? '').slice(0, 80))}`);
    if (!body.stream) return json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: msg, finish_reason, logprobs: null }], usage: toUsage(usage) });
    const final = msg.content ?? '';
    const rest = final.startsWith(streamed) ? final.slice(streamed.length) : '';
    chunk({ role: streamed ? undefined : 'assistant', content: rest, tool_calls: msg.tool_calls?.map((c, index) => ({ index, ...c })) });
    chunk({}, finish_reason, toUsage(usage));
    res.end('data: [DONE]\n\n');
  } catch (e) {
    console.error('[zai-proxy]', e.message);
    if (res.destroyed) return;
    if (headersSent) res.end('data: [DONE]\n\n'); else json(res, 500, { error: { message: e.message } });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[zai-proxy] http://127.0.0.1:${PORT}/v1  (Ctrl+C para salir)`));
if (!process.argv.includes('--test')) browser().catch((e) => { console.error('[zai-proxy] no pude abrir el navegador:', e.message); process.exit(1); });

// ---------- self-check: pnpm test ----------
if (process.argv.includes('--test')) {
  const blk = '{"tool_calls":[{"name":"write","arguments":{"path":"a.ts","content":"if (x) { y(\\"}\\"); }"}}]}';
  const r = parseToolCalls(`voy a escribir\njson\n${blk}`);
  assert.equal(r.tool_calls[0].function.name, 'write');
  assert.equal(JSON.parse(r.tool_calls[0].function.arguments).content, 'if (x) { y("}"); }');
  assert.equal(r.content, 'voy a escribir');
  assert.equal(parseToolCalls('hola {"x":1}').tool_calls, undefined);
  assert.equal(safePrefix('hola\n```json\n{"tool_calls":[]}'), 'hola\n');
  assert.equal(safePrefix('sin bloque'), 'sin bloque');
  const conv = [{ role: 'system', content: 's' }, { role: 'user', content: 'hola' }];
  const d1 = delta([], conv); assert.equal(d1.fresh, true); assert.equal(d1.msgs.length, 2);
  const sent = [...d1.keys, 'assistant'];
  const conv2 = [...conv, { role: 'assistant', content: 'ok', tool_calls: [] }, { role: 'tool', name: 'read_file', content: 'x' }];
  const d2 = delta(sent, conv2); assert.equal(d2.fresh, false); assert.equal(d2.msgs.length, 1); assert.equal(d2.msgs[0].role, 'tool');
  assert.equal(delta(sent, [{ role: 'user', content: 'otra sesión' }]).fresh, true);
  assert.match(renderMessage(conv2[2]), /"tool_calls":\[\]/);
  const meta = [...conv2, { role: 'user', content: '<system-reminder>Generate a session title' }];
  assert.equal(metaReply(meta), 'ok');
  assert.equal(metaReply(conv2), null);
  assert.equal(metaReply([{ role: 'user', content: '<user_query>\nhola\n</user_query>' }]), null);
  // parser SSE: ignora thinking, concatena answer, edit_content reemplaza y quita <details>, done cierra
  const seen = []; let done;
  const feed = makeSseParser((t) => seen.push(t), (t, u) => { done = { t, u }; });
  const ev = (d) => `data: ${JSON.stringify({ type: 'chat:completion', data: d })}\n\n`;
  feed(ev({ delta_content: 'pensando', phase: 'thinking' }) + ev({ phase: 'other', usage: { total_tokens: 7 } }) + ev({ edit_content: '<details type="reasoning">x</details>\nho', phase: 'answer' }));
  feed(ev({ delta_content: 'la', phase: 'answer' }).slice(0, 20)); feed(ev({ delta_content: 'la', phase: 'answer' }).slice(20) + ev({ phase: 'done', done: true }));
  assert.deepEqual(seen, ['ho', 'hola']);
  assert.equal(done.t, 'hola'); assert.equal(done.u.total_tokens, 7);
  const loopTxt = 'Cualquier texto incluido en el archivo debe coincidir exactamente con el contenido del archivo. '.repeat(8);
  assert.equal(isLooping(loopTxt), true);
  assert.equal(isLooping('texto normal sin repetición '.repeat(3)), false);
  let looped = 0; const lp = makeSseParser(() => {}, () => { looped++; }, () => { looped += 10; });
  lp(ev({ delta_content: loopTxt, phase: 'answer' })); lp(ev({ delta_content: 'más', phase: 'answer' }));
  assert.equal(looped, 11); // onLoop + onDone una sola vez, chunks posteriores ignorados
  console.log('self-check OK'); process.exit(0);
}
