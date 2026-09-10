import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { compile, create, readDrafts } from './project.mjs';
import { updateDraft } from './update.mjs';

// 从真实草稿包发布修改副本，验证原稿保护、参数拒绝和素材自包含。
test('已有草稿修改与副本发布', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easycut-update-'));
  try {
    for (const name of ['video.mp4', 'bgm.wav', 'star.gif']) await writeFile(path.join(dir, name), name);
    const config = path.join(dir, 'edit.json'), patch = path.join(dir, 'changes.json');
    await writeFile(config, JSON.stringify({ version: 1, name: '原稿', videos: [{ file: 'video.mp4', out: 10, effect: { kind: 'warm' } }], texts: [{ text: '原文字', end: 10 }, { text: '片尾', start: 9, end: 10 }], audio: [{ file: 'bgm.wav', end: 10 }], stickers: [{ file: 'star.gif', end: 10 }] }));
    const saved = await create(await compile(config), dir), original = (await readDrafts(dir))[0];
    const changes = { version: 1, revision: 1, name: '修改副本', clips: [{ id: original.project.clips[0].id, out: 8 }], texts: [{ id: original.project.texts[0].id, text: '新文字', size: 150, color: '#FFFF00' }], audio: [{ id: original.project.audio[0].id, volume: 20 }], stickers: [{ id: original.project.stickers[0].id, x: .9 }] };
    await writeFile(patch, JSON.stringify(changes));
    const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('./jianyi.mjs', import.meta.url)), 'update', patch, '--draft', saved.id, '--library', dir, '--json'], { encoding: 'utf8' }));
    assert.notEqual(result.id, saved.id); assert.equal(result.sourceRevision, 1);
    const all = await readDrafts(dir), updated = all.find(d => d.id === result.id);
    assert.deepEqual(all.find(d => d.id === saved.id), original);
    assert.equal(updated.project.texts.length, 1); assert.equal(updated.project.texts[0].end, 8);
    assert.equal(updated.project.texts[0].size, 150); assert.equal(updated.project.audio[0].volume, .2);
    assert.deepEqual(updated.project.clips[0].effect, original.project.clips[0].effect);
    assert.equal(updated.duration, 8); assert.ok(result.warnings.some(w => w.includes('移除')));
    for (const asset of updated.assetInfo) assert.ok((await readFile(path.join(dir, 'jianyi-drafts/cli-drafts', result.id, 'assets', asset.id))).length);
    // 拒绝陈旧版本、错误 ID、未知字段、非法大小和越界裁剪，不创建半成品。
    for (const invalid of [{ ...changes, revision: 2 }, { ...changes, texts: [{ id: 999, size: 150 }] }, { ...changes, texts: [{ id: original.project.texts[0].id, size: 1001 }] }, { ...changes, remove: true }, { ...changes, clips: [{ id: original.project.clips[0].id, out: 11 }] }, { ...changes, audio: [{ id: original.project.audio[0].id, volume: '20' }] }]) {
      await writeFile(patch, JSON.stringify(invalid)); await assert.rejects(updateDraft(patch, saved.id, dir));
      assert.equal((await readDrafts(dir)).length, 2);
    }
    // 网页保存的主清单记录和公共素材目录同样可读，原始素材路径无需存在。
    const root = path.join(dir, 'jianyi-drafts'), index = path.join(root, 'project-index.json');
    const data = JSON.parse(await readFile(index, 'utf8'));
    const web = structuredClone(original); web.revision = 3; web.project.texts[0].font = 'serif';
    for (const asset of web.assetInfo) {
      await writeFile(path.join(root, 'assets', asset.id), await readFile(path.join(root, 'cli-drafts', saved.id, 'assets', asset.id)));
      delete asset.cliPackage;
    }
    data.drafts.push(web); await writeFile(index, JSON.stringify(data));
    await writeFile(patch, JSON.stringify({ version: 1, revision: 3, volume: 50 }));
    const fromWeb = await updateDraft(patch, saved.id, dir);
    assert.equal((await readDrafts(dir)).find(d => d.id === fromWeb.id).project.texts[0].font, 'serif');
    // 指向库外文件的素材软链不能作为已授权素材复制。
    const asset = web.assetInfo[0], target = path.join(root, 'assets', asset.id);
    await rm(target); await symlink(path.join(dir, 'video.mp4'), target);
    await assert.rejects(updateDraft(patch, saved.id, dir), /超出草稿库/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
