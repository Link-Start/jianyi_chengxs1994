'use strict';
// 将草稿存入用户授权的专用目录；只有文件夹入口保留在浏览器数据库。
window.JianyiDraftFolder = (() => {
  const marker = 'jianyi-folder-drafts', uuid = /^[a-f0-9-]{36}$/i;
  // 校验文件标识，素材原名只作显示，不参与磁盘路径拼接。
  function key(id) { if (!uuid.test(id)) throw new Error('草稿或素材标识无效'); return id; }
  // 读写目录入口元数据，不在浏览器数据库中存放素材。
  async function setting(key, value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('jianyi-draft-folders', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('settings', value === undefined ? 'readonly' : 'readwrite');
        const action = value === undefined ? tx.objectStore('settings').get(key) : tx.objectStore('settings').put(value, key);
        let result; action.onsuccess = () => { result = action.result; };
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  // 保留旧版最后目录接口，已有记录可迁移为最近目录。
  async function remembered(handle) { return setting('last', handle); }
  // 保存最近五个规范化目录，刷新后仅显示入口，授权仍由用户点击触发。
  async function recent(handle, name) {
    let entries = await setting('recent');
    if (!Array.isArray(entries)) { const last = await remembered(); entries = last ? [{ handle: last, name: last.name }] : []; }
    if (!handle) return entries;
    const others = [];
    for (const entry of entries) {
      try { if (await handle.isSameEntry(entry.handle)) continue; } catch { /* 失效的旧入口仍保留，用户可重新选择目录。 */ }
      others.push(entry);
    }
    entries = [{ handle, name }, ...others].slice(0, 5);
    await setting('recent', entries); return entries;
  }
  // 检查读取的清单格式；未知版本和损坏清单不得被新草稿覆盖。
  function validate(data) {
    if (data.format !== marker || data.version !== 1 || !uuid.test(data.id) || !Array.isArray(data.drafts) || (data.cliImports !== undefined && !Array.isArray(data.cliImports))) throw new Error('草稿目录清单损坏或版本不支持，请从备份恢复');
    for (const draft of data.drafts) { key(draft.id); if (!Array.isArray(draft.assetIds) || !Array.isArray(draft.assetInfo)) throw new Error('草稿素材清单无效'); draft.assetIds.forEach(key); }
    return data;
  }
  // 连接专用目录，不覆盖所选文件夹内的其他文件。
  async function connect(parent, { create = true } = {}) {
    const permission = await parent.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('请点击“重新授权文件夹”并允许读写');
    let root;
    // 清单所在目录和外层作品目录都可识别，避免误建嵌套 jianyi-drafts。
    try { await parent.getFileHandle('project-index.json'); root = parent; }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    if (!root && parent.name === 'jianyi-drafts') root = parent;
    if (!root) {
      try { root = await parent.getDirectoryHandle('jianyi-drafts', { create }); }
      catch (error) { if (error.name === 'NotFoundError') throw new Error('未找到本地草稿，请选择作品目录或 jianyi-drafts 目录；保存当前作品请使用“另存到文件夹”'); throw error; }
    }
    let manifest;
    try { manifest = await root.getFileHandle('project-index.json'); }
    catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      if (!create) throw new Error('未找到草稿清单，请选择已有草稿目录');
      for await (const entry of root.values()) throw new Error('jianyi-drafts 目录非空且缺少清单，请选择其他目录');
      manifest = await root.getFileHandle('project-index.json', { create: true });
      const writable = await manifest.createWritable({ mode: 'exclusive' });
      try { await writable.write(JSON.stringify({ format: marker, version: 1, id: crypto.randomUUID(), drafts: [] })); await writable.close(); }
      catch (failure) { await writable.abort().catch(() => {}); throw failure; }
    }
    // 从磁盘读取最新版本，跨标签页修改不会使用内存中的陈旧副本。
    async function read() {
      const data = validate(JSON.parse(await (await manifest.getFile()).text()));
      const seen = new Set([...(data.cliImports || []), ...data.drafts.map(d => d.id)]);
      let incoming;
      try { incoming = await root.getDirectoryHandle('cli-drafts'); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
      if (incoming) for await (const [id, entry] of incoming.entries()) {
        if (entry.kind !== 'directory' || !uuid.test(id) || seen.has(id)) continue;
        const draft = JSON.parse(await (await (await entry.getFileHandle('draft.json')).getFile()).text());
        if (draft.id !== id) throw new Error('CLI 草稿包标识不一致');
        validate({ ...data, drafts: [draft] });
        for (const info of draft.assetInfo) { key(info.id); if (info.cliPackage !== id) throw new Error('CLI 素材目录不一致'); }
        data.drafts.push(draft); seen.add(id);
      }
      // 持久化已处理记录，删除草稿后仍不会被磁盘包重新导入。
      data.cliImports = [...new Set([...(data.cliImports || []), ...data.drafts.flatMap(d => d.assetInfo.map(a => a.cliPackage).filter(Boolean))])];
      return data;
    }
    const identity = (await read()).id;
    const assets = await root.getDirectoryHandle('assets', { create });
    // CLI 素材留在独立包中，网页首次编辑保存时按现有逻辑写入公共素材目录。
    async function assetFile(info) {
      if (!info.cliPackage) return (await assets.getFileHandle(key(info.id))).getFile();
      const incoming = await root.getDirectoryHandle('cli-drafts'), entry = await incoming.getDirectoryHandle(key(info.cliPackage));
      return (await (await entry.getDirectoryHandle('assets')).getFileHandle(key(info.id))).getFile();
    }
    // 写清单前先完成所有素材写入；异常时取消替换，保留上次完整清单。
    async function update(work) {
      const execute = async () => {
        let serverActive = false;
        try { await root.getDirectoryHandle('.editor-server.lock'); serverActive = true; } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        if (serverActive) throw new Error('此库正在通过 CLI 编辑服务使用，请在服务打开的网页中保存，或停止服务后重试');
        const writable = await manifest.createWritable({ mode: 'exclusive' });
        try {
          const data = await read(), result = await work(data);
          await writable.write(JSON.stringify(data)); await writable.close();
          return result;
        } catch (error) { await writable.abort().catch(() => {}); throw error; }
      };
      return navigator.locks ? navigator.locks.request('jianyi-folder-' + identity, execute) : execute();
    }
    // 只加载列表和封面，不读取素材内容。
    async function list() { return (await read()).drafts.sort((a, b) => b.updatedAt - a.updatedAt); }
    // 加载文件快照并与保存大小核对；缺失文件由已有重新关联流程处理。
    async function get(id) {
      const draft = (await read()).drafts.find(item => item.id === id);
      if (!draft) throw new Error('草稿已被删除');
      const files = new Map();
      for (const info of draft.assetInfo) {
        try { const blob = await assetFile(info); if (blob.size === info.size) files.set(info.id, { ...info, blob }); }
        catch (error) { if (error.name !== 'NotFoundError') throw error; }
      }
      return { draft, files };
    }
    // 保存素材副本；仅新素材写入磁盘，重复自动保存只更新 JSON 清单。
    async function save(draft, files, revision) {
      key(draft.id);
      return update(async data => {
        const old = data.drafts.find(item => item.id === draft.id);
        if ((old?.revision || 0) !== revision) throw new Error('草稿已在其他页面变化，请重新打开后保存');
        const provided = new Map(files.map(file => [file.id, file]));
        for (const info of draft.assetInfo) {
          let existing;
          try { existing = await assetFile(info); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
          if (existing?.size === info.size) continue;
          const file = provided.get(info.id); if (!file?.blob) throw new Error(`素材缺失：${info.name}，请重新关联`);
          const target = await assets.getFileHandle(info.id, { create: true }), writable = await target.createWritable({ mode: 'exclusive' });
          try { await writable.write(file.blob); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
        }
        const next = { ...draft, revision: revision + 1, updatedAt: Date.now() };
        data.drafts = data.drafts.filter(item => item.id !== draft.id); data.drafts.push(next); return next;
      });
    }
    // 删除仅移除草稿清单，素材保留以避免跨文件操作失败造成不可恢复的数据损坏。
    async function change(id, revision, name) {
      return update(async data => {
        const old = data.drafts.find(item => item.id === id);
        if (!old || old.revision !== revision) throw new Error('草稿已变化，请刷新列表重试');
        data.drafts = data.drafts.filter(item => item.id !== id);
        if (name === null) return null;
        const next = { ...old, name, revision: revision + 1, updatedAt: Date.now() }; data.drafts.push(next); return next;
      });
    }
    // 在独占写入期间清理专用 assets 目录中无引用且名称符合本应用格式的文件。
    async function clean() {
      return update(async data => {
        const used = new Set(data.drafts.flatMap(item => item.assetIds)); let count = 0;
        for await (const [name, entry] of assets.entries()) if (entry.kind === 'file' && uuid.test(name) && !used.has(name)) { await assets.removeEntry(name); count++; }
        let incoming;
        try { incoming = await root.getDirectoryHandle('cli-drafts'); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        const packages = new Set(data.drafts.flatMap(d => d.assetInfo.map(a => a.cliPackage).filter(Boolean)));
        if (incoming) for (const id of data.cliImports || []) {
          if (packages.has(id)) continue;
          try { await incoming.removeEntry(key(id), { recursive: true }); count++; } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
        return count;
      });
    }
    return { list, get, save, change, clean, parent, root, name: root === parent ? parent.name : parent.name + '/jianyi-drafts', isFolder: true };
  }
  return { connect, remembered, recent };
})();
