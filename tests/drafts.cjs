const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const media = process.env.DRAFT_TEST_ASSETS;
if (!media) throw new Error('请将 DRAFT_TEST_ASSETS 指向含 sample.mp4、blue.mp4、music.wav、sticker.png、animated.gif 的测试素材目录');
// 通过真实媒体验证刷新恢复、自动保存、共享素材生命周期和写入失败保护。
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(error.message));
    p.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '草稿测试' : undefined));
    const url = process.env.LIGHTCUT_URL || pathToFileURL(path.resolve(__dirname, '../index.html')).href;
    await p.goto(url); await p.waitForSelector('#draft-dialog[open]');
    await p.click('#draft-new'); await p.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    await p.setInputFiles('#file', [path.join(media, 'sample.mp4'), path.join(media, 'blue.mp4')]);
    await p.waitForFunction(() => clips.length === 2 && !busy && !switching);
    await p.click('[data-library="text"]'); await p.click('#add-text'); await p.fill('#text', '草稿字幕');
    await p.fill('#size', '300');
    if (process.env.DRAFT_TEST_FONT) {
      await p.setInputFiles('#font-file', process.env.DRAFT_TEST_FONT);
      await p.waitForFunction(() => draftFonts.size === 1 && !busy);
    }
    await p.click('[data-library="audio"]'); await p.setInputFiles('#audio-file', path.join(media, 'music.wav'));
    await p.waitForFunction(() => audioClips.length === 1 && !busy);
    await p.click('[data-library="decal"]'); await p.setInputFiles('#decal-file', [path.join(media, 'sticker.png'), path.join(media, 'animated.gif')]);
    await p.waitForFunction(() => stickers.length === 2 && !busy);
    await p.click('[data-library="sticker"]'); await p.setInputFiles('#sticker-file', path.join(media, 'blue.mp4'));
    await p.waitForFunction(() => stickers.length === 3 && !busy);
    await p.evaluate(async () => { clips[0].effect = { kind: 'warm', strength: .6 }; clips[1].transition = { kind: 'dissolve', duration: .4, previousId: clips[0].id }; await navigate(1, clips[1].in + .1); });
    await p.click('#draft-save'); await p.waitForFunction(() => document.querySelector('#draft-save-state').textContent === '已保存');
    const before = await p.evaluate(() => JianyiDraftEditor.snapshot().project);
    const initial = await p.evaluate(() => JianyiDraftStore.list()); assert.equal(initial.length, 1);
    assert.equal(initial[0].assetIds.length, process.env.DRAFT_TEST_FONT ? 7 : 6);
    await p.reload(); await p.waitForSelector('#draft-dialog[open]'); assert.equal(await p.evaluate(() => clips.length), 0);
    await p.click('.draft-item'); await p.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    const after = await p.evaluate(() => JianyiDraftEditor.snapshot().project);
    assert.deepEqual(after, before);
    assert.ok(await p.evaluate(() => clips[1].transition.frame instanceof HTMLCanvasElement));
    if (process.env.DRAFT_TEST_FONT) assert.equal(await p.evaluate(() => document.fonts.check('20px ' + texts[0].font)), true);
    // 拒绝未知版本、缺失素材和损坏文件，且必须保持原作品的快照不变。
    const protection = await p.evaluate(async () => {
      const before = JSON.stringify(JianyiDraftEditor.snapshot().project);
      const { draft, files } = await JianyiDraftStore.get((await JianyiDraftStore.list())[0].id);
      let rejected = 0;
      for (const [project, assets] of [[{ ...draft.project, schemaVersion: 99 }, files], [draft.project, new Map()]]) {
        try { await JianyiDraftEditor.restore(project, assets); } catch { rejected++; }
      }
      const broken = new Map(files), first = draft.project.sources[0].assetId;
      broken.set(first, { ...broken.get(first), blob: new Blob(['broken'], { type: 'video/mp4' }) });
      try { await JianyiDraftEditor.restore(draft.project, broken); } catch { rejected++; }
      let conflict = false;
      try { await JianyiDraftStore.save(draft, [], draft.revision - 1); } catch { conflict = true; }
      return { rejected, conflict, intact: JSON.stringify(JianyiDraftEditor.snapshot().project) === before, locked: JianyiDraftEditor.locked() };
    });
    assert.deepEqual(protection, { rejected: 3, conflict: true, intact: true, locked: false });
    await p.click('[data-library="text"]'); await p.click('[data-inspector="text"]'); await p.selectOption('#text-select', String(before.texts[0].id));
    await p.waitForFunction(() => !switching); await p.fill('#text', '自动保存成功');
    await p.waitForFunction(async () => (await JianyiDraftStore.list())[0].project.texts[0].text === '自动保存成功');
    await p.click('[data-library="video"]'); await p.click('#draft-open'); await p.getByRole('button', { name: '复制', exact: true }).click();
    await p.waitForFunction(async () => (await JianyiDraftStore.list()).length === 2);
    const records = await p.evaluate(() => JianyiDraftStore.list());
    assert.deepEqual(records[0].assetIds, records[1].assetIds);
    await p.locator(`[data-draft-id="${initial[0].id}"]`).getByRole('button', { name: '删除', exact: true }).click();
    await p.waitForFunction(async () => (await JianyiDraftStore.list()).length === 1);
    await p.click('.draft-item'); await p.waitForSelector('#draft-dialog[open]', { state: 'detached' });
    assert.equal(await p.evaluate(() => texts[0].text), '自动保存成功');
    await p.click('[data-library="video"]'); await p.click('#draft-open');
    await p.getByRole('button', { name: '重命名', exact: true }).click();
    await p.waitForFunction(async () => (await JianyiDraftStore.list())[0].name === '草稿测试');
    await p.click('#draft-close');
    // 注入写入失败，旧数据库版本和当前内存内容都必须保留。
    await p.evaluate(() => { window.originalDraftSave = JianyiDraftStore.save; JianyiDraftStore.save = async () => { throw new DOMException('full', 'QuotaExceededError'); }; texts[0].text = '未保存的修改'; });
    await p.click('#draft-save'); await p.waitForFunction(() => document.querySelector('#draft-message').textContent.includes('存储空间不足'));
    assert.equal(await p.evaluate(async () => (await JianyiDraftStore.list())[0].project.texts[0].text), '自动保存成功');
    assert.equal(await p.evaluate(() => texts[0].text), '未保存的修改');
    await p.evaluate(() => { JianyiDraftStore.save = originalDraftSave; }); await p.click('#draft-save');
    await p.waitForFunction(() => document.querySelector('#draft-save-state').textContent === '已保存');
    const download = p.waitForEvent('download'); await p.click('#export'); await p.click('#export-start'); const result = await download;
    const output = process.env.DRAFT_TEST_OUTPUT; if (output) await result.saveAs(output);
    await p.waitForFunction(() => !busy);
    await p.click('[data-library="video"]'); await p.click('#draft-open'); await p.getByRole('button', { name: '删除', exact: true }).click();
    await p.waitForFunction(async () => (await JianyiDraftStore.list()).length === 0);
    const count = await p.evaluate(() => new Promise(resolve => { const r = indexedDB.open('jianyi-drafts', 1); r.onsuccess = () => { const db = r.result; const q = db.transaction('assets').objectStore('assets').count(); q.onsuccess = () => { resolve(q.result); db.close(); }; }; }));
    assert.equal(count, 0); assert.deepEqual(errors, []);
    console.log('PASS refresh + all tracks + transition + autosave + duplicate/delete + quota failure + restored export + asset cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
