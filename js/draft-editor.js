'use strict';
// 将编辑器的运行时对象转换为可持久化快照，隔离数据库与核心交互。
window.JianyiDraftEditor = (() => {
  const ids = new WeakMap();
  // 为同一个素材文件保留稳定标识，分割与复制不重复保存文件。
  function asset(file, files) {
    if (!(file instanceof Blob)) throw new Error('素材原文件不可用，请重新导入后保存');
    if (!ids.has(file)) ids.set(file, crypto.randomUUID());
    const id = ids.get(file);
    files.set(id, { id, name: file.name || '素材', type: file.type, size: file.size, lastModified: file.lastModified || 0, blob: file });
    return id;
  }
  // 只复制白名单字段，避免 DOM、音频解码缓存与对象 URL 进入 JSON。
  function pick(item, keys) {
    return Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  }
  // 捕获完整的时间线、画布与字体配置，不复制素材字节。
  function snapshot() {
    const files = new Map();
    const project = {
      schemaVersion: 1,
      sources: sources.map(s => ({ id: s.id, assetId: asset(s.file, files) })),
      clips: clips.map(c => ({ ...pick(c, ['id', 'in', 'out', 'lower', 'upper', 'effect']), ...(c.transition ? { transition: pick(c.transition, ['kind', 'duration', 'previousId']) } : {}), sourceId: c.source.id })),
      texts: texts.map(t => ({ ...t })),
      stickers: stickers.map(s => ({ ...pick(s, ['id', 'name', 'decal', 'x', 'y', 'size', 'opacity', 'start', 'end', 'in']), assetId: asset(s.file, files), kind: s.media ? 'video' : s.animation ? 'gif' : 'image' })),
      audio: audioClips.map(a => ({ ...pick(a, ['id', 'name', 'in', 'start', 'end', 'volume']), assetId: asset(a.file, files) })),
      fonts: [...draftFonts].map(([family, entry]) => ({ family, assetId: asset(entry.file, files) })),
      ratio: $('ratio').value, volume: Number($('volume').value), zoom: Number($('timeline-zoom').value),
      playhead: position(), selected, inspectorMode, selectedText: selectedText?.id, selectedSticker: selectedSticker?.id, selectedAudio: selectedAudio?.id,
      exportName: $('export-name').value, exportFormat: $('export-format').value,
    };
    return { project: JSON.parse(JSON.stringify(project)), files: [...files.values()] };
  }
  // 解码所有素材后再替换当前作品，失败时释放临时资源并保留原作品。
  async function restore(project, records, { history = false } = {}) {
    if (busy || switching) throw new Error('请等待当前操作结束');
    if (project.schemaVersion !== 1) throw new Error('不支持此草稿版本，请使用匹配版本的剪易');
    for (const key of ['sources', 'clips', 'texts', 'stickers', 'audio', 'fonts']) if (!Array.isArray(project[key])) throw new Error('草稿数据不完整');
    pause(); busy = 'draft'; controls();
    const urls = [], mediaList = [], preparedSources = [], preparedStickers = [], preparedAudio = [], preparedFonts = [], fileCache = new Map();
    let committed = false;
    const originalNextId = nextId;
    // 根据素材标识读取文件，并在重建后沿用同一数据库标识。
    function file(id) {
      if (fileCache.has(id)) return fileCache.get(id);
      const entry = records.get(id);
      if (!entry?.blob) throw new Error(`素材缺失：${entry?.name || id}`);
      const value = new File([entry.blob], entry.name, { type: entry.type, lastModified: entry.lastModified });
      ids.set(value, id); fileCache.set(id, value); return value;
    }
    // 统一登记临时对象 URL，解码失败时能够完整清理。
    function url(value) { const result = URL.createObjectURL(value); urls.push(result); return result; }
    // 校验片段的有限数值和时长范围，拒绝损坏的配置。
    function interval(item, begin, end, limit) {
      if (!Number.isFinite(item[begin]) || !Number.isFinite(item[end]) || item[begin] < 0 || item[end] <= item[begin] || item[end] > limit + .01) throw new Error('草稿片段时间无效');
    }
    try {
      for (const item of project.sources) {
        const value = file(item.assetId), address = url(value), media = document.createElement('video');
        mediaList.push(media); media.playsInline = true; media.preload = 'auto';
        await mediaEvent(media, 'loadeddata', () => { media.src = address; media.load(); });
        const thumbnail = document.createElement('canvas');
        thumbnail.width = 160; thumbnail.height = Math.max(1, Math.round(160 * media.videoHeight / media.videoWidth));
        thumbnail.getContext('2d').drawImage(media, 0, 0, thumbnail.width, thumbnail.height);
        preparedSources.push({ id: item.id, name: value.name, file: value, url: address, media, thumb: thumbnail.toDataURL('image/jpeg', .6) });
      }
      const sourceMap = new Map(preparedSources.map(s => [s.id, s]));
      const preparedClips = project.clips.map(c => {
        const source = sourceMap.get(c.sourceId); if (!source) throw new Error('草稿视频素材缺失');
        interval(c, 'in', 'out', source.media.duration);
        if (!Number.isFinite(c.lower) || !Number.isFinite(c.upper) || c.lower < 0 || c.lower > c.in || c.upper < c.out || c.upper > source.media.duration + .01) throw new Error('草稿裁剪边界无效');
        return { ...c, source };
      });
      const duration = preparedClips.reduce((sum, c) => sum + c.out - c.in, 0);
      for (let i = 1; i < preparedClips.length; i++) {
        const c = preparedClips[i], previous = preparedClips[i - 1];
        if (!isFrameTransition(c.transition?.kind)) continue;
        await seek(previous.source.media, Math.max(previous.in, previous.out - .001));
        const frame = document.createElement('canvas'), media = previous.source.media;
        const scale = Math.min(1, 1280 / Math.max(media.videoWidth, media.videoHeight));
        frame.width = Math.round(media.videoWidth * scale); frame.height = Math.round(media.videoHeight * scale);
        frame.getContext('2d').drawImage(media, 0, 0, frame.width, frame.height);
        c.transition = { ...c.transition, frame, key: `${previous.id}:${previous.out}` };
      }
      for (const t of project.texts) { interval(t, 'start', 'end', duration); if (!Number.isFinite(t.size) || t.size < 20 || t.size > 1000 || typeof t.text !== 'string') throw new Error('草稿文字参数无效'); }
      for (const item of project.stickers) {
        interval(item, 'start', 'end', duration);
        const value = file(item.assetId), address = url(value); let decoded;
        if (item.kind === 'video') { decoded = await loadPipVideo(value, address); mediaList.push(decoded.media); if (item.in < 0 || item.in + item.end - item.start > decoded.media.duration + .01) throw new Error('画中画时间无效'); }
        else if (item.kind === 'gif') decoded = await loadGifSticker(value, address);
        else if (item.kind === 'image') { const image = new Image(); image.src = address; await image.decode(); decoded = { image }; }
        else throw new Error('未知画中画类型');
        preparedStickers.push({ ...decoded, ...item, file: value, url: address });
      }
      if (project.audio.length) await setupAudio(false);
      const buffers = new Map();
      for (const item of project.audio) {
        interval(item, 'start', 'end', duration);
        const value = file(item.assetId);
        if (!buffers.has(item.assetId)) buffers.set(item.assetId, await audioCtx.decodeAudioData(await value.arrayBuffer()));
        const buffer = buffers.get(item.assetId);
        if (!Number.isFinite(item.in) || item.in < 0 || item.in + item.end - item.start > buffer.duration + .01) throw new Error('音频时间无效');
        preparedAudio.push({ ...item, file: value, buffer });
      }
      for (const item of project.fonts) { const value = file(item.assetId), face = new FontFace(item.family, await value.arrayBuffer()); await face.load(); preparedFonts.push({ ...item, file: value, face }); }
      if (!['original', '16:9', '9:16', '1:1'].includes(project.ratio)) throw new Error('草稿画布比例无效');
      const items = [...preparedSources, ...preparedClips, ...project.texts, ...preparedStickers, ...preparedAudio];
      if (items.some(item => !Number.isSafeInteger(item.id) || item.id < 1) || new Set(items.map(item => item.id)).size !== items.length) throw new Error('草稿片段标识无效');
      let index = preparedClips.length ? Math.max(0, Math.min(project.selected || 0, preparedClips.length - 1)) : -1;
      let elapsed = 0, t = Math.max(0, Math.min(duration, project.playhead || 0));
      for (let i = 0; i < preparedClips.length; i++) { const c = preparedClips[i]; if (t < elapsed + c.out - c.in || i === preparedClips.length - 1) { index = i; await seek(c.source.media, c.in + Math.min(c.out - c.in, t - elapsed)); break; } elapsed += c.out - c.in; }
      for (const item of preparedStickers) if (item.media) await seek(item.media, Math.min(item.media.duration - .001, item.in + Math.max(0, Math.min(item.end - item.start, t - item.start))));
      // 所有素材验证通过后，才释放旧作品并提交新的内存状态。
      for (const source of sources) { source.node?.disconnect(); source.media.removeAttribute('src'); source.media.load(); URL.revokeObjectURL(source.url); }
      stickers.splice(0).forEach(releaseSticker);
      for (const [family, entry] of draftFonts) { document.fonts.delete(entry.face); [...$('font-family').options].filter(o => o.value === family).forEach(o => o.remove()); }
      draftFonts.clear();
      sources.splice(0, sources.length, ...preparedSources); clips.splice(0, clips.length, ...preparedClips);
      texts.splice(0, texts.length, ...project.texts.map(item => ({ ...item })));
      stickers.push(...preparedStickers); audioClips.splice(0, audioClips.length, ...preparedAudio);
      for (const entry of preparedFonts) { registerFont(entry.face, entry.file.name + ' · 已导入'); draftFonts.set(entry.family, entry); }
      nextId = Math.max(1, ...items.map(item => item.id + 1), ...preparedFonts.map(item => Number(item.family.match(/\d+$/)?.[0] || 0) + 1));
      selected = index; video = currentClip()?.source.media || null;
      selectedText = texts.find(item => item.id === project.selectedText) || null;
      selectedSticker = stickers.find(item => item.id === project.selectedSticker) || null;
      selectedAudio = audioClips.find(item => item.id === project.selectedAudio) || null;
      $('ratio').value = project.ratio; $('volume').value = project.volume; $('volumevalue').textContent = `${project.volume}%`;
      $('timeline-zoom').value = project.zoom; $('timeline-zoom').dispatchEvent(new Event('input'));
      $('export-name').value = project.exportName || '剪易作品'; $('export-format').value = project.exportFormat || 'mp4';
      for (const source of sources) {
        const media = source.media;
        media.onplaying = () => { if (video === media && playing) scheduleMusic(); };
        media.onwaiting = () => { if (video === media) { stopMusic(); stopPipVideos(); } };
        media.onended = () => { if (video === media && playing) advance(); };
        media.onseeked = () => { if (video === media && !switching) draw(); };
        media.onerror = () => {
          if (video !== media || !playing) return;
          if (busy === 'export') stopExport(false, '草稿素材读取失败，导出已终止');
          else { pause(); status('草稿素材读取失败，请在草稿列表重新关联素材'); }
        };
      }
      committed = true; render(); resize(); showInspector(['video', 'text', 'audio', 'sticker'].includes(project.inspectorMode) ? project.inspectorMode : 'video'); draw();
    } finally {
      if (!committed) { nextId = originalNextId; for (const media of mediaList) { media.removeAttribute('src'); media.load(); } urls.forEach(URL.revokeObjectURL); }
      busy = ''; controls();
      if (committed && !history) window.dispatchEvent(new Event('easycut-project-restored'));
    }
  }
  // 为列表生成小尺寸封面，避免存储整张预览画布。
  function cover() {
    if (!clips.length) return '';
    const image = document.createElement('canvas'); image.width = 240; image.height = Math.max(1, Math.round(240 * canvas.height / canvas.width));
    image.getContext('2d').drawImage(canvas, 0, 0, image.width, image.height); return image.toDataURL('image/jpeg', .6);
  }
  // 草稿操作只在稳定编辑状态执行，拖拽中不采集半完成的位置。
  function locked() { return !!(busy || switching || playing || trackDrag || stickerDrag || textDrag || scrubPointer); }
  return { snapshot, restore, cover, locked, pause };
})();
