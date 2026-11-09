import { Plugin } from '@opencode/plugin';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/ticket-runner.mjs', import.meta.url));

export default Plugin.define({
  id: 'ticket-runner',
  async setup(ctx) {
    await ctx.command.transform(editor => {
      editor.add({
        name: 'ticket-run',
        description: 'Delega un GitHub issue a dos modelos económicos independientes en Herdr',
        execute: async ({ sessionID, prompt }) => {
          const text = prompt.text.trim();
          const match = text.match(/^#?(\d+)(?:\s+--impl-model\s+(\S+))?(?:\s+--review-model\s+(\S+))?$/);
          if (!match) {
            await ctx.session.synthetic({ sessionID, text: 'Uso: /ticket-run 42 [--impl-model provider/model] [--review-model provider/model]' });
            return;
          }
          const args = ['run', match[1], '--cwd', ctx.location.directory];
          if (match[2]) args.push('--impl-model', match[2]);
          if (match[3]) args.push('--review-model', match[3]);
          const logDir = join(homedir(), '.local', 'state', 'ticket-runner');
          mkdirSync(logDir, { recursive: true });
          const log = join(logDir, 'launcher.log');
          const fd = openSync(log, 'a');
          // Detached: does not keep a paid planner session busy waiting for the work.
          const child = spawn(process.execPath, [cli, ...args], {
            cwd: ctx.location.directory, detached: true,
            stdio: ['ignore', fd, fd], env: process.env,
          });
          child.unref();
          await ctx.session.synthetic({
            sessionID,
            text: `TicketRunner iniciado para issue #${match[1]} (PID ${child.pid}). Sin invocar otro modelo. Log: ${log}. Usá ticket-runner status ${match[1]} para ver el estado de la ejecución más reciente.`,
          });
        },
      });
    });
  },
});
