# TexBrowser IDE

**A LaTeX IDE that runs entirely in your browser, with a real TeX engine compiled to WebAssembly.**
No server, no account, no upload. Your documents stay on your machine unless you push them to your own GitHub.

- **Real TeX Live.** pdfTeX, XeTeX, BibTeX and makeindex run as WebAssembly in a background thread and produce a native PDF. Low-level primitives (`\makeatletter`, `\dimexpr`, `\ifcase`, …) and heavy packages (geometry, fancyhdr, titlesec, enumitem, TikZ/pgfplots, biblatex, siunitx, beamer, …) work because it *is* TeX.
- **About 2,000 packages on demand.** The IDE scans your preamble and the TeX log, then fetches only the packages and fonts a document needs, and caches them for offline use.
- **Notion-style `/` commands.** Type `/` at the start of a line for 50+ blocks (tables, matrices, equations, figures, TikZ, theorems, citations, beamer frames…). Tables and matrices open visual wizards with live previews.
- **Beginner-friendly errors.** TeX errors are explained in plain English, with one-click fixes such as *Add `\usepackage{siunitx}`*.
- **Expert-friendly tooling.** Monaco editor, SyncTeX (Ctrl+Alt+J to jump source→PDF; double-click the PDF to jump back), a document outline, a log and problems panel, multi-file projects, version history and diffs.
- **Your storage.** Projects live in IndexedDB. You can save to disk, load files, folders and `.zip`s, and push to or pull from a GitHub repository or Gist with a personal access token, all through client-side `fetch`.

---

## Architecture

```
┌───────────────────────────── Main thread (React 19) ─────────────────────────────┐
│  Monaco editor ── slash menu / wizards / KaTeX math preview / diagnostics        │
│  Workspace (in-memory VFS) ⇄ IndexedDB (debounced persistence, history)          │
│  pdf.js viewer ── text layer, SyncTeX forward/inverse search                     │
│  GitHub client (REST + Git Data API via fetch)   Local disk (File API, zip)      │
│                          │ postMessage (files in, PDF/log/SyncTeX out)           │
└──────────────────────────┼───────────────────────────────────────────────────────┘
┌──────────────────────────▼──────── Web Worker (tex.worker.ts) ───────────────────┐
│  TexCompiler: latexmk-style loop — pdflatex/xelatex → bibtex8 → makeindex →      │
│  rerun while .aux/.toc/.out change; missing-file resolution → fetch → rerun      │
│  BusyTexHost: one Emscripten multi-call WASM binary (pdfTeX, XeTeX, bibtex8,     │
│  makeindex, xdvipdfmx) + MEMFS; heap snapshot restored between tool runs         │
│    /texlive           TeX Live basic (preloaded data package, 72 MB)             │
│    /texmf/texmf-dist  Ubuntu collections, mounted when a document needs them     │
│    /texmf-shelf       per-package bundles fetched from the shelf on demand       │
│    /home/web_user/project   your files, synced incrementally from the VFS        │
└──────────────────────────────────────────────────────────────────────────────────┘
          ▲ Cache API (engine + shelf are downloaded once, then work offline)
   Static files on GitHub Pages: /engine (WASM + data packages), /shelf (bundles)
```

### 1. In-browser TeX → PDF

Browser-side TeX usually means a JavaScript re-implementation (latex.js) that outputs HTML and cannot run real macros. TexBrowser runs the actual TeX Live programs instead:

