import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SAFE, checkLink } from './safety.mjs';

export const runFile = promisify(execFile);
export const cliEnv = () => ({
  ...process.env,
  PATH: [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':'),
});

export async function executable(name) {
  for (const dir of cliEnv().PATH.split(':').filter(path.isAbsolute)) {
    const file = path.join(dir, name);
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  return null;
}

const slug = /^[a-z0-9][a-z0-9-]{0,78}$/i;
export function slackTarget(value) {
  if (typeof value !== 'string' || checkLink(value).level !== SAFE) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname)) return null;
  const app = /^\/client\/(T[A-Z0-9]+)\/([CG][A-Z0-9]+)\/?$/.exec(url.pathname);
  if (url.hostname === 'app.slack.com' && app) return { id: app[2], ts: null, parent: null, team: app[1], host: url.hostname, url: url.origin + url.pathname };
  const m = /^\/(archives|messages)\/([CG][A-Z0-9]+)(?:\/p(\d{16}))?\/?$/.exec(url.pathname);
  if (!m) return null;
  const ts = m[3] ? m[3].slice(0, 10) + '.' + m[3].slice(10) : null;
  const parent = url.searchParams.get('thread_ts');
  if (parent && (!ts || !/^\d{10}\.\d{6}$/.test(parent) || parent > ts)) return null;
  return { id: m[2], ts, parent, host: url.hostname, url: url.origin + url.pathname + (parent ? '?thread_ts=' + parent : '') };
}

export class JarvisError extends Error {
  constructor(pt, en) { super(en); this.pt = pt; }
}

export function createSlack({ getToken, request = fetch }) {
  async function api(method, token, args = {}) {
    const response = await request('https://slack.com/api/' + method, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(args),
    });
    if (!response.ok) throw new JarvisError('Slack retornou HTTP ' + response.status, 'Slack returned HTTP ' + response.status);
    return response.json();
  }

  const requireOK = (r) => {
    if (r.ok) return r;
    const code = /^[a-z_]{1,50}$/.test(r.error) ? r.error : 'unknown_error';
    throw new JarvisError('Slack recusou a operação (' + code + ').', 'Slack rejected the operation (' + code + ').');
  };

  async function identity() {
    const token = await getToken();
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(token ?? '')) throw new JarvisError('Cadastre o token do bot Slack no painel Jarvis.', 'Add a Slack bot token in the Jarvis panel.');
    const auth = requireOK(await api('auth.test', token));
    if (!auth.bot_id || !auth.user || !auth.team_id) throw new JarvisError('Slack não confirmou uma identidade de bot.', 'Slack did not confirm a bot identity.');
    return { token, auth };
  }

  return {
    async verify() { const { auth } = await identity(); return auth.user; },
    async resolve(target) {
      const { token, auth } = await identity();
      if (target.team ? target.team !== auth.team_id : new URL(auth.url).hostname !== target.host) {
        throw new JarvisError('Esse link é de outro workspace do Slack.', 'That link belongs to another Slack workspace.');
      }
      const info = await api('conversations.info', token, { channel: target.id });
      const channel = info.ok ? info.channel : null;
      if (!channel && info.error !== 'missing_scope') requireOK(info);
      if (channel?.is_archived) throw new JarvisError('O canal está arquivado.', 'That channel is archived.');
      let thread = null;
      if (target.ts) {
        const ts = target.parent ?? target.ts;
        const result = await api('conversations.history', token, { channel: target.id, latest: ts, oldest: ts, inclusive: 'true', limit: '1' });
        const root = result.ok && result.messages?.find((m) => m.ts === ts);
        if (root) thread = root.ts;
        else {
          const replies = requireOK(await api('conversations.replies', token, { channel: target.id, ts, limit: '1' }));
          const first = replies.messages?.[0];
          if (first?.ts === ts) thread = first.thread_ts ?? first.ts;
        }
        if (!thread) throw new JarvisError('Não consegui verificar a mensagem raiz. Copie o link da mensagem original.', 'I could not verify the parent message. Copy the original message link.');
        if (target.parent && target.parent !== target.ts) {
          const replies = requireOK(await api('conversations.replies', token, { channel: target.id, ts: thread, latest: target.ts, oldest: target.ts, inclusive: 'true', limit: '2' }));
          if (!replies.messages?.some((m) => m.ts === target.ts && m.thread_ts === thread)) {
            throw new JarvisError('A resposta indicada não pôde ser verificada nessa thread. Use o link da mensagem original.', 'That reply could not be verified in this thread. Use the original message link.');
          }
        }
      } else if (!channel) requireOK(await api('conversations.history', token, { channel: target.id, limit: '1' }));
      return { channel: channel?.name ? '#' + channel.name : target.id, thread, user: auth.user, team: auth.team_id, bot: auth.bot_id };
    },
    async send(target, review, text) {
      const { token, auth } = await identity();
      if (auth.bot_id !== review.bot || auth.team_id !== review.team) throw new JarvisError('A identidade mudou. Revise a mensagem novamente.', 'The bot identity changed. Review the message again.');
      const posted = requireOK(await api('chat.postMessage', token, {
        channel: target.id, text, ...(review.thread ? { thread_ts: review.thread } : {}),
        mrkdwn: 'false', unfurl_links: 'false', unfurl_media: 'false',
      }));
      if (posted.channel !== target.id || !/^\d{10}\.\d{6}$/.test(posted.ts)) throw new JarvisError('Slack não confirmou o destino do envio. Verifique antes de tentar de novo.', 'Slack did not confirm the destination. Check before retrying.');
      return new URL('/archives/' + posted.channel + '/p' + posted.ts.replace('.', ''), auth.url).href;
    },
  };
}

