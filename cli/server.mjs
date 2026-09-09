import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat, realpath, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { readDrafts, defaultLibrary } from './project.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
// API 只接受 UUID，不允许文件路径作为请求参数。
function id(value) { if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('标识无效'); return value; }
// 为错误附带明确 HTTP 状态。
function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
// 流式限制请求体大小，避免请求占满服务内存或磁盘。
function limit(max) { let size = 0; return new Transform({ transform(chunk, encoding, done) { size += chunk.length; done(size > max ? failure('请求内容过大', 413) : null, chunk); } }); }
// 元数据只接受有限大小 JSON；素材通过独立流式接口上传。
async function jsonBody(req) {
  const chunks = []; const stream = req.pipe(limit(8 * 1024 * 1024));
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// 系统打开命令使用参数数组，不经 shell 解释路径或 URL。
export function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore' });
  const warn = () => process.stderr.write('自动打开浏览器失败，请手动打开输出的编辑地址。\n');
  child.on('error', warn); child.on('exit', code => { if (code) warn(); }); child.unref();
}
// 启动仅回环访问的编辑服务，进程存在期间串行保存并检查修订号。
export async function startServer(folder = defaultLibrary(), draftId) {
  const parent = await realpath(folder), root = await realpath(path.join(parent, 'jianyi-drafts'));
  const initial = await readDrafts(parent);
  if (draftId && !initial.some(d => d.id === draftId)) throw new Error('未找到草稿');
  const staticFiles = new Set(['index.html', 'style.css']);
  for (const directory of ['js', 'vendor']) for (const file of await readdir(path.join(repo, directory))) if (file.endsWith('.js')) staticFiles.add(directory + '/' + file);
  // 防止两个本地编辑服务同时改写同一库；CLI 发布新作品无需该锁。
  const lock = path.join(root, '.editor-server.lock');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('此草稿库已有编辑服务，请使用原窗口；若进程异常退出，确认服务已停止后移除 .editor-server.lock'); throw error; }
  const token = randomBytes(24).toString('hex'); let origin, queue = Promise.resolve();
  // 所有解析后的磁盘路径必须仍位于授权目录，拒绝指向外部的软链接。
  async function contained(base, relative) {
    const result = await realpath(path.join(base, relative));
    if (!result.startsWith(base + path.sep)) throw failure('路径超出授权范围', 403);
    return result;
  }
  // 从受控素材记录解析文件，不接受客户端直接给出的磁盘路径。
  async function assetPath(info) {
    return contained(root, info.cliPackage ? `cli-drafts/${id(info.cliPackage)}/assets/${id(info.id)}` : `assets/${id(info.id)}`);
  }
  // 合并 CLI 新发布作品，再保存主清单，删除后以导入标记防止草稿复活。
  async function update(work) {
    const execute = async () => {
      const manifestPath = await contained(root, 'project-index.json');
      const data = JSON.parse(await readFile(manifestPath, 'utf8')), drafts = await readDrafts(parent);
      data.cliImports = [...new Set([...(data.cliImports || []), ...drafts.flatMap(d => d.assetInfo.map(a => a.cliPackage).filter(Boolean))])];
      data.drafts = drafts;
      const result = await work(data), temporary = path.join(root, '.save-' + randomUUID());
      try { await writeFile(temporary, JSON.stringify(data), { flag: 'wx' }); await rename(temporary, manifestPath); }
      finally { await rm(temporary, { force: true }); }
      return result;
    };
    const task = queue.then(execute); queue = task.catch(() => {}); return task;
  }
  // 支持单段 Range 请求，媒体读取不把完整文件加载到服务内存。
  async function sendFile(req, res, filename, type) {
    const info = await stat(filename); let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) throw failure('无效 Range', 416);
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (start > end || start >= info.size) { res.setHeader('Content-Range', `bytes */${info.size}`); throw failure('Range 越界', 416); }
      status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    }
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD' || !info.size) return res.end();
    await pipeline(createReadStream(filename, { start, end }), res);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    // 所有 API 都校验临时令牌和请求来源，阻止其他网站驱动本机读写。
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw failure('禁止跨站访问', 403);
      const url = new URL(req.url, origin), route = url.pathname;
      if (!route.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw failure('方法不支持', 405);
        const name = route === '/' ? 'index.html' : route.slice(1);
        if (!staticFiles.has(name)) throw failure('未找到文件', 404);
        return await sendFile(req, res, await contained(repo.replace(/\/$/, ''), name), name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      }
      if (req.headers['x-easycut-token'] !== token) throw failure('本地编辑会话无效，请重新运行 open', 401);
      let result;
      if (route === '/api/session' && req.method === 'GET') result = { folder: parent, draftId };
      else if (route === '/api/drafts' && req.method === 'GET') result = await readDrafts(parent);
      else if (route.startsWith('/api/assets/')) {
        const key = id(route.slice('/api/assets/'.length));
        if (['GET', 'HEAD'].includes(req.method)) {
          const all = await readDrafts(parent), info = all.flatMap(d => d.assetInfo).find(a => a.id === key);
          if (!info) throw failure('素材不存在', 404);
          return await sendFile(req, res, await assetPath(info), info.type || 'application/octet-stream');
        }
        if (req.method !== 'PUT') throw failure('方法不支持', 405);
        const directory = await contained(root, 'assets'), target = path.join(directory, key), temporary = path.join(directory, '.upload-' + randomUUID());
        try {
          await pipeline(req, limit(2 * 1024 ** 3), createWriteStream(temporary, { flags: 'wx' }));
          // 新 ID 才能上传，禁止覆盖任何已存在的素材。
          const { link } = await import('node:fs/promises');
          try { await link(temporary, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          result = { size: (await stat(target)).size };
        } finally { await rm(temporary, { force: true }); }
      } else if (route.startsWith('/api/drafts/')) {
        const key = id(route.slice('/api/drafts/'.length));
        if (req.method === 'GET') { result = (await readDrafts(parent)).find(d => d.id === key); if (!result) throw failure('草稿不存在', 404); }
        else if (req.method === 'POST') {
          const body = await jsonBody(req);
          result = await update(async data => {
            const old = data.drafts.find(d => d.id === key);
            if ((old?.revision || 0) !== body.revision) throw failure('草稿已变化，请重新打开后保存', 409);
            if (body.action === 'change') {
              if (!old) throw failure('草稿不存在', 404);
              if (body.name !== null && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) throw failure('草稿名称无效');
              result = body.name === null ? null : { ...old, name: body.name, revision: old.revision + 1, updatedAt: Date.now() };
            } else if (body.action === 'save') {
              const draft = body.draft;
              if (!draft || draft.id !== key || draft.project?.schemaVersion !== 1 || !Array.isArray(draft.assetInfo) || !Array.isArray(draft.assetIds) || typeof draft.name !== 'string' || draft.name.length > 100) throw failure('草稿配置无效');
              const ids = new Set(draft.assetInfo.map(a => a.id));
              if (draft.assetIds.length !== ids.size || draft.assetIds.some(a => !ids.has(a))) throw failure('素材清单不一致');
              for (const info of draft.assetInfo) { if ((await stat(await assetPath(info))).size !== info.size) throw failure('素材不完整：' + info.name); }
              result = { ...draft, revision: body.revision + 1, updatedAt: Date.now() };
            } else throw failure('操作无效');
            data.drafts = data.drafts.filter(d => d.id !== key); if (result) data.drafts.push(result); return result;
          });
        } else throw failure('方法不支持', 405);
      } else throw failure('未找到接口', 404);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(error.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message }));
    }
  });
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  origin = `http://127.0.0.1:${server.address().port}`;
  // 停止接收新请求并等待正在保存的事务，正常退出时释放库锁。
  async function close() { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await queue; await rm(lock, { recursive: true, force: true }); }
  return { url: `${origin}/#easycut=${token}`, folder: parent, draftId, close };
}
