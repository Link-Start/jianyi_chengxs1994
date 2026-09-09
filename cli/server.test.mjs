import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { compile, create, readDrafts } from './project.mjs';
import { startServer } from './server.mjs';

// 真实 HTTP 验证服务边界、分段读取、保存冲突、CLI 追加与退出清理。
test('本地编辑服务 API 与保存边界', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easycut-open-')); let session;
  try {
    await writeFile(path.join(dir, 'video.mp4'), '0123456789');
    const config = path.join(dir, 'edit.json');
    await writeFile(config, JSON.stringify({ version: 1, name: '服务测试', videos: [{ file: 'video.mp4', out: 2 }] }));
    const compiled = await compile(config), saved = await create(compiled, dir);
    session = await startServer(dir, saved.id);
    const url = new URL(session.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('easycut');
    const headers = { 'X-EasyCut-Token': token };
    // 发送 JSON 操作，保留 HTTP 状态供断言。
    const post = (route, data) => fetch(origin + route, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await fetch(origin + '/api/drafts')).status, 401);
    assert.equal((await fetch(origin + '/api/drafts', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(origin + '/api/drafts', { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal((await fetch(origin + '/package.json')).status, 404);
    assert.equal((await fetch(origin + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(origin + '/js/draft-remote.js')).status, 200);
    const draft = (await readDrafts(dir))[0], asset = draft.assetIds[0];
    const range = await fetch(origin + '/api/assets/' + asset, { headers: { ...headers, Range: 'bytes=2-4' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), '234');
    assert.equal((await fetch(origin + '/api/assets/' + asset, { headers: { ...headers, Range: 'bytes=99-' } })).status, 416);
    await assert.rejects(startServer(dir), /已有编辑服务/);
    const renamed = await post('/api/drafts/' + draft.id, { action: 'change', revision: 1, name: '网页修改' });
    assert.equal(renamed.status, 200); assert.equal((await renamed.json()).revision, 2);
    assert.equal((await post('/api/drafts/' + draft.id, { action: 'change', revision: 1, name: '旧版本' })).status, 409);
    const current = (await readDrafts(dir))[0];
    assert.equal((await post('/api/drafts/' + draft.id, { action: 'save', revision: 2, draft: current })).status, 200);
    const next = await create(compiled, dir);
    assert.equal((await (await fetch(origin + '/api/drafts', { headers })).json()).length, 2);
    assert.equal((await post('/api/drafts/' + next.id, { action: 'change', revision: 1, name: null })).status, 200);
    assert.equal((await readDrafts(dir)).length, 1);
    const upload = randomUUID();
    assert.equal((await fetch(origin + '/api/assets/' + upload, { method: 'PUT', headers, body: 'new-bytes' })).status, 200);
    // 即使库内出现外部软链接，也不能经 API 读取授权库外的素材。
    const outside = path.join(dir, 'outside.txt'); await writeFile(outside, 'private');
    const linkedId = randomUUID(); await symlink(outside, path.join(dir, 'jianyi-drafts/assets', linkedId));
    const broken = structuredClone((await readDrafts(dir))[0]);
    broken.assetInfo = [{ ...broken.assetInfo[0], id: linkedId, cliPackage: undefined, size: 7 }]; broken.assetIds = [linkedId];
    assert.equal((await post('/api/drafts/' + broken.id, { action: 'save', revision: broken.revision, draft: broken })).status, 403);
    await session.close(); session = null;
    await assert.rejects(access(path.join(dir, 'jianyi-drafts/.editor-server.lock')));
  } finally { if (session) await session.close(); await rm(dir, { recursive: true, force: true }); }
});

// 验证实际命令输出可用于连接，且正常终止进程会释放草稿库。
test('create --open 与 open 命令保持服务并响应退出信号', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'easycut-command-')); let child;
  try {
    await writeFile(path.join(dir, 'video.mp4'), 'video');
    const config = path.join(dir, 'edit.json');
    await writeFile(config, JSON.stringify({ version: 1, name: '命令测试', videos: [{ file: 'video.mp4', out: 2 }] }));
    let draftId;
    for (const args of [['create', config, '--output', dir, '--open'], ['open', dir]]) {
      child = spawn(process.execPath, [fileURLToPath(new URL('./jianyi.mjs', import.meta.url)), ...args, '--no-browser', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const result = await new Promise((resolve, reject) => {
        let output = ''; child.on('error', reject); child.on('exit', () => reject(new Error('服务提前退出')));
        child.stdout.on('data', chunk => { output += chunk; try { resolve(JSON.parse(output)); } catch {} });
      });
      const url = new URL(result.url), token = new URLSearchParams(url.hash.slice(1)).get('easycut');
      const data = await (await fetch(url.origin + '/api/session', { headers: { 'X-EasyCut-Token': token } })).json();
      if (args[0] === 'create') { draftId = result.id; assert.equal(data.draftId, draftId); }
      else assert.equal(data.draftId, undefined);
      assert.equal(result.folder, await import('node:fs/promises').then(fs => fs.realpath(dir)));
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = null;
      await assert.rejects(access(path.join(dir, 'jianyi-drafts/.editor-server.lock')));
    }
    assert.equal((await readDrafts(dir))[0].id, draftId);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(dir, { recursive: true, force: true });
  }
});
