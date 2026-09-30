import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** All .ts/.tsx files under src/. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('React effects', () => {
  // `useEffect(() => expr, deps)` returns expr's value, which React calls as the cleanup.
  // That broke the command palette when Chrome made scrollIntoView() return a Promise.
  it('never use an expression body (only a block, or a returned cleanup function)', () => {
    const offenders: string[] = [];
    for (const file of sources(resolve(process.cwd(), 'src'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/use(Layout)?Effect\(\s*\(\)\s*=>\s*(?![\s{]|\(\)\s*=>)/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
