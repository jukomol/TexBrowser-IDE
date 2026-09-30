// Documents exercised by the engine end-to-end test (tests/e2e/engine.mjs).
export const DOCS = {
  macros: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage[margin=2cm]{geometry}
\usepackage{fancyhdr}\pagestyle{fancy}\fancyhead[L]{TexBrowser}\fancyhead[R]{\thepage}
\usepackage{titlesec}\titleformat{\section}{\Large\bfseries\sffamily}{\thesection}{1em}{}
\usepackage{enumitem}
\makeatletter
\newcommand\checkopt{\@ifnextchar[{\@checkopt}{\@checkopt[none]}}
\def\@checkopt[#1]{(opt=#1)}
\makeatother
\newcount\n \n=2
\begin{document}
\section{Low-level macros}\label{sec:low}
Dimexpr: \the\dimexpr 1pt*3+2pt\relax. Numexpr: \the\numexpr 7*6\relax.
Case: \ifcase\n zero\or one\or two\else many\fi. \checkopt \checkopt[x].
\begin{itemize}[leftmargin=2.4em, label=$\triangleright$]\item one \item two\end{itemize}
See Section~\ref{sec:low} and \cite{knuth,lamport}.
\bibliographystyle{plain}\bibliography{refs}
\end{document}`,
      'refs.bib': `@book{knuth, author={Donald E. Knuth}, title={The {\\TeX}book}, publisher={Addison-Wesley}, year={1984}}
@book{lamport, author={Leslie Lamport}, title={{\\LaTeX}: A Document Preparation System}, publisher={Addison-Wesley}, year={1994}}`,
    },
    expect: { status: ['success', 'warnings'], logExcludes: ['undefined references', 'Citation'], passesAtLeast: 2 },
  },
  t1fonts: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\begin{document}
\section{Café}
Ünïcödé-ish text with T1 fonts \textdegree{} \textbullet{} « guillemets ».
\end{document}`,
    },
    expect: { status: ['success', 'warnings'], fetchedIncludes: 'font:sfrm1000.pfb' },
  },
  tikz: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{arrows,positioning,shapes.geometric}
\usepackage{pgfplots}\pgfplotsset{compat=1.17}
\begin{document}
\begin{tikzpicture}[node distance=2cm]
\node[draw, circle] (a) {A};
\node[draw, rectangle, right=of a] (b) {B};
\draw[->] (a) -- (b);
\end{tikzpicture}
\begin{tikzpicture}\begin{axis}[width=6cm]\addplot {x^2};\end{axis}\end{tikzpicture}
\end{document}`,
    },
    expect: { status: ['success', 'warnings'], fetchedIncludes: 'pgf' },
  },
  biblatex: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage[backend=bibtex,style=numeric]{biblatex}
\addbibresource{refs.bib}
\begin{document}
Cite \cite{knuth}.
\printbibliography
\end{document}`,
      'refs.bib': `@book{knuth, author={Donald E. Knuth}, title={The TeXbook}, publisher={Addison-Wesley}, year={1984}}`,
    },
    expect: { status: ['success', 'warnings'], fetchedIncludes: 'biblatex', logExcludes: ['undefined references'] },
  },
  xelatex: {
    engine: 'xetex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\usepackage{fontspec}
\begin{document}
\section{XeLaTeX}
Unicode: ‘quotes’ — dash, café, naïve, Ελληνικά? $E=mc^2$.
\end{document}`,
    },
    expect: { status: ['success', 'warnings'] },
  },
  errors: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
Hello \undefinedmacro{} world.
\end{document}`,
    },
    expect: { status: ['errors'], logIncludes: ['Undefined control sequence'] },
  },
  multifile: {
    engine: 'pdftex',
    files: {
      'main.tex': String.raw`\documentclass{report}
\usepackage{graphicx}
\usepackage{makeidx}\makeindex
\begin{document}
\tableofcontents
\include{chapters/intro}
\input{chapters/body.tex}
\printindex
\end{document}`,
      'chapters/intro.tex': String.raw`\chapter{Intro}Intro text\index{intro}.`,
      'chapters/body.tex': String.raw`\chapter{Body}\includegraphics[width=2cm]{img/dot.png}\index{body}`,
    },
    binary: { 'img/dot.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    expect: { status: ['success', 'warnings'], passesAtLeast: 2 },
  },
  lualatex: {
    engine: 'luatex',
    files: {
      'main.tex': String.raw`\documentclass{article}
\begin{document}
Hello from Lua\TeX: \directlua{tex.print(6*7)}.
\end{document}`,
    },
    // Not available in the TeX Live 2022 BusyTeX build (see scripts/fetch-engine.mjs).
    expect: { error: 'not available' },
  },
};
