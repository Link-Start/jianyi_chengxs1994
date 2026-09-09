import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compile, create, readDrafts, defaultLibrary } from './project.mjs';

// 使用假媒体测试纯配置逻辑；真实解码另由浏览器验证，不依赖测试包。
test('编译、素材复用、追加草稿、并发发布、失败保护和参数拒绝', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jianyi-cli-'));
  try {
    await writeFile(path.join(dir, '视频.mp4'), 'fake-video');
    await writeFile(path.join(dir, '音频.wav'), 'fake-audio');
    const config = { version: 1, name: '测试', videos: [{ file: '视频.mp4', in: 0, out: 3 }, { file: '视频.mp4', in: 1, out: 3, transition: { kind: 'dissolve', duration: .4 } }], texts: [{ text: '标题', end: 5 }], audio: [{ file: '音频.wav', end: 5, volume: 30 }] };
    const configFile = path.join(dir, 'edit.json');
    await writeFile(configFile, JSON.stringify(config));
    // 默认提示与机器输出分别验证，错误状态不能被包装成成功 JSON。
    const cli = fileURLToPath(new URL('./jianyi.mjs', import.meta.url));
    const human = spawnSync(process.execPath, [cli, 'validate', configFile], { encoding: 'utf8' });
    assert.equal(human.status, 0); assert.match(human.stdout, /配置检查通过/);
    const json = spawnSync(process.execPath, [cli, 'validate', configFile, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0); assert.equal(JSON.parse(json.stdout).valid, true);
    const invalid = spawnSync(process.execPath, [cli, 'create', configFile, '--output', '', '--json'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0); assert.match(JSON.parse(invalid.stderr).error, /output/);
    const compiled = await compile(configFile);
    assert.equal(compiled.duration, 5); assert.equal(compiled.assets.length, 2);
    assert.equal(compiled.project.sources.length, 1); assert.equal(compiled.project.texts[0].size, 100);
    assert.equal(compiled.project.audio[0].volume, .3);
    const output = path.join(dir, '作品'), saved = await create(compiled, output);
    assert.equal((await readDrafts(output))[0].id, saved.id);
    assert.equal((await readdir(path.join(output, 'jianyi-drafts/cli-drafts', saved.id, 'assets'))).length, 2);
    const before = await readFile(path.join(output, 'jianyi-drafts/project-index.json'), 'utf8');
    const second = await create(compiled, output);
    assert.notEqual(saved.id, second.id); assert.equal((await readDrafts(output)).length, 2);
    assert.equal(await readFile(path.join(output, 'jianyi-drafts/project-index.json'), 'utf8'), before);
    // 已经复制部分素材后失败，也不能留下可误认为完整草稿的目录。
    const broken = structuredClone(compiled); broken.assets[1].original = path.join(dir, 'missing.wav');
    const failedOutput = path.join(dir, '失败');
    await assert.rejects(create(broken, failedOutput));
    assert.deepEqual(await readDrafts(failedOutput), []);
    assert.deepEqual(await readdir(path.join(failedOutput, 'jianyi-drafts/cli-drafts')), []);
    assert.equal(defaultLibrary(), path.join(os.homedir(), 'EasyCut'));
    // 五个独立进程同时首次创建同一库，全部草稿必须保留，主清单不被反复改写。
    const concurrent = path.join(dir, '并发库');
    const results = await Promise.all(Array.from({ length: 5 }, () => promisify(execFile)(process.execPath, [cli, 'create', configFile, '--output', concurrent, '--json'])));
    assert.equal(new Set(results.map(r => JSON.parse(r.stdout).id)).size, 5);
    assert.equal((await readDrafts(concurrent)).length, 5);
    // 模拟网页编辑、删除后的已处理标记，旧发布包不会覆盖新版本或复活删除记录。
    const indexPath = path.join(concurrent, 'jianyi-drafts/project-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')), imported = await readDrafts(concurrent);
    index.cliImports = imported.map(d => d.id); index.drafts = [{ ...imported[0], name: '网页修改', revision: 2 }];
    await writeFile(indexPath, JSON.stringify(index));
    assert.equal((await readDrafts(concurrent)).length, 1);
    assert.equal((await readDrafts(concurrent))[0].name, '网页修改');
    await writeFile(indexPath, '{broken');
    await assert.rejects(create(compiled, concurrent));
    assert.equal(await readFile(indexPath, 'utf8'), '{broken');
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
