'use strict';
// 草稿元数据和素材副本通过同一个事务写入，避免出现半份草稿。
window.JianyiDraftStore = (() => {
  let connection;
  // 打开本机数据库；其他页面升级数据库时释放连接。
  function open() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('jianyi-drafts', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('drafts', { keyPath: 'id' });
        request.result.createObjectStore('assets', { keyPath: 'id' });
      };
      request.onerror = () => { connection = null; reject(request.error); };
      request.onblocked = () => { connection = null; reject(new Error('请关闭其他剪易页面后重试')); };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = null; };
        resolve(request.result);
      };
    });
    return connection;
  }
  // 只在事务完整提交后返回结果，存储不足和并发冲突保留原记录。
  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'assets'], mode);
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('草稿写入失败'));
      tx.onerror = () => {};
      // 将业务错误转换为事务回滚。
      const abort = error => { failure = error; tx.abort(); };
      try { work(tx.objectStore('drafts'), tx.objectStore('assets'), value => { result = value; }, abort); }
      catch (error) { abort(error); }
    });
  }
  // 仅列出草稿元数据，不加载大型素材文件。
  function list() {
    return transaction('readonly', (drafts, assets, done) => {
      drafts.getAll().onsuccess = event => done(event.target.result.sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }
  // 读取草稿及其引用素材；缺失记录由恢复面板提示重新关联。
  function get(id) {
    return transaction('readonly', (drafts, assets, done, abort) => {
      drafts.get(id).onsuccess = event => {
        const draft = event.target.result;
        if (!draft) return abort(new Error('草稿已被删除'));
        const files = new Map(); done({ draft, files });
        for (const key of draft.assetIds) assets.get(key).onsuccess = e => { if (e.target.result) files.set(key, e.target.result); };
      };
    });
  }
  // 清理无任何草稿引用的素材，复制草稿共享的素材不会被误删。
  function collect(drafts, assets) {
    drafts.getAll().onsuccess = event => {
      const used = new Set(event.target.result.flatMap(draft => draft.assetIds));
      assets.openCursor().onsuccess = e => {
        const cursor = e.target.result; if (!cursor) return;
        if (!used.has(cursor.key)) cursor.delete();
        cursor.continue();
      };
    };
  }
  // 检查版本再保存，防止多个标签页静默覆盖彼此的编辑。
  function save(draft, files, revision) {
    return transaction('readwrite', (drafts, assets, done, abort) => {
      drafts.get(draft.id).onsuccess = event => {
        const old = event.target.result;
        if ((old?.revision || 0) !== revision) return abort(new Error('草稿已在其他页面修改或删除，请另存副本或重新打开'));
        const next = { ...draft, revision: revision + 1, updatedAt: Date.now() };
        const provided = new Map(files.map(file => [file.id, file]));
        for (const id of next.assetIds) {
          assets.get(id).onsuccess = e => {
            if (e.target.result) return;
            const file = provided.get(id);
            if (!file?.blob) return abort(new Error('草稿引用的素材已缺失，请重新关联素材'));
            assets.put(file);
          };
        }
        drafts.put(next); collect(drafts, assets); done(next);
      };
    });
  }
  // 重命名和删除都检查草稿版本，避免删除他人刚保存的版本。
  function change(id, revision, name) {
    return transaction('readwrite', (drafts, assets, done, abort) => {
      drafts.get(id).onsuccess = event => {
        const old = event.target.result;
        if (!old || old.revision !== revision) return abort(new Error('草稿已变化，请刷新列表后重试'));
        if (name === null) { drafts.delete(id); collect(drafts, assets); done(null); }
        else { const next = { ...old, name, revision: revision + 1, updatedAt: Date.now() }; drafts.put(next); done(next); }
      };
    });
  }
  return { list, get, save, change };
})();
