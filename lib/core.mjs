import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import readline from 'node:readline/promises';

const execFileAsync = promisify(execFile);
export const DEFAULT_CONFIG = {
  models: { implementer: [], reviewer: [] },
  checks: [], maxReviewCycles: 3, turnTimeoutMs: 900000,
  selectionTimeoutMs: 15000,
  implementerAgent: 'ticket-implementer', reviewerAgent: 'ticket-reviewer',
};

export async function runProcess(cmd, args = [], options = {}) {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: options.cwd, timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024, encoding: 'utf8',
  });
  return stdout.trim();
}

export async function execJSON(cmd, args, options = {}) {
  const text = await runProcess(cmd, args, options);
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`${cmd} devolvió una respuesta no JSON: ${text.slice(0, 500)}`); }
  if (parsed.error || parsed.success === false) {
    throw new Error(`${cmd}: ${JSON.stringify(parsed.error ?? parsed).slice(0, 500)}`);
  }
  return parsed.result ?? parsed;
}

export function safeIssueNumber(raw) {
  if (!/^[1-9]\d{0,8}$/.test(String(raw))) throw new Error('Se requiere un número de issue (p. ej. 42).');
  return Number(raw);
}
export function repoKey(path) {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12);
}
export function runDirectory(repo, issue, runID) {
  return join(homedir(), '.local', 'state', 'ticket-runner', repoKey(repo), `${issue}-${runID}`);
}
export function parseModelList(stdout) {
  return new Set(stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^[\w.-]+\/[\w.#:-]+$/.test(s)));
}
export async function loadConfig(cwd) {
  const file = join(cwd, 'ticket-runner.config.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const config = { ...DEFAULT_CONFIG, ...raw,
    models: { ...DEFAULT_CONFIG.models, ...(raw.models || {}) } };
  for (const role of ['implementer', 'reviewer']) {
    const list = config.models[role];
    if (!Array.isArray(list) || list.length < 1 || !list.every(x => typeof x === 'string' && x.includes('/') && !x.startsWith('REPLACE_'))) {
      throw new Error(`Configurar models.${role} con uno o más IDs REALES de modelos gratuitos.`);
    }
  }
  if (!Array.isArray(config.checks)) throw new Error('checks debe ser un array.');
  if (!Number.isInteger(config.maxReviewCycles) || config.maxReviewCycles < 1 || config.maxReviewCycles > 20) {
    throw new Error('maxReviewCycles debe estar entre 1 y 20.');
  }
  return config;
}

export async function selectModels(config, available, flags = {}, interactive = false) {
  const picked = {};
  for (const role of ['implementer', 'reviewer']) {
    const eligible = config.models[role].filter(m => available.has(m));
    if (!eligible.length) throw new Error(`No hay modelos elegibles conectados para ${role}; revisar opencode models y config.`);
    const override = role === 'implementer' ? flags.implModel : flags.reviewModel;
    if (override && !eligible.includes(override)) throw new Error(`Modelo ${override} no permitido para ${role}.`);
    picked[role] = override ?? (interactive ? await askTimed(role, eligible, config.selectionTimeoutMs) : eligible[0]);
  }
  if (picked.implementer === picked.reviewer) {
    throw new Error('Implementer y reviewer deben usar modelos diferentes para lograr independencia de criterio.');
  }
  return picked;
}

async function askTimed(role, choices, timeout) {
  if (!process.stdin.isTTY) return choices[0];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nModelo para ${role} (${timeout / 1000}s, Enter = predeterminado):`);
    choices.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    const answer = await Promise.race([
      rl.question('Seleccioná un número: '),
      new Promise(res => setTimeout(() => res(''), timeout)),
    ]);
    const index = Number(answer) - 1;
    return Number.isInteger(index) && index >= 0 && index < choices.length ? choices[index] : choices[0];
  } finally { rl.close(); }
}

export async function writeState(file, state) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(temp, file);
}
export async function readState(file) { return JSON.parse(await readFile(file, 'utf8')); }
export async function readResult(path, kind) {
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Resultado ausente o JSON inválido: ${path}`); }
  if (kind === 'implementation') {
    if (!['ready', 'blocked'].includes(data.status) || typeof data.commit !== 'string') {
      throw new Error('implementation.json requiere {status:"ready|blocked",commit:"SHA"}.');
    }
  } else {
    if (!['approved', 'changes_requested', 'blocked'].includes(data.verdict) || !Array.isArray(data.findings)) {
      throw new Error('review.json requiere {verdict:"approved|changes_requested|blocked",findings:[]}.');
    }
    if (data.verdict === 'changes_requested' && data.findings.length === 0) throw new Error('changes_requested requiere findings.');
    for (const f of data.findings) {
      if (!f || typeof f.message !== 'string' || f.message.length === 0) throw new Error('Finding inválido.');
    }
  }
  return data;
}

