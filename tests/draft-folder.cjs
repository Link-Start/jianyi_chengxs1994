const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
// 用真实文件系统 API 验证目录后端；仅将系统目录选择器替换为测试专用 OPFS 目录。
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '目录测试' : undefined));
    await page.addInitScript(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test', { create: true });
    });
    await page.goto(process.env.LIGHTCUT_URL || 'http://127.0.0.1:8836');
    await page.waitForSelector('#draft-dialog[open]');
    await page.click('#draft-folder-pick');
    await page.waitForFunction(() => document.querySelector('#draft-location').textContent.includes('folder-test/'));
    await page.click('#draft-new');
    await page.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    await page.setInputFiles('#file', path.join(process.env.DRAFT_TEST_ASSETS, 'sample.mp4'));
    await page.waitForFunction(() => clips.length === 1 && !busy && !switching);
    await page.click('#draft-save');
    await page.waitForFunction(() => document.querySelector('#draft-save-state').textContent === '已保存 · 文件夹');
    const before = await page.evaluate(() => JianyiDraftEditor.snapshot().project);
    assert.equal(await page.evaluate(async () => (await JianyiDraftStore.list()).length), 0);
    await page.reload(); await page.waitForSelector('#draft-dialog[open]');
    assert.equal(await page.evaluate(() => clips.length), 0);
    await page.waitForSelector('#draft-folder-reconnect:visible');
    await page.click('#draft-folder-reconnect'); await page.waitForSelector('.draft-item');
    await page.click('.draft-item'); await page.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    assert.deepEqual(await page.evaluate(() => JianyiDraftEditor.snapshot().project), before);
    // 校验增量写入、共享引用、冲突拒绝以及手动清理的范围。
    const checks = await page.evaluate(async () => {
      const parent = await showDirectoryPicker(), store = await JianyiDraftFolder.connect(parent);
      const original = (await store.list())[0], root = await parent.getDirectoryHandle('jianyi-drafts'), assets = await root.getDirectoryHandle('assets');
      const asset = await assets.getFileHandle(original.assetIds[0]);
      const modified = (await asset.getFile()).lastModified;
      const copy = await store.save({ ...original, id: crypto.randomUUID() }, [], 0);
      const updated = await store.change(copy.id, copy.revision, '重命名');
      let conflict = false;
      try { await store.save(copy, [], 0); } catch { conflict = true; }
      await store.change(updated.id, updated.revision, null);
      const shared = await store.clean(), unchanged = (await asset.getFile()).lastModified === modified;
      const extra = await assets.getFileHandle(crypto.randomUUID(), { create: true });
      const custom = await assets.getFileHandle('keep.txt', { create: true });
      const removed = await store.clean();
      const customKept = !!await assets.getFileHandle(custom.name);
      let extraGone = false; try { await assets.getFileHandle(extra.name); } catch { extraGone = true; }
      const readBack = await store.get(original.id);
      return { conflict, shared, unchanged, removed, customKept, extraGone, size: readBack.files.get(original.assetIds[0]).blob.size === original.assetInfo[0].size };
    });
    assert.deepEqual(checks, { conflict: true, shared: 0, unchanged: true, removed: 1, customKept: true, extraGone: true, size: true });
    // 模拟清单写入失败，旧清单和当前编辑均应保持完整。
    const failure = await page.evaluate(async () => {
      const parent = await showDirectoryPicker(), store = await JianyiDraftFolder.connect(parent);
      const old = (await store.list())[0], text = JSON.stringify(await store.list());
      const native = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const writer = await native.apply(this, args);
        if (this.name === 'project-index.json') writer.write = async () => { throw new DOMException('模拟磁盘满', 'QuotaExceededError'); };
        return writer;
      };
      let rejected = false;
      try { await store.change(old.id, old.revision, '不应保存'); } catch { rejected = true; }
      finally { FileSystemFileHandle.prototype.createWritable = native; }
      return rejected && JSON.stringify(await store.list()) === text;
    });
    assert.equal(failure, true);
    await page.click('#draft-open');
    await page.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('取消', 'AbortError'); }; });
    await page.click('#draft-folder-pick');
    assert.deepEqual(await page.evaluate(() => JianyiDraftEditor.snapshot().project), before);
    await page.screenshot({ path: process.env.DRAFT_FOLDER_SCREENSHOT || '/tmp/jianyi-folder-test.png' });
    await page.click('#draft-browser');
    await page.waitForFunction(() => document.querySelector('#draft-location').textContent === '保存位置：当前浏览器');
    assert.equal(await page.evaluate(() => clips.length), 0);
    // 从浏览器草稿另存到目录，原草稿必须保留。
    await page.click('#draft-new'); await page.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    await page.setInputFiles('#file', path.join(process.env.DRAFT_TEST_ASSETS, 'sample.mp4'));
    await page.waitForFunction(() => clips.length === 1 && !busy && !switching);
    await page.click('#draft-open');
    await page.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test'); });
    await page.click('#draft-folder-pick');
    await page.waitForFunction(() => document.querySelector('#draft-location').textContent.includes('folder-test/'));
    assert.equal(await page.evaluate(async () => (await JianyiDraftStore.list()).length), 1);
    assert.equal(await page.evaluate(async () => (await (await JianyiDraftFolder.connect(await showDirectoryPicker())).list()).length), 2);
    assert.deepEqual(errors, []);
    console.log('PASS: 目录保存、刷新恢复、素材复用、冲突、清理、失败回滚、取消及浏览器切换');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
