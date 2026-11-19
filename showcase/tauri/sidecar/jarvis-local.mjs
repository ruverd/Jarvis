import { access, open as openFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SAFE, checkRead, checkOpen } from './safety.mjs';
import { GIT_SAFE } from './tools.mjs';
import { JarvisError, runFile } from './jarvis-work.mjs';

const home = os.homedir();
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const simple = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
const protectedLocation = (p) => checkRead(p, home).level !== SAFE || /(?:^|\/)(?:\.git|\.ssh|Keychains|node_modules)(?:\/|$)/i.test(p);
const allowedRoot = async (value) => {
  const local = checkRead(value, home, { recursive: true });
  if (local.level !== SAFE) return null;
  try {
    const dir = await realpath(local.path);
    return !protectedLocation(dir) && dir !== home && (await stat(dir)).isDirectory() ? dir : null;
  } catch { return null; }
};
export async function repoRoots(values = [path.join(home, 'Developer')]) {
  return [...new Set((await Promise.all(values.slice(0, 8).map(allowedRoot))).filter(Boolean))];
}

async function isRepo(dir) {
  try { await access(path.join(dir, '.git')); return true; } catch { return false; }
}

async function candidate(name, root, depth) {
  if (norm(path.basename(root)) === name && await isRepo(root)) return [root];
  if (!depth || await isRepo(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !protectedLocation(e.name)).slice(0, 150);
  return (await Promise.all(dirs.map((e) => candidate(name, path.join(root, e.name), depth - 1)))).flat();
}

export async function findRepos(term, roots) {
  const dirs = await repoRoots(roots);
  if (term.startsWith('/') || term.startsWith('~/')) {
    const p = await allowedRoot(term);
    return p && dirs.some((root) => inside(root, p)) && await isRepo(p) ? [p] : [];
  }
  if (!term || term.length > 120 || /[\x00-\x1f/\\]/.test(term)) return [];
  return [...new Set((await Promise.all(dirs.map((root) => candidate(norm(term), root, 2)))).flat())].sort();
}

const git = async (cwd, ...args) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const { stdout } = await runFile('/usr/bin/git', ['--no-optional-locks', '-C', cwd, ...args], {
    env: { ...env, ...GIT_SAFE, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    timeout: 12_000, maxBuffer: 1024 * 1024,
  });
  return stdout;
};

function remoteLabel(s) {
  const scp = /^(?:[^@\s]+@)?([a-zA-Z0-9.-]+):([A-Za-z0-9._/-]+)$/.exec(s.trim());
  if (scp) return scp[1] + '/' + scp[2].replace(/\.git$/, '');
  try {
    const u = new URL(s.trim());
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    return u.hostname + u.pathname.replace(/\.git$/, '');
  } catch { return null; }
}

async function readme(dir, entries) {
  const entry = entries.find((e) => e.isFile() && /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(e.name));
  if (!entry) return null;
  const file = await realpath(path.join(dir, entry.name)).catch(() => null);
  if (!file || !inside(dir, file) || protectedLocation(file)) return null;
  const handle = await openFile(file).catch(() => null);
  if (!handle) return null;
  try {
    const bytes = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(bytes);
    const lines = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    const title = simple(lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '')).slice(0, 100);
    const plain = [];
    let fenced = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      const body = line.trim().replace(/^[-*+]\s+/, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1');
      if (fenced || !/^[\p{L}\p{N}]/u.test(body) || /(?:token|secret|password|api[_ -]?key)\s*[:=]|\b(?:xox[baprs]-|lin_api_)/iu.test(body)) continue;
      plain.push(simple(body).slice(0, 240));
      if (plain.length === 2) break;
    }
    return { title, summary: plain.join(' ').slice(0, 360) };
  } finally { await handle.close(); }
}