export function githubTarget(value) {
  const m = /^(?:https:\/\/github\.com\/)?([a-z0-9_.-]+)\/([a-z0-9_.-]+)(?:(?:\/pull\/|#)([1-9][0-9]*))?\/?$/i.exec(value ?? '');
  if (!m || !slug.test(m[1]) || ['.', '..'].includes(m[2]) || m[2].startsWith('-')) return null;
  return { repo: m[1] + '/' + m[2], number: m[3] ?? null };
}

export async function readGitHub(target, gh = executable) {
  const binary = await gh('gh');
  if (!binary) throw new JarvisError('GitHub CLI não encontrado.', 'GitHub CLI was not found.');
  const fields = 'number,title,state,isDraft,url';
  const args = target.number
    ? ['pr', 'view', target.number, '--json', fields + ',statusCheckRollup,headRefOid']
    : ['pr', 'list', '--state', 'open', '--limit', '10', '--json', fields];
  try {
    const { stdout } = await runFile(binary, [...args, '--repo', 'github.com/' + target.repo], { env: { ...cliEnv(), GH_PROMPT_DISABLED: '1' }, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { throw new JarvisError('GitHub não retornou o PR ou o repositório. Verifique o acesso da conta no gh.', 'GitHub could not read that PR or repository. Check the account access in gh.'); }
}

// A Linear priority of 0 is unset. Position is a tie breaker only after priority.
export function nextIssue(issues) {
  const priority = (issue) => {
    const value = Number(issue.priority);
    return Number.isInteger(value) && value > 0 ? value : ({ urgent: 1, high: 2, medium: 3, normal: 3, low: 4 })[String(issue.priority).toLowerCase()] ?? Infinity;
  };
  const position = (issue) => Number.isFinite(issue.sortOrder) ? issue.sortOrder : Infinity;
  const stage = (issue) => ({ started: 0, unstarted: 1 }[issue.state?.type] ?? Infinity);
  return issues.filter((i) => !i.archivedAt && Number.isFinite(stage(i))).sort((a, b) =>
    stage(a) - stage(b) || priority(a) - priority(b) || position(a) - position(b) || a.identifier.localeCompare(b.identifier)
  )[0] ?? null;
}

export async function readLinear(getKey, request = fetch) {
  const key = await getKey();
  if (!key) throw new JarvisError('Cadastre uma chave de leitura do Linear no painel Jarvis.', 'Add a Linear read-only key in the Jarvis panel.');
  async function query(query, variables = {}) {
    const response = await request('https://api.linear.app/graphql', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok || body.errors?.length || !body.data) throw new JarvisError('Linear recusou a consulta. Verifique a chave e suas permissões de leitura.', 'Linear rejected the query. Check the key and its read permissions.');
    return body.data;
  }
  const { viewer } = await query('query JarvisViewer { viewer { id name } }');
  if (!viewer?.id) throw new JarvisError('Linear não retornou a identidade autenticada.', 'Linear did not return the authenticated identity.');
  const issues = [];
  let after = null;
  const seen = new Set();
  do {
    const { issues: page } = await query(`query JarvisAssigned($id: ID!, $after: String) {
      issues(first: 100, after: $after, filter: { assignee: { id: { eq: $id } }, state: { type: { in: ["started", "unstarted"] } } }) {
        nodes { id identifier title url priority priorityLabel sortOrder archivedAt state { name type } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { id: viewer.id, after });
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after || seen.has(after) || seen.size >= 20) throw new JarvisError('Linear retornou uma lista parcial de tarefas.', 'Linear returned a partial task list.');
    seen.add(after);
  } while (after);
  return { viewer, issue: nextIssue(issues) };
}
