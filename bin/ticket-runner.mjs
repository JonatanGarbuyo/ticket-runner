#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, copyFile, mkdir, access } from 'node:fs/promises';
import {
  runProcess, loadConfig, loadAvailableModels, selectModels, gitIssue,
  readRun, startRun, humanFeedback, approveRun,
} from '../lib/core.mjs';

function parseArgs(args) {
  const positional = []; const flags = {};
  const names = { '--cwd': 'cwd', '--impl-model': 'implModel', '--review-model': 'reviewModel' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--select-models') { flags.selectModels = true; continue; }
    if (a === '--close-issue') { flags.closeIssue = true; continue; }
    if (names[a]) {
      if (!args[i + 1]) throw new Error(`Falta argumento para ${a}`);
      flags[names[a]] = args[++i]; continue;
    }
    if (a.startsWith('--')) throw new Error(`Flag desconocido: ${a}`);
    positional.push(a);
  }
  return { positional, ...flags, cwd: resolve(flags.cwd || process.cwd()) };
}

const HELP = `TicketRunner (OpenCode V2 + Herdr)

  ticket-runner init [--cwd repo]
  ticket-runner doctor [--cwd repo]
  ticket-runner preview <issue> [--cwd repo] [--impl-model provider/model] [--review-model provider/model]
  ticket-runner run <issue> [--cwd repo] [--select-models] [--impl-model provider/model] [--review-model provider/model]
  ticket-runner status <issue-runID|issue> [--cwd repo]
  ticket-runner feedback <issue-runID|issue> "Problema encontrado" [--cwd repo]
  ticket-runner approve <issue-runID|issue> [--close-issue] [--cwd repo]

Los modelos deben estar explícitamente permitidos en ticket-runner.config.json.
Sin --select-models usa el primer modelo elegible. Nunca hereda el modelo del planner.
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { console.log(HELP); return; }
  const opts = parseArgs(rest);
  const id = opts.positional[0];
  if (command === 'init') {
    const examples = fileURLToPath(new URL('../examples/', import.meta.url));
    const files = [
      ['ticket-runner.config.json', 'ticket-runner.config.json'],
      ['ticket-implementer.md', '.opencode/agents/ticket-implementer.md'],
      ['ticket-reviewer.md', '.opencode/agents/ticket-reviewer.md'],
    ];
    for (const [source, dest] of files) {
      const target = join(opts.cwd, dest);
      try { await access(target); console.log(`EXISTS ${target} (se conserva)`); continue; } catch {}
      await mkdir(resolve(target, '..'), { recursive: true });
      await copyFile(join(examples, source), target);
      console.log(`CREATED ${target}`);
    }
    console.log('Editar el JSON con IDs gratuitos reales. Agregar el plugin al opencode.jsonc (README). Versionar los agentes antes del primer run.');
    return;
  }
  if (command === 'doctor') {
    const cfg = await loadConfig(opts.cwd);
    const available = await loadAvailableModels(opts.cwd);
    const models = await selectModels(cfg, available, opts, false);
    const results = {};
    for (const [cmd, args] of Object.entries({ git: ['--version'], gh: ['--version'], herdr: ['--version'], opencode: ['--version'] })) {
      results[cmd] = (await runProcess(cmd, args, { cwd: opts.cwd })).split('\n')[0];
    }
    console.log(JSON.stringify({ status: 'OK', models, dependencies: results }, null, 2)); return;
  }
  if (command === 'preview') {
    const cfg = await loadConfig(opts.cwd);
    const models = await selectModels(cfg, await loadAvailableModels(opts.cwd), opts, false);
    const issue = await gitIssue(opts.cwd, id);
    console.log(JSON.stringify({ status: 'PREVIEW_ONLY', issue, models, checks: cfg.checks, maxReviewCycles: cfg.maxReviewCycles }, null, 2));
    return;
  }
  if (command === 'run') {
    const run = await startRun({ ...opts, issue: id });
    console.log(JSON.stringify({ runID: `${run.issue.number}-${run.runID}`, status: run.status, models: run.models, branch: run.branch, worktree: run.worktree, panes: run.panes }, null, 2));
    return;
  }
  if (command === 'status') {
    const run = await readRun(opts.cwd, id);
    console.log(JSON.stringify({ issue: run.issue.number, runID: id, status: run.status, models: run.models, round: run.round, branch: run.branch, panes: run.panes, lastFeedback: run.lastFeedback, blockReason: run.blockReason }, null, 2));
    return;
  }
  if (command === 'feedback') {
    const msg = opts.positional.slice(1).join(' ');
    const run = await humanFeedback(opts.cwd, id, msg);
    console.log(`${run.status} — ${id}`); return;
  }
  if (command === 'approve') {
    const run = await approveRun(opts.cwd, id, opts.closeIssue);
    console.log(`${run.status} — ${id}`); return;
  }
  throw new Error(`Comando desconocido: ${command}\n${HELP}`);
}

main().catch(err => { console.error(`ERROR: ${err.message}`); process.exitCode = 1; });
