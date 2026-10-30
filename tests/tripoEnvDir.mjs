// tripoProxy.test.ts 用：在临时目录里写几个 env 文件（.env、.env.local……），用完删掉
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeEnvDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tripo-env-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
