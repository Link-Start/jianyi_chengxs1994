'use strict';
// 本地 HTTP 草稿适配层：仅由 CLI 启动入口启用，普通网页无需服务。
window.JianyiDraftRemote = (() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('easycut');
  if (!token || location.hostname !== '127.0.0.1') return null;
  const known = new Map();
  // 服务停止或写入失败时明确抛错，绝不回退到浏览器数据库。
  async function request(url, options = {}) {
    let response;
    try { response = await fetch(url, { ...options, headers: { 'X-EasyCut-Token': token, ...options.headers } }); }
    catch { throw new Error('本地编辑服务不可用，请保持 CLI 终端运行；恢复服务后重新打开草稿'); }
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `本地服务错误 ${response.status}`); }
    return response;
  }
  // 元数据操作统一使用 JSON，不把素材编码成体积更大的 Base64。
  async function json(url, body) {
    return (await request(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  }
  // 列表不读取媒体字节，顺带记住已持久化素材，后续自动保存无需重复上传。
  async function list() {
    const drafts = await json('/api/drafts');
    for (const d of drafts) for (const info of d.assetInfo) known.set(info.id, info);
    return drafts;
  }
  // 将服务素材转换成现有恢复适配器需要的 Blob 记录。
  async function get(id) {
    const draft = await json('/api/drafts/' + encodeURIComponent(id)), files = new Map();
    for (const info of draft.assetInfo) {
      const blob = await (await request('/api/assets/' + encodeURIComponent(info.id))).blob();
      files.set(info.id, { ...info, blob }); known.set(info.id, info);
    }
    return { draft, files };
  }
  // 新素材先上传，全部成功后才提交草稿；旧素材沿用磁盘包位置。
  async function save(draft, files, revision) {
    const supplied = new Map(files.map(f => [f.id, f]));
    const assetInfo = [];
    for (const info of draft.assetInfo) {
      const old = known.get(info.id);
      if (old && old.size === info.size) { assetInfo.push({ ...info, ...(old.cliPackage ? { cliPackage: old.cliPackage } : {}) }); continue; }
      const file = supplied.get(info.id); if (!file?.blob) throw new Error('素材缺失：' + info.name);
      const uploaded = await (await request('/api/assets/' + encodeURIComponent(info.id), { method: 'PUT', body: file.blob })).json();
      if (uploaded.size !== info.size) throw new Error('素材上传大小不一致：' + info.name);
      assetInfo.push(info);
    }
    const result = await json('/api/drafts/' + draft.id, { action: 'save', draft: { ...draft, assetInfo }, revision });
    for (const info of assetInfo) known.set(info.id, info); return result;
  }
  // 改名和删除仍使用修订号保护，服务串行处理同库请求。
  async function change(id, revision, name) { return json('/api/drafts/' + id, { action: 'change', revision, name }); }
  const store = { list, get, save, change, isFolder: true, isServer: true, name: '本地编辑服务' };
  // 读取当前库与目标草稿；令牌留在片段中以支持刷新，不发送给静态资源请求。
  async function session() { const data = await json('/api/session'); store.name = data.folder; return data; }
  return { store, session };
})();
