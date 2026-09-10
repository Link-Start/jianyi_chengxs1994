import { parseArgs } from 'node:util';
import { compile, create, readDrafts, defaultLibrary } from './project.mjs';
import { updateDraft } from './update.mjs';
import { startServer, openBrowser } from './server.mjs';

let jsonOutput = process.argv.includes('--json');
// 命令行默认面向用户显示摘要；--json 为 AI 和脚本保留结构化输出。
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, library: { type: 'string' }, draft: { type: 'string' }, help: { type: 'boolean' }, json: { type: 'boolean' }, open: { type: 'boolean' }, 'no-browser': { type: 'boolean' } } });
  jsonOutput = !!values.json;
  const [command, input] = positionals;
  if (values.help || !command) return { usage: ['node cli/jianyi.mjs update changes.json --draft <id> [--library <目录>] [--open]', 'node cli/jianyi.mjs create edit.json [--open]', 'node cli/jianyi.mjs open [草稿库目录] [--draft <id>] [--no-browser]', 'node cli/jianyi.mjs validate edit.json', 'node cli/jianyi.mjs list', 'node cli/jianyi.mjs inspect --draft <id>', '以上命令均支持 --json，供 AI 或脚本读取'], note: `Node.js 18.3+；无需 npm install 或 ffprobe。默认草稿库：${defaultLibrary()}。--output 可指定其他草稿库。create 已包含检查，时间单位为秒。` };
  if (positionals.length > 2 || (!input && !['list', 'inspect', 'open'].includes(command))) throw new Error('需要一个配置文件或草稿父目录参数，请使用 --help');
  if (values.output !== undefined && !['create', 'update'].includes(command)) throw new Error('--output 仅用于 create 或 update');
  if (values.draft !== undefined && !['inspect', 'open', 'update'].includes(command)) throw new Error('--draft 仅用于 inspect、open 或 update');
  if (values.open && !['create', 'update'].includes(command)) throw new Error('--open 仅用于 create 或 update');
  if (values['no-browser'] && command !== 'open' && !values.open) throw new Error('--no-browser 需配合 open、create --open 或 update --open');
  if (values.library !== undefined && (command !== 'update' || !values.library.trim())) throw new Error('--library 仅用于 update，且不能为空');
  if (command === 'open') return { opened: true, ...await launch(input, values.draft, values['no-browser']) };
  if (command === 'validate' || command === 'create' || command === 'update') {
    if (values.output !== undefined && !values.output.trim()) throw new Error('--output 不能为空');
    const result = command === 'update' ? null : await compile(input);
    if (command === 'validate') return { valid: true, name: result.name, duration: result.duration, assets: result.assets.length, warnings: result.warnings };
    const saved = command === 'update' ? await updateDraft(input, values.draft, values.library, values.output) : await create(result, values.output);
    if (values.open) {
      try { return { ...saved, ...await launch(saved.folder, saved.id, values['no-browser']) }; }
      catch (error) { return { ...saved, warnings: [...saved.warnings, `草稿已保存，但未能启动编辑器：${error.message}`] }; }
    }
    return saved;
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
// 服务保持前台运行；正常中断等待保存收尾后释放库锁。
async function launch(folder, draftId, noBrowser) {
  const session = await startServer(folder, draftId); let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await session.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (!noBrowser) openBrowser(session.url);
  return { url: session.url, folder: session.folder, draftId: session.draftId, note: '保持此终端运行，网页修改会保存回草稿库；结束编辑后按 Ctrl+C 停止。' };
}
// 生成简洁的操作指引；inspect 保留完整 JSON 快照方便排查配置。
function display(result) {
  if (jsonOutput) return JSON.stringify(result, null, 2);
  if (result.usage) return result.usage.join('\n') + '\n\n' + result.note;
  if (result.url) return `${result.name ? '草稿已生成：' + result.name + '\n' : ''}本地编辑器：${result.url}\n草稿库：${result.folder}\n${result.note}\n${(result.warnings || []).join('\n')}`;
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
