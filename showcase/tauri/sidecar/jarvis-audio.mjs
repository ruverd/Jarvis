import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInput } from './secrets.mjs';
import { JarvisError } from './jarvis-work.mjs';

const voice = (lang) => lang === 'pt' ? 'Luciana' : 'Samantha';
const audioError = () => new JarvisError('O macOS não conseguiu gerar a fala.', 'macOS could not generate speech.');

export function macSay(text, lang, signal) {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/say', ['-v', voice(lang), '-f', '-'], {
      stdio: ['pipe', 'ignore', 'ignore'], signal, timeout: 60_000,
    });
    p.once('error', () => resolve(false));
    p.once('close', (code) => resolve(code === 0));
    p.stdin.on('error', () => {});
    p.stdin.end(text);
  });
}

export async function macWave(text, lang) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jarvis-speech-'));
  const file = path.join(folder, 'speech.wav');
  try {
    const r = await runInput('/usr/bin/say', ['-v', voice(lang), '--data-format=LEI16@22050', '-o', file, '-f', '-'], text, 30_000);
    if (r.code !== 0) throw audioError();
    const wave = await readFile(file);
    if (wave.length < 44 || wave.subarray(0, 4).toString() !== 'RIFF' || wave.subarray(8, 12).toString() !== 'WAVE') throw audioError();
    return wave;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

const page = `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Jarvis · Áudio para Teams</title>
<style>
:root{color-scheme:dark;font:17px/1.6 system-ui;background:#10151e;color:#f2f5fb}
main{max-width:620px;margin:12vh auto;padding:24px}
h1{font-size:2.2rem;line-height:1.1;margin-bottom:1rem}
p{color:#c4d0e3}button{font:inherit;color:#0c1725;background:#91c7ff;padding:9px 16px;border:0;border-radius:8px;cursor:pointer}
button:disabled{opacity:.55} #status{color:#b3dfbb}
</style>
<main><h1>Jarvis · Áudio para Teams</h1>
<p>No Teams Web, compartilhe esta aba com a opção de áudio da aba. Mantenha seu microfone ativo, se quiser falar junto. Avise quem está na call que a voz é do Jarvis.</p>
<button id="arm">Ativar áudio nesta aba</button> <button id="stop" disabled>Desativar</button>
<p id="status" role="status">Áudio desativado.</p></main>
<script src="./client.js"></script></html>`;

const client = `
const status = document.getElementById('status');
const arm = document.getElementById('arm'), stop = document.getElementById('stop');
let events, audio, source, active;
function off() {
  active = null;
  if (source) { source.onended = null; try { source.stop(); } catch {} source = null; }
  if (events) { events.close(); events = null; }
  arm.disabled = false; stop.disabled = true;
  status.textContent = 'Áudio desativado.';
}
stop.onclick = off;
window.addEventListener('pagehide', off);
arm.onclick = async () => {
  try {
    audio ??= new AudioContext();
    await audio.resume();
    arm.disabled = true;
    stop.disabled = false;
    events = new EventSource('./events');
    events.onopen = () => status.textContent = 'Pronto. O áudio sai quando você pedir ao Jarvis.';
    events.onerror = () => { off(); status.textContent = 'Canal encerrado. Abra a aba pelo Jarvis novamente.'; };
    events.addEventListener('halt', () => {
      active = null;
      if (source) { source.onended = null; try { source.stop(); } catch {} source = null; }
      status.textContent = 'Pronto.';
    });
    events.addEventListener('speak', async ({ data: id }) => {
      active = id;
      const ack = (outcome) => fetch('./ack/' + id + '/' + outcome, { method: 'POST' }).catch(() => {});
      try {
        const result = await fetch('./audio/' + id);
        if (!result.ok) throw new Error();
        const decoded = await audio.decodeAudioData(await result.arrayBuffer());
        if (active !== id) return;
        source = audio.createBufferSource();
        source.buffer = decoded;
        source.connect(audio.destination);
        source.onended = () => { source = null; active = null; status.textContent = 'Pronto.'; ack('played'); };
        source.start();
        status.textContent = 'Jarvis falando…';
      } catch { if (active === id) { active = null; status.textContent = 'Falha ao reproduzir.'; ack('failed'); } }
    });
  } catch { off(); status.textContent = 'Não foi possível ativar áudio no navegador.'; }
};`;

export function createTeamsAudio({ synth = macWave } = {}) {
  let server, origin, prefix, listener, pending, generating = null;
  const inactive = () => new JarvisError('Ative o áudio na aba do Jarvis antes de falar no Teams.', 'Enable audio in the Jarvis tab before speaking in Teams.');
  const event = (name, value = '') => listener?.write('event: ' + name + '\ndata: ' + value + '\n\n');
  function complete(played) {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(played);
  }

  function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    res.setHeader('Permissions-Policy', 'microphone=(), camera=(), display-capture=()');
    const respond = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || !req.url?.startsWith(prefix)) return respond(404, 'text/plain', '');
    const route = req.url.slice(prefix.length);
    if (req.method === 'GET') {
      if (route === '') return respond(200, 'text/html; charset=utf-8', page);
      if (route === 'client.js') return respond(200, 'text/javascript; charset=utf-8', client);
      if (route === 'events') {
        if (listener) return respond(409, 'text/plain', 'Only one audio tab can be active.');
        listener = res;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': ready\n\n');
        res.on('close', () => { if (listener === res) { listener = null; complete(false); } });
        return;
      }
      if (pending && route === 'audio/' + pending.id) return respond(200, 'audio/wav', pending.wave);
    }
    if (req.method === 'POST' && req.headers.origin === origin && pending) {
      if (route === 'ack/' + pending.id + '/played') { complete(true); return respond(204, 'text/plain', ''); }
      if (route === 'ack/' + pending.id + '/failed') { complete(false); return respond(204, 'text/plain', ''); }
    }
    return respond(404, 'text/plain', '');
  }

  return {
    async open() {
      if (server) {
        if (!origin) throw new JarvisError('A aba de áudio está iniciando.', 'The audio tab is starting.');
        return origin + prefix;
      }
      prefix = '/' + randomBytes(24).toString('hex') + '/';
      const instance = server = createServer(handler);
      try {
        await new Promise((resolve, reject) => {
          instance.once('error', reject);
          instance.listen(0, '127.0.0.1', resolve);
        });
        origin = 'http://127.0.0.1:' + instance.address().port;
        instance.unref();
        return origin + prefix;
      } catch (error) { server = null; throw error; }
    },
    async speak(text, lang) {
      if (!listener) throw inactive();
      if (generating || pending) throw new JarvisError('Já tem uma fala na aba do Jarvis.', 'The Jarvis tab is already playing a line.');
      const target = listener;
      const job = generating = {};
      let wave;
      try { wave = await synth((lang === 'pt' ? 'Jarvis falando. ' : 'This is Jarvis. ') + text, lang); }
      finally { if (generating === job) generating = null; }
      if (job.cancelled || listener !== target) throw inactive();
      return new Promise((resolve) => {
        const id = randomUUID();
        const timer = setTimeout(() => { event('halt'); complete(false); }, 60_000).unref();
        pending = { id, wave, resolve, timer };
        event('speak', id);
      });
    },
    stop() {
      if (generating) generating.cancelled = true;
      event('halt');
      complete(false);
    },
    close() {
      this.stop();
      listener?.end();
      listener = null;
      server?.closeAllConnections();
      server?.close();
      server = null;
      origin = null;
    },
  };
}
