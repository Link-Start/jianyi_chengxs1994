import { readFile, realpath, stat, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const effects = ['none', 'grayscale', 'sepia', 'blur', 'vignette', 'warm', 'cool', 'vivid', 'shake', 'pulse', 'pixelate'];
const transitions = ['none', 'black', 'white', 'dissolve', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'circle', 'zoom-fade'];
const warning = '未解码素材：真实时长、尺寸及编码兼容性将在网页打开时检查。';

// 拒绝未知字段，避免拼写错误被静默忽略。
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key} 不受支持`);
}
// 检查数值范围，不将字符串或空值隐式转换成数字。
function number(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${label} 必须是 ${min} 到 ${max} 的数字`);
  return result;
}
// 检查限定选项。
function choice(value, fallback, values, label) {
  const result = value === undefined ? fallback : value;
  if (!values.includes(result)) throw new Error(`${label} 可选值：${values.join(', ')}`);
  return result;
}
// 校验必需文本并限制配置规模。
function string(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 必须是 1 到 ${max} 字符的非空文本`);
  return value;
}
// 校验可选布尔值。
function boolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
  return value;
}
// 检查叠加轨道的作品时间，结束时间必须显式提供。
function interval(item, duration, label) {
  const start = number(item.start, 0, 0, duration, `${label}.start`);
  const end = number(item.end, undefined, 0, duration, `${label}.end`);
  if (end <= start) throw new Error(`${label}.end 必须大于 start`);
  return { start, end };
}
// 将用户配置编译成网页 schemaVersion=1 草稿，不依赖 DOM 或媒体解码器。
export async function compile(configFile) {
  const filename = path.resolve(configFile), config = JSON.parse(await readFile(filename, 'utf8'));
  fields(config, ['version', 'name', 'ratio', 'volume', 'videos', 'texts', 'audio', 'stickers'], '配置');
  if (config.version !== 1) throw new Error('配置 version 必须为 1');
  const name = string(config.name, 'name');
  for (const group of ['videos', 'texts', 'audio', 'stickers']) {
    if (config[group] === undefined && group !== 'videos') config[group] = [];
    if (!Array.isArray(config[group]) || config[group].length > 1000) throw new Error(`${group} 必须是最多 1000 项的数组`);
  }
  if (!config.videos.length) throw new Error('videos 至少包含一个片段');
  let nextId = 1;
  const assets = new Map(), sources = [], clips = [], texts = [], audio = [], stickers = [];
  // 按真实路径共享素材，路径始终相对于配置文件目录解释。
  async function asset(file, allowed, label) {
    const original = await realpath(path.resolve(path.dirname(filename), string(file, `${label}.file`, 4096)));
    const info = await stat(original), type = types[path.extname(original).toLowerCase()];
    if (!info.isFile() || !info.size) throw new Error(`${label} 素材必须是非空文件：${original}`);
    if (!type || !allowed.some(prefix => type.startsWith(prefix))) throw new Error(`${label} 不支持此素材扩展名：${original}`);
    if (!assets.has(original)) assets.set(original, { id: randomUUID(), name: path.basename(original), type, size: info.size, lastModified: info.mtimeMs, original });
    return assets.get(original);
  }
  for (const [i, item] of config.videos.entries()) {
    const label = `videos[${i}]`;
    fields(item, ['file', 'in', 'out', 'effect', 'transition'], label);
    const media = await asset(item.file, ['video/'], label);
    let source = sources.find(s => s.assetId === media.id);
    if (!source) { source = { id: nextId++, assetId: media.id }; sources.push(source); }
    const begin = number(item.in, 0, 0, Number.MAX_SAFE_INTEGER, `${label}.in`), end = number(item.out, undefined, 0, Number.MAX_SAFE_INTEGER, `${label}.out`);
    if (end <= begin) throw new Error(`${label}.out 必须大于 in`);
    const clip = { id: nextId++, sourceId: source.id, in: begin, out: end, lower: 0, upper: end };
    if (item.effect !== undefined) {
      fields(item.effect, ['kind', 'strength'], `${label}.effect`);
      clip.effect = { kind: choice(item.effect.kind, 'none', effects, 'effect.kind'), strength: number(item.effect.strength, 1, 0, 1, 'effect.strength') };
    }
    if (item.transition !== undefined) {
      fields(item.transition, ['kind', 'duration'], `${label}.transition`);
      const kind = choice(item.transition.kind, 'none', transitions, 'transition.kind');
      if (kind !== 'none') {
        if (!i) throw new Error('第一个视频片段不能设置入场转场');
        clip.transition = { kind, duration: number(item.transition.duration, .5, .01, end - begin, 'transition.duration'), previousId: clips[i - 1].id };
      }
    }
    clips.push(clip);
  }
  const duration = clips.reduce((sum, c) => sum + c.out - c.in, 0);
  if (!Number.isFinite(duration) || duration > Number.MAX_SAFE_INTEGER) throw new Error('作品总时长无效');
  for (const [i, item] of config.texts.entries()) {
    const label = `texts[${i}]`;
    fields(item, ['text', 'start', 'end', 'size', 'color', 'position', 'offsetX', 'offsetY', 'align', 'bold', 'outline', 'background', 'strokeColor', 'strokeWidth', 'bgColor'], label);
    const text = { id: nextId++, text: string(item.text, `${label}.text`, 10000), ...interval(item, duration, label), font: 'sans-serif', size: number(item.size, 100, 20, 1000, 'text.size'), position: number(item.position, .82, 0, 1, 'text.position'), offsetX: number(item.offsetX, 0, -1, 1, 'text.offsetX'), offsetY: number(item.offsetY, 0, -1, 1, 'text.offsetY'), align: choice(item.align, 'center', ['left', 'center', 'right'], 'text.align'), strokeWidth: number(item.strokeWidth, 4, 0, 30, 'text.strokeWidth') };
    for (const [key, fallback] of [['bold', true], ['outline', true], ['background', false]]) text[key] = boolean(item[key], fallback, `text.${key}`);
    for (const [key, fallback] of [['color', '#ffffff'], ['strokeColor', '#000000'], ['bgColor', '#000000']]) {
      text[key] = item[key] === undefined ? fallback : item[key];
      if (typeof text[key] !== 'string' || !/^#[\da-f]{6}$/i.test(text[key])) throw new Error(`text.${key} 必须使用 #RRGGBB 颜色`);
    }
    texts.push(text);
  }
  for (const [i, item] of config.audio.entries()) {
    const label = `audio[${i}]`; fields(item, ['file', 'in', 'start', 'end', 'volume'], label);
    const media = await asset(item.file, ['audio/'], label);
    audio.push({ id: nextId++, assetId: media.id, name: media.name, ...interval(item, duration, label), in: number(item.in, 0, 0, Number.MAX_SAFE_INTEGER, 'audio.in'), volume: number(item.volume, 100, 0, 200, 'audio.volume') / 100 });
  }
  for (const [i, item] of config.stickers.entries()) {
    const label = `stickers[${i}]`; fields(item, ['file', 'in', 'start', 'end', 'x', 'y', 'size', 'opacity'], label);
    const media = await asset(item.file, ['image/', 'video/'], label), kind = media.type.startsWith('video/') ? 'video' : media.type === 'image/gif' ? 'gif' : 'image';
    if (kind !== 'video' && item.in !== undefined) throw new Error(`${label}.in 仅支持视频画中画`);
    stickers.push({ id: nextId++, assetId: media.id, name: media.name, kind, decal: kind !== 'video', ...interval(item, duration, label), in: number(item.in, 0, 0, Number.MAX_SAFE_INTEGER, 'sticker.in'), x: number(item.x, .72, 0, 1, 'sticker.x'), y: number(item.y, .28, 0, 1, 'sticker.y'), size: number(item.size, .3, .01, 2, 'sticker.size'), opacity: number(item.opacity, 1, 0, 1, 'sticker.opacity') });
  }
  const project = { schemaVersion: 1, sources, clips, texts, stickers, audio, fonts: [], ratio: choice(config.ratio, 'original', ['original', '16:9', '9:16', '1:1'], 'ratio'), volume: number(config.volume, 100, 0, 200, 'volume'), zoom: 100, playhead: 0, selected: 0, inspectorMode: 'video', exportName: name, exportFormat: 'mp4' };
  return { name, duration, project, assets: [...assets.values()], warnings: [warning] };
}