export async function runChecks(checks, cwd, logDir) {
  await mkdir(logDir, { recursive: true });
  const results = [];
  for (const check of checks) {
    if (typeof check.name !== 'string' || typeof check.command !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(check.name)) throw new Error('Check inválido.');
    const log = join(logDir, `${check.name}.log`);
    const result = await new Promise((res) => {
      // Commands come from the user's trusted local project config, never an issue body.
      const child = spawn(check.command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGTERM'), Math.min(check.timeoutMs || 120000, 600000));
      let output = ''; let truncated = false;
      const max = 2 * 1024 * 1024;
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
        if (output.length < max) output += chunk.toString();
        else truncated = true;
      });
      child.on('error', err => res({ passed: false, excerpt: err.message }));
      child.on('close', code => { clearTimeout(timer); res({ passed: code === 0, excerpt: output.slice(-2400), output, truncated, code }); });
    });
    await writeFile(log, (result.output || result.excerpt || '') + (result.truncated ? '\n[output truncated]\n' : ''));
    results.push({ name: check.name, passed: result.passed, log, ...(result.passed ? {} : { excerpt: result.excerpt }) });
    if (!result.passed) break; // fast failure; full suite runs after preceding checks pass
  }
  return results;
}
export const allPassed = results => results.every(c => c.passed);

export function implementationPrompt(issue, path) {
  return [
    `Implementá exclusivamente GitHub issue #${issue.number}: ${issue.title}.`,
    `Ticket: ${issue.url}`,
    `Criterios y contexto: ${issue.body}`,
    `Trabajás en un Git worktree dedicado. Aplicá TDD cuando corresponda, ejecutá tests focalizados y hacé commit.`,
    `No invoques la skill code-review: la ejecutará un reviewer de OTRO modelo.`,
    `No cierres ni modifiques el issue, no hagas push ni merge.`,
    `Al terminar escribí JSON VÁLIDO exactamente en ${path}:`,
    `{ "status": "ready", "commit": "<SHA de HEAD>", "summary": "<breve>" }`,
    `Si te bloqueás escribí { "status":"blocked", "commit":"<SHA o HEAD>", "summary":"motivo" }.`,
    `No reportes finalización hasta que ese archivo exista.`,
  ].join('\n\n');
}
export function reviewPrompt(issue, base, path, round) {
  return [
    `Revisá en forma adversarial los cambios del issue #${issue.number} desde ${base} hasta HEAD. Ciclo ${round}.`,
    `Ticket: ${issue.url}\n${issue.body}`,
    `Invocá la skill code-review instalada, con punto fijo ${base}, verificando ejes Standards y Spec.`,
    `No cambies código, no implementes. Tu modelo y el de tus subagentes deben seguir siendo el modelo gratuito seleccionado para este pane.`,
    `Reportá defectos concretos con evidencia; evitá sugerencias cosméticas sin relación con requisitos.`,
    `Escribí JSON en ${path} como:`,
    `{ "verdict":"approved|changes_requested|blocked", "findings":[{"severity":"major","file":"src/...","line":12,"message":"..."}] }`,
    `No des aprobación sin haber inspeccionado el diff y la spec.`,
  ].join('\n\n');
}

