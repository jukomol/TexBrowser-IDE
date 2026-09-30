import { describe, expect, it } from 'vitest';
import { Workspace, guessMainFile, looksBinary } from '../../src/state/workspace';
import * as store from '../../src/storage/db';

describe('Workspace', () => {
  it('creates, edits, renames, deletes and persists a project', async () => {
    const meta = await Workspace.create('Test', 'blank', [
      { path: 'main.tex', text: '\\documentclass{article}\\begin{document}Hi\\end{document}' },
      { path: 'img/logo.png', data: new Uint8Array([137, 80, 0]) },
    ]);
    expect(meta.mainFile).toBe('main.tex');
    const ws = await Workspace.open(meta.id);
    expect(ws.paths()).toEqual(['img/logo.png', 'main.tex']);

    ws.setText('main.tex', 'changed');
    ws.writeFile('chapters/one.tex', 'one');
    ws.createFolder('empty');
    expect(ws.folders()).toEqual(['chapters', 'empty', 'img']);
    expect(ws.rename('chapters', 'parts')).toEqual([['chapters/one.tex', 'parts/one.tex']]);
    expect(ws.delete('img')).toEqual(['img/logo.png']);
    ws.rename('main.tex', 'root.tex');
    expect(ws.project.mainFile).toBe('root.tex');
    await ws.flush();

    const again = await Workspace.open(meta.id);
    expect(again.paths()).toEqual(['parts/one.tex', 'root.tex']);
    expect(again.getText('root.tex')).toBe('changed');
    expect(again.folders()).toEqual(['empty', 'parts']);
    expect(again.compileFiles().map((f) => f.path).sort()).toEqual(['parts/one.tex', 'root.tex']);

    await store.deleteProject(meta.id);
    expect(await store.listFiles(meta.id)).toEqual([]);
  });

  it('guesses the main file and sniffs binaries', () => {
    expect(guessMainFile([{ path: 'ch/a.tex', text: 'x' }, { path: 'paper.tex', text: '\\documentclass{x}' }])).toBe('paper.tex');
    expect(looksBinary(new Uint8Array([1, 2, 0]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain'))).toBe(false);
  });
});
