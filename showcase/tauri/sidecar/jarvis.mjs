import { randomUUID } from 'node:crypto';
import { createSlack, githubTarget, JarvisError, readGitHub, slackTarget } from './jarvis-work.mjs';
import { herdrFolder, providers, sendHerdr } from './jarvis-herdr.mjs';
import { readJarvisLinear } from './jarvis-linear.mjs';
import { createTeamsAudio } from './jarvis-audio.mjs';
import { describeRepo, findLocalFiles, findRepos, safeFile } from './jarvis-local.mjs';
import { calendarDraft, createCalendarEntry, mailDraft } from './jarvis-desktop.mjs';

export const SLACK_KEY = 'jarvis-slack-bot';
export const LINEAR_KEY = 'jarvis-linear';
const MAX_TEXT = 2000;
const slash = /^\/(herdr|slack|teams|github|linear|idioma|language|repo|arquivo|file|agenda|calendar|email|mail|rewrite)\b/i;
const wordsPT = /(?:[ãõçáéíóúâêôà]|\b(abra|abrir|fale|diga|responda|envie|manda|mandar|enviar|qual|próxim[oa]|proxim[oa]|tarefa|obrigad[oa]|em português|como|porque|explique|meu|minha|você|pode|faça|analise|isso|mostre)\b)/iu;
const clean = (s) => String(s ?? '').trim();
const ptEn = (lang, pt, en) => lang === 'pt' ? pt : en;

export function requestLanguage(text, override = 'auto', transcription = null) {
  if (override === 'pt' || override === 'en') return override;
  if (/^\s*(?:in English|em ingl[eê]s)[,:\s]/iu.test(text)) return 'en';
  if (/^\s*(?:in (?:Brazilian )?Portuguese|em portugu[eê]s)[,:\s]/iu.test(text)) return 'pt';
  if (wordsPT.test(text)) return 'pt';
  if (/(?:^|\s)(?:what|why|how|explain|show|my|next|please|can|send|open|say|speak|reply|status|hello|hi|good morning|good afternoon|good evening|thanks|thank you)(?:\s|$)/iu.test(text)) return 'en';
  return transcription === 'pt-BR' ? 'pt' : 'en';
}

