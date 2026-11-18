// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeStepPreview } from '../host/step-preview';

const testOnLinux = test.runIf(process.platform === 'linux');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rustx-step-preview-test-'));
  roots.push(root);
  const executable = join(root, 'converter');
  const file = join(root, 'model.step');
  await writeFile(file, 'assigned original');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.readFileSync(3);
if (input.toString() === 'wait for cancel') {
  fs.writeFileSync(${JSON.stringify(join(root, 'started'))}, 'yes');
  setInterval(() => {}, 1000);
} else {
  const output = Buffer.alloc(24);
  input.copy(output);
  fs.writeFileSync('preview.glb', output);
  fs.writeFileSync('timing.json', '{"occt":"fixture","threads":1}');
}
`);
  await chmod(executable, 0o700);
  return { root, file, preview: new NativeStepPreview({ executable, threads: 1 }) };
}

testOnLinux('converts the authorized descriptor and rechecks the source before responding', async () => {
  const { root, preview } = await fixture();
  let checked = 0;
  const result = await preview.run(root, 'model.step', async () => { checked++; });
  expect(checked).toBe(1);
  expect(Buffer.from(result.preview!.data).subarray(0, 17).toString()).toBe('assigned original');
  expect(result.preview?.bytes).toBe(24);
  expect(result.stepTiming?.threads).toBe(1);
});

testOnLinux('discards a conversion if authorization is revoked or the source is replaced', async () => {
  const { root, file, preview } = await fixture();
  await expect(preview.run(root, 'model.step', async () => { throw new Error('authorization_revoked'); }))
    .rejects.toThrow('authorization_revoked');
  await expect(preview.run(root, 'model.step', async () => {
    await rename(file, join(root, 'old.step'));
    await writeFile(file, 'replacement');
  })).rejects.toThrow('Source changed');
  await symlink('old.step', join(root, 'linked.step'));
  await expect(preview.run(root, 'linked.step', async () => {})).rejects.toThrow();
});

testOnLinux('waits for canceled conversion to exit before admitting a replacement', async () => {
  const { root, file, preview } = await fixture();
  await writeFile(file, 'wait for cancel');
  const current = preview.run(root, 'model.step', async () => {});
  void current.catch(() => {});
  await expect.poll(() => readFile(join(root, 'started'), 'utf8').catch(() => '')).toBe('yes');
  await expect(preview.run(root, 'model.step', async () => {})).rejects.toThrow('capacity');
  await preview.cancel();
  await expect(current).rejects.toThrow();
  await writeFile(file, 'assigned original');
  await expect(preview.run(root, 'model.step', async () => {})).resolves.toHaveProperty('preview');
});
