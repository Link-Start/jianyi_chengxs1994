import { parseArgs } from 'node:util';
import { compile, create, readDrafts } from './project.mjs';

// 命令行仅依赖 Node.js 内置模块，标准输出始终为 JSON，错误返回非零状态。
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, draft: { type: 'string' }, help: { type: 'boolean' } } });
  const [command, input] = positionals;
  if (values.help || !command) return { usage: ['node cli/jianyi.mjs validate edit.json', 'node cli/jianyi.mjs create edit.json --output ./workspace', 'node cli/jianyi.mjs list ./workspace', 'node cli/jianyi.mjs inspect ./workspace --draft <id>'], note: 'Node.js 18.3+；无需 npm install 或 ffprobe。时间单位为秒。' };
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
main().then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1;
});
