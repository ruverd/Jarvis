import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createJarvis, parseJarvis, requestLanguage } from '../jarvis.mjs';
import { createSlack, githubTarget, nextIssue, readLinear, slackTarget } from '../jarvis-work.mjs';
import { sendHerdr } from '../jarvis-herdr.mjs';
import { createTeamsAudio } from '../jarvis-audio.mjs';
import { dataPaths } from '../datadir.mjs';
import { BLOCK, checkRead, checkWrite } from '../safety.mjs';

const msg = 'https://example.slack.com/archives/C123/p1700000000001234';
const auth = { ok: true, url: 'https://example.slack.com/', user: 'test_bot', bot_id: 'B123', team_id: 'T123' };
assert.deepEqual(parseJarvis('Qual é a próxima task que eu tenho?'), { kind: 'linear' });
assert.deepEqual(parseJarvis("What's my next task?"), { kind: 'linear' });
assert.deepEqual(parseJarvis('Mande uma tarefa para o Herdr com Claude em /tmp: testar a tela'), { kind: 'herdr', provider: 'claude', cwd: '/tmp', text: 'testar a tela' });
assert.deepEqual(parseJarvis('Jarvis, diga no Teams: bom dia, pessoal'), { kind: 'teamsSay', text: 'bom dia, pessoal' });
assert.deepEqual(parseJarvis('Responda no Slack com valeu!'), { kind: 'slackReply', text: 'valeu!' });
assert.equal(parseJarvis('Explique como enviar uma tarefa ao Herdr'), null);
assert.equal(requestLanguage('Mostre meus dados'), 'pt');
assert.equal(requestLanguage('No problem, show my task'), 'en');
assert.equal(requestLanguage('No problem', 'pt'), 'pt');
assert.equal(requestLanguage('Em inglês, explique o resultado'), 'en');
assert.equal(requestLanguage('Good morning', 'auto', 'pt-BR'), 'en');
assert.equal(slackTarget(msg).ts, '1700000000.001234');
assert.equal(slackTarget('https://app.slack.com/client/T123/C123').team, 'T123');
assert.equal(slackTarget('https://example.slack.com.evil.test/archives/C1'), null);
assert.equal(slackTarget('https://a:b@example.slack.com/archives/C1'), null);
assert.equal(slackTarget('https://example.slack.com/archives/C1?thread_ts=9999999999.000000'), null);
assert.deepEqual(githubTarget('https://github.com/owner/project/pull/46'), { repo: 'owner/project', number: '46' });
assert.equal(githubTarget('https://github.com.evil.test/owner/repo'), null);

const a = { identifier: 'A', state: { type: 'started' }, priority: 0, sortOrder: 1 };
const b = { identifier: 'B', state: { type: 'unstarted' }, priority: 1, sortOrder: 0 };
const c = { identifier: 'C', state: { type: 'started' }, priority: 2, sortOrder: 2 };
const d = { identifier: 'D', state: { type: 'started' }, priority: 'High', sortOrder: 1 };
assert.equal(nextIssue([a, b, c, d]), d);
assert.equal(nextIssue([{ ...a, archivedAt: '2026-11-19' }, b]), b);
assert.equal(nextIssue([{ identifier: 'E', state: { type: 'backlog' }, priority: 1 }]), null);

let page = 0;
const linear = await readLinear(() => 'fixture', async (url, opts) => {
  assert.equal(url, 'https://api.linear.app/graphql');
  const body = JSON.parse(opts.body);
  assert.match(body.query, /^query Jarvis/);
  if (body.query.includes('JarvisViewer')) return Response.json({ data: { viewer: { id: 'me', name: 'Tester' } } });
  assert.equal(body.variables.id, 'me');
  assert.equal(body.variables.after, page === 0 ? null : '2');
  return Response.json({ data: { issues: ++page === 1
    ? { nodes: [a, b], pageInfo: { hasNextPage: true, endCursor: '2' } }
    : { nodes: [c], pageInfo: { hasNextPage: false, endCursor: null } } } });
});
assert.equal(linear.issue.identifier, 'C');

