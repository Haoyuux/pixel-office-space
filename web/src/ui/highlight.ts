/**
 * Tiny safe syntax highlighter for code blocks: splits code into tokens (React renders them as text spans — never HTML).
 * Covers C#, TS/JS, HTML/XML, CSS, SQL, JSON, bash and PowerShell; anything else stays plain.
 */
export type TokenClass = 'kw' | 'str' | 'com' | 'num' | 'lit' | 'type' | 'fn' | 'var' | 'tag' | 'attr' | 'key' | 'prop';
export interface Token { text: string; cls?: TokenClass }
export type Lang = 'js' | 'cs' | 'html' | 'css' | 'sql' | 'json' | 'bash' | 'ps';

const ALIAS: Record<string, Lang> = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', javascript: 'js', ts: 'js', tsx: 'js', typescript: 'js',
  cs: 'cs', csharp: 'cs', 'c#': 'cs',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', xaml: 'html', csproj: 'html', razor: 'html', cshtml: 'html',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql', tsql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  json: 'json', jsonc: 'json', json5: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash',
  powershell: 'ps', ps1: 'ps', ps: 'ps', pwsh: 'ps', psm1: 'ps',
};
export const langOf = (info: string): Lang | undefined => ALIAS[info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''];

const words = (s: string) => new Set(s.split(' '));
const JS_KW = words('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield');
const CS_KW = words('abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new object operator out override params partial private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while with yield');
const LIT = words('true false null undefined NaN Infinity');
const SQL_KW = words('add all alter and any as asc begin between by case cast check column commit constraint create cross database declare default delete desc distinct drop else end exec exists foreign from full group having if in index inner insert into is join key left like limit merge not null offset on or order outer over partition primary procedure references returning right rollback select set table then top transaction trigger truncate union unique update use values view when where with');
const BASH_KW = words('if then else elif fi for while until do done case esac in function return local export source alias unset readonly shift break continue exit echo cd');
const PS_KW = words('if else elseif switch foreach for while do until function param begin process end return break continue throw try catch finally trap filter in class enum using');

type Rule = [RegExp, TokenClass | undefined | ((m: string) => TokenClass | undefined)];
const r = (src: string, flags = '') => new RegExp(src, `y${flags}`);

const STR_DQ = '"(?:[^"\\\\\\n]|\\\\.)*"?', STR_SQ = "'(?:[^'\\\\\\n]|\\\\.)*'?";
const NUM = '(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[a-zA-Z]*';
const ident = (kw: Set<string>, ci = false): Rule => [r('[A-Za-z_$@][\\w$]*'), w => {
  const k = ci ? w.toLowerCase() : w;
  if (kw.has(k)) return 'kw';
  if (LIT.has(w) || (ci && LIT.has(k))) return 'lit';
  return /^[A-Z][a-z0-9]/.test(w) ? 'type' : undefined;
}];