export function parseJarvis(raw) {
  const text = clean(raw).replace(/^(?:hey|ei|oi)\s+jarvis[,!:]?\s+|^jarvis[,!:]?\s+/iu, '');
  let m;
  if ((m = /^(?:\/(?:idioma|language)\s+|(?:responda|fale|answer|reply)\s+(?:em|in)\s+)(pt(?:-br)?|portugu[eê]s|(?:brazilian )?portuguese|en(?:-us)?|ingl[eê]s|english|auto(?:m[aá]tico)?)\s*[.!?]?$/iu.exec(text))) {
    const raw = m[1].toLowerCase();
    return { kind: 'language', lang: raw.startsWith('auto') ? 'auto' : /^(pt|portugu|brazilian)/.test(raw) ? 'pt' : 'en' };
  }
  if (/^(?:\/teams\s+stop|pare (?:de falar )?no teams|stop (?:speaking in )?teams)[.!?]?$/iu.test(text)) return { kind: 'teamsStop' };
  if (/^(?:\/teams\s+(?:open|abrir)|(?:abra|abrir|open)\s+(?:(?:a )?aba (?:de )?)?(?:[aá]udio (?:do |para )?|(?:the )?audio tab (?:for )?)teams)[.!?]?$/iu.test(text)) return { kind: 'teamsOpen' };
  if ((m = /^(?:\/teams\s+(?:say|fale)\s+|(?:fale|diga)\s+no teams\s*[:;,]?\s+|(?:say|speak)\s+(?:in|on) teams\s*[:;,]?\s+)([\s\S]+)/iu.exec(text))) return { kind: 'teamsSay', text: clean(m[1]) };
  if ((m = /^(?:\/herdr\s+|(?:(?:envie|enviar|mande|manda|mandar)\s+(?:(?:uma |a )?tarefa\s+)?(?:para |pro )?|send\s+(?:(?:a |the )?task\s+)?to )(?:(?:o )?herdr(?:\s+(?:com|via|using|with))?\s+)?)(codex|claude(?: code)?|cursor(?: agent)?)\b(?:\s+(?:em|in)\s+([^:\n]+))?\s*[:;,]?\s+([\s\S]+)/iu.exec(text))) {
    return { kind: 'herdr', provider: m[1].toLowerCase().split(' ')[0], cwd: clean(m[2]), text: clean(m[3]) };
  }
  if ((m = /^(?:\/slack\s+(?:open|abrir)\s+|(?:abra|abrir|open)\s+(?:(?:o |the )?slack\s+|(?:o )?canal (?:do |no )?slack\s+|(?:the )?slack channel\s+))([^\s]+)$/iu.exec(text))) return { kind: 'slackOpen', target: m[1] };
  if ((m = /^(?:\/slack\s+(?:reply|responder)\s+|(?:responda|responder|reply)\s+(?:(?:no|ao|in|to)\s+(?:(?:o|the)\s+)?)?slack:?\s+)(\S+?)\s*(?::\s+|\s+(?:com|with)\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'slackReply', target: m[1], text: clean(m[2]) };
  if (/^(?:\/slack\s+(?:open|abrir)|(?:abra|abrir|open)\s+(?:(?:o |the )?slack|(?:o )?canal (?:do |no )?slack))[.!?]?$/iu.test(text)) return { kind: 'slackOpen' };
  if ((m = /^(?:responda|responder|reply)\s+(?:(?:no|ao|in|to)\s+)?slack\s*(?::\s+|\s+(?:com|with)\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'slackReply', text: clean(m[1]) };
  if ((m = /^(?:\/github\s+(?:(?:pr|ci|prs)\s+)?|(?:status\s+(?:do|de|of)\s+(?:(?:ci|pr)\s+)?|(?:check|veja|consulte|liste|list|show)\s+(?:(?:os|as|the)\s+)?(?:ci|pr|prs|check runs|pull requests)(?:\s+(?:do|de|in|for|of|da))?\s+))(\S+)\??$/iu.exec(text))) return { kind: 'github', target: m[1].replace(/\?$/, '') };
  if (/^(?:\/linear(?:\s+(?:next|pr[oó]xima))?|(?:(?:qual\s+(?:[eé]\s+)?)?(?:[aà]\s+)?(?:minha\s+)?pr[oó]xim[ao]\s+(?:task|tarefa|issue)(?:\s+(?:que eu tenho|no linear|atribu[ií]da a mim))*|(?:what(?:'s| is)\s+)?(?:my|the)\s+next\s+(?:linear\s+)?(?:task|issue)(?:\s+(?:in linear|assigned to me))*))[.!?]?$/iu.test(text)) return { kind: 'linear' };
  if ((m = /^(?:\/repo\s+|(?:explica|explique|resuma|explain|describe|summarize)\s+(?:(?:o|esse|the)\s+)?(?:reposit[oó]rio|repo(?:sitory)?)\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'repo', target: clean(m[1]).replace(/[?]$/, '') };
  if ((m = /^(?:\/(?:arquivo|file)\s+|(?:abra|abre|abrir|open)\s+(?:(?:o|um|the|a)\s+)?(?:arquivo|file)\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'file', target: clean(m[1]) };
  if ((m = /^(?:\/(?:agenda|calendar)\s+|(?:agende|agenda|agendar|marque|marca|schedule)\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'calendar', text: clean(m[1]) };
  if ((m = /^(?:\/(?:email|mail)\s+|(?:escreva|escreve|redija|write|draft)\s+(?:(?:um|an|a)\s+)?(?:e-?mail)(?:\s+(?:para|to))?\s+)([\s\S]+)$/iu.exec(text))) return { kind: 'email', text: clean(m[1]) };
  if (/^(?:\/rewrite|(?:esse|este) trecho.{0,65}\b(?:reescreve|reescreva)(?: para mim)?|(?:reescreve|reescreva|melhore) (?:o |esse |este )?(?:trecho|texto|sele[cç][aã]o)(?: selecionado| para mim)?|rewrite (?:this|the) (?:text|selection|passage))[.!?]?$/iu.test(text)) return { kind: 'rewrite', replace: true };
  if (/^(?:\/rewrite suggest|(?:sugira|d[eê]) uma (?:vers[aã]o|sugest[aã]o)(?: (?:para|desse|deste) (?:o )?trecho)?|suggest a rewrite(?: for (?:this|the) selection)?)[.!?]?$/iu.test(text)) return { kind: 'rewrite', replace: false };
  if (/^\/jarvis\b/i.test(text) || slash.test(text) || /^(?:envie|enviar|mande|manda|mandar|send)\b.*\bherdr\b/iu.test(text) || /^(?:responda|responder|reply)\b.*\bslack\b/iu.test(text)) return { kind: 'help' };
  return null;
}

const compact = (text) => clean(text).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
const approvedUrl = (value, host) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === host && !u.username && !u.password && !u.port ? u.href : null;
  } catch { return null; }
};

export function createJarvis({ prefs, save, secrets, dataDir, open, confirm, hands, rewrite, deps = {} }) {
  const slack = createSlack({ getToken: () => secrets.get(SLACK_KEY), ...deps.slack });
  const audio = deps.audio ?? createTeamsAudio();
  const runHerdr = deps.sendHerdr ?? sendHerdr;
  const github = deps.readGitHub ?? readGitHub;
  const linear = deps.readLinear ?? readJarvisLinear;
  const result = (text, links = [], choices = []) => ({ text, links, choices });
  const describe = deps.describeRepo ?? describeRepo, repos = deps.findRepos ?? findRepos, files = deps.findLocalFiles ?? findLocalFiles;
  const saveEvent = deps.createCalendarEntry ?? createCalendarEntry;
  const link = (label, url) => url ? [{ label, url }] : [];
  return {
    settings: { async slack() { return slack.verify(); }, async linear() { return linear(() => secrets.get(LINEAR_KEY), dataDir); } },
    close: () => audio.close(),
    stop: () => audio.stop(),
    async dispatch(command, lang, selectionOrigin) {
      const t = (pt, en) => ptEn(lang, pt, en);
      const text = command.text;
      if (command.kind === 'teamsSay' && text?.length > 500) return result(t('Use até 500 caracteres por fala no Teams.', 'Use up to 500 characters per Teams line.'));
      if (text !== undefined && (!text || text.length > MAX_TEXT || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))) {
        return result(t('Use texto de até 2.000 caracteres.', 'Use up to 2,000 characters.'));
      }
      try {
        if (command.kind === 'repo' || command.kind === 'file') {
          const isRepo = command.kind === 'repo';
          const options = isRepo ? await repos(command.target, prefs.jarvisRepoRoots) : await files(command.target);
          if (!options.length) return result(isRepo ? t('Não achei esse repositório nas raízes configuradas.', 'Could not find that repository in the configured roots.') : t('Não achei um arquivo seguro com esse nome ou caminho.', 'Could not find a safe file with that name or path.'));
          if (options.length > 1) return result(t('Encontrei mais de um candidato. Escolha no painel.', 'Found more than one match. Choose one in the panel.'), [], options.slice(0, 12).map((p) => ({ label: p, command: (isRepo ? '/repo ' : '/file ') + p })));
          if (!isRepo) {
            if (!await safeFile(options[0])) return result(t('Esse arquivo não passou na verificação.', 'That file did not pass the safety check.'));
            await open(options[0]);
            return result(t('Arquivo aberto. ', 'Opened file. ') + options[0]);
          }
          const repo = await describe(options[0]);
          const intro = repo.readme?.title && repo.readme.title.toLowerCase() !== repo.name.toLowerCase() ? repo.name + ' · ' + repo.readme.title : repo.name;
          const details = [
            repo.readme?.summary || t('README sem uma descrição curta.', 'No short description in the README.'),
            repo.branch && t('Git ', 'Git ') + repo.branch + ' · ' + t(repo.changed + ' itens alterados', repo.changed + ' changed entries'),
            repo.remote && t('Remoto ', 'Remote ') + repo.remote,
            repo.structure.length && t('Raiz ', 'Root ') + repo.structure.join(', '),
          ].filter(Boolean);
          return result([intro, ...details].join('\n'));
        }
        if (command.kind === 'email') {
          const draft = mailDraft(text);
          if (!draft) return result(t('Use /email destinatário@exemplo.com | Assunto | Mensagem.', 'Use /email recipient@example.com | Subject | Message.'));
          await open(draft.url);
          return result(t('Rascunho encaminhado ao app padrão de e-mail.', 'Handed the draft to the default email app.'));
        }
        if (command.kind === 'calendar') {
          const event = calendarDraft(text);
          if (!event) return result(t('Informe data, hora e título. Exemplo: /agenda amanhã 14:30 30m: Revisão.', 'Give me a date, time and title. Example: /calendar tomorrow 14:30 30m: Review.'));
          const format = new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: event.zone });
          const details = format.formatRange(new Date(event.start), new Date(event.end)) + ' · ' + event.zone + '\n' +
            (event.attendees.length ? t('Convidados ', 'Guests ') + event.attendees.join(', ') + '\n' + t('Importação no Calendário. Confira os convidados lá.', 'Calendar import. Check attendees there.') : t('Calendário padrão do Mac.', 'Mac default calendar.'));
          if (!await confirm({ id: randomUUID(), kind: 'calendar', target: details, text: event.title, lang })) return result(t('Agendamento cancelado.', 'Scheduling canceled.'));
          const entry = await saveEvent(event, { hands, open });
          return result(entry.saved ? t('Evento salvo no Calendário. ', 'Event saved to Calendar. ') + event.title : t('Arquivo de evento aberto para importar no Calendário.', 'Opened the event for import in Calendar.'));
        }
        if (command.kind === 'rewrite') {
          if (!rewrite) throw new Error();
          const draft = await rewrite.read(lang, selectionOrigin);
          if (!command.replace) return result(draft.text);
          if (!await confirm({ id: randomUUID(), kind: 'rewrite', target: draft.target, text: draft.text, lang })) return result(t('Seleção preservada.', 'Selection left as it was.'));
          const changed = await rewrite.apply(draft, lang);
          if (!changed.ok) return result(changed.attempted
            ? t('Não consegui confirmar a edição. Verifique o editor antes de repetir.', 'I could not verify the edit. Check the editor before retrying.')
            : t('A seleção ou a janela mudou. Selecione o trecho e tente novamente.', 'The selection or window changed. Select the text and try again.'));
          return result(t('Seleção substituída. Use ⌘Z no editor para desfazer.', 'Selection replaced. Use Command-Z in the editor to undo.'));
        }
        if (command.kind === 'language') {
          prefs.jarvisLanguage = command.lang;
          save();
          return result(command.lang === 'pt' ? 'Vou responder em português.' : command.lang === 'en' ? 'I will reply in English.' : t('Vou seguir o idioma do pedido.', 'I will follow the request language.'));
        }
        if (command.kind === 'teamsOpen') {
          await open(await audio.open());
          return result(t('Aba do Jarvis aberta. Ative o áudio e compartilhe só essa aba no Teams Web.', 'Jarvis tab opened. Enable audio and share only that tab in Teams Web.'));
        }
        if (command.kind === 'teamsStop') { audio.close(); return result(t('Áudio do Jarvis desativado.', 'Jarvis tab audio is off.')); }
        if (command.kind === 'teamsSay') {
          const played = await audio.speak(text, lang);
          return result(played ? t('A aba do Jarvis reproduziu a fala.', 'The Jarvis tab played the line.') : t('A aba não confirmou a reprodução.', 'The tab did not confirm playback.'));
        }
        if (command.kind === 'herdr') {
          if (!Object.hasOwn(providers, command.provider)) throw new Error();
          const cwd = await herdrFolder(command.cwd || prefs.jarvisHerdrFolder || dataDir);
          if (!await confirm({ id: randomUUID(), kind: 'herdr', target: command.provider + ' · ' + cwd, text, lang })) return result(t('Tarefa cancelada.', 'Task canceled.'));
          const sent = await runHerdr({ provider: command.provider, cwd, text });
          return result(t('Herdr recebeu a tarefa para ' + command.provider + ' na sessão ' + sent.session + ' (' + sent.pane + ').', 'Herdr accepted the task for ' + command.provider + ' in session ' + sent.session + ' (' + sent.pane + ').'));
        }
        if (command.kind === 'slackOpen' || command.kind === 'slackReply') {
          const target = slackTarget(command.target || prefs.jarvisSlackTarget);
          if (!target) return result(t('Use um link HTTPS de canal ou mensagem do Slack.', 'Use an HTTPS Slack channel or message link.'));
          if (command.kind === 'slackOpen') { await open(target.url); return result(t('Link do Slack aberto.', 'Opened the Slack link.')); }
          const recipient = await slack.resolve(target);
          const where = recipient.channel + ' · ' + target.host + (recipient.thread ? ' · ' + recipient.thread : '');
          if (!await confirm({ id: randomUUID(), kind: 'slack', target: where, url: target.url, as: recipient.user, text, lang })) return result(t('Envio cancelado.', 'Send canceled.'));
          const url = await slack.send(target, recipient, text);
          return result(t('Mensagem enviada como bot Slack.', 'Message sent as the Slack bot.'), link(t('Abrir mensagem', 'Open message'), url));
        }
        if (command.kind === 'github') {
          const target = githubTarget(command.target);
          if (!target) return result(t('Informe um link de PR ou owner/repo.', 'Give me a PR URL or owner/repo.'));
          const pr = await github(target);
          if (Array.isArray(pr)) {
            const lines = pr.map((p) => ({ label: '#' + p.number + ' ' + compact(p.title), url: approvedUrl(p.url, 'github.com') })).filter((p) => p.url);
            return result(t(lines.length + ' PRs abertos em ', lines.length + ' open PRs in ') + target.repo + '.', lines);
          }
          const checks = pr.statusCheckRollup ?? [];
          const successful = checks.filter((c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state)).length;
          const pending = checks.filter((c) => ['PENDING', 'EXPECTED'].includes(c.state) || c.status && c.status !== 'COMPLETED').length;
          const failed = checks.length - successful - pending;
          const summary = checks.length
            ? t(successful + ' ok, ' + pending + ' pendentes, ' + failed + ' com falha ou sem sucesso.', successful + ' passed, ' + pending + ' pending, ' + failed + ' failed or unsuccessful.')
            : t('Sem checks reportados.', 'No checks reported.');
          const state = ({ OPEN: t('aberto', 'open'), CLOSED: t('fechado', 'closed'), MERGED: t('mesclado', 'merged') })[pr.state] ?? compact(pr.state);
          const sha = /^[a-f0-9]{40}$/.test(pr.headRefOid) ? ' · ' + pr.headRefOid.slice(0, 7) : '';
          const url = approvedUrl(pr.url, 'github.com');
          return result('#' + pr.number + ' ' + compact(pr.title) + ' · ' + state + (pr.isDraft ? t(' (rascunho)', ' (draft)') : '') + sha + '\n' + summary,
            [...link(t('Abrir PR', 'Open PR'), url), ...link(t('Abrir checks', 'Open checks'), url && url + '/checks')]);
        }
        if (command.kind === 'linear') {
          const { viewer, issue, order } = await linear(() => secrets.get(LINEAR_KEY), dataDir);
          if (!issue) return result(t('Linear não retornou tarefas em andamento ou prontas para ', 'Linear returned no in-progress or ready tasks for ') + compact(viewer.name) + '.');
          const stage = issue.state.type === 'started' ? t('Já está em andamento', 'Already in progress') : t('Está pronta', 'Ready to start');
          const why = order === 'updated' ? t('lidera por prioridade, com empate pela atualização mais recente.', 'first by priority, breaking ties by most recent update.') : t('lidera por prioridade e posição no Linear.', 'first by priority and position in Linear.');
          const explanation = stage + t(' e ', ' and ') + why;
          return result(issue.identifier + ' · ' + compact(issue.title) + '\n' + compact(issue.state.name) + ' · ' + compact(viewer.name) + '. ' + explanation, link(t('Abrir no Linear', 'Open in Linear'), approvedUrl(issue.url, 'linear.app')));
        }
        return result(t('Use /herdr, /slack, /teams, /github, /linear, /repo, /arquivo, /agenda ou /email. Veja exemplos no painel Jarvis.', 'Use /herdr, /slack, /teams, /github, /linear, /repo, /file, /calendar or /email. See examples in the Jarvis panel.'));
      } catch (error) {
        return result(error instanceof JarvisError ? t(error.pt, error.message) : t('A integração não confirmou o resultado. Confira o destino antes de tentar de novo.', 'The integration did not confirm the result. Check the destination before retrying.'));
      }
    },
  };
}
