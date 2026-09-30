import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncTex } from '../../src/latex/synctex';

const text = readFileSync(resolve(process.cwd(), 'tests/unit/fixtures/sample.synctex'), 'utf8');

describe('SyncTex', () => {
  const s = SyncTex.parse(text);

  it('maps inputs to project paths', () => {
    expect(s.inputs.get(1)).toBe('main.tex');
    expect(s.inputs.get(10)).toBe('chapters/one.tex');
    expect(s.inputs.has(2)).toBe(false); // article.cls is a TeX Live file
  });

  it('forward search finds the line on page 1 in PDF points', () => {
    const rects = s.forward('main.tex', 5);
    expect(rects).toHaveLength(1);
    const r = rects[0];
    expect(r.page).toBe(1);
    // Letter paper is 612×792 bp; text lives inside the margins.
    expect(r.x).toBeGreaterThan(50);
    expect(r.x + r.w).toBeLessThan(612);
    expect(r.y).toBeGreaterThan(50);
    expect(r.y).toBeLessThan(400);
  });

  it('inverse search round-trips a forward result', () => {
    const r = s.forward('chapters/one.tex', 2)[0];
    const hit = s.inverse(r.page, r.x + 5, r.y + r.h / 2);
    expect(hit).toEqual({ file: 'chapters/one.tex', line: 2 });
  });

  it('falls back to the nearest line with output', () => {
    const rects = s.forward('main.tex', 3); // \begin{document} produces nothing itself
    expect(rects.length).toBeGreaterThan(0);
  });
});
