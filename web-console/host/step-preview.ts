import { spawn } from 'node:child_process';
import { closeSync, fstatSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { FILE_PREVIEW_LIMITS } from '../shared/file-preview.ts';
import type { StepPreviewTiming, WorkbenchResult } from '../src/workspaces/workbench.ts';
import { WorkspaceHostError } from '../src/workspaces/host.ts';
import { descriptorVersion, openPreviewPath } from './workspace-preview.ts';

export interface StepPreviewConverter {
  executable: string;
  threads: 1 | 8;
}

async function convert(config: StepPreviewConverter, fd: number, cwd: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.executable, [String(config.threads)], {
      cwd, stdio: ['ignore', 'ignore', 'ignore', fd],
      env: { LANG: 'C', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH },
    });
    const cancel = () => child.kill('SIGKILL');
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) reject(signal.reason);
      else if (spawnError) reject(new Error('preview_unavailable'));
      else if (exitSignal === 'SIGXFSZ') reject(new Error('too_large'));
      else if (code !== 0) reject(new Error('parser_failure'));
      else resolve();
    });
  });
}

export class NativeStepPreview {
  private active?: { controller: AbortController; done: Promise<WorkbenchResult> };

  constructor(private readonly config: StepPreviewConverter) {
    if (process.platform !== 'linux' || !isAbsolute(config.executable) || ![1, 8].includes(config.threads))
      throw new Error('Invalid native STEP converter configuration');
  }

  async run(root: string, path: string, reauthorize: () => Promise<void>, signal?: AbortSignal): Promise<WorkbenchResult> {
    if (typeof path !== 'string' || !/\.(?:step|stp)$/i.test(path)) throw new Error('preview_unavailable');
    if (this.active) throw new WorkspaceHostError('Native STEP conversion capacity reached', 'capacity');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('parser_timeout')), 60_000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const done = this.preview(root, path, reauthorize, controller.signal);
    this.active = { controller, done };
    try { return await done; }
    finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      this.active = undefined;
    }
  }

  async cancel() {
    const active = this.active;
    active?.controller.abort();
    await active?.done.catch(() => {});
  }

  private async preview(root: string, path: string, reauthorize: () => Promise<void>, signal: AbortSignal): Promise<WorkbenchResult> {
    const dir = await mkdtemp(join(tmpdir(), 'rustx-step-preview-'));
    try {
      signal.throwIfAborted();
      const fd = openPreviewPath(root, path);
      try {
        const source = fstatSync(fd, { bigint: true });
        if (!source.isFile() || source.size < 1n) throw new WorkspaceHostError('Source is not a regular STEP file', 'source_unavailable');
        if (source.size > BigInt(FILE_PREVIEW_LIMITS.geometryBytes)) throw new Error('too_large');
        const version = descriptorVersion(fd, source);
        const start = performance.now();
        await convert(this.config, fd, dir, signal);
        const processMs = performance.now() - start;
        const output = join(dir, 'preview.glb');
        const { size } = await stat(output);
        if (size < 20) throw new Error('parser_failure');
        if (size > FILE_PREVIEW_LIMITS.convertedPdfBytes) throw new Error('too_large');
        const timingPath = join(dir, 'timing.json');
        if ((await stat(timingPath)).size > 4096) throw new Error('parser_failure');
        const timing = JSON.parse(await readFile(timingPath, 'utf8')) as Omit<StepPreviewTiming, 'processMs'>;
        const data = new Uint8Array(await readFile(output));
        if (data.byteLength !== size) throw new Error('parser_failure');
        await reauthorize();
        signal.throwIfAborted();
        const current = openPreviewPath(root, path);
        try {
          if (descriptorVersion(fd) !== version || descriptorVersion(current) !== version)
            throw new WorkspaceHostError('Source changed during STEP conversion', 'source_changed');
        } finally { closeSync(current); }
        return { cwd: root, preview: { data, version, bytes: size, offset: 0, eof: true }, stepTiming: { ...timing, processMs } };
      } finally { closeSync(fd); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}
