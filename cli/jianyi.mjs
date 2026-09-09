import { parseArgs } from 'node:util';
import { compile, create, readDrafts } from './project.mjs';

let jsonOutput = process.argv.includes('--json');
// 命令行默认面向用户显示摘要；--json 为 AI 和脚本保留结构化输出。
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, draft: { type: 'string' }, help: { type: 'boolean' }, json: { type: 'boolean' } } });
  jsonOutput = !!values.json;
  const [command, input] = positionals;
  if (values.help || !command) return { usage: ['node cli/jianyi.mjs create edit.json --output ./workspace', 'node cli/jianyi.mjs validate edit.json', 'node cli/jianyi.mjs list ./workspace', 'node cli/jianyi.mjs inspect ./workspace --draft <id>', '以上命令均支持 --json，供 AI 或脚本读取'], note: 'Node.js 18.3+；无需 npm install 或 ffprobe。create 已包含检查，时间单位为秒。' };
  if (!input || positionals.length !== 2) throw new Error('需要一个配置文件或草稿父目录参数，请使用 --help');
  if (values.output !== undefined && command !== 'create') throw new Error('--output 仅用于 create');
  if (values.draft !== undefined && command !== 'inspect') throw new Error('--draft 仅用于 inspect');
  if (command === 'validate' || command === 'create') {
    if (command === 'create' && !values.output?.trim()) throw new Error('create 必须指定 --output');
    const result = await compile(input);
    return command === 'create' ? create(result, values.output) : { valid: true, name: result.name, duration: result.duration, assets: result.assets.length, warnings: result.warnings };
  }
  if (command === 'list' || command === 'inspect') {
    const drafts = await readDrafts(input);
    if (command === 'list') return drafts.map(({ id, name, revision, duration, updatedAt }) => ({ id, name, revision, duration, updatedAt }));
    if (!values.draft) throw new Error('inspect 必须指定 --draft');
    const draft = drafts.find(d => d.id === values.draft); if (!draft) throw new Error('未找到草稿');
    return draft;
  }
  throw new Error(`未知命令：${command}`);
}
// 生成简洁的操作指引；inspect 保留完整 JSON 快照方便排查配置。
function display(result) {
  if (jsonOutput) return JSON.stringify(result, null, 2);
  if (result.usage) return result.usage.join('\n') + '\n\n' + result.note;
  if (Array.isArray(result)) return result.length ? result.map(item => `${item.name} · ${item.duration} 秒\n  ID：${item.id}`).join('\n') : '此目录中没有草稿。';
  if (result.valid || result.folder) {
    const lines = [`${result.valid ? '配置检查通过' : '草稿已生成'}：${result.name}`, `时长：${result.duration} 秒 · 素材：${result.assets} 个`];
    if (result.folder) lines.push(`\n打开剪易 → 草稿 → 打开本地草稿，选择：\n${result.folder}`, `然后打开“${result.name}”。`, `草稿 ID：${result.id}`);
    lines.push('', ...(result.warnings || [])); return lines.join('\n');
  }
  return JSON.stringify(result, null, 2);
}
main().then(result => process.stdout.write(display(result) + '\n')).catch(error => {
  process.stderr.write((jsonOutput ? JSON.stringify({ error: error.message }) : `错误：${error.message}`) + '\n'); process.exitCode = 1;
});
