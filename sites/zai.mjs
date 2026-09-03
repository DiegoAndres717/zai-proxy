// @ts-check
// Adaptador para chat.z.ai (fork de Open WebUI).
// Stream SSE: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking|answer|other|done", "edit_content"?, "usage"?, "done"?}}

/** @typedef {import('../server.mjs').Site} Site */

// ponytail: el modelo a veces entra en bucle repitiendo una frase. Si la cola del texto aparece 3+ veces en los últimos 2000 chars, cortamos.
/** @param {string} text */
export const isLooping = (text) => {
  if (text.length < 400) return false;
  const tail = text.slice(-120), win = text.slice(-2000);
  return win.split(tail).length - 1 >= 3;
};

/** @type {Site['makeParser']} */
export function makeParser(onAnswer, onDone, onLoop = () => {}) {
  let buf = '', answer = '', ended = false;
  /** @type {import('../server.mjs').Usage | undefined} */
  let usage;
  const finish = () => { if (!ended) { ended = true; onDone(answer, usage); } };
  return (chunk) => {
    if (ended) return;
    if (chunk === null) { finish(); return; }
    buf += chunk;
    const events = buf.split('\n\n'); buf = events.pop() ?? '';
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      /** @type {{ delta_content?: string, edit_content?: string, phase?: string, usage?: import('../server.mjs').Usage, done?: boolean } | undefined} */
      let d;
      try { d = JSON.parse(line.slice(5)).data; } catch { continue; }
      if (!d) continue;
      if (d.usage) usage = d.usage;
      if (d.phase === 'answer') {
        if (typeof d.edit_content === 'string') answer = d.edit_content.replace(/<details[\s\S]*?<\/details>\s*/g, '');
        if (typeof d.delta_content === 'string') answer += d.delta_content;
        try { onAnswer(answer); } catch { /* el consumidor no debe romper el stream */ }
        if (isLooping(answer)) { console.log('[proxy] bucle detectado, corto la generación'); onLoop(); finish(); return; }
      }
      if (d.phase === 'done' || d.done) { finish(); return; }
    }
  };
}

/** @type {Site} */
const zai = {
  name: 'zai',
  url: 'https://chat.z.ai/',
  input: '#chat-input',
  send: '#send-message-button',
  streamUrl: '/api/v2/chat/completions',
  captchaText: 'security verification',
  makeParser,
  // ponytail: el interruptor "Deep Think" no obedece al clic automatizado; solo se lee y se avisa. Apágalo a mano en la ventana.
  async onFreshChat(p, thinking) {
    const menu = p.getByText('Deep Think', { exact: true }).first();
    if (!(await menu.count())) return;
    await menu.click(); await p.waitForTimeout(300);
    const on = (await p.locator('button[role=switch]').last().getAttribute('aria-checked').catch(() => null)) === 'true';
    await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    if (await p.locator('button[role=switch]').count()) await p.mouse.click(5, 5);
    if (on !== thinking) console.log(`[proxy] AVISO: Deep Think está ${on ? 'ENCENDIDO (lento). Apágalo en el menú "Deep Think" de la ventana' : 'apagado pero ZAI_THINKING=1'}`);
  },
};
export default zai;
