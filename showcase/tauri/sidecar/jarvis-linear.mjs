import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cliEnv, executable, JarvisError, nextIssue, readLinear } from './jarvis-work.mjs';

const missing = () => new JarvisError(
  'O MCP Linear do Codex não confirmou acesso. Conecte o Linear no Codex ou salve uma chave de leitura no painel Jarvis.',
  'Codex Linear MCP did not confirm access. Connect Linear in Codex or save a read-only key in the Jarvis panel.',
);
const linearUrl = 'https://mcp.linear.app/mcp';
const endpoint = (entry) => entry?.url?.replace(/\/$/, '') === linearUrl && entry.enabled !== false;

function appServer(binary, cwd) {
  const child = spawn(binary, ['app-server'], { cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  const queue = new Map();
  let seq = 0, closed = false;
  const notify = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  function close() {
    if (closed) return;
    closed = true;
    child.kill();
    for (const job of queue.values()) { clearTimeout(job.timer); job.reject(missing()); }
    queue.clear();
  }
  child.on('error', close);
  child.on('exit', close);
  child.stdin.on('error', close);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id != null) {
      notify({ id: msg.id, error: { code: -32601, message: 'Jarvis performs read-only MCP lookups.' } });
      return;
    }
    const job = queue.get(msg.id);
    if (!job) return;
    queue.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.error) job.reject(missing());
    else job.resolve(msg.result);
  });
  return {
    close,
    notify,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (closed) return reject(missing());
        const id = ++seq;
        const timer = setTimeout(() => { queue.delete(id); reject(missing()); }, 15_000);
        queue.set(id, { resolve, reject, timer });
        notify({ id, method, params });
      });
    },
  };
}

function unpack(result) {
  if (result?.isError) throw missing();
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(result.content.find((x) => x.type === 'text').text); }
  catch { throw missing(); }
}

export async function readCodexLinear(cwd) {
  const binary = await executable('codex');
  if (!binary) throw missing();
  const client = appServer(binary, cwd);
  try {
    await client.request('initialize', { clientInfo: { name: 'jarvis', title: 'Jarvis', version: '1.0' } });
    client.notify({ method: 'initialized' });
    const { config } = await client.request('config/read', { cwd, includeLayers: false });
    if (!endpoint(config?.mcp_servers?.linear)) throw missing();
    const servers = Object.fromEntries(Object.keys(config.mcp_servers).map((name) =>
      [name, name === 'linear' ? { enabled: true, url: linearUrl } : { enabled: false }],
    ));
    // No model turn is started. The ephemeral thread only carries the user's existing Linear OAuth connection.
    const { thread } = await client.request('thread/start', {
      cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', config: { mcp_servers: servers },
    });
    const threadId = thread?.id;
    if (!threadId) throw missing();
    const status = await client.request('mcpServerStatus/list', { threadId, serverName: 'linear', detail: 'toolsAndAuthOnly' });
    if (!status.data?.some((s) => s.name === 'linear' && s.authStatus === 'oAuth' && s.tools?.get_user && s.tools?.list_issues)) throw missing();
    const read = async (tool, args) => unpack(await client.request('mcpServer/tool/call', { threadId, server: 'linear', tool, arguments: args }));
    const viewer = await read('get_user', { query: 'me' });
    if (!viewer?.id) throw missing();
    const issues = [];
    for (const state of ['started', 'unstarted']) {
      let cursor;
      const seen = new Set();
      do {
        const page = await read('list_issues', {
          assignee: 'me', state, includeArchived: false, limit: 50, orderBy: 'updatedAt',
          fields: ['id', 'title', 'status', 'statusType', 'url', 'priority', 'updatedAt'],
          ...(cursor ? { cursor } : {}),
        });
        for (const issue of page.issues ?? []) {
          if (issue.statusType !== state || !issue.id || !issue.url) continue;
          issues.push({ ...issue, identifier: issue.id, sortOrder: -(Date.parse(issue.updatedAt) || 0), state: { name: issue.status, type: state } });
        }
        if (!page.hasNextPage) break;
        cursor = page.cursor;
        if (!cursor || seen.has(cursor) || seen.size >= 20) throw missing();
        seen.add(cursor);
      } while (cursor);
      if (issues.length) break;
    }
    return { viewer, issue: nextIssue(issues), order: 'updated' };
  } finally { client.close(); }
}

export async function readJarvisLinear(getKey, cwd) {
  const key = await getKey();
  return key ? readLinear(() => key) : readCodexLinear(cwd);
}