let posted = 0, confirmation, authInUse = auth;
const request = async (url, opts) => {
  assert.equal(new URL(url).hostname, 'slack.com');
  assert.equal(opts.headers.Authorization, 'Bearer xoxb-fixture');
  const action = url.split('/').at(-1);
  if (action === 'auth.test') return Response.json(authInUse);
  if (action === 'conversations.info') return Response.json({ ok: false, error: 'missing_scope' });
  if (action === 'conversations.history') {
    assert.equal(opts.body.get('channel'), 'C123');
    assert.equal(opts.body.get('inclusive'), 'true');
    return Response.json({ ok: true, messages: [{ ts: '1700000000.001234' }] });
  }
  assert.equal(action, 'chat.postMessage');
  assert.equal(opts.body.get('channel'), 'C123');
  assert.equal(opts.body.get('thread_ts'), '1700000000.001234');
  assert.equal(opts.body.get('text'), 'See you soon.');
  posted++;
  return Response.json({ ok: true, channel: 'C123', ts: '1700000200.001234' });
};
const client = createSlack({ getToken: () => 'xoxb-fixture', request });
await assert.rejects(client.resolve(slackTarget('https://wrong.slack.com/archives/C123')), /another Slack workspace/);
const make = (approve) => createJarvis({
  prefs: {}, save() {}, secrets: { get: () => 'xoxb-fixture' }, dataDir: os.tmpdir(),
  open() {}, confirm: async (review) => { confirmation = review; return approve; }, deps: { slack: { request } },
});
const command = parseJarvis('/slack reply ' + msg + ': See you soon.');
await make(false).dispatch(command, 'en');
assert.equal(confirmation.text, 'See you soon.');
assert.equal(confirmation.as, 'test_bot');
assert.equal(confirmation.url, msg);
assert.equal(posted, 0);
const sent = await make(true).dispatch(command, 'en');
assert.equal(posted, 1);
assert.equal(sent.links[0].url, 'https://example.slack.com/archives/C123/p1700000200001234');
const review = await client.resolve(slackTarget(msg));
authInUse = { ...auth, bot_id: 'B456' };
await assert.rejects(client.send(slackTarget(msg), review, 'See you soon.'), /identity changed/);
assert.equal(posted, 1);

const tmp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-test-'));
try {
  assert.equal(dataPaths({ ROAMIES_APP_NAME: 'Jarvis', ROAMIES_DATA_DIR: tmp }).root, path.join(tmp, 'Jarvis'));
  assert.equal(dataPaths({ ROAMIES_DATA_DIR: tmp }).root, path.join(tmp, 'Roamies'));
  assert.equal(checkRead('~/Jarvis/Data/auth.json', tmp).level, BLOCK);
  assert.equal(checkWrite('~/Jarvis/Data/settings.json', tmp).level, BLOCK);
  const calls = [];
  const fake = async (_socket, method, params) => {
    calls.push({ method, params });
    if (method === 'agent.start') return { type: 'agent_started', agent: { pane_id: 'w1:p1', terminal_id: 'term_test123' } };
    if (method === 'pane.get') return { pane: { terminal_id: 'term_test123', agent_status: 'idle' } };
    return { type: 'ok' };
  };
  const deps = { find: (n) => '/mock/' + n, connect: () => 'test-socket', call: fake };
  const handoff = await sendHerdr({ provider: 'cursor', cwd: tmp, text: 'Read this.\nNo edits.' }, deps);
  assert.equal(handoff.pane, 'w1:p1');
  assert.deepEqual(calls[0].params.argv, ['/mock/cursor-agent']);
  assert.equal(calls.at(-1).params.text, 'Task from Jarvis: Read this. No edits.');
  assert.deepEqual(calls.at(-1).params.keys, ['Enter']);
  await assert.rejects(sendHerdr({ provider: 'cursor', cwd: tmp, text: 'press\x1b[confirmed' }, deps));
} finally { await rm(tmp, { recursive: true, force: true }); }