export async function describeRepo(dir) {
  const top = await git(dir, 'rev-parse', '--show-toplevel');
  if (await realpath(top.trim()) !== dir) throw new JarvisError('O caminho não é raiz de um repositório.', 'The path is not a repository root.');
  const [status, remote, entries] = await Promise.all([
    git(dir, 'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all'),
    git(dir, 'remote', 'get-url', 'origin').catch(() => ''),
    readdir(dir, { withFileTypes: true }),
  ]);
  const [head, ...records] = status.split('\0');
  const structure = entries.filter((e) => !e.name.startsWith('.') && !protectedLocation(e.name) &&
    (e.isDirectory() || /^(?:README|LICENSE|package\.json|Cargo\.toml|pyproject\.toml|go\.mod|Makefile|[^/]+\.sln)/i.test(e.name)))
    .slice(0, 16).map((e) => simple(e.name) + (e.isDirectory() ? '/' : ''));
  return {
    dir, name: path.basename(dir), branch: simple(head?.replace(/^##\s+/, '')), remote: remoteLabel(remote), structure,
    changed: records.filter((record) => /^[ MADRCU?!]{2} /.test(record)).length,
    readme: await readme(dir, entries),
  };
}

const searchRoots = () => ['Desktop', 'Documents', 'Downloads'].map((name) => path.join(home, name));
function normalizedFile(term) {
  if (!term.startsWith('/') && !term.startsWith('~/')) return null;
  return checkRead(term, home).path;
}

async function indexedOrLocal(root, term, query) {
  const { stdout } = await runFile('/usr/bin/mdfind', ['-0', '-onlyin', root, query], {
    timeout: 4000, maxBuffer: 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const indexed = stdout.split('\0').filter(Boolean).slice(0, 60);
  if (indexed.some((file) => norm(path.basename(file)) === norm(term) || norm(path.parse(file).name) === norm(term))) return indexed;

  const matches = new Set(indexed);
  const folders = [{ dir: root, depth: 0 }];
  const wanted = norm(term);
  const deadline = Date.now() + 2500;
  const maxDirectories = 1500;
  for (let at = 0; at < folders.length && at < maxDirectories && Date.now() < deadline; at++) {
    const { dir, depth } = folders[at];
    const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const candidate = path.join(dir, item.name);
      if (item.isDirectory() && depth < 6 && folders.length < maxDirectories) folders.push({ dir: candidate, depth: depth + 1 });
      if (item.isFile() && norm(item.name).includes(wanted)) matches.add(candidate);
      if (matches.size >= 60) break;
    }
    if (matches.size >= 60) break;
  }
  return [...matches];
}

export async function findLocalFiles(term, settings) {
  if (!term || term.length > 1024 || /[\x00-\x1f\x7f]/.test(term)) return [];
  const explicit = normalizedFile(term);
  if (explicit) {
    const file = await realpath(explicit).catch(() => null);
    return file && await safeFile(file) ? [file] : [];
  }
  const roots = settings ?? searchRoots();
  const query = 'kMDItemFSName == "*' + term.replace(/[\\"*?\[\]]/g, (char) => '\\' + char) + '*"cd';
  const found = new Set();
  for (const root of await repoRoots(roots)) {
    for (const p of await indexedOrLocal(root, term, query)) {
      if (!p || !inside(root, p) || protectedLocation(p)) continue;
      const file = await realpath(p).catch(() => null);
      if (file && inside(root, file) && await safeFile(file)) found.add(file);
      if (found.size >= 12) break;
    }
  }
  const files = [...found].sort();
  const exact = files.filter((file) => norm(path.basename(file)) === norm(term) || norm(path.parse(file).name) === norm(term));
  return exact.length ? exact : files;
}

export async function safeFile(file) {
  if (protectedLocation(file) || /\.(?:app|pkg|dmg|command|exe|bat|sh|js|ps1|workflow|scpt|webloc|url|html?)$/i.test(file)) return false;
  try { const s = await stat(file); return s.isFile() && checkOpen(file, home, { executable: !!(s.mode & 0o111) }).level === SAFE; } catch { return false; }
}
