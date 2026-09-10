import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { create, readDrafts, defaultLibrary } from './project.mjs';

// 严格限制可修改字段，未开放的工程数据原样保留。
function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' 必须是对象');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key} 不受支持`);
}
// 校验有限数值，不接受字符串或隐式类型转换。
function numeric(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 必须在 ${min}–${max} 范围内`);
  return value;
}
// 仅接受草稿生成的素材标识，不将配置作为磁盘路径使用。
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('素材标识无效');
  return value;
}
// 对指定组按稳定片段 ID 打补丁，不根据文本内容或数组序号猜测对象。
function patchItems(project, group, updates, allowed, apply) {
  if (updates === undefined) return;
  if (!Array.isArray(updates) || updates.length > 1000) throw new Error(group + ' 必须是最多 1000 项的数组');
  const seen = new Set();
  for (const change of updates) {
    fields(change, ['id', ...allowed], group);
    if (!Number.isSafeInteger(change.id) || seen.has(change.id)) throw new Error(group + ' 片段 ID 无效或重复');
    seen.add(change.id);
    const item = project[group].find(item => item.id === change.id);
    if (!item) throw new Error(`${group} 未找到片段 ID：${change.id}`);
    if (Object.keys(change).length === 1) throw new Error(group + ' 未提供修改字段');
    apply(item, change);
  }
}
// 更新区间时先检查自身合法性，作品缩短后的越界由统一裁短规则处理。
function interval(item) {
  numeric(item.start, 0, Number.MAX_SAFE_INTEGER, 'start');
  numeric(item.end, 0, Number.MAX_SAFE_INTEGER, 'end');
  if (item.end <= item.start) throw new Error('end 必须大于 start');
}
// 读取最新持久化工程，应用白名单修改后发布独立副本，不改写原草稿。
export async function updateDraft(patchFile, draftId, folder = defaultLibrary(), output = folder) {
  const patch = JSON.parse(await readFile(patchFile, 'utf8'));
  fields(patch, ['version', 'revision', 'name', 'volume', 'ratio', 'clips', 'texts', 'audio', 'stickers'], '修改配置');
  if (patch.version !== 1) throw new Error('修改配置 version 必须为 1');
  if (!Number.isSafeInteger(patch.revision) || patch.revision < 1) throw new Error('必须提供 inspect 返回的 revision');
  if (!draftId) throw new Error('update 必须指定 --draft');
  const original = (await readDrafts(folder)).find(draft => draft.id === draftId);
  if (!original) throw new Error('未找到草稿');
  if (original.revision !== patch.revision) throw new Error('草稿版本已变化，请重新 inspect 后修改');
  const project = structuredClone(original.project), warnings = [];
  if (project?.schemaVersion !== 1) throw new Error('不支持此草稿版本');
  for (const group of ['sources', 'clips', 'texts', 'audio', 'stickers', 'fonts']) if (!Array.isArray(project[group])) throw new Error('草稿结构不完整');
  const before = JSON.stringify(project);
  const name = patch.name ?? (original.name.slice(0, 94) + ' · 修改版');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('name 必须是 1–100 字符的非空文本');
  if (patch.volume !== undefined) project.volume = numeric(patch.volume, 0, 200, 'volume');
  if (patch.ratio !== undefined) {
    if (!['original', '16:9', '9:16', '1:1'].includes(patch.ratio)) throw new Error('ratio 无效');
    project.ratio = patch.ratio;
  }
  patchItems(project, 'clips', patch.clips, ['in', 'out'], (item, change) => {
    if (change.in !== undefined) item.in = numeric(change.in, item.lower, item.upper, 'clip.in');
    if (change.out !== undefined) item.out = numeric(change.out, item.lower, item.upper, 'clip.out');
    if (item.out <= item.in) throw new Error('clip.out 必须大于 in');
  });
  patchItems(project, 'texts', patch.texts, ['text', 'size', 'color', 'position', 'offsetX', 'offsetY', 'start', 'end'], (item, change) => {
    for (const [key, value] of Object.entries(change)) {
      if (key === 'id') continue;
      if (key === 'text') { if (typeof value !== 'string' || value.length > 200) throw new Error('text 必须是最多 200 字符的文本'); }
      else if (key === 'color') { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('color 必须使用 #RRGGBB'); }
      else { const range = key === 'size' ? [20, 1000] : key === 'position' ? [0, 1] : key.startsWith('offset') ? [-1, 1] : [0, Number.MAX_SAFE_INTEGER]; numeric(value, ...range, key); }
      item[key] = value;
    }
    interval(item);
  });
  patchItems(project, 'audio', patch.audio, ['volume', 'in', 'start', 'end'], (item, change) => {
    const availableEnd = item.in + item.end - item.start;
    for (const key of ['in', 'start', 'end']) if (change[key] !== undefined) item[key] = numeric(change[key], 0, Number.MAX_SAFE_INTEGER, 'audio.' + key);
    if (change.volume !== undefined) item.volume = numeric(change.volume, 0, 200, 'audio.volume') / 100;
    interval(item);
    if (item.in + item.end - item.start > availableEnd + .000001) throw new Error('音频调整超出原片段已知素材范围');
  });
  patchItems(project, 'stickers', patch.stickers, ['x', 'y', 'size', 'opacity', 'start', 'end', 'in'], (item, change) => {
    const availableEnd = (item.in || 0) + item.end - item.start;
    if (change.in !== undefined && item.kind !== 'video') throw new Error('sticker.in 仅支持视频画中画');
    for (const [key, value] of Object.entries(change)) {
      if (key === 'id') continue;
      const range = key === 'size' ? [.01, 2] : ['x', 'y', 'opacity'].includes(key) ? [0, 1] : [0, Number.MAX_SAFE_INTEGER];
      item[key] = numeric(value, ...range, 'sticker.' + key);
    }
    interval(item);
    if (item.kind === 'video' && item.in + item.end - item.start > availableEnd + .000001) throw new Error('画中画调整超出原片段已知素材范围');
  });
  if (JSON.stringify(project) === before && patch.name === undefined) throw new Error('没有有效修改');
  const duration = project.clips.reduce((sum, c) => sum + c.out - c.in, 0);
  numeric(duration, .000001, Number.MAX_SAFE_INTEGER, '作品时长');
  // 主轨连续拼接，叠加轨保持作品绝对时间；超出新结尾的内容裁短或移除。
  for (const group of ['texts', 'audio', 'stickers']) {
    project[group] = project[group].filter(item => {
      if (item.start >= duration) { warnings.push(`${group} ${item.id} 位于作品结尾之后，已从副本移除`); return false; }
      if (item.end > duration) { item.end = duration; warnings.push(`${group} ${item.id} 已裁短至作品结尾`); }
      return true;
    });
  }
  project.playhead = 0; project.selected = project.clips.length ? 0 : -1;
  for (const [key, group] of [['selectedText', 'texts'], ['selectedAudio', 'audio'], ['selectedSticker', 'stickers']]) if (!project[group].some(item => item.id === project[key])) delete project[key];
  project.exportName = name;
  const root = await realpath(path.join(folder, 'jianyi-drafts')), assets = [];
  const referenced = new Set([...project.sources, ...project.audio, ...project.stickers, ...project.fonts].map(item => item.assetId));
  for (const assetId of referenced) {
    const info = original.assetInfo.find(item => item.id === assetId);
    if (!info) throw new Error('素材记录缺失：' + assetId);
    const relative = info.cliPackage ? `cli-drafts/${uuid(info.cliPackage)}/assets/${uuid(assetId)}` : `assets/${uuid(assetId)}`;
    const filename = await realpath(path.join(root, relative));
    if (!filename.startsWith(root + path.sep)) throw new Error('素材路径超出草稿库');
    const disk = await stat(filename);
    if (!disk.isFile() || disk.size !== info.size) throw new Error('素材文件不完整：' + info.name);
    const { cliPackage, ...metadata } = info;
    assets.push({ ...metadata, original: filename, lastModified: disk.mtimeMs });
  }
  const latest = (await readDrafts(folder)).find(draft => draft.id === draftId);
  if (!latest || latest.revision !== patch.revision) throw new Error('读取期间草稿版本已变化，请重新 inspect 后修改');
  warnings.push('基于磁盘已保存版本创建副本；未解码素材，请在网页检查预览。');
  return { ...await create({ name, duration, project, assets, warnings }, output), sourceDraftId: draftId, sourceRevision: patch.revision };
}
