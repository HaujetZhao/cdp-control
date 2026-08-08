/**
 * cli-args.ts — CLI 参数解析(纯函数,可单测)。
 * 支持 `--flag`(布尔)、`--opt <值>`(VALUE_OPTS 里的取值)、位置参数(args)。
 */

const VALUE_OPTS = new Set(['target', 'file', 'url', 'level', 'since', 'xpath', 'selector', 'xpath-file', 'selector-file']);

export function parseArgs(argv: string[]): { args: string[]; opts: Record<string, any> } {
  const args: string[] = [];
  const opts: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.slice(2);
    if (VALUE_OPTS.has(name)) opts[name] = argv[++i];
    else if (a.startsWith('--')) opts[name] = true;
    else args.push(a);
  }
  return { args, opts };
}