// 仅创建全新专用目录；绝不修改已有目录或正在被网页编辑的清单。
export async function create(compiled, output) {
  const parent = path.resolve(output), root = path.join(parent, 'jianyi-drafts');
  await mkdir(parent, { recursive: true });
  try { await mkdir(root); } catch (error) { if (error.code === 'EEXIST') throw new Error('目标已有 jianyi-drafts，请换一个输出目录；第一版不覆盖或追加已有草稿'); throw error; }
  try {
    await mkdir(path.join(root, 'assets'));
    for (const asset of compiled.assets) {
      await copyFile(asset.original, path.join(root, 'assets', asset.id), constants.COPYFILE_EXCL);
      const current = await stat(asset.original), copied = await stat(path.join(root, 'assets', asset.id));
      if (current.size !== asset.size || current.mtimeMs !== asset.lastModified || copied.size !== asset.size) throw new Error(`复制期间素材发生变化：${asset.name}`);
    }
    const now = Date.now(), draft = { id: randomUUID(), name: compiled.name, createdAt: now, updatedAt: now, revision: 1, schemaVersion: 1, project: compiled.project, assetIds: compiled.assets.map(a => a.id), assetInfo: compiled.assets.map(({ original, ...info }) => info), size: compiled.assets.reduce((sum, a) => sum + a.size, 0), duration: compiled.duration, cover: '' };
    await writeFile(path.join(root, 'project-index.json'), JSON.stringify({ format: 'jianyi-folder-drafts', version: 1, id: randomUUID(), drafts: [draft] }, null, 2), { flag: 'wx' });
    return { id: draft.id, name: draft.name, folder: parent, duration: draft.duration, assets: draft.assetIds.length, warnings: compiled.warnings, next: '在网页草稿列表选择 folder 指向的目录，然后打开此草稿。' };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

// 只读现有清单，供 AI 查看网页调优后的快照；不会触发网页保存或解码。
export async function readDrafts(folder) {
  const root = path.join(path.resolve(folder), 'jianyi-drafts');
  const data = JSON.parse(await readFile(path.join(root, 'project-index.json'), 'utf8'));
  if (data?.format !== 'jianyi-folder-drafts' || data.version !== 1 || !Array.isArray(data.drafts)) throw new Error('不支持的草稿目录格式');
  return data.drafts;
}
