import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  selectModels, safeIssueNumber, parseModelList, execJSON, readResult,
  advanceRun, git, readState, writeState, implementationPrompt,
} from '../lib/core.mjs';

test('safeIssueNumber no acepta inyección ni cadenas ambiguas', () => {
  assert.equal(safeIssueNumber('42'), 42);
  assert.throws(() => safeIssueNumber('42;rm -rf /'));
  assert.throws(() => safeIssueNumber('0'));
});

test('modelos diferentes, pertenecientes a una allowlist y conectados', async () => {
  const cfg = { models: { implementer: ['free/a','free/c'], reviewer: ['free/b','free/c'] } };
  const available = parseModelList('free/a\nfree/b\nfree/c\n');
  assert.deepEqual(await selectModels(cfg, available), { implementer:'free/a', reviewer:'free/b' });
  await assert.rejects(() => selectModels(cfg, available, { implModel: 'paid/expensive' }), /permitido/);
  await assert.rejects(() => selectModels(cfg, available, { reviewModel: 'free/a' }), /permitido/);
  await assert.rejects(() => selectModels(cfg, new Set(['free/c']), {}), /diferentes/);
});

test('contratos de implementación y review rechazan respuestas incompletas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-schema-'));
  const file = join(dir, 'result.json');
  await writeFile(file, JSON.stringify({ status:'ready' }));
  await assert.rejects(() => readResult(file, 'implementation'), /requiere/);
  await writeFile(file, JSON.stringify({ verdict:'approved', findings:[] }));
  assert.equal((await readResult(file, 'review')).verdict, 'approved');
  await writeFile(file, JSON.stringify({ verdict:'changes_requested', findings:['oops'] }));
  await assert.rejects(() => readResult(file, 'review'), /Finding/);
});

test('retorna bloqueo si falta el artefacto, sin suponer éxito por idle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-silent-'));
  const run = {
    runDir:dir, worktree: dir, issue:{number:42,title:'Tarea',url:'https://github.com/x/y/issues/42',body:'Pruebas'},
    round:0, maxReviewCycles:1, base:'base', checks:[], turnTimeoutMs:100,
    agentNames:{impl:'impl',review:'review'},
  };
  await assert.rejects(() => advanceRun(run, { herdr:{prompt:async()=>({})} }), /ausente/);
  assert.equal((await readState(join(dir,'state.json'))).status,'IMPLEMENTING');
});

test('flujo: implementa, reviewer pide cambios, misma sesión implementer corrige, aprueba → AWAITING_HUMAN', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runner-cycle-'));
  const worktree = join(base, 'repo'); const runDir=join(base, 'state');
  await mkdir(worktree); await mkdir(runDir);
  const runGit=(...args)=>execFileSync('git',args,{cwd:worktree,encoding:'utf8'}).trim();
  runGit('init','-q'); runGit('config','user.email','bot@example.test'); runGit('config','user.name','Test Bot');
  await writeFile(join(worktree,'app.js'),'console.log(0)\n');
  runGit('add','app.js'); runGit('commit','-qm','base');
  await writeFile(join(worktree,'.git','info','exclude'), '.ticket-runner/\n');
  const baseSHA=runGit('rev-parse','HEAD');
  const run={runDir,worktree,base:baseSHA,issue:{number:42,title:'Bug',body:'Corrige resultado',url:'https://github.com/x/y/issues/42'},
    round:0,maxReviewCycles:3,checks:[],turnTimeoutMs:10000,agentNames:{impl:'impl',review:'review'}};
  const names=[];
  let implCount=0, reviewCount=0;
  const herdr={prompt:async(name,prompt)=>{
    names.push(name);
    await mkdir(join(worktree,'.ticket-runner'),{recursive:true});
    if (name==='impl') {
      implCount++;
      await writeFile(join(worktree,'app.js'),`console.log(${implCount})\n`);
      runGit('add','app.js'); runGit('commit','-qm',`implementation ${implCount}`);
      const sha=runGit('rev-parse','HEAD');
      await writeFile(join(worktree,'.ticket-runner','implementation.json'),JSON.stringify({status:'ready',commit:sha,summary:'done'}));
    } else {
      reviewCount++;
      await writeFile(join(worktree,'.ticket-runner','review.json'),JSON.stringify(reviewCount === 1 ?
        {verdict:'changes_requested',findings:[{message:'Falta edge case',severity:'major'}]} :
        {verdict:'approved',findings:[]}));
    }
    return {};
  }};
  const result=await advanceRun(run,{herdr});
  assert.equal(result.status,'AWAITING_HUMAN');
  assert.equal(result.round,2);
  assert.deepEqual(names,['impl','review','impl','review']);
  assert.equal((await readState(join(runDir,'state.json'))).status,'AWAITING_HUMAN');
});

test('Herdr construye panes y pasa modelos diferentes de forma explícita', async () => {
  const { Herdr } = await import('../lib/core.mjs');
  const calls=[];
  const herdr=new Herdr(async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0]==='workspace') return { root_pane:{pane_id:'w5:p1'} };
    if (args[0]==='pane') return { pane:{pane_id:'w5:p2'} };
    return { agent:{ status:'idle' } };
  });
  const panes=await herdr.create('/repo','ticket-42');
  assert.deepEqual(panes, { implPane:'w5:p1', reviewPane:'w5:p2' });
  await herdr.start('impl42','w5:p1','ticket-implementer','free/a');
  await herdr.start('rev42','w5:p2','ticket-reviewer','free/b');
  assert.ok(calls[2].includes('free/a'));
  assert.ok(calls[3].includes('free/b'));
  assert.ok(!calls[2].includes('free/b'));
  assert.ok(calls[2].includes('--model'));
});
