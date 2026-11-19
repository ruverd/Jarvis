import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { SAFE, checkRead } from './safety.mjs';
import { cliEnv, executable, JarvisError, runFile } from './jarvis-work.mjs';

export const providers = { codex: 'codex', claude: 'claude', cursor: 'cursor-agent' };
const sessionName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/;
const terminalId = /^term_[a-z0-9]+$/;
const paneId = /^w\d+:p\d+$/;
const fail = () => new JarvisError('Herdr não confirmou a operação. Confira a sessão antes de tentar de novo.', 'Herdr did not confirm the operation. Check the session before retrying.');

export function herdrCall(socket, method, params, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = createConnection(socket);
    const finish = (result) => { connection.destroy(); result ? resolve(result) : reject(fail()); };
    let buffer = '';
    connection.setEncoding('utf8').setTimeout(timeout);
    connection.on('connect', () => connection.write(JSON.stringify({ id, method, params }) + '\n'));
    connection.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(null);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, end));
        finish(response.id === id && !response.error ? response.result : null);
      } catch { finish(null); }
    });
    connection.once('close', () => reject(fail()));
    connection.once('error', () => finish(null));
    connection.once('timeout', () => finish(null));
  });
}

async function server(herdr, session) {
  const prefix = ['--session', session];
  const opts = { env: cliEnv(), timeout: 3000 };
  const socket = async () => {
    try {
      const { stdout } = await runFile(herdr, [...prefix, 'status', 'server'], opts);
      const file = /^socket: (.+)$/m.exec(stdout)?.[1];
      if (!/^compatible: yes$/m.test(stdout) || !file || !path.isAbsolute(file)) return null;
      const info = await stat(file);
      return info.isSocket() && info.uid === process.getuid() ? file : null;
    } catch { return null; }
  };

  const ready = await socket();
  if (ready) return ready;
  const proc = spawn(herdr, [...prefix, 'server'], { detached: true, stdio: 'ignore', env: opts.env });
  let failed = false;
  proc.on('error', () => { failed = true; });
  proc.unref();
  for (let i = 0; i < 25 && !failed; ++i) {
    await delay(200);
    const ready = await socket();
    if (ready) return ready;
  }
  throw fail();
}

export async function herdrFolder(value) {
  const home = os.homedir();
  const checked = checkRead(value, home);
  if (checked.level !== SAFE) throw new JarvisError('Essa pasta é protegida.', 'That folder is protected.');
  try {
    if (!(await stat(checked.path)).isDirectory()) throw new Error();
    await access(checked.path);
    return checked.path;
  } catch {
    throw new JarvisError('Pasta do Herdr não encontrada.', 'Herdr folder not found.');
  }
}

export async function sendHerdr({ provider, text, cwd, session = 'jarvis' }, { find = executable, connect = server, call = herdrCall, readyMs = 20_000 } = {}) {
  if (!Object.hasOwn(providers, provider) || !sessionName.test(session) || !text || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw fail();
  const folder = await herdrFolder(cwd);
  const [herdr, agent] = await Promise.all([find('herdr'), find(providers[provider])]);
  if (!herdr || !agent) throw new JarvisError('Herdr ou o agente escolhido não está instalado.', 'Herdr or the selected agent is not installed.');
  const socket = await connect(herdr, session);
  const started = await call(socket, 'agent.start', {
    name: 'Jarvis ' + provider + ' ' + randomUUID().slice(0, 6), cwd: folder, argv: [agent], focus: false,
  });
  const pane = started.agent?.pane_id;
  const terminal = started.agent?.terminal_id;
  if (started.type !== 'agent_started' || !paneId.test(pane ?? '') || !terminalId.test(terminal ?? '')) throw fail();

  // Only paste after the provider reports idle in the exact pane we just started.
  // Startup/login dialogs and a disappearing pane must never receive the task.
  const deadline = Date.now() + readyMs;
  let info;
  do {
    const result = await call(socket, 'pane.get', { pane_id: pane });
    info = result.pane;
    if (info?.terminal_id !== terminal) throw fail();
    if (info.agent_status === 'idle') break;
    if (info.agent_status === 'blocked') break;
    await delay(250);
  } while (Date.now() < deadline);
  if (info?.agent_status !== 'idle') {
    throw new JarvisError('O agente abriu no Herdr, mas não ficou pronto. Confira o login ou a tela inicial na sessão ' + session + '.', 'The agent opened in Herdr but is not ready. Check its login or startup screen in session ' + session + '.');
  }
  const input = 'Task from Jarvis: ' + text.trim().replace(/\s*\n\s*/g, ' ');
  const result = await call(socket, 'pane.send_input', { pane_id: pane, text: input, keys: ['Enter'] });
  if (result.type !== 'ok') throw fail();
  return { pane, terminal, session };
}
