import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compile, create, readDrafts } from './project.mjs';

// 使用假媒体测试纯配置逻辑；真实解码另由浏览器验证，不依赖测试包。
test('编译、素材复用、只创建新目录、复制失败回滚和参数拒绝', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jianyi-cli-'));
  try {
    await writeFile(path.join(dir, '视频.mp4'), 'fake-video');
    await writeFile(path.join(dir, '音频.wav'), 'fake-audio');
    const config = { version: 1, name: '测试', videos: [{ file: '视频.mp4', in: 0, out: 3 }, { file: '视频.mp4', in: 1, out: 3, transition: { kind: 'dissolve', duration: .4 } }], texts: [{ text: '标题', end: 5 }], audio: [{ file: '音频.wav', end: 5, volume: 30 }] };
    const configFile = path.join(dir, 'edit.json');
    await writeFile(configFile, JSON.stringify(config));
    const compiled = await compile(configFile);
    assert.equal(compiled.duration, 5); assert.equal(compiled.assets.length, 2);
    assert.equal(compiled.project.sources.length, 1); assert.equal(compiled.project.texts[0].size, 100);
    assert.equal(compiled.project.audio[0].volume, .3);
    const output = path.join(dir, '作品'), saved = await create(compiled, output);
    assert.equal((await readDrafts(output))[0].id, saved.id);
    assert.equal((await readdir(path.join(output, 'jianyi-drafts/assets'))).length, 2);
    const before = await readFile(path.join(output, 'jianyi-drafts/project-index.json'), 'utf8');
    await assert.rejects(create(compiled, output), /已有/);
    assert.equal(await readFile(path.join(output, 'jianyi-drafts/project-index.json'), 'utf8'), before);
    // 已经复制部分素材后失败，也不能留下可误认为完整草稿的目录。
    const broken = structuredClone(compiled); broken.assets[1].original = path.join(dir, 'missing.wav');
    const failedOutput = path.join(dir, '失败');
    await assert.rejects(create(broken, failedOutput));
    await assert.rejects(access(path.join(failedOutput, 'jianyi-drafts')));
    for (const bad of [
      { ...config, version: 2 }, { ...config, volum: 100 },
      { ...config, videos: [{ file: '视频.mp4', in: 3, out: 2 }] },
      { ...config, videos: [{ file: '视频.mp4', out: 2, transition: { kind: 'dissolve' } }] },
      { ...config, videos: [{ file: '不存在.mp4', out: 2 }] },
      { ...config, texts: [{ text: '标题', end: 6 }] },
      { ...config, texts: [{ text: '标题', end: 2, size: '100' }] },
      { ...config, texts: [{ text: '标题', end: 2, size: 1001 }] },
      { ...config, audio: [{ file: '音频.wav', end: 2, volume: 201 }] }
    ]) {
      await writeFile(configFile, JSON.stringify(bad)); await assert.rejects(compile(configFile));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