let words;
const team = createTeamsAudio({ synth: async (text, lang) => { words = [text, lang]; return Buffer.from('test'); } });
try {
  await assert.rejects(team.speak('Test', 'en'), /Enable audio/);
  const url = await team.open();
  const origin = new URL(url).origin;
  const html = await fetch(url);
  assert.match(html.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.equal((await fetch(origin + '/events')).status, 404);
  const stream = await fetch(url + 'events');
  const reader = stream.body.getReader();
  await reader.read();
  const playback = team.speak('Bom dia.', 'pt');
  const event = new TextDecoder().decode((await reader.read()).value);
  const audioId = /data: ([0-9a-f-]+)/.exec(event)[1];
  assert.deepEqual(words, ['Jarvis falando. Bom dia.', 'pt']);
  assert.equal(await (await fetch(url + 'audio/' + audioId)).text(), 'test');
  assert.equal((await fetch(url + 'ack/' + audioId + '/played', { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 404);
  assert.equal((await fetch(url + 'ack/' + audioId + '/played', { method: 'POST', headers: { Origin: origin } })).status, 204);
  assert.equal(await playback, true);
  await reader.cancel();
} finally { team.close(); }

console.log('Jarvis: command, confirmation, read-only service, isolation and audio transport tests passed');

const { calendarDraft, calendarFile, mailDraft } = await import('../jarvis-desktop.mjs');
const { describeRepo, findRepos, findLocalFiles } = await import('../jarvis-local.mjs');
const { writeFile, mkdir, symlink } = await import('node:fs/promises');
const { runFile } = await import('../jarvis-work.mjs');
assert.deepEqual(parseJarvis('Jarvis, explica o repositório Example'), { kind: 'repo', target: 'Example' });
assert.deepEqual(parseJarvis('Esse trecho tá ruim, reescreve para mim'), { kind: 'rewrite', replace: true });
assert.deepEqual(parseJarvis('Suggest a rewrite for the selection'), { kind: 'rewrite', replace: false });
assert.deepEqual(parseJarvis('Abra o arquivo teste.pdf'), { kind: 'file', target: 'teste.pdf' });
assert.deepEqual(parseJarvis('Agende revisão amanhã às 14:30'), { kind: 'calendar', text: 'revisão amanhã às 14:30' });
assert.deepEqual(parseJarvis('Escreva e-mail para x@example.test | assunto | corpo'), { kind: 'email', text: 'x@example.test | assunto | corpo' });
assert.equal(mailDraft('x@example.test | Olá | teste com & ou ?').url, 'mailto:x@example.test?subject=Ol%C3%A1&body=teste%20com%20%26%20ou%20%3F');
assert.equal(mailDraft('x arroba example ponto test, assunto Teste, mensagem Olá').recipients[0], 'x@example.test');
assert.equal(mailDraft('x@example.test?bcc=y@other.test | Teste | Olá'), null);
const date = new Date(2026, 10, 19, 10, 0);
const event = calendarDraft('amanhã 14:30 45m: Revisão | x@example.test', date);
assert.equal(new Date(event.start).getHours(), 14);
assert.equal(new Date(event.start).getMinutes(), 30);
assert.equal(+new Date(event.end) - +new Date(event.start), 45 * 60_000);
assert.match(calendarFile(event), /SUMMARY:Revisão\r\nATTENDEE:mailto:x@example.test\r\n/);
assert.equal(calendarDraft('2026-11-31 10:00: Invalid', date), null);

let replacements = 0, savedEvents = 0, destinations = [], readOrigin;
const native = (approve) => createJarvis({
  prefs: {}, save() {}, secrets: { get: () => null }, dataDir: '/tmp',
  open: (url) => { destinations.push(url); },
  confirm: async (r) => { confirmation = r; return approve; },
  rewrite: {
    read: (lang, origin) => {
      readOrigin = origin;
      return { pid: 12, stamp: 'old', target: 'Test editor', text: 'Edited line.' };
    },
    apply: () => { replacements++; return { ok: true }; },
  },
  deps: { createCalendarEntry: () => { savedEvents++; return { saved: false }; } },
});
assert.equal((await native(true).dispatch({ kind: 'rewrite', replace: false }, 'en')).text, 'Edited line.');
assert.equal(readOrigin, undefined);
const editorOrigin = { ok: true, pid: 12, windowID: 34 };
await native(false).dispatch({ kind: 'rewrite', replace: true }, 'en', editorOrigin);
assert.deepEqual(readOrigin, editorOrigin);
assert.equal(replacements, 0);
assert.equal(confirmation.text, 'Edited line.');
assert.match((await native(true).dispatch({ kind: 'rewrite', replace: true }, 'en')).text, /Command-Z/);
assert.equal(replacements, 1);
await native(true).dispatch({ kind: 'email', text: 'x@example.test | Test | Body' }, 'en');
assert.equal(destinations[0], 'mailto:x@example.test?subject=Test&body=Body');
await native(false).dispatch({ kind: 'calendar', text: 'tomorrow 18:00: Test event' }, 'en');
assert.equal(savedEvents, 0);
assert.match((await native(true).dispatch({ kind: 'calendar', text: 'tomorrow 18:00: Test event' }, 'en')).text, /for import/);
assert.equal(savedEvents, 1);

if (process.platform !== 'win32') {
  const repoBase = await mkdtemp(path.join(os.tmpdir(), 'jarvis-repos-'));
  try {
    const repo = path.join(repoBase, 'group', 'Example');
    await mkdir(repo, { recursive: true });
    await runFile('/usr/bin/git', ['init', '-q', repo]);
    await runFile('/usr/bin/git', ['-C', repo, 'remote', 'add', 'origin', 'https://example:fixture@example.test/owner/project.git?secret=no']);
    await writeFile(path.join(repo, 'README.md'), '# Synthetic\n\nThe test data lives in this repository.\npassword=fixture-secret\n');
    await writeFile(path.join(repo, '.env'), 'NO_PRINT=true');
    await mkdir(path.join(repo, 'src'));
    const dirs = await findRepos('example', [repoBase]);
    assert.equal(dirs.length, 1);
    const first = await describeRepo(dirs[0]);
    assert.equal(first.name, 'Example');
    assert.equal(first.remote, 'example.test/owner/project');
    assert.equal(first.readme.summary, 'The test data lives in this repository.');
    assert.ok(first.structure.includes('src/'));
    assert.ok(!first.structure.includes('.env'));
    assert.deepEqual(await findLocalFiles(path.join(repo, '.env')), []);
    await mkdir(path.join(repoBase, 'second', 'Example'), { recursive: true });
    await runFile('/usr/bin/git', ['init', '-q', path.join(repoBase, 'second', 'Example')]);
    const candidates = await findRepos('example', [repoBase]);
    assert.equal(candidates.length, 2);
    await symlink(repo, path.join(repoBase, 'Alias'));
    assert.deepEqual(await findRepos('Alias', [repoBase]), []);
    assert.deepEqual(await findRepos('/private/tmp', [repoBase]), []);
  } finally { await rm(repoBase, { recursive: true, force: true }); }
}

console.log('Jarvis: repository, file, calendar, draft and selection tests passed');
