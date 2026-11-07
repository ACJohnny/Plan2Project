import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a binary with a hard timeout and a scrubbed environment (R-68). Poppler tools never
 * fetch remote resources; the empty env also drops proxy settings.
 */
export function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      if (stderr.length < 10_000) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
