/**
 * Monaco bootstrap: core editor + contributions only (no bundled language
 * services), our own LaTeX/BibTeX languages, and TexBrowser themes.
 * Everything is bundled locally — no CDN.
 */
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

const MATH_ENVS = 'equation\\*?|align\\*?|gather\\*?|multline\\*?|flalign\\*?|alignat\\*?|eqnarray\\*?|displaymath|math|dmath\\*?';
const VERBATIM_ENVS = 'verbatim\\*?|Verbatim|lstlisting|minted|comment|filecontents\\*?';

const latexTokens: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.latex',
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
  ],
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [new RegExp(`(\\\\begin)(\\s*)(\\{)(${VERBATIM_ENVS})(\\})`), ['keyword.env', '', 'delimiter.curly', { token: 'type.env', next: '@verbatim.$4' }, 'delimiter.curly']],
      [new RegExp(`(\\\\begin)(\\s*)(\\{)(${MATH_ENVS})(\\})`), ['keyword.env', '', 'delimiter.curly', { token: 'type.env', next: '@mathenv.$4' }, 'delimiter.curly']],
      [/(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/, ['keyword.env', '', 'delimiter.curly', 'type.env', 'delimiter.curly']],
      [/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|frametitle|title|maketitle|caption)\*?(?![a-zA-Z@])/, 'keyword.section'],
      [/\\(?:label|ref|eqref|pageref|autoref|nameref|cref|Cref|vref|cite[a-zA-Z]*|[a-z]*cite|nocite|footcite|parencite|textcite)\*?(?![a-zA-Z@])/, 'keyword.ref'],
      [/\\(?:documentclass|usepackage|RequirePackage|input|include|includeonly|includegraphics|bibliography|bibliographystyle|addbibresource|printbibliography|usetikzlibrary)(?![a-zA-Z@])/, 'keyword.control'],
      [/\\(?:def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|makeatletter|makeatother|expandafter|noexpand|csname|endcsname|relax|numexpr|dimexpr|glueexpr|the|advance|multiply|divide|ifx|ifnum|ifdim|ifcase|ifdefined|ifcsname|if[a-zA-Z@]*|else|or|fi|unless|global|long|protected|begingroup|endgroup|NewDocumentCommand|ExplSyntaxOn|ExplSyntaxOff)(?![a-zA-Z@])/, 'keyword.primitive'],
      [/\\[a-zA-Z@]+\*?/, 'keyword'],
      [/\\./, 'keyword.escape'],
      [/\$\$/, { token: 'string.math.delim', next: '@displaymath' }],
      [/\$/, { token: 'string.math.delim', next: '@inlinemath' }],
      [/\\\[/, { token: 'string.math.delim', next: '@bracketmath' }],
      [/\\\(/, { token: 'string.math.delim', next: '@parenmath' }],
      [/[{}]/, 'delimiter.curly'],
      [/[[\]]/, 'delimiter.square'],
      [/&/, 'delimiter.amp'],
      [/#\d/, 'variable.param'],
      [/~/, 'delimiter.tilde'],
      [/-?\d+(?:\.\d+)?(?:pt|em|ex|cm|mm|in|bp|sp|pc|dd|cc|mu)\b/, 'number'],
    ],
    mathcommon: [
      [/%.*$/, 'comment'],
      [/\\(?:label|ref|eqref|tag)(?![a-zA-Z@])/, 'keyword.ref'],
      [/\\[a-zA-Z@]+\*?/, 'string.math.command'],
      [/\\./, 'string.math.command'],
      [/[{}]/, 'delimiter.curly'],
      [/&/, 'delimiter.amp'],
      [/[_^]/, 'string.math.op'],
    ],
    inlinemath: [[/\$/, { token: 'string.math.delim', next: '@pop' }], { include: '@mathcommon' }, [/[^$\\{}%&_^]+/, 'string.math']],
    displaymath: [[/\$\$/, { token: 'string.math.delim', next: '@pop' }], { include: '@mathcommon' }, [/[^$\\{}%&_^]+/, 'string.math'], [/\$/, 'string.math']],
    bracketmath: [[/\\\]/, { token: 'string.math.delim', next: '@pop' }], { include: '@mathcommon' }, [/[^\\{}%&_^]+/, 'string.math']],
    parenmath: [[/\\\)/, { token: 'string.math.delim', next: '@pop' }], { include: '@mathcommon' }, [/[^\\{}%&_^]+/, 'string.math']],
    mathenv: [
      [/(\\end)(\s*)(\{)([^}]*)(\})/, { cases: { '$4==$S2': ['keyword.env', '', 'delimiter.curly', { token: 'type.env', next: '@pop' }, 'delimiter.curly'], '@default': ['keyword.env', '', 'delimiter.curly', 'type.env', 'delimiter.curly'] } }],
      [/(\\begin)(\s*)(\{)([^}]*)(\})/, ['keyword.env', '', 'delimiter.curly', 'type.env', 'delimiter.curly']],
      { include: '@mathcommon' },
      [/[^\\{}%&_^]+/, 'string.math'],
    ],
    verbatim: [
      [/(\\end)(\s*)(\{)([^}]*)(\})/, { cases: { '$4==$S2': ['keyword.env', '', 'delimiter.curly', { token: 'type.env', next: '@pop' }, 'delimiter.curly'], '@default': 'string.verbatim' } }],
      [/[^\\]+/, 'string.verbatim'],
      [/./, 'string.verbatim'],
    ],
  },
};