const RULES: Record<Lang, Rule[]> = {
  js: [
    [r('//[^\\n]*'), 'com'], [r('/\\*[\\s\\S]*?(?:\\*/|$)'), 'com'],
    [r(STR_DQ), 'str'], [r(STR_SQ), 'str'], [r('`(?:[^`\\\\]|\\\\[\\s\\S])*`?'), 'str'],
    [r(NUM), 'num'], [r('[A-Za-z_$][\\w$]*(?=\\s*\\()'), w => (JS_KW.has(w) ? 'kw' : 'fn')], ident(JS_KW),
  ],
  cs: [
    [r('//[^\\n]*'), 'com'], [r('/\\*[\\s\\S]*?(?:\\*/|$)'), 'com'],
    [r('\\$?@"(?:[^"]|"")*"?'), 'str'], [r('\\$?' + STR_DQ), 'str'], [r("'(?:[^'\\\\\\n]|\\\\.)*'"), 'str'],
    [r('#\\s*(?:region|endregion|if|else|elif|endif|define|nullable|pragma)\\b[^\\n]*'), 'com'],
    [r(NUM), 'num'], [r('[A-Za-z_][\\w]*(?=\\s*\\()'), w => (CS_KW.has(w) ? 'kw' : 'fn')], ident(CS_KW),
  ],
  html: [
    [r('<!--[\\s\\S]*?(?:-->|$)'), 'com'], [r('</?[A-Za-z][\\w:.-]*'), 'tag'], [r('/?>'), 'tag'],
    [r('[A-Za-z_:@][\\w:.-]*(?=\\s*=)'), 'attr'], [r(STR_DQ), 'str'], [r(STR_SQ), 'str'],
  ],
  css: [
    [r('/\\*[\\s\\S]*?(?:\\*/|$)'), 'com'], [r(STR_DQ), 'str'], [r(STR_SQ), 'str'],
    [r('@[\\w-]+'), 'kw'], [r('--[\\w-]+|[a-zA-Z-]+(?=\\s*:[^:{]*[;}\\n])'), 'prop'],
    [r('#[\\da-fA-F]{3,8}\\b'), 'num'], [r('-?\\d*\\.?\\d+(?:%|[a-zA-Z]+)?'), 'num'], [r('!important'), 'kw'],
  ],
  sql: [
    [r('--[^\\n]*'), 'com'], [r('/\\*[\\s\\S]*?(?:\\*/|$)'), 'com'], [r("N?'(?:[^']|'')*'?"), 'str'], [r('"[^"\\n]*"?|\\[[^\\]\\n]*\\]'), 'var'],
    [r(NUM), 'num'], [r('@@?[\\w]+'), 'var'], [r('[A-Za-z_][\\w]*'), w => (SQL_KW.has(w.toLowerCase()) ? 'kw' : w.toLowerCase() === 'null' ? 'lit' : undefined)],
  ],
  json: [
    [r(STR_DQ + '(?=\\s*:)'), 'key'], [r(STR_DQ), 'str'], [r('-?' + NUM), 'num'], [r('true|false|null'), 'lit'], [r('//[^\\n]*'), 'com'],
  ],
  bash: [
    [r('(?:^|(?<=\\s))#[^\\n]*', 'm'), 'com'], [r(STR_DQ), 'str'], [r("'[^']*'?"), 'str'],
    [r('\\$\\{[^}\\n]*\\}?|\\$\\w+|\\$[@#?$!*-]'), 'var'], [r('(?<=\\s)--?[\\w-]+'), 'attr'],
    [r('\\d+\\b'), 'num'], [r('[A-Za-z_][\\w-]*'), w => (BASH_KW.has(w) ? 'kw' : undefined)],
  ],
  ps: [
    [r('<#[\\s\\S]*?(?:#>|$)'), 'com'], [r('#[^\\n]*'), 'com'], [r('@?' + STR_DQ), 'str'], [r("@?'(?:[^']|'')*'?"), 'str'],
    [r('\\$(?:\\{[^}\\n]*\\}|[\\w:]+)'), 'var'], [r('-[A-Za-z][\\w]*'), 'attr'], [r('\\[[A-Za-z][\\w.]*\\]'), 'type'],
    [r(NUM), 'num'], [r('[A-Za-z]+-[A-Za-z]+\\w*'), 'fn'], [r('[A-Za-z_][\\w]*'), w => (PS_KW.has(w.toLowerCase()) ? 'kw' : LIT.has(w.toLowerCase()) ? 'lit' : undefined)],
  ],
};

/** Highlighting is skipped for huge blocks (plain text is fine there). */
const MAX = 40_000;

export function highlight(code: string, lang: Lang | string | undefined): Token[] {
  const l = lang && (lang in RULES ? (lang as Lang) : langOf(lang));
  if (!l || code.length > MAX) return [{ text: code }];
  const rules = RULES[l];
  const out: Token[] = [];
  let plain = '';
  const emit = (text: string, cls?: TokenClass) => {
    if (!cls) { plain += text; return; }
    if (plain) { out.push({ text: plain }); plain = ''; }
    out.push({ text, cls });
  };
  let i = 0;
  while (i < code.length) {
    let hit = false;
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || !m[0].length) continue;
      emit(m[0], typeof cls === 'function' ? cls(m[0]) : cls);
      i += m[0].length;
      hit = true;
      break;
    }
    if (!hit) {
      // skip a whole run of characters no rule starts on (word chars stay together so keywords are never split)
      const w = /^[\w$]+|^[^\w$]/.exec(code.slice(i, i + 64))![0];
      emit(w);
      i += w.length;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}
