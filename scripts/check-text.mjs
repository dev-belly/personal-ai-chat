import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suffixes = new Set(['.md', '.txt', '.html', '.svg', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.yml', '.yaml', '.toml', '.ps1']);
const names = new Set(['.gitattributes', '.gitignore', '.env.example', 'LICENSE']);
const corruption = /\uFFFD|\u00C3[\u0080-\u00BF]|\u00E2\u20AC[\u2122\u0153\u009D]|\u951F\u65A4\u62F7/;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

export function textFindings(raw) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { return [{ line: 1, reason: 'not valid UTF-8' }]; }
  const issues = [];
  content.split('\n').forEach((line, index) => {
    if (corruption.test(line)) issues.push({ line: index + 1, reason: 'replacement character or common mojibake signature' });
    if (controls.test(line)) issues.push({ line: index + 1, reason: 'unexpected control character' });
  });
  return issues;
}

export function inspectText(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const report = { checkedFiles: 0, issues: [] };
  for (const name of files) {
    if (!suffixes.has(path.extname(name).toLowerCase()) && !names.has(path.basename(name))) continue;
    const target = path.join(root, name);
    let stat;
    try { stat = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || path.relative(root, realpathSync(target)).startsWith('..')) {
      report.issues.push({ path: name, line: 1, reason: 'text symlink leaves the checked file set' });
      continue;
    }
    if (!stat.isFile()) continue;
    report.checkedFiles += 1;
    report.issues.push(...textFindings(readFileSync(target)).map(issue => ({ path: name, ...issue })));
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectText(fileURLToPath(new URL('../', import.meta.url)));
  for (const issue of report.issues) console.error(`${issue.path}:${issue.line}: ${issue.reason}`);
  console.log(`Text checks: ${report.checkedFiles} source/documentation files, ${report.issues.length} findings.`);
  process.exitCode = report.issues.length ? 1 : 0;
}