- **Engine.** [BusyTeX](https://github.com/busytex/busytex) builds pdfTeX, XeTeX, bibtex8, makeindex and xdvipdfmx into a single Emscripten binary. `scripts/fetch-engine.mjs` downloads a pinned build (TeX Live 2022), checks every file against its SHA-256, and writes `public/engine/manifest.json`.
- **Fast reruns.** The WASM module is instantiated once. After each tool run, the worker restores a snapshot of the low heap instead of re-instantiating (about 70 ms), so a latexmk loop of several passes stays interactive. kpathsea gets runtime-generated `ls-R` databases, which cut an incremental compile from 3.3 s to about 1.2 s.
- **The package shelf.** `scripts/build-shelf.mjs` turns a TeX Live installation into about 2,000 small `.tgz` bundles (one per package, with a dependency graph, a font-name index and a merged `pdftex.map`), about 156 MB in total. Before compiling, the worker scans the sources for `\usepackage`, `\documentclass`, `\RequirePackage`, fonts and bib styles. After each pass it reads the log for missing files, fetches the bundles that provide them, and reruns. Large upstream collections are mounted whole when that is cheaper.
- **XeLaTeX** runs `xelatex -no-pdf` then `xdvipdfmx`, with a generated `fonts.conf`. **BibTeX** is `bibtex8 --8bit --huge`, and biblatex uses its BibTeX backend (biber is not available in WASM).
- **Output** is a real PDF plus `synctex.gz`. Aux files are kept between compiles, so edits usually need one pass.

### 2. Web Workers and responsiveness

All compilation happens in `src/engine/tex.worker.ts`. `EngineClient` owns the worker. It streams progress and TeX output to the console panel, coalesces compile requests made while one is running, enforces a timeout, and implements **Stop** by terminating and respawning the worker. If the WASM runtime crashes, the worker recreates the host and the next compile starts clean. Monaco's language services and pdf.js each run in their own workers too.

### 3. Virtual file system

`src/state/workspace.ts` holds the project in memory (text and binary files, folders) and persists changes to IndexedDB (`src/storage/db.ts`) after a short debounce. Before each compile the worker receives only the files whose fingerprints changed and writes them into Emscripten's MEMFS under the project directory. That is why `\includegraphics{images/chart.png}`, `\input{chapters/intro}` and `\bibliography{references}` resolve exactly as they do on disk. Dropped or uploaded images and `.bib` files go into the same VFS.

### 4. Storage and sync

| | How |
|---|---|
| Local disk | Download the active file, the PDF, or the whole project as `.zip`. Import files, folders or `.zip` archives (File API / drag and drop). |
| GitHub repo | PAT (fine-grained, *Contents: read & write*). Push creates blobs → tree → commit → ref update in **one commit**. Pull and open work from any `owner/repo[/path]`, anonymously for public repos. Conflicts are detected against the last synced blob SHAs, and a pull takes a history snapshot first. |
| Gist | Save a project to a new or existing Gist (paths and binary files are encoded in a manifest) and open Gists by URL or id. |
| History | Automatic and named snapshots in IndexedDB, with a side-by-side diff and restore. |

The token is kept in `sessionStorage` by default, or in `localStorage` if you tick *Remember*. It is only sent to `api.github.com`.

### Source map

```
src/engine/    worker, compiler loop, BusyTeX host, shelf/scan/missing-file resolution, caches
src/editor/    Monaco setup, LaTeX/BibTeX language, completions, slash commands + menu
src/pdf/       pdf.js viewer and PDF pane (toolbar, error overlay, boot progress)
src/latex/     log parser, plain-English error explanations, SyncTeX, BibTeX parser, outline
src/state/     zustand store, workspace (VFS), actions, GitHub actions
src/storage/   IndexedDB, history snapshots, local disk, GitHub client
src/components/ file tree, panels, dialogs, wizards, UI kit
scripts/       fetch-engine.mjs, build-shelf.mjs
tests/unit/    vitest (log parser, SyncTeX, scanner, tar, GitHub client, workspace…)
tests/e2e/     Playwright: engine documents + full UI walkthrough with the real engine
```

---

## Running locally

Requires Node 22+. To build the package shelf you also need a TeX Live installation; Ubuntu 24.04 packages work.

```bash
npm install
npm run engine:fetch          # ~180 MB WASM engine → public/engine (pinned, SHA-256 verified)

# optional but recommended: the on-demand package shelf → public/shelf
sudo apt-get install --no-install-recommends texlive-latex-extra texlive-pictures \
  texlive-science texlive-bibtex-extra texlive-fonts-recommended texlive-lang-greek cm-super
npm run shelf:build -- --texmf /usr/share/texlive/texmf-dist --texmf /usr/share/texmf \
  --map /var/lib/texmf/fonts/map/pdftex/updmap/pdftex.map --label "TeX Live 2023 (Ubuntu 24.04)"

npm run dev                   # http://localhost:5173
```

Without a shelf the IDE still compiles everything in TeX Live basic and the bundled collections (LaTeX base/recommended/extra, science, recommended fonts). The shelf adds the rest: pgf/TikZ, pgfplots, biblatex, cm-super fonts and more.

| Command | |
|---|---|
| `npm run build` | Typecheck and production build into `dist/` (engine and shelf are copied from `public/`) |
| `npm test` | Unit tests (vitest) |
| `npm run e2e [-- --prod] [-- --only ui\|engine]` | Browser tests with the real engine (Playwright + Chromium) |

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` builds, tests and publishes the site:

1. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to the default branch, or run the workflow manually.

The workflow fetches the engine, installs TeX Live on the runner to build the shelf, runs unit tests and both end-to-end suites against the production build, then deploys. The site is about 350 MB, within the 1 GB Pages limit. The build uses relative asset paths, so it works under `https://<user>.github.io/<repo>/` without configuration.

## Limitations

- **LuaLaTeX** is disabled: the pinned TeX Live 2022 build cannot load its Lua format. **biber** does not exist for WASM, so use `backend=bibtex` with biblatex (the IDE suggests this automatically).
- The first visit downloads about 80 MB (the engine and TeX Live basic). After that everything is served from the browser cache and works offline.
- The shelf is built from TeX Live 2023 while the engine's format files are TeX Live 2022. Packages are fetched only when the engine lacks them, so this mismatch has not caused failures in testing.
- `\write18` / shell escape is disabled (minted and similar packages will not work).

## Licenses

TexBrowser IDE is MIT licensed (see `LICENSE`). The engine binaries and TeX Live files downloaded by the build scripts keep their own licenses: TeX Live components are under their respective free licenses, and BusyTeX's build scripts are MIT. The optional experimental `texlyre` engine profile in `scripts/fetch-engine.mjs` downloads AGPL-3.0 assets and is not used by default.
