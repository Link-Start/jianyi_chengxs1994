'use strict';
// 管理草稿选择、自动保存与切换；所有写操作串行执行。
(() => {
  let store = window.JianyiDraftRemote?.store || window.JianyiDraftStore, recentFolders = [];
  const editor = window.JianyiDraftEditor, folder = window.JianyiDraftFolder;
  const damaged = new Map();
  let current = null, saved = '', observed = '', changedAt = 0, working = false, saving = null, storageError = '', loadRequest = 0;
  const dialog = $('draft-dialog');
  dialog.setAttribute('aria-label', '我的草稿');
  dialog.querySelector('.draft-body').innerHTML = '<div class="draft-list-title"><span>我的草稿</span><button id="draft-refresh" type="button">刷新列表</button><button id="draft-new" type="button">＋ 新建草稿</button></div><div id="draft-list"></div><p id="draft-message" role="status"></p><p class="hint">草稿和素材仅保存在当前浏览器；清理站点数据会删除草稿。不同网址、浏览器的草稿不互通。</p>';
  const locations = document.createElement('div'); locations.className = 'draft-locations';
  locations.innerHTML = '<div class="draft-location-actions"><button id="draft-browser">浏览器草稿</button><button id="draft-folder-pick">打开本地草稿</button><button id="draft-folder-save-as">另存到文件夹</button><button id="draft-folder-clean" hidden>清理未引用素材</button></div><p id="draft-location"></p><div id="draft-recent" hidden><p class="hint">最近目录 · 点击打开，必要时重新授权</p><div class="draft-location-actions" id="draft-recent-list"></div></div>';
  dialog.querySelector('.draft-body').prepend(locations);
  const saveButton = document.createElement('button'); saveButton.id = 'draft-save'; saveButton.textContent = '保存草稿';
  const badge = document.createElement('span'); badge.id = 'draft-save-state'; badge.setAttribute('role', 'status');
  document.querySelector('.top-actions').prepend(saveButton, badge);
  // 显示当前作品的持久化状态，只有事务成功才显示已保存。
  function state(message) {
    badge.textContent = message + (store.isFolder ? ' · 文件夹' : '');
    document.querySelector('.project').textContent = current?.name || '未命名作品';
  }
  // 将异常转换为可执行提示，不清空用户当前的编辑内容。
  function fail(error) {
    storageError = error.name === 'QuotaExceededError' ? '存储空间不足，请删除旧草稿后重试' : error.message;
    state('未保存'); $('draft-message').textContent = storageError;
    status(`草稿操作失败：${storageError}`);
  }
  // 保存快照；切换之前等待已有保存完成，旧请求不会写入新的草稿。
  async function save() {
    if (saving) await saving;
    if (editor.locked()) throw new Error('请暂停播放并等待当前操作结束后保存');
    const snapshot = editor.snapshot(), signature = JSON.stringify(snapshot.project);
    if (current && signature === saved && !storageError) return current;
    const record = current || { id: crypto.randomUUID(), name: '未命名作品', createdAt: Date.now(), revision: 0 };
    state('保存中');
    saving = store.save({ ...record, project: snapshot.project, schemaVersion: 1, assetIds: snapshot.files.map(item => item.id), assetInfo: snapshot.files.map(({ blob, ...item }) => item), size: snapshot.files.reduce((sum, item) => sum + item.size, 0), duration: total(), cover: editor.cover() }, snapshot.files, record.revision);
    try { current = await saving; saved = signature; storageError = ''; state('已保存'); return current; }
    finally { saving = null; }
  }
  // 统一锁定草稿面板，避免重名、删除与异步恢复相互交错。
  async function operation(action) {
    if (working) return;
    if (busy || switching || trackDrag || stickerDrag || textDrag) { fail(new Error('请等待当前编辑操作结束')); return; }
    working = true; editor.pause();
    dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    saveButton.disabled = true;
    try { await action(); }
    catch (error) { if (error.name !== 'AbortError') fail(error); }
    finally { working = false; saveButton.disabled = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); locationState(); }
  }
  // 展示当前保存位置，目录模式下清理浏览器数据不会删除磁盘文件。
  function locationState() {
    $('draft-location').textContent = store.isFolder ? `保存位置：${store.name}` : '保存位置：当前浏览器';
    $('draft-folder-pick').disabled = !window.showDirectoryPicker;
    $('draft-folder-pick').title = window.showDirectoryPicker ? '选择作品目录或内部 jianyi-drafts 目录；不会复制当前作品' : '当前浏览器不支持目录写入，请使用桌面 Chrome 或 Edge';
    $('draft-folder-save-as').disabled = !window.showDirectoryPicker || (!current && !sources.length && !draftFonts.size);
    $('draft-folder-save-as').title = '把当前作品保存为文件夹草稿副本，原草稿保留';
    const recentList = $('draft-recent-list'); recentList.replaceChildren();
    $('draft-recent').hidden = !recentFolders.length;
    for (const entry of recentFolders) {
      const button = document.createElement('button'); button.textContent = entry.name; button.title = `打开 ${entry.name}`;
      button.onclick = () => operation(() => chooseFolder('open', entry)); recentList.append(button);
    }
    $('draft-folder-clean').hidden = !store.isFolder;
    // CLI 编辑窗口固定连接启动时的库，避免误切到其他存储位置。
    for (const id of ['draft-browser', 'draft-folder-pick', 'draft-folder-save-as', 'draft-recent']) if (store.isServer) $(id).hidden = true;
    if (store.isServer) $('draft-folder-clean').hidden = true;
    dialog.querySelector('.draft-body > .hint').textContent = store.isFolder
      ? '草稿和素材写入所选文件夹；请备份整个 jianyi-drafts 目录。删除草稿后可手动清理未引用素材。不要在不同浏览器同时编辑同一目录。'
      : '草稿和素材仅保存在当前浏览器；清理站点数据会删除草稿。不同网址、浏览器的草稿不互通。';
    if (store.isServer) dialog.querySelector('.draft-body > .hint').textContent = '通过本地服务保存到此草稿库。请保持 CLI 终端运行；结束前确认“已保存”。';
  }
  // 打开只切换列表，另存才复制当前作品；权限请求保持在用户点击事件内。
  async function chooseFolder(mode = 'open', entry = null) {
    const parent = entry?.handle || await window.showDirectoryPicker({ mode: 'readwrite', id: 'jianyi-drafts' });
    if (!parent) throw new Error('请先选择文件夹');
    if (await parent.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('没有获得文件夹读写权限，当前草稿保持原保存位置');
    const target = await folder.connect(parent, { create: mode === 'save-as' });
    if (entry?.name) target.name = entry.name;
    // 先确认目标清单可读，再保存原作品，失败时不切换当前状态。
    const targetItems = await target.list();
    if (!entry && target.name === 'jianyi-drafts' && targetItems[0]?.name) target.name = `${targetItems[0].name} / jianyi-drafts`;
    await preserve();
    if (mode === 'open' && store.isFolder && await store.root.isSameEntry(target.root)) {
      recentFolders = await folder.recent(target.root, target.name); await list(); return;
    }
    let record = null, signature = '';
    if (mode === 'save-as' && (current || sources.length || draftFonts.size)) {
      const snapshot = editor.snapshot(); signature = JSON.stringify(snapshot.project);
      record = await target.save({ id: crypto.randomUUID(), name: current?.name || '未命名作品', createdAt: Date.now(), project: snapshot.project, schemaVersion: 1, assetIds: snapshot.files.map(f => f.id), assetInfo: snapshot.files.map(({ blob, ...info }) => info), size: snapshot.files.reduce((sum, f) => sum + f.size, 0), duration: total(), cover: editor.cover() }, snapshot.files, 0);
    }
    if (mode === 'open') await editor.restore(empty(), new Map());
    store = target; current = record; saved = signature; observed = signature; storageError = ''; damaged.clear();
    try { recentFolders = await folder.recent(target.root, target.name); } catch { status('无法记住目录，下次请重新选择；当前草稿保存位置不受影响'); }
    state(record ? '已保存' : '未创建草稿'); locationState(); await list();
    $('draft-message').textContent = record ? '当前作品已另存到文件夹，原位置草稿保留。' : '已打开目录，请从列表选择草稿。';
  }
  // 切回浏览器列表前先保存当前文件夹草稿，不自动复制文件回浏览器。
  async function browserDrafts() {
    if (!store.isFolder) return list();
    await preserve(); await editor.restore(empty(), new Map());
    store = window.JianyiDraftStore; current = null; saved = ''; observed = ''; storageError = ''; damaged.clear();
    state('未创建草稿'); locationState(); await list();
  }
  // 只有当前工程包含素材或已有草稿时才保存，避免打开列表制造空记录。
  async function preserve() { if (current || sources.length || draftFonts.size) await save(); }
  // 创建空项目配置，以同一恢复入口释放旧作品并重置全部轨道。
  function empty() {
    return { schemaVersion: 1, sources: [], clips: [], texts: [], stickers: [], audio: [], fonts: [], ratio: 'original', volume: 100, zoom: 100, playhead: 0, selected: -1, inspectorMode: 'video', exportName: '剪易作品', exportFormat: 'mp4' };
  }
  // 新建前保存当前作品；新草稿持久化成功后才切换编辑器。
  async function create() {
    await preserve();
    const project = empty(), name = prompt('草稿名称', '未命名作品'); if (name === null) return;
    const record = await store.save({ id: crypto.randomUUID(), name: name.trim().slice(0, 100) || '未命名作品', createdAt: Date.now(), project, schemaVersion: 1, assetIds: [], assetInfo: [], size: 0, duration: 0, cover: '' }, [], 0);
    await editor.restore(project, new Map()); current = record; saved = JSON.stringify(editor.snapshot().project); storageError = ''; state('已保存'); dialog.close();
  }
  // 选择草稿时先保存当前作品，损坏素材不会替换正在编辑的时间线。
  async function load(id) {
    await preserve(); const { draft, files } = await store.get(id);
    try { await editor.restore(draft.project, files); damaged.delete(id); }
    catch (error) { damaged.set(id, error.message); await list(); throw error; }
    current = draft; saved = JSON.stringify(editor.snapshot().project); observed = saved; storageError = ''; state('已保存'); dialog.close(); status('草稿已恢复');
  }
  // 修改名称独立更新数据库，并同步当前草稿的修订号。
  async function rename(item) {
    await preserve(); const { draft } = await store.get(item.id);
    const name = prompt('草稿名称', draft.name); if (name === null || !name.trim()) return;
    const updated = await store.change(draft.id, draft.revision, name.trim().slice(0, 100));
    if (current?.id === draft.id) { current = updated; state('已保存'); }
    await list();
  }
  // 复制配置并共享素材引用，任一副本删除都不会影响其他草稿。
  async function duplicate(item) {
    await preserve(); const { draft } = await store.get(item.id);
    await store.save({ ...draft, id: crypto.randomUUID(), name: (draft.name + ' 副本').slice(0, 100), createdAt: Date.now() }, [], 0); await list();
  }
  // 删除前明确提示永久删除范围；当前草稿删除成功后回到空作品。
  async function remove(item) {
    if (!confirm(`删除草稿“${item.name}”？${store.isFolder ? '素材文件暂时保留，可稍后清理未引用素材。' : '未被其他草稿引用的素材副本也会删除。'}草稿删除无法撤销。`)) return;
    if (saving) await saving;
    await store.change(item.id, item.revision, null);
    if (current?.id === item.id) { await editor.restore(empty(), new Map()); current = null; saved = ''; observed = ''; state('未创建草稿'); }
    await list();
  }
  // 为缺失或损坏素材重新选择文件；验证可恢复后用新素材标识另存副本。
  async function repair(item) {
    await preserve(); const { draft, files } = await store.get(item.id);
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    // 浏览器文件选择完成后再进入串行操作，按原文件名和大小匹配。
    input.onchange = () => operation(async () => {
      const project = structuredClone(draft.project), selectedFiles = [...input.files]; let count = 0;
      for (const info of draft.assetInfo || []) {
        const value = selectedFiles.find(f => f.name === info.name && f.size === info.size); if (!value) continue;
        const id = crypto.randomUUID(); files.set(id, { ...info, id, blob: value });
        for (const group of [project.sources, project.stickers, project.audio, project.fonts]) for (const entry of group) if (entry.assetId === info.id) entry.assetId = id;
        count++;
      }
      if (!count) throw new Error('未匹配到同名且大小一致的原素材，请选择原文件');
      await editor.restore(project, files); current = null; saved = ''; storageError = '';
      await save(); current = await store.change(current.id, current.revision, draft.name + ' 恢复副本');
      state('已保存'); dialog.close();
    });
    input.click();
  }
  // 用安全文本节点生成草稿列表，名称不会被解释为 HTML。
  async function list() {
    const request = ++loadRequest, items = await store.list(); if (request !== loadRequest) return;
    const container = $('draft-list'); container.replaceChildren();
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '还没有草稿，点击“新建草稿”开始。'; container.append(empty); }
    for (const item of items) {
      const row = document.createElement('div'); row.className = 'draft-row'; row.dataset.draftId = item.id;
      const button = document.createElement('button'); button.className = 'draft-item' + (current?.id === item.id ? ' current' : '');
      const cover = document.createElement('img'); cover.className = 'draft-cover'; cover.alt = ''; if (item.cover) cover.src = item.cover;
      const detail = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('small');
      title.textContent = item.name; meta.textContent = `${new Date(item.updatedAt).toLocaleString()} · ${time(item.duration)} · ${(item.size / 1024 / 1024).toFixed(1)} MB`;
      if (damaged.has(item.id)) meta.textContent += ` · 无法恢复：${damaged.get(item.id)}`;
      detail.append(title, meta); button.append(cover, detail); button.onclick = () => operation(() => load(item.id));
      const actions = document.createElement('div'); actions.className = 'draft-row-actions';
      for (const [name, handler] of [['重命名', rename], ['复制', duplicate], ['重新关联素材', repair], ['删除', remove]]) {
        const action = document.createElement('button'); action.textContent = name; action.onclick = () => operation(() => handler(item)); actions.append(action);
      }
      row.append(button, actions); container.append(row);
    }
  }
  // 打开列表暂停播放并刷新数据，不自动恢复任何草稿。
  async function show() {
    editor.pause(); $('draft-message').textContent = '';
    try { await preserve(); } catch (error) { fail(error); }
    await list(); if (!dialog.open) dialog.showModal();
  }
  $('draft-open').onclick = () => operation(show);
  $('draft-new').onclick = () => operation(create);
  $('draft-refresh').onclick = () => operation(show);
  $('draft-folder-pick').onclick = () => operation(() => chooseFolder());
  $('draft-folder-save-as').onclick = () => operation(() => chooseFolder('save-as'));
  $('draft-browser').onclick = () => operation(browserDrafts);
  // 清理范围仅包含应用专用目录中的无引用素材，不删除任何原始文件。
  $('draft-folder-clean').onclick = () => operation(async () => {
    await preserve();
    if (confirm('清理 jianyi-drafts/assets 中未被任何草稿引用的素材副本？不会删除原始素材，清理无法撤销。')) {
      const count = await store.clean(); $('draft-message').textContent = `已清理 ${count} 个未引用素材文件或草稿包`;
    }
  });
  saveButton.onclick = () => operation(save);
  // 对话框内的键盘操作不传递到编辑器的删除、播放等快捷键。
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && !working) dialog.close(); });
  $('draft-close').onclick = () => { if (!working) dialog.close(); };
  // 比较轻量 JSON，用户停止修改约 800 毫秒后自动保存；播放时不记录逐帧变化。
  setInterval(() => {
    if (working || saving || editor.locked() || storageError || (!current && !sources.length && !draftFonts.size)) return;
    try {
      const signature = JSON.stringify(editor.snapshot().project);
      if (signature !== observed) { observed = signature; changedAt = Date.now(); if (signature !== saved) state('待保存'); }
      else if (signature !== saved && Date.now() - changedAt >= 800) save().catch(fail);
    } catch (error) { fail(error); }
  }, 250);
  // 关闭前不依赖异步事务完成；存在未保存修改时使用浏览器原生离开提示。
  window.addEventListener('beforeunload', event => {
    if (working || saving || storageError || ((current || sources.length) && JSON.stringify(editor.snapshot().project) !== saved)) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !working && !saving && !editor.locked() && (current || sources.length)) save().catch(fail); });
  // 普通启动不弹列表；CLI 主动打开草稿库或恢复失败时展示列表。
  async function initialize() {
    state('未创建草稿'); locationState();
    try {
      const session = window.JianyiDraftRemote ? await window.JianyiDraftRemote.session() : null;
      locationState(); await list();
      if (session?.draftId) await operation(() => load(session.draftId));
      if ((session && !session.draftId) || storageError) dialog.showModal();
    } catch (error) { fail(error); if (!dialog.open) dialog.showModal(); }
  }
  initialize();
  folder.recent().then(entries => { recentFolders = entries; if (!working) locationState(); }).catch(() => {});
})();