export class Herdr {
  constructor(runner = execJSON) { this.runner = runner; }
  async run(args) { return this.runner('herdr', args); }
  async create(cwd, label) {
    const root = await this.run(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']);
    const first = root.root_pane?.pane_id;
    if (!first) throw new Error('Herdr no devolvió root_pane.pane_id');
    const split = await this.run(['pane', 'split', first, '--direction', 'right', '--no-focus']);
    if (!split.pane?.pane_id) throw new Error('Herdr no devolvió pane.pane_id');
    return { implPane: first, reviewPane: split.pane.pane_id };
  }
  async start(name, pane, agent, model) {
    // OpenCode receives --model explicitly; it must never inherit the planner model.
    await this.run(['agent', 'start', name, '--kind', 'opencode', '--pane', pane, '--', '--agent', agent, '--model', model]);
  }
  async prompt(name, prompt, timeout) {
    return this.run(['agent', 'prompt', name, prompt, '--wait', '--timeout', String(timeout)]);
  }
}

export async function git(cwd, ...args) { return runProcess('git', args, { cwd, timeout: 90000 }); }
export async function prepareWorktree(repo, branch, worktree) {
  await mkdir(resolve(worktree, '..'), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, worktree, 'HEAD');
  const gitDir = await git(repo, 'rev-parse', '--absolute-git-dir');
  // Git's local exclude covers auxiliary output in worktrees without touching tracked .gitignore.
  const exclude = join(gitDir, 'info', 'exclude');
  let prev = '';
  try { prev = await readFile(exclude, 'utf8'); } catch {}
  if (!prev.split(/\r?\n/).includes('.ticket-runner/')) {
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(exclude, prev + '\n.ticket-runner/\n');
  }
}

export async function gitIssue(repo, issueNum) {
  const text = await runProcess('gh', ['issue', 'view', String(issueNum), '--json', 'number,title,body,url,state'], { cwd: repo });
  const issue = JSON.parse(text);
  if (issue.state !== 'OPEN') throw new Error('El issue no está abierto.');
  return issue;
}
export async function verifyCommit(worktree, base, claimed) {
  const actual = await git(worktree, 'rev-parse', 'HEAD');
  const ancestor = await git(worktree, 'merge-base', '--is-ancestor', base, actual).then(() => true, () => false);
  if (actual === base || !ancestor) throw new Error('No hay commits nuevos válidos desde el punto base.');
  if (actual !== claimed) throw new Error(`Commit reportado (${claimed}) difiere de HEAD (${actual}).`);
  const changed = await git(worktree, 'status', '--porcelain');
  if (changed) throw new Error('Working tree sucio tras commit; revisar cambios sin confirmar.');
  return actual;
}

export async function saveRun(run) { await writeState(join(run.runDir, 'state.json'), run); }
export async function readRun(repo, runID) {
  const parent = join(homedir(), '.local', 'state', 'ticket-runner', repoKey(repo));
  let id = runID;
  if (/^[1-9]\d{0,8}$/.test(runID)) {
    const options = (await readdir(parent)).filter(x => x.startsWith(`${runID}-`)).sort();
    if (!options.length) throw new Error(`No hay ejecuciones de issue #${runID}`);
    id = options.at(-1);
  }
  const dir = join(parent, id);
  const run = await readState(join(dir, 'state.json'));
  if (resolve(repo) !== run.repo) throw new Error('El estado corresponde a otro repositorio.');
  return run;
}
export async function loadAvailableModels(cwd) {
  return parseModelList(await runProcess('opencode', ['models'], { cwd, timeout: 90000 }));
}

export async function advanceRun(run, { herdr = new Herdr(), feedback } = {}) {
  const worktree = run.worktree;
  const impl = join(worktree, '.ticket-runner', 'implementation.json');
  const review = join(worktree, '.ticket-runner', 'review.json');
  for (let i = run.round; i < run.maxReviewCycles; i++) {
    run.round = i + 1;
    run.status = 'IMPLEMENTING'; await saveRun(run);
    try { await import('node:fs/promises').then(fs => fs.rm(impl, { force: true })); } catch {}
    const prompt = i === 0 && !feedback ? implementationPrompt(run.issue, impl)
      : `Corregí los problemas pendientes del issue #${run.issue.number} en esta MISMA sesión.\n${feedback || run.lastFeedback}\nHacé commit. Actualizá ${impl} con {"status":"ready","commit":"<HEAD SHA>","summary":"..."}. No invoques code-review.`;
    await herdr.prompt(run.agentNames.impl, prompt, run.turnTimeoutMs);
    const output = await readResult(impl, 'implementation');
    if (output.status === 'blocked') throw new Error(`Implementer bloqueado: ${output.summary}`);
    await verifyCommit(worktree, run.base, output.commit);
    run.status = 'VERIFYING'; await saveRun(run);
    const checks = await runChecks(run.checks, worktree, join(run.runDir, `logs-${run.round}`));
    run.lastChecks = checks.map(({ name, passed, log }) => ({ name, passed, log }));
    if (!allPassed(checks)) {
      run.lastFeedback = JSON.stringify({ source: 'tests', errors: checks.filter(c => !c.passed).map(c => ({ name: c.name, excerpt: c.excerpt, log: c.log })) });
      await saveRun(run); feedback = undefined; continue;
    }
    run.status = 'REVIEWING'; await saveRun(run);
    await import('node:fs/promises').then(fs => fs.rm(review, { force: true }));
    await herdr.prompt(run.agentNames.review, reviewPrompt(run.issue, run.base, review, run.round), run.turnTimeoutMs);
    const verdict = await readResult(review, 'review');
    if (verdict.verdict === 'blocked') throw new Error('Reviewer reportó bloqueo.');
    if (verdict.verdict === 'approved') {
      run.status = 'AWAITING_HUMAN'; run.lastFeedback = null;
      await saveRun(run); return run;
    }
    run.lastFeedback = JSON.stringify({ source: 'reviewer', findings: verdict.findings });
    await saveRun(run); feedback = undefined;
  }
  run.status = 'BLOCKED'; run.blockReason = `Sin aprobación tras ${run.maxReviewCycles} ciclos`;
  await saveRun(run); return run;
}

export async function startRun(opts) {
  const repo = resolve(opts.cwd);
  const issueNum = safeIssueNumber(opts.issue);
  const config = await loadConfig(repo);
  const available = await loadAvailableModels(repo);
  const models = await selectModels(config, available, opts, opts.selectModels);
  const issue = await gitIssue(repo, issueNum);
  const runID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`;
  const runDir = runDirectory(repo, issueNum, runID);
  const branch = `agent/ticket-${issueNum}-${runID}`;
  const worktree = join(runDir, 'worktree');
  const base = await git(repo, 'rev-parse', 'HEAD');
  await mkdir(runDir, { recursive: true });
  const run = { version: 1, runID, runDir, repo, issue, branch, worktree, base, models,
    checks: config.checks, maxReviewCycles: config.maxReviewCycles,
    turnTimeoutMs: config.turnTimeoutMs, round: 0, status: 'PREPARING',
    agentNames: { impl: `impl_${issueNum}_${process.pid}`.slice(0, 32), review: `review_${issueNum}_${process.pid}`.slice(0, 32) } };
  await saveRun(run);
  try {
    await prepareWorktree(repo, branch, worktree);
    const herdr = new Herdr();
    const panes = await herdr.create(worktree, `ticket-${issueNum}`);
    run.panes = panes; await saveRun(run);
    await herdr.start(run.agentNames.impl, panes.implPane, config.implementerAgent, models.implementer);
    await herdr.start(run.agentNames.review, panes.reviewPane, config.reviewerAgent, models.reviewer);
    run.status = 'READY'; await saveRun(run);
    return await advanceRun(run, { herdr });
  } catch (e) {
    run.status = 'BLOCKED'; run.blockReason = e.message;
    await saveRun(run); throw new Error(`${e.message}\nEstado: ${join(runDir, 'state.json')}`);
  }
}

export async function humanFeedback(repo, runID, text) {
  const run = await readRun(repo, runID);
  if (run.status !== 'AWAITING_HUMAN') throw new Error(`Estado ${run.status}, se requiere AWAITING_HUMAN.`);
  if (!text.trim()) throw new Error('Feedback vacío.');
  // Same two panes = same two OpenCode conversations; no --continue.
  run.round = 0; run.lastFeedback = JSON.stringify({ source: 'human', message: text });
  await saveRun(run);
  try { return await advanceRun(run, { feedback: run.lastFeedback }); }
  catch (e) { run.status = 'BLOCKED'; run.blockReason = e.message; await saveRun(run); throw e; }
}
export async function approveRun(repo, runID, closeIssue = false) {
  const run = await readRun(repo, runID);
  if (run.status !== 'AWAITING_HUMAN') throw new Error('Solo se aprueba AWAITING_HUMAN.');
  if (closeIssue) await runProcess('gh', ['issue','close',String(run.issue.number),'--comment',`Aceptado por humano. Branch: ${run.branch}`], {cwd:repo});
  run.status = 'DONE'; run.approvedAt = new Date().toISOString();
  await saveRun(run); return run;
}
