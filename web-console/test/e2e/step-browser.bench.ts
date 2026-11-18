import { chromium, expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { startDogfood } from './dogfood-server';
import { instrument, observeGeometryLatency, resources } from './geometry-observation';
import { connectRemote, openEmptySession } from './shell-actions';

interface Fixture { id: string; path: string; control?: boolean; variants?: string[] }
interface Benchmark {
  builds: { baseline: string; lexer: string };
  native?: { dist: string; executable: string };
  fixtures: Fixture[];
  output: string;
  executablePath?: string;
  softwareWebGL?: boolean;
  repetitions?: number;
  diagnosticRepetitions?: number;
}

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function serve(dir: string, hostConfigFile: string) {
  const reservation = createServer();
  await new Promise<void>((done, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', done));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing preview server port');
  await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port',
    String(address.port), '--strictPort', '--outDir', resolve(dir)], {
    env: { ...process.env, RUSTX_WORKSPACE_HOST_CONFIG: hostConfigFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const exited = new Promise<void>(done => child.once('close', () => done()));
  const stop = async () => { child.kill('SIGTERM'); await exited; };
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Preview server exited: ${stderr}`);
      return fetch(origin).then(response => response.status, () => 0);
    }, { timeout: 15_000 }).toBe(200);
    return { origin, stop };
  } catch (error) { await stop(); throw error; }
}

/** Observe upload calls and frame metadata without touching bytes or adding GPU copies. */
async function observeUploads(page: Page) {
  await page.addInitScript(() => {
    const frames: { at: number; lod?: string; calls: number; bytes: number; cpuMs: number; firstCallAt: number | null }[] = [];
    const uploads = new WeakMap<HTMLCanvasElement, { calls: number; bytes: number; cpuMs: number; firstCallAt: number }>();
    for (const name of ['bufferData', 'bufferSubData'] as const) {
      const original = WebGL2RenderingContext.prototype[name];
      Object.defineProperty(WebGL2RenderingContext.prototype, name, { value: function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const canvas = this.canvas, data = args[name === 'bufferData' ? 1 : 2];
        if (!(canvas instanceof HTMLCanvasElement) || !ArrayBuffer.isView(data) || !canvas.closest('[data-geometry-format]'))
          return Reflect.apply(original, this, args);
        const start = performance.now();
        const result = Reflect.apply(original, this, args);
        const current = uploads.get(canvas) ?? { calls: 0, bytes: 0, cpuMs: 0, firstCallAt: start };
        current.calls++;
        const elements = args[4];
        const offset = args[3];
        // Three.js sometimes uploads a subrange of a typed array.
        const stride = (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
        current.bytes += typeof elements === 'number' && elements > 0 ? elements * stride : data.byteLength - (typeof offset === 'number' ? offset * stride : 0);
        current.cpuMs += performance.now() - start;
        uploads.set(canvas, current);
        return result;
      } });
    }
    document.addEventListener('geometry-test-model-submitted', event => {
      const canvas = (event as CustomEvent).detail;
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.closest('[data-geometry-format]') || frames.length >= 128) return;
      const upload = uploads.get(canvas);
      frames.push({ at: performance.now(), lod: canvas.dataset.geometryLod, calls: upload?.calls ?? 0,
        bytes: upload?.bytes ?? 0, cpuMs: upload?.cpuMs ?? 0, firstCallAt: upload?.firstCallAt ?? null });
      uploads.delete(canvas);
    });
    Object.assign(window, { stepUploadFrames: frames });
  });
}

async function sample(page: Page, name: string, bytes: number, warm: boolean, diagnostic: boolean, native: boolean) {
  const selector = `[data-files-path="${name}"] > button`;
  await observeGeometryLatency(page, selector, 'click');
  const previous = await page.evaluate(() => {
    performance.clearResourceTimings();
    performance.clearMarks('geometry:native-step');
    performance.setResourceTimingBufferSize(2_000);
    for (const name of ['geometry:cad-code-compile', 'geometry:cad-code-wait', 'geometry:display-prepare:step']) performance.clearMeasures(name);
    const observation = window as any;
    return { imports: observation.geometryImports.length, frames: observation.geometryModelFrames.length, uploads: observation.stepUploadFrames.length, lods: observation.geometryLods.length };
  });
  await page.locator(selector).click();
  const file = page.locator(`[data-workbench-file="${name}"]`);
  await page.waitForFunction(name => {
    const state = (window as any).geometryLatency;
    return state.first > 0 || document.querySelector(`[data-workbench-file="${name}"] [role=alert]`);
  }, name, { timeout: 100_000 });
  const failure = file.getByRole('alert');
  const error = await failure.first().isVisible() ? await failure.first().textContent() : null;
  const result = await page.evaluate(previous => {
    const observation = window as any;
    const { start, firstModel, firstModelGpuReady, firstModelSubmission, first, firstGpuReady, firstSubmission, lodStages } = observation.geometryLatency;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const method = (entry: PerformanceResourceTiming) => new URL(entry.name).pathname.split('/').at(-1);
    const sinceClick = resources.filter(entry => entry.startTime >= start);
    const open = sinceClick.find(entry => method(entry) === 'preview-open');
    const close = sinceClick.find(entry => method(entry) === 'preview-close');
    const pages = sinceClick.filter(entry => method(entry) === 'preview-read');
    const wasm = sinceClick.filter(entry => method(entry)?.endsWith('.wasm'));
    const conversion = sinceClick.find(entry => method(entry) === 'workbench-preview');
    const nativeTiming = (performance.getEntriesByName('geometry:native-step')[0] as PerformanceMark | undefined)?.detail;
    const shapeBody = document.querySelector('[data-geometry-format]');
    const measures = performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('geometry:'))
      .map(entry => ({ name: entry.name, startMs: entry.startTime - start, ms: entry.duration }));
    const imports = observation.geometryImports.slice(previous.imports);
    const importsTiming = observation.geometryImportTimings.slice(previous.imports).map((entry: any) =>
      ({ startedMs: entry.startedAt - start, completedMs: entry.completedAt - start, elapsedMs: entry.elapsedMs, profile: entry.profile }));
    const frames = observation.geometryModelFrames.slice(previous.frames).map((frame: any) => ({ ...frame, ms: frame.ms - start }));
    const uploads = observation.stepUploadFrames.slice(previous.uploads).map((frame: any) =>
      ({ ...frame, at: frame.at - start, firstCallAt: frame.firstCallAt === null ? null : frame.firstCallAt - start }));
    const lods = observation.geometryLods.slice(previous.lods).map((entry: any) => ({ level: entry.level, triangles: entry.triangles, receivedMs: entry.at - start }));
    const gl = shapeBody?.querySelector('canvas')?.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      first: { submissionMs: firstModelSubmission, gpuReadyMs: firstModelGpuReady, displayProxyMs: firstModel },
      final: { submissionMs: firstSubmission, gpuReadyMs: firstGpuReady, displayProxyMs: first }, lodStages,
      source: open && close ? { startedMs: open.startTime - start, settledMs: close.responseEnd - start,
        ms: close.responseEnd - open.startTime, pages: pages.length, encodedBytes: pages.reduce((sum, page) => sum + page.encodedBodySize, 0) } : null,
      wasm: wasm.map(entry => ({ asset: method(entry), startedMs: entry.startTime - start, ms: entry.duration, transferBytes: entry.transferSize })),
      measures, gpu: debug && gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL), lods, frames, uploads,
      nativeTiming,
      nativeCarrier: conversion && { startedMs: conversion.startTime - start, settledMs: conversion.responseEnd - start,
        durationMs: conversion.duration, bytes: conversion.encodedBodySize },
      bounds: [...(shapeBody?.querySelectorAll('p[title]') ?? [])].map(p => p.getAttribute('title')),
      geometry: imports.map((meshes: { triangles: number; vertices: number }[]) => ({
        meshes: meshes.length, triangles: meshes.reduce((n, mesh) => n + mesh.triangles, 0),
        vertices: meshes.reduce((n, mesh) => n + mesh.vertices, 0),
      })),
      worker: importsTiming,
    };
  }, previous);
  if (native) {
    expect(result.source).toBeNull();
    expect(result.wasm).toHaveLength(0);
    if (!error) {
      expect(result.nativeTiming?.processMs).toBeGreaterThan(0);
      expect(result.nativeCarrier?.bytes).toBeGreaterThan(0);
      expect(result.frames.some((frame: { triangles: number }) => frame.triangles > 0)).toBe(true);
      expect(result.first.displayProxyMs).toBeGreaterThan(0);
    }
    return { ...result, error };
  }
  expect(result.source?.pages, 'Read every source page through Product Host').toBe(Math.ceil(bytes / (2 * 1024 * 1024)));
  expect(result.source?.encodedBytes).toBeGreaterThanOrEqual(bytes);
  expect(result.wasm.length).toBe(warm ? 0 : 1);
  if (error) return { ...result, error };
  expect(result.worker).toHaveLength(1);
  expect(result.worker[0].profile.cad.some((entry: { name: string }) => entry.name === 'geometry:cad-initialize')).toBe(true);
  expect(Boolean(result.worker[0].profile.native?.length)).toBe(diagnostic);
  expect(result.geometry).toHaveLength(1);
  expect(result.frames.some((frame: { lod?: string; triangles: number }) => frame.lod === 'full' && frame.triangles > 0)).toBe(true);
  expect(result.first.displayProxyMs).toBeGreaterThan(0);
  expect(result.final.displayProxyMs).toBeGreaterThanOrEqual(result.first.displayProxyMs);
  return { ...result, error };
}

test('paired STEP preview from production Workbench', async () => {
  const manifest = process.env.RUSTX_STEP_BROWSER_BENCHMARK;
  test.skip(!manifest, 'Set RUSTX_STEP_BROWSER_BENCHMARK to a local benchmark JSON manifest.');
  const config: Benchmark = JSON.parse(readFileSync(manifest!, 'utf8'));
  const repetitions = config.repetitions ?? 3, diagnosticRepetitions = config.diagnosticRepetitions ?? 1;
  if (!config.fixtures.length || config.fixtures.some(fixture => !/^[a-z0-9-]+$/.test(fixture.id))
    || new Set(config.fixtures.map(fixture => fixture.id)).size !== config.fixtures.length
    || !Number.isSafeInteger(repetitions) || repetitions < 0 || !Number.isSafeInteger(diagnosticRepetitions) || diagnosticRepetitions < 0
    || repetitions + diagnosticRepetitions === 0)
    throw new Error('Invalid STEP benchmark manifest');
  const cases = await Promise.all(config.fixtures.map(async fixture => ({ id: fixture.id, control: !!fixture.control,
    bytes: statSync(fixture.path).size, sha256: await sha256(fixture.path) })));
  const variants = config.native ? [
    { id: 'wasm', dir: config.builds.lexer },
    { id: 'native-1', dir: config.native.dist, threads: 1 },
    { id: 'native-8', dir: config.native.dist, threads: 8 },
  ] : Object.entries(config.builds).map(([id, dir]) => ({ id, dir, threads: undefined }));
  const buildAssets = await Promise.all(variants.map(async ({ id: build, dir: directory }) => {
    const assets = join(directory, 'assets');
    const files = readdirSync(assets).filter(file => /^occt-import-js-.*\.wasm$/.test(file));
    if (files.length !== 1) throw new Error(`Expected one CAD WASM asset in ${build}`);
    return { build, asset: files[0]!, sha256: await sha256(join(assets, files[0]!)) };
  }));
  if (!config.native && buildAssets[0]?.sha256 === buildAssets[1]?.sha256) throw new Error('The two builds contain the same CAD WASM');
  const graphicsArgs = config.softwareWebGL ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : config.softwareWebGL === false && platform() === 'linux' ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl'] : [];
  if (config.fixtures.some(({ variants: selected }) => selected && (!selected.length ||
    new Set(selected).size !== selected.length || selected.some(id => !variants.some(variant => variant.id === id)))))
    throw new Error('Unknown or repeated STEP benchmark variant');
  const report = { cpu: cpus()[0]?.model, os: `${platform()} ${release()}`, browser: '', cases, buildAssets,
    nativeExecutableSha256: config.native && await sha256(config.native.executable),
    affinity: platform() === 'linux' ? readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] : undefined,
    rows: [] as unknown[], failures: [] as unknown[] };
  const persist = () => {
    const staging = config.output + '.tmp';
    writeFileSync(staging, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    renameSync(staging, config.output);
  };
  for (const diagnostic of [false, true]) {
    for (let round = 0; round < (diagnostic ? diagnosticRepetitions : repetitions); round++) {
      for (const [index, model] of cases.entries()) {
        if (model.control && round > 0) continue;
        const { path, variants: selected } = config.fixtures[index]!;
        for (let lane = 0; lane < variants.length; lane++) {
          const variant = variants[(round + index + lane) % variants.length]!;
          const { id: build, threads } = variant;
          if (selected && !selected.includes(build)) continue;
          // Give each variant a fresh session catalog. Session attachment is
          // setup, outside both click-to-display windows.
          const fixture = await startDogfood();
          let server: Awaited<ReturnType<typeof serve>> | undefined;
          let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
          try {
            for (const mode of ['cold', 'warm']) {
              const copy = join(fixture.workspaceA, `${model.id}-${mode}.step`);
              copyFileSync(path, copy);
              if (await sha256(copy) !== model.sha256) throw new Error(`STEP source changed while staging ${model.id}`);
            }
            if (threads) {
              const hostConfig = JSON.parse(readFileSync(fixture.hostConfigFile, 'utf8'));
              hostConfig.stepPreviewConverter = { executable: config.native!.executable, threads };
              writeFileSync(fixture.hostConfigFile, JSON.stringify(hostConfig), { mode: 0o600 });
            }
            server = await serve(variant.dir, fixture.hostConfigFile);
            browser = await chromium.launch({ executablePath: config.executablePath, args: graphicsArgs });
            report.browser = browser.version();
            const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 1000 },
              storageState: { cookies: [], origins: [{ origin: server.origin, localStorage: [{ name: 'rustx-locale-v1', value: 'en' }] }] } });
            page.setDefaultTimeout(20_000);
            page.setDefaultNavigationTimeout(20_000);
            await instrument(page, diagnostic ? 'native' : true);
            await observeUploads(page);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto(server.origin);
            await connectRemote(page, fixture.endpoint, fixture.token);
            await openEmptySession(page, fixture, 'Workspace A');
            await page.locator('[data-preview-toggle]').click();
            const workbench = page.locator('[data-workbench]');
            await workbench.getByRole('button', { name: /Workspace files/ }).click();
            for (const mode of ['cold', 'warm'] as const) {
              const name = `${model.id}-${mode}.step`;
              try {
                const value = await sample(page, name, model.bytes, mode === 'warm', diagnostic, !!threads);
                if (config.softwareWebGL === false && !value.error)
                  expect(value.gpu, 'Requested hardware WebGL').toMatch(/^(?!.*(?:SwiftShader|llvmpipe|softpipe)).+$/i);
                report.rows.push({ model: model.id, build, mode, round, diagnostic, ...value });
                persist();
                console.log(`${model.id} ${build} ${mode} ${diagnostic ? 'diagnostic' : round}: ${value.error ?? `${value.first.displayProxyMs.toFixed(1)} ms`}`);
                if (mode === 'cold') {
                  const tab = workbench.getByRole('tab', { name, exact: false });
                  await tab.hover();
                  await tab.locator('[data-dockkit-tab-close]').click();
                  await expect(page.locator(`[data-workbench-file="${name}"]`)).toHaveCount(0);
                  await expect.poll(async () => (await resources(page)).contexts).toBe(0);
                  await workbench.getByRole('tab', { name: 'Files', exact: false }).click();
                }
              } catch (error) {
                report.failures.push({ model: model.id, build, mode, round, diagnostic, error: String(error) });
                persist();
                break;
              }
            }
          } catch (error) {
            report.failures.push({ model: model.id, build, mode: 'cold', round, diagnostic, error: String(error) });
            persist();
          } finally {
            try { await browser?.close(); }
            finally {
              try { await server?.stop(); }
              finally { await fixture.stop(false); }
            }
          }
        }
      }
    }
  }
  expect(report.failures).toEqual([]);
});