const latexConfig: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '%' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$', notIn: ['string', 'comment'] },
    { open: '`', close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '$', close: '$' },
  ],
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  folding: {
    markers: { start: /^\s*%\s*#?region\b/, end: /^\s*%\s*#?endregion\b/ },
  },
  onEnterRules: [],
};

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

const bibtexTokens: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.bib',
  ignoreCase: true,
  tokenizer: {
    root: [
      [/%.*$/, 'comment'],
      [/(@\w+)(\s*)(\{)(\s*)([^,\s]+)/, ['keyword', '', 'delimiter.curly', '', 'type.key']],
      [/(@\w+)/, 'keyword'],
      [/([a-zA-Z_-]+)(\s*)(=)/, ['attribute.name', '', 'delimiter']],
      [/\{/, { token: 'string', next: '@brace' }],
      [/"/, { token: 'string', next: '@quoted' }],
      [/\d+/, 'number'],
      [/[},]/, 'delimiter'],
    ],
    brace: [
      [/\{/, { token: 'string', next: '@push' }],
      [/\}/, { token: 'string', next: '@pop' }],
      [/\\[a-zA-Z]+/, 'string.escape'],
      [/[^{}\\]+/, 'string'],
      [/./, 'string'],
    ],
    quoted: [
      [/"/, { token: 'string', next: '@pop' }],
      [/[^"]+/, 'string'],
    ],
  },
};

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

monaco.editor.defineTheme('texbrowser-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f6a82', fontStyle: 'italic' },
    { token: 'keyword', foreground: '82aaff' },
    { token: 'keyword.escape', foreground: 'f78c6c' },
    { token: 'keyword.section', foreground: 'c792ea', fontStyle: 'bold' },
    { token: 'keyword.ref', foreground: '4dd0e1' },
    { token: 'keyword.control', foreground: 'ff79c6' },
    { token: 'keyword.primitive', foreground: 'ff6b8b' },
    { token: 'keyword.env', foreground: 'c792ea' },
    { token: 'type.env', foreground: 'ffcb6b' },
    { token: 'type.key', foreground: 'ffcb6b', fontStyle: 'bold' },
    { token: 'string.math', foreground: 'a5e075' },
    { token: 'string.math.delim', foreground: '7ee787', fontStyle: 'bold' },
    { token: 'string.math.command', foreground: '7ee787' },
    { token: 'string.math.op', foreground: 'ff9e64' },
    { token: 'string.verbatim', foreground: 'b4bcd0' },
    { token: 'string', foreground: 'c3e88d' },
    { token: 'attribute.name', foreground: '82aaff' },
    { token: 'number', foreground: 'f78c6c' },
    { token: 'delimiter.curly', foreground: '89ddff' },
    { token: 'delimiter.square', foreground: '89ddff' },
    { token: 'delimiter.amp', foreground: 'ff9e64', fontStyle: 'bold' },
    { token: 'variable.param', foreground: 'ff6b8b' },
  ],
  colors: {
    'editor.background': '#0f1219',
    'editor.foreground': '#dfe3ee',
    'editorLineNumber.foreground': '#3c4458',
    'editorLineNumber.activeForeground': '#9aa4bb',
    'editor.lineHighlightBackground': '#161c28',
    'editor.selectionBackground': '#7c6cff40',
    'editor.inactiveSelectionBackground': '#7c6cff22',
    'editorCursor.foreground': '#a79dff',
    'editorIndentGuide.background1': '#1d2432',
    'editorBracketMatch.background': '#7c6cff30',
    'editorBracketMatch.border': '#7c6cff90',
    'editorWidget.background': '#141923',
    'editorWidget.border': '#262e40',
    'editorSuggestWidget.background': '#141923',
    'editorSuggestWidget.selectedBackground': '#232b3d',
    'editorHoverWidget.background': '#141923',
    'editorGutter.background': '#0f1219',
    'scrollbarSlider.background': '#ffffff14',
    'minimap.background': '#0f1219',
  },
});

monaco.editor.defineTheme('texbrowser-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8a93a6', fontStyle: 'italic' },
    { token: 'keyword', foreground: '2f5bd3' },
    { token: 'keyword.escape', foreground: 'c2410c' },
    { token: 'keyword.section', foreground: '7c3aed', fontStyle: 'bold' },
    { token: 'keyword.ref', foreground: '0e7490' },
    { token: 'keyword.control', foreground: 'be185d' },
    { token: 'keyword.primitive', foreground: 'dc2626' },
    { token: 'keyword.env', foreground: '7c3aed' },
    { token: 'type.env', foreground: 'b45309' },
    { token: 'type.key', foreground: 'b45309', fontStyle: 'bold' },
    { token: 'string.math', foreground: '15803d' },
    { token: 'string.math.delim', foreground: '15803d', fontStyle: 'bold' },
    { token: 'string.math.command', foreground: '166534' },
    { token: 'string.math.op', foreground: 'c2410c' },
    { token: 'string.verbatim', foreground: '475569' },
    { token: 'string', foreground: '15803d' },
    { token: 'attribute.name', foreground: '2f5bd3' },
    { token: 'number', foreground: 'c2410c' },
    { token: 'delimiter.curly', foreground: '0369a1' },
    { token: 'delimiter.square', foreground: '0369a1' },
    { token: 'delimiter.amp', foreground: 'c2410c', fontStyle: 'bold' },
    { token: 'variable.param', foreground: 'dc2626' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f4f5fa',
    'editorLineNumber.foreground': '#b6bccb',
    'editor.selectionBackground': '#5b4cf033',
  },
});

let registered = false;
export function registerLanguages() {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: 'latex', extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbl'], aliases: ['LaTeX', 'TeX'] });
  monaco.languages.setMonarchTokensProvider('latex', latexTokens);
  monaco.languages.setLanguageConfiguration('latex', latexConfig);
  monaco.languages.register({ id: 'bibtex', extensions: ['.bib'], aliases: ['BibTeX'] });
  monaco.languages.setMonarchTokensProvider('bibtex', bibtexTokens);
  monaco.languages.setLanguageConfiguration('bibtex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"' },
    ],
  });
}

export { monaco };
