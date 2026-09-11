'use strict';
// 获取页面元素。
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d');
const clips = [], sources = [], stickers = [], texts = [], audioClips = [];
// 保留导入字体原文件，草稿可以在下次打开时重建字体。
const draftFonts = new Map();
let selectedAudio = null, musicVoices = [];
let textDrag = null;
let selectedText = null, trackDrag = null, inspectorMode = 'video';
let selectedSticker = null, stickerDrag = null;
let scrubPointer = null, scrubTarget = null, scrubPending = null, scrubRunning = false;
let selected = -1, video = null, nextId = 1, busy = '', switching = false;
let playing = false, recorder, audioCtx, master, audioDest, exportStream;
let downloadURL, runId = 0, exportError = '', cancelled = false, muxController;
// 获取选中片段及作品累计时长。
const currentClip = () => clips[selected];
const length = clip => clip.out - clip.in;
const total = () => clips.reduce((sum, clip) => sum + length(clip), 0);
const offset = index => clips.slice(0, index).reduce((sum, clip) => sum + length(clip), 0);
const position = () => currentClip() ? offset(selected) + Math.max(0, Math.min(length(currentClip()), video.currentTime - currentClip().in)) : 0;
// 将秒数转换为时间码。
function time(seconds) {
  const tenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${(tenths % 600 / 10).toFixed(1).padStart(4, '0')}`;
}
// 展示操作结果。
function status(message) { $('status').textContent = message; }
// 统一限制加载、切换和导出期间的编辑，避免异步操作交错。
function controls() {
  const locked = !!busy || switching, ready = clips.length > 0;
  document.querySelectorAll('[data-edit]').forEach(el => el.disabled = !ready || locked);
  for (const id of ['play', 'back', 'export', 'delete']) $(id).disabled = !ready || locked;
  const clip = currentClip();
  $('split').disabled = inspectorMode !== 'video' || !clip || locked || video.currentTime - clip.in < .1 || clip.out - video.currentTime < .1;
  if (inspectorMode === 'audio') $('split').disabled = locked || !selectedAudio || position() - selectedAudio.start < .1 || selectedAudio.end - position() < .1;
  if (inspectorMode === 'sticker') $('split').disabled = locked || !selectedSticker || position() - selectedSticker.start < .1 || selectedSticker.end - position() < .1;
  $('import-audio').disabled = !ready || locked;
  $('audio-select').disabled = !audioClips.length || locked;
  document.querySelectorAll('[data-audio]').forEach(el => el.disabled = !selectedAudio || locked);
  $('pip-in').disabled = locked || !selectedSticker?.media;
  document.querySelectorAll('[data-preset]').forEach(el => el.disabled = !ready || locked);
  $('import-font').disabled = locked;
  $('import').disabled = locked;
  $('export-format').disabled = locked;
  $('add-text').disabled = !ready || locked;
  if ($('add-text-segment')) $('add-text-segment').disabled = !ready || locked;
  $('text-select').disabled = !texts.length || locked;
  document.querySelectorAll('[data-text]').forEach(el => el.disabled = !selectedText || locked);
  document.querySelectorAll('.overlay-item').forEach(el => el.disabled = locked);
  $('cancel').hidden = busy !== 'export';
  $('export').hidden = busy === 'export';
  document.querySelectorAll('.asset,.clip').forEach(el => el.disabled = locked);
  $('import-sticker').disabled = $('import-decal').disabled = !ready || locked;
  $('sticker-select').disabled = !stickers.length || locked;
  document.querySelectorAll('[data-sticker]').forEach(el => el.disabled = !selectedSticker || locked);
  $('delete-selection').disabled = locked || !(inspectorMode === 'video' ? currentClip() : inspectorMode === 'text' ? selectedText : inspectorMode === 'audio' ? selectedAudio : selectedSticker);
  document.querySelectorAll('[data-library],[data-inspector],.resource-list button,#sticker-library button,#decal-library button').forEach(el => el.disabled = locked);
  document.querySelectorAll('[data-fx]').forEach(el => el.disabled = !ready || locked);
  document.querySelectorAll('[data-transition]').forEach(el => el.disabled = clips.length < 2 || locked);
  syncSelection(); updateStickerOutline(); syncPlayhead();
}
// 等待指定媒体事件，失败或超时后移除监听器。
function mediaEvent(media, name, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('媒体响应超时')), 20000);
    const ok = () => finish(), fail = () => finish(new Error('无法解码视频，请换用 H.264 MP4 或 WebM'));
    // 清理本次等待，确保只结算一次。
    function finish(error) {
      clearTimeout(timer);
      media.removeEventListener(name, ok); media.removeEventListener('error', fail);
      error ? reject(error) : resolve();
    }
    media.addEventListener(name, ok, { once: true }); media.addEventListener('error', fail, { once: true });
    try { action(); } catch (error) { finish(error); }
  });
}
// 跳转到素材时间，兼容相同时间不触发 seeked 的情况。
async function seek(media, seconds) {
  if (Math.abs(media.currentTime - seconds) < .001 && media.readyState >= 2) return;
  await mediaEvent(media, 'seeked', () => { media.currentTime = seconds; });
}
// 暂停所有素材，确保不会同时播放多段原声。
function pause() {
  stopPipVideos(); stopMusic();
  playing = false;
  sources.forEach(source => source.media.pause());
  $('play').textContent = '▶';
  updateStickerOutline();
}
// 切换片段并定位；所有调用者负责在交互入口检查锁定状态。
async function activate(index, seconds = clips[index]?.in) {
  switching = true; controls();
  try {
    stopPipVideos(); stopMusic(); video?.pause(); selected = index; video = currentClip().source.media;
    await seek(video, seconds);
    await prepareTransition(index);
    await preparePipVideos(position());
    render(); draw();
  } finally { switching = false; controls(); }
}
// 批量导入素材并追加片段，单文件失败不会丢失已有作品。
async function importVideos(files) {
  if (busy || switching || !files.length) return;
  pause(); busy = 'import'; controls();
  let imported = 0; const failures = [], firstNew = clips.length;
  for (const file of files) {
    status(`正在导入 ${file.name}…`);
    const url = URL.createObjectURL(file), media = document.createElement('video');
    media.playsInline = true; media.preload = 'auto';
    try {
      await mediaEvent(media, 'loadeddata', () => { media.src = url; media.load(); });
      if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('无有效时长');
      // 按原视频比例生成缩略图，避免竖屏素材被压成横屏。
      const thumb = document.createElement('canvas');
      const thumbScale = Math.min(1, 240 / Math.max(media.videoWidth, media.videoHeight));
      thumb.width = Math.max(1, Math.round(media.videoWidth * thumbScale));
      thumb.height = Math.max(1, Math.round(media.videoHeight * thumbScale));
      thumb.getContext('2d').drawImage(media, 0, 0, thumb.width, thumb.height);
      const source = { id: nextId++, name: file.name, file, url, media, thumb: thumb.toDataURL('image/jpeg', .6) };
      sources.push(source);
      clips.push({ id: nextId++, source, in: 0, out: media.duration, lower: 0, upper: media.duration });
      media.onplaying = () => { if (video === media && playing) scheduleMusic(); };
      media.onwaiting = () => { if (video === media) { stopMusic(); stopPipVideos(); } };
      media.onended = () => { if (video === media && playing) advance(); };
      media.onseeked = () => { if (video === media && !switching) draw(); };
      media.onerror = () => {
        if (video !== media || !playing) return;
        if (busy === 'export') stopExport(false, '素材读取失败，导出已终止');
        else { pause(); status('素材读取失败，请重新导入'); }
      };
      imported++;
    } catch (error) {
      media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url);
      failures.push(`${file.name}（${error.message}）`);
    }
  }
  try {
    if (imported) { showInspector('video'); await activate(firstNew); resize(); }
    render();
    status(`已导入 ${imported} 段${failures.length ? `；失败：${failures.join('、')}` : ' · 新片段已追加到时间线'}`);
  } catch (error) { status(error.message); }
  finally { busy = ''; controls(); $('file').value = ''; }
}
// 绘制片段按钮、素材列表和选中片段的裁剪范围。
function render() {
  const duration = total(), clip = currentClip();
  $('clips').replaceChildren(); $('assets').replaceChildren();
  let accumulated = 0;
  clips.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = `clip${index === selected ? ' selected' : ''}`;
    button.style.left = `${accumulated / duration * 100}%`;
    button.style.width = `${length(item) / duration * 100}%`;
    const caption = document.createElement('span'); caption.textContent = `${index + 1} · ${item.source.name}`; button.append(caption);
    button.style.backgroundImage = `url(${item.source.thumb})`;
    button.title = `${item.source.name} · ${time(length(item))}`;
    button.setAttribute('aria-pressed', index === selected);
    button.onclick = event => {
      event.stopPropagation(); if (busy || switching) return;
      const rect = button.getBoundingClientRect();
      showInspector('video'); navigate(index, item.in + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * length(item));
    };
    window.EasyCutTimeline?.bind(button, item);
    $('clips').append(button); accumulated += length(item);
  });
  sources.forEach(source => {
    const button = document.createElement('button'); button.className = `asset${clip?.source === source ? ' selected' : ''}`;
    const img = document.createElement('img'); img.src = source.thumb; img.alt = '视频素材缩略图';
    const detail = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('small');
    title.textContent = source.name; meta.textContent = `${time(source.media.duration)} · ${clips.filter(item => item.source === source).length} 个片段`;
    detail.append(title, meta); button.append(img, detail);
    button.onclick = () => { showInspector('video'); navigate(clips.findIndex(item => item.source === source)); };
    $('assets').append(button);
  });
  for (const id of ['start', 'end']) {
    $(id).min = clip?.lower || 0; $(id).max = clip?.upper || 0;
    $(id).value = (id === 'start' || id === 'in' ? clip?.in || 0 : clip?.out || 0).toFixed(2);
  }
  $('selection').textContent = clip ? `片段 ${selected + 1} / ${clips.length} · 全片 ${time(duration)}` : '导入视频，开始剪辑';
  $('drop').hidden = sources.length > 0;
  $('duration').textContent = `/ ${time(duration)}`;
  [...$('ruler').children].forEach((el, i) => el.textContent = time(duration * i / 4));
  $('track').setAttribute('aria-valuemax', duration);
  $('canvas').hidden = !clip; $('empty').hidden = !!clip;
  if (!clip) { $('current').textContent = time(0); $('head').style.left = '0'; $('track').setAttribute('aria-valuenow', 0); $('resolution').textContent = '准备创作'; }
  renderEffects(); filterAssets(); normalizeStickers(); normalizeTexts(); normalizeAudio(); renderAudio(); renderTexts(); renderStickers(); controls();
}
// 手动定位会停止连续播放。
async function navigate(index, seconds) {
  if (busy || switching || index < 0) return;
  pause();
  try { await activate(index, seconds); } catch (error) { status(error.message); }
}
// 将作品全局时间映射到对应片段的素材时间。
function navigateTime(seconds) {
  const t = Math.max(0, Math.min(total(), seconds)); let elapsed = 0;
  for (let i = 0; i < clips.length; i++) {
    if (t < elapsed + length(clips[i]) || i === clips.length - 1) {
      return navigate(i, clips[i].in + t - elapsed);
    }
    elapsed += length(clips[i]);
  }
}
// 使用首段素材确定统一输出尺寸，片段切换不改变画布尺寸。
function resize() {
  if (!clips.length) return;
  const first = clips[0].source.media, ratio = $('ratio').value;
  const r = ratio === 'original' ? first.videoWidth / first.videoHeight : ratio.split(':').reduce((a, b) => a / b);
  const longest = Math.min(1280, Math.max(first.videoWidth, first.videoHeight));
  canvas.width = Math.max(2, Math.round((r >= 1 ? longest : longest * r) / 2) * 2);
  canvas.height = Math.max(2, Math.round((r >= 1 ? longest / r : longest) / 2) * 2);
  $('resolution').textContent = `${canvas.width} × ${canvas.height}`; draw();
}
// 裁剪仅改变选中片段，并限制在该片段的分割边界内。
function trim(which, value) {
  const clip = currentClip(); if (!clip || busy || switching || value === '') return;
  const v = Number(value), min = Math.min(.1, clip.upper - clip.lower);
  if (!Number.isFinite(v)) return;
  pause();
  if (which === 'start') clip.in = Math.max(clip.lower, Math.min(v, clip.out - min));
  else clip.out = Math.min(clip.upper, Math.max(v, clip.in + min));
  navigate(selected, which === 'start' ? clip.in : Math.max(clip.in, clip.out - .04));
}
// 在播放头处分成两个独立片段，保留素材引用及总时长。
function split() {
  if ($('split').disabled) return;
  pause(); const clip = currentClip(), t = video.currentTime;
  const right = { ...clip, id: nextId++, in: t, lower: t };
  delete right.transition;
  clip.out = t; clip.upper = t;
  clips.splice(selected + 1, 0, right); selected++;
  render(); draw(); status('已分割 · 当前选中右侧片段');
}
// 删除选中片段；素材无引用时释放解码器和对象 URL。
async function deleteClip() {
  if (!currentClip() || busy || switching) return;
  pause(); const [removed] = clips.splice(selected, 1);
  if (!clips.some(clip => clip.source === removed.source)) {
    const source = removed.source;
    source.node?.disconnect(); source.media.removeAttribute('src'); source.media.load();
    URL.revokeObjectURL(source.url); sources.splice(sources.indexOf(source), 1);
  }
  if (clips.length) {
    selected = Math.min(selected, clips.length - 1);
    try { await activate(selected); resize(); } catch (error) { status(error.message); return; }
  } else { selected = -1; video = null; render(); }
  status('片段已删除');
}
// 合成视频、画中画与文字，并同步三条轨道的播放头。
function draw() {
  if (!currentClip() || !video || video.readyState < 2) return;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  drawMainMedia(video, currentClip());
  drawTransition();
  drawStickers(); drawTexts();
  const t = position(), left = `${total() ? t / total() * 100 : 0}%`;
  $('current').textContent = time(t); $('head').style.left = left;
  document.querySelectorAll('.overlay-head').forEach(el => el.style.left = left);
  $('track').setAttribute('aria-valuenow', t.toFixed(2)); controls();
}
// 为各素材连接共用音量与导出节点，音频节点只创建一次。
async function setupAudio(resume = true) {
  if (!audioCtx) {
    audioCtx = new AudioContext(); master = audioCtx.createGain();
    audioDest = audioCtx.createMediaStreamDestination(); master.connect(audioCtx.destination); master.connect(audioDest);
  }
  for (const source of sources) {
    if (!source.node) { source.node = audioCtx.createMediaElementSource(source.media); source.node.connect(master); }
  }
  master.gain.value = Number($('volume').value) / 100;
  // 自动恢复草稿只解码配乐，用户点击播放后再唤醒受手势限制的音频上下文。
  if (resume) await audioCtx.resume();
}
// 从当前位置连续预览，作品结束后再次播放会从头开始。
async function play() {
  if (!currentClip() || busy || switching) return;
  if (playing) { pause(); return; }
  switching = true; controls();
  try {
    await setupAudio();
    if (position() >= total() - .03) await activate(0);
    else if (video.currentTime >= currentClip().out - .01 && selected < clips.length - 1) await activate(selected + 1);
    playing = true; await video.play(); $('play').textContent = 'Ⅱ';
  } catch (error) { pause(); status(`播放失败：${error.message}`); }
  finally { switching = false; controls(); }
}
// 切换下一片段；切换解码期间暂停录制，避免把等待画面写入成片。
async function advance() {
  if (switching || !playing) return;
  if (selected === clips.length - 1) {
    if (busy === 'export') stopExport(); else pause();
    return;
  }
  const token = runId, exporting = busy === 'export';
  try {
    if (exporting && recorder.state === 'recording') recorder.pause();
    await activate(selected + 1);
    if (token !== runId || !playing) return;
    if (exporting && recorder.state === 'paused') recorder.resume();
    await video.play(); $('play').textContent = 'Ⅱ';
  } catch (error) {
    if (exporting) stopExport(false, error.message);
    else { pause(); status(`片段切换失败：${error.message}`); }
  }
}
// 结束或取消导出，并使正在等待的片段切换失效。
function stopExport(cancel = false, error = '') {
  runId++; cancelled = cancel; exportError = error; pause();
  $('cancel').disabled = true;
  if (cancel || error) muxController?.abort();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
// 将整条时间线录制成一个视频，保留每段原声。
async function exportVideo(options = {}) {
  if (!clips.length || busy || switching) return;
  if (!window.MediaRecorder || !canvas.captureStream) { status('当前浏览器不支持导出，请使用桌面版 Chrome 或 Edge'); return; }
  const format = $('export-format').value;
  const filename = $('export-name').value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.(mp4|mov)$/i, '') || '剪易作品';
  const mime = ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) { status('当前浏览器不支持 H.264/AAC MP4 录制，请使用新版 Chrome、Edge 或 Safari'); return; }
  if (!window.LightcutMux) { status('导出组件加载失败，请确认 vendor 文件夹完整'); return; }
  muxController = new AbortController();
  pause(); busy = 'export'; cancelled = false; exportError = ''; runId++;
  $('cancel').disabled = true; $('download').hidden = true; controls();
  const chunks = []; let outcome;
  try {
    await setupAudio(); await activate(0); resize(); draw();
    exportStream = canvas.captureStream(30);
    audioDest.stream.getAudioTracks().forEach(track => exportStream.addTrack(track.clone()));
    recorder = new MediaRecorder(exportStream, { mimeType: mime, videoBitsPerSecond: 6000000 });
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => stopExport(false, '编码失败，请换用更短的视频重试');
    recorder.onstop = async () => {
      exportStream.getTracks().forEach(track => track.stop());
      try {
        if (exportError) throw new Error(exportError);
        if (cancelled) return;
        const recording = new Blob(chunks, { type: mime });
        if (!recording.size) throw new Error('未生成有效视频，请重试');
        $('cancel').disabled = false;
        status(`正在封装 ${format.toUpperCase()}…`);
        const blob = await window.LightcutMux.convert(recording, format, muxController.signal, progress => {
          $('progress').style.width = `${Math.round(progress * 100)}%`;
        });
        if (cancelled) return;
        if (downloadURL) URL.revokeObjectURL(downloadURL);
        downloadURL = URL.createObjectURL(blob);
        const link = $('download'); link.href = downloadURL;
        link.download = `${filename}.${format}`;
        link.hidden = false; outcome = { blob, filename: link.download }; if (options.download !== false) link.click(); status(`导出完成 · ${format.toUpperCase()} · ${clips.length} 个片段 · ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (error) { outcome = { error: error.message }; if (!cancelled) status(`导出失败：${error.message}`); }
      finally {
        if (cancelled) status('导出已取消，可继续编辑');
        busy = ''; muxController = null; controls(); $('progress').style.width = '0';
        options.onComplete?.(outcome || { cancelled: true });
      }
    };
    recorder.start(200); $('cancel').disabled = false;
    playing = true; await video.play(); status('正在导出整条时间线，请保持页面在前台…');
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') stopExport(false, error.message);
    else { exportStream?.getTracks().forEach(track => track.stop()); busy = ''; controls(); status(`导出失败：${error.message}`); }
  }
}
// 刷新画面，并根据素材时间推进整条时间线。
function tick() {
  if (playing && !switching && currentClip()) {
    draw();
    if (busy === 'export') $('progress').style.width = `${Math.min(100, position() / total() * 100)}%`;
    if (video.currentTime >= currentClip().out || video.ended) advance();
  }
  requestAnimationFrame(tick);
}
$('import').onclick = () => $('file').click();
$('file').onchange = event => importVideos([...event.target.files]);
$('drop').ondragover = event => { event.preventDefault(); if (!busy) $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = event => { event.preventDefault(); $('drop').classList.remove('over'); importVideos([...event.dataTransfer.files]); };
$('play').onclick = play; $('back').onclick = () => navigate(0);
$('split').onclick = () => inspectorMode === 'audio' ? splitAudio() : inspectorMode === 'sticker' ? splitSticker() : split(); $('delete').onclick = deleteClip;
$('export').onclick = openExportDialog; $('cancel').onclick = () => stopExport(true);
for (const id of ['start']) $(id).onchange = event => trim('start', event.target.value);
for (const id of ['end']) $(id).onchange = event => trim('end', event.target.value);
$('ratio').onchange = resize;
for (const id of ['text', 'size', 'position', 'color']) $(id).oninput = editText;
$('volume').oninput = () => { $('volumevalue').textContent = $('volume').value + '%'; if (master) master.gain.value = Number($('volume').value) / 100; };
$('track').onclick = event => { if (!clips.length || busy || switching) return; const rect = $('track').getBoundingClientRect(); navigateTime((event.clientX - rect.left) / rect.width * total()); };
$('track').onkeydown = event => {
  if (!clips.length || busy || switching || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); navigateTime(position() + (event.key === 'ArrowLeft' ? -.1 : .1));
};
window.addEventListener('keydown', event => {
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(document.activeElement.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); play(); }
});
// 初始化编辑器与贴图事件。
initStickers(); initTracks(); initWorkspace(); initNativeLayout(); initPlayhead(); initEffects(); initAudio(); initFonts(); initTextStyles(); render(); tick();

// 将贴图尺寸按比例转换为画布像素，并确保整张图片位于画面内。
function stickerBox(sticker) {
  const aspect = sticker.media ? sticker.media.videoWidth / sticker.media.videoHeight : sticker.image.naturalWidth / sticker.image.naturalHeight;
  const width = Math.min(canvas.width * sticker.size, canvas.height * .95 * aspect);
  const height = width / aspect;
  const x = Math.max(width / 2, Math.min(canvas.width - width / 2, sticker.x * canvas.width));
  const y = Math.max(height / 2, Math.min(canvas.height - height / 2, sticker.y * canvas.height));
  return { x: x - width / 2, y: y - height / 2, width, height };
}
// 根据作品时间判断贴图是否需要合成。
function stickerVisible(sticker) { return position() + .00001 >= sticker.start && position() < sticker.end; }
// 合成贴图到视频之上、文字之下，选中框使用独立 DOM，避免进入导出视频。
function drawStickers() {
  syncPipVideos();
  for (const sticker of stickers) {
    if (!stickerVisible(sticker)) continue;
    const box = stickerBox(sticker);
    ctx.save(); ctx.globalAlpha = sticker.opacity;
    ctx.drawImage(sticker.animation ? gifFrame(sticker) : sticker.media || sticker.image, box.x, box.y, box.width, box.height); ctx.restore();
  }
}
// 视频时长缩短时收紧贴图时间；视频全部删除时释放贴图资源。
function normalizeStickers() {
  const duration = total();
  if (!duration) {
    stickers.splice(0).forEach(releaseSticker); selectedSticker = null;
  } else {
    for (const sticker of stickers) {
      sticker.end = Math.min(sticker.end, duration);
      sticker.start = Math.min(sticker.start, Math.max(0, sticker.end - .1));
    }
  }
}
// 同步选中贴图和属性控件，不触碰画布像素。
function renderStickers() {
  const select = $('sticker-select'); select.replaceChildren();
  if (!stickers.length) select.add(new Option('尚未添加贴图', ''));
  stickers.forEach((sticker, index) => select.add(new Option(`${index + 1} · ${sticker.name}`, String(sticker.id))));
  $('sticker-count').textContent = stickers.length;
  $('pip-in-field').hidden = !selectedSticker?.media;
  if (selectedSticker?.media) { $('pip-in').value = selectedSticker.in.toFixed(2); $('pip-in').max = selectedSticker.media.duration - (selectedSticker.end - selectedSticker.start); }
  if (selectedSticker) {
    select.value = selectedSticker.id;
    $('sticker-start').value = selectedSticker.start.toFixed(2);
    $('sticker-end').value = selectedSticker.end.toFixed(2);
    $('sticker-start').max = $('sticker-end').max = total();
    $('sticker-size').value = Math.round(selectedSticker.size * 100);
    $('sticker-opacity').value = Math.round(selectedSticker.opacity * 100);
    const box = stickerBox(selectedSticker);
    $('sticker-x').value = Math.round((box.x + box.width / 2) / canvas.width * 100);
    $('sticker-y').value = Math.round((box.y + box.height / 2) / canvas.height * 100);
    $('sticker-size-value').textContent = `${$('sticker-size').value}%`;
    $('sticker-opacity-value').textContent = `${$('sticker-opacity').value}%`;
  } else {
    for (const id of ['sticker-start', 'sticker-end', 'sticker-x', 'sticker-y']) $(id).value = '';
    $('sticker-size-value').textContent = $('sticker-opacity-value').textContent = '';
  }
  renderLibraries(); renderOverlayTracks(); updateStickerOutline(); controls();
}
// 批量读取静态图片，保留透明通道，并默认覆盖当前作品的完整时长。
async function importStickers(files, decal = false) {
  if (!clips.length || busy || switching || !files.length) return;
  pause(); busy = 'image'; controls();
  let imported = 0; const failed = [];
  try {
    for (const file of files) {
      const url = URL.createObjectURL(file), image = new Image();
      try {
        if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
          const sticker = await loadPipVideo(file, url); sticker.file = file; stickers.push(sticker); selectedSticker = sticker; imported++; continue;
        }
        if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) {
          const sticker = await loadGifSticker(file, url); sticker.file = file; stickers.push(sticker); selectedSticker = sticker; imported++; continue;
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片');
        image.src = url; await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
        // 固定为解码后的静态画面，避免动画图片随实时播放改变。
        const still = document.createElement('canvas');
        const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
        still.width = Math.max(1, Math.round(image.naturalWidth * scale));
        still.height = Math.max(1, Math.round(image.naturalHeight * scale));
        still.getContext('2d').drawImage(image, 0, 0, still.width, still.height);
        const snapshot = new Image(); snapshot.src = still.toDataURL('image/png'); await snapshot.decode();
        const sticker = { id: nextId++, name: file.name, file, url, image: snapshot, decal, x: .72, y: .28, size: .3, opacity: 1, start: 0, end: total() };
        stickers.push(sticker); selectedSticker = sticker; imported++;
      } catch (error) { URL.revokeObjectURL(url); failed.push(`${file.name}（${error.message}）`); }
    }
    if (imported) { showInspector('sticker'); showLibrary(selectedSticker.decal ? 'decal' : 'sticker'); }
    renderStickers(); draw();
    status(`已添加 ${imported} 个贴纸 / 画中画素材${failed.length ? `；失败：${failed.join('、')}` : ' · 在预览中拖动，可调整大小和显示时间'}`);
  } finally { busy = ''; $('sticker-file').value = $('decal-file').value = ''; controls(); updateStickerOutline(); }
}
// 将选中框定位到画布的实际显示区域，兼容横竖屏与页面缩放。
function updateStickerOutline() {
  const outline = $('sticker-outline');
  const item = inspectorMode === 'text' ? selectedText : inspectorMode === 'sticker' ? selectedSticker : null;
  outline.hidden = !item || !clips.length || busy || playing || !stickerVisible(item) || (inspectorMode === 'text' && !item.text.trim());
  if (outline.hidden) return;
  const canvasRect = canvas.getBoundingClientRect(), screenRect = canvas.parentElement.getBoundingClientRect();
  const box = inspectorMode === 'text' ? textLayout(selectedText).box : stickerBox(selectedSticker), sx = canvasRect.width / canvas.width, sy = canvasRect.height / canvas.height;
  outline.style.left = `${canvasRect.left - screenRect.left - canvas.parentElement.clientLeft + box.x * sx}px`;
  outline.style.top = `${canvasRect.top - screenRect.top - canvas.parentElement.clientTop + box.y * sy}px`;
  outline.style.width = `${box.width * sx}px`; outline.style.height = `${box.height * sy}px`;
}
// 更新贴图属性，限制输入范围并立刻刷新预览。
function editSticker(key, value) {
  if (!selectedSticker || busy || switching) return;
  pause(); const n = Number(value), sticker = selectedSticker;
  if (value === '' || !Number.isFinite(n)) { renderStickers(); return; }
  const oldStart = sticker.start;
  if (key === 'start') sticker.start = Math.max(0, Math.min(n, sticker.end - Math.min(.1, total())));
  else if (key === 'end') sticker.end = Math.min(total(), Math.max(n, sticker.start + Math.min(.1, total())));
  else if (key === 'in' && sticker.media) sticker.in = Math.max(0, Math.min(sticker.media.duration - (sticker.end - sticker.start), n));
  else if (key === 'size') sticker.size = Math.max(.05, Math.min(.9, n / 100));
  else sticker[key] = Math.max(0, Math.min(1, n / 100));
  if (sticker.animation && key === 'start') sticker.in += sticker.start - oldStart;
  if (sticker.media) sticker.end = Math.min(sticker.end, sticker.start + sticker.media.duration - sticker.in);
  renderStickers(); draw();
}
// 将屏幕指针位置映射为画布像素。
function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) / rect.width * canvas.width, y: (event.clientY - rect.top) / rect.height * canvas.height };
}
// 绑定贴图导入、选择、层级、删除以及鼠标和触摸拖动操作。
function initStickers() {
  $('import-decal').onclick = () => $('decal-file').click();
  $('decal-file').onchange = event => importStickers([...event.target.files], true);
  $('decal-search').oninput = renderLibraries;
  $('import-sticker').onclick = () => $('sticker-file').click();
  $('pip-in').onchange = event => editSticker('in', event.target.value);
  $('sticker-file').onchange = event => importStickers([...event.target.files]);
  $('sticker-select').onchange = event => {
    if (busy || switching) return;
    pause(); selectedSticker = stickers.find(sticker => sticker.id === Number(event.target.value)) || null;
    renderStickers(); draw();
    if (selectedSticker && !stickerVisible(selectedSticker)) navigateTime(selectedSticker.start);
  };
  for (const key of ['start', 'end', 'x', 'y']) $(`sticker-${key}`).onchange = event => editSticker(key, event.target.value);
  for (const key of ['size', 'opacity']) $(`sticker-${key}`).oninput = event => editSticker(key, event.target.value);
  $('sticker-delete').onclick = () => {
    if (!selectedSticker || busy || switching) return;
    pause(); releaseSticker(selectedSticker);
    stickers.splice(stickers.indexOf(selectedSticker), 1); selectedSticker = stickers.at(-1) || null;
    renderStickers(); draw(); status('贴图已删除');
  };
  $('sticker-front').onclick = () => {
    if (!selectedSticker || busy || switching) return;
    pause(); stickers.splice(stickers.indexOf(selectedSticker), 1); stickers.push(selectedSticker);
    renderStickers(); draw();
  };
  canvas.onpointerdown = event => {
    if (busy || switching || !clips.length || event.button !== 0) return;
    const point = canvasPoint(event);
    const textHit = [...texts].reverse().find(item => {
      if (!stickerVisible(item) || !item.text.trim()) return false;
      const box = textLayout(item).box;
      return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    });
    if (textHit) {
      pause(); selectedText = textHit; showInspector('text');
      textDrag = { id: event.pointerId, point, box: textLayout(textHit).box, x: textHit.offsetX || 0, y: textHit.offsetY || 0 };
      canvas.setPointerCapture(event.pointerId); renderTexts(); draw(); event.preventDefault(); return;
    }
    const hit = [...stickers].reverse().find(sticker => {
      const box = stickerBox(sticker);
      return stickerVisible(sticker) && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    });
    if (!hit) return;
    pause(); showInspector('sticker'); selectedSticker = hit;
    const box = stickerBox(hit);
    stickerDrag = { id: event.pointerId, dx: point.x - box.x - box.width / 2, dy: point.y - box.y - box.height / 2 };
    canvas.setPointerCapture(event.pointerId); renderStickers(); event.preventDefault();
  };
  canvas.onpointermove = event => {
    if (textDrag && event.pointerId === textDrag.id && !busy && !switching) {
      const point = canvasPoint(event), { box } = textDrag;
      const dx = Math.max(-box.x, Math.min(canvas.width - box.x - box.width, point.x - textDrag.point.x));
      const dy = Math.max(-box.y, Math.min(canvas.height - box.y - box.height, point.y - textDrag.point.y));
      selectedText.offsetX = textDrag.x + dx / canvas.width;
      selectedText.offsetY = textDrag.y + dy / canvas.height;
      draw(); event.preventDefault(); return;
    }
    if (!stickerDrag || event.pointerId !== stickerDrag.id || busy || switching) return;
    const point = canvasPoint(event), box = stickerBox(selectedSticker);
    selectedSticker.x = Math.max(box.width / 2, Math.min(canvas.width - box.width / 2, point.x - stickerDrag.dx)) / canvas.width;
    selectedSticker.y = Math.max(box.height / 2, Math.min(canvas.height - box.height / 2, point.y - stickerDrag.dy)) / canvas.height;
    renderStickers(); draw();
  };
  canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = () => { stickerDrag = null; textDrag = null; };
  window.addEventListener('resize', updateStickerOutline);
}

// 创建独立文字片段，支持多段文字分别设置样式和时间。
function addText(fromInput = false) {
  if (!clips.length || busy || switching) return;
  pause();
  const start = fromInput ? 0 : Math.min(position(), Math.max(0, total() - .1));
  selectedText = { ...defaultTextStyle(), id: nextId++, text: fromInput ? $('text').value : '输入文字', font: $('font-family').value, start, end: fromInput ? total() : Math.min(total(), start + 3) };
  texts.push(selectedText); showInspector('text'); renderTexts(); draw();
}
// 将文字片段限制在作品时长内；空时间线释放全部文字。
function normalizeTexts() {
  if (!total()) { texts.length = 0; selectedText = null; }
  texts.forEach(item => { item.end = Math.min(item.end, total()); item.start = Math.min(item.start, Math.max(0, item.end - .1)); });
}
// 同步文字属性面板和文字轨道。
function renderTexts() {
  $('text-select').replaceChildren();
  if (!texts.length) $('text-select').add(new Option('尚未添加文字', ''));
  texts.forEach((item, index) => $('text-select').add(new Option(`${index + 1} · ${item.text || '空文字'}`, item.id)));
  if (selectedText) {
    syncTextStyle();
    $('text-select').value = selectedText.id;
    $('font-family').value = selectedText.font || 'sans-serif';
    $('text').value = selectedText.text; $('size').value = selectedText.size;
    $('position').value = selectedText.position; $('color').value = selectedText.color;
    $('text-start').value = selectedText.start.toFixed(2); $('text-end').value = selectedText.end.toFixed(2);
    $('text-start').max = $('text-end').max = total();
  } else { $('text').value = ''; $('text-start').value = $('text-end').value = ''; }
  $('font-preview').style.fontFamily = $('font-family').value;
  $('font-preview').textContent = selectedText?.text || '文字预览 Aa 123';
  $('sizevalue').textContent = $('size').value;
  renderLibraries(); renderOverlayTracks(); controls();
}
// 保存选中文字内容和样式，保留输入焦点。
function editText() {
  if (!clips.length || busy || switching) return;
  pause();
  if (!selectedText) { if ($('text').value) addText(true); return; }
  Object.assign(selectedText, { font: $('font-family').value, text: $('text').value, size: Number($('size').value), position: Number($('position').value), color: $('color').value });
  renderTexts(); draw();
}
// 按各自时间区间合成文字，沿用换行和描边效果。
function drawTexts() {
  const w = canvas.width, h = canvas.height, t = position();
  for (const item of texts) {
    if (t + .00001 < item.start || t >= item.end || !item.text.trim()) continue;
    const { size, lines, top, x, spacing } = textLayout(item);
    ctx.save(); ctx.font = `${item.bold === false ? 400 : 600} ${size}px ${item.font || 'sans-serif'}`; ctx.textAlign = item.align || 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = item.strokeColor || '#000000'; ctx.lineWidth = (item.strokeWidth || 4) * Math.max(w, h) / 1280; ctx.lineJoin = 'round';
    lines.forEach((text, i) => {
      const y = top + i * spacing;
      if (item.background) {
        const width = ctx.measureText(text).width, pad = size * .3;
        const left = item.align === 'left' ? x : item.align === 'right' ? x - width : x - width / 2;
        ctx.save(); ctx.globalAlpha = .75; ctx.fillStyle = item.bgColor || '#000000';
        ctx.fillRect(left - pad, y - size * .65, width + pad * 2, size * 1.3); ctx.restore();
      }
      ctx.fillStyle = item.color;
      if (item.outline !== false) ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    });
    ctx.restore();
  }
}
// 将重叠片段排到轨道内不同高度，避免短片段或重叠贴图无法选中。
function renderOverlayTracks() {
  if (trackDrag) return;
  for (const [kind, items, active] of [['text', texts, selectedText], ['sticker', stickers, selectedSticker], ['audio', audioClips, selectedAudio]]) {
    const container = $(`${kind}-clips`), track = $(`${kind}-track`);
    container.replaceChildren(); const rows = [];
    [...items].sort((a, b) => a.start - b.start).forEach(item => {
      let row = rows.findIndex(end => end <= item.start);
      if (row < 0) row = rows.length;
      rows[row] = item.end;
      const button = document.createElement('button');
      button.className = `overlay-item ${kind}${active === item ? ' chosen' : ''}`;
      button.dataset.id = item.id; button.dataset.kind = kind;
      button.style.left = `${item.start / total() * 100}%`; button.style.width = `${(item.end - item.start) / total() * 100}%`;
      button.style.top = `${7 + row * 40}px`; button.textContent = kind === 'text' ? item.text || '空文字' : item.name;
      if (kind === 'audio') button.style.backgroundImage = `url(${audioWaveform(item)})`;
      button.title = `${button.textContent} · ${time(item.start)} – ${time(item.end)}`;
      button.setAttribute('aria-pressed', item === active);
      for (const edge of ['left', 'right']) {
        const handle = document.createElement('span'); handle.className = `edge ${edge}`; handle.dataset.edge = edge; button.append(handle);
      }
      button.onpointerdown = event => beginTrackDrag(event, kind, item, button);
      button.onkeydown = event => {
        if (busy || switching) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectOverlay(kind, item); navigateTime(item.start); }
      };
      container.append(button);
    });
    track.style.height = `${Math.max(48, rows.length * 40 + 8)}px`;
    if (!items.length) { const hint = document.createElement('span'); hint.className = 'overlay-empty'; hint.textContent = kind === 'text' ? '添加文字后，可在此调整显示区间' : kind === 'audio' ? '导入配乐或配音，可在此裁剪与移动' : '导入图片后，可在此调整显示区间'; container.append(hint); }
    track.querySelector('.overlay-head').style.left = `${total() ? position() / total() * 100 : 0}%`;
  }
}
// 选中轨道对象并同步对应属性面板。
function selectOverlay(kind, item) {
  pause(); showInspector(kind);
  if (kind === 'text') { selectedText = item; renderTexts(); }
  else if (kind === 'audio') { selectedAudio = item; renderAudio(); }
  else { selectedSticker = item; renderStickers(); }
  draw();
}
// 开始移动或裁剪覆盖层片段，记录初始区间以支持取消恢复。
function beginTrackDrag(event, kind, item, button) {
  if (busy || switching || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation(); pause();
  trackDrag = { kind, item, button, id: event.pointerId, x: event.clientX, start: item.start, end: item.end, sourceIn: item.in, edge: event.target.dataset.edge, width: $(`${kind}-track`).getBoundingClientRect().width, moved: false };
  selectOverlay(kind, item);
  button.classList.add('chosen'); button.setPointerCapture(event.pointerId);
  button.onpointermove = moveTrackDrag;
  button.onpointerup = event => finishTrackDrag(event, false);
  button.onpointercancel = event => finishTrackDrag(event, true);
  button.onlostpointercapture = event => { if (trackDrag) finishTrackDrag(event, true); };
}
// 拖动中约束时间范围并同步属性，避免重建正在捕获指针的按钮。
function moveTrackDrag(event) {
  const drag = trackDrag; if (!drag || event.pointerId !== drag.id) return;
  let delta = (event.clientX - drag.x) / drag.width * total();
  delta = window.EasyCutTimeline?.overlayDelta(drag, delta, event) ?? delta;
  const min = Math.min(.1, total());
  if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true;
  if (drag.edge === 'left') drag.item.start = Math.max(0, Math.min(drag.end - min, drag.start + delta));
  else if (drag.edge === 'right') drag.item.end = Math.min(total(), Math.max(drag.start + min, drag.end + delta));
  else { const duration = drag.end - drag.start; drag.item.start = Math.max(0, Math.min(total() - duration, drag.start + delta)); drag.item.end = drag.item.start + duration; }
  if (drag.item.animation && drag.edge === 'left') drag.item.in = (drag.sourceIn || 0) + drag.item.start - drag.start;
  if (drag.kind === 'audio' || drag.item.media) {
    if (drag.edge === 'left') { drag.item.start = Math.max(drag.start - drag.sourceIn, drag.item.start); drag.item.in = drag.sourceIn + drag.item.start - drag.start; }
    drag.item.end = Math.min(drag.item.end, drag.item.start + (drag.item.buffer || drag.item.media).duration - drag.item.in);
  }
  drag.button.style.left = `${drag.item.start / total() * 100}%`; drag.button.style.width = `${(drag.item.end - drag.item.start) / total() * 100}%`;
  if (drag.kind === 'text') renderTexts(); else if (drag.kind === 'audio') renderAudio(); else renderStickers();
  draw();
}
// 松开时刷新轨道排列并定位预览，取消拖动则恢复原区间。
function finishTrackDrag(event, cancel) {
  const drag = trackDrag; if (!drag || event.pointerId !== drag.id) return;
  trackDrag = null; window.EasyCutTimeline?.clear();
  if (cancel) { drag.item.start = drag.start; drag.item.end = drag.end; if (drag.kind === 'audio' || drag.item.media || drag.item.animation) drag.item.in = drag.sourceIn; }
  renderTexts(); renderStickers(); renderAudio(); draw();
  if (!cancel) navigateTime(drag.item.start);
}
// 初始化文字轨道属性编辑与轨道空白区域定位。
function initTracks() {
  $('add-text').onclick = () => addText();
  // 在属性面板保留新增入口，编辑已有文字时也能连续创建独立片段。
  const addSegment = document.createElement('button');
  addSegment.id = 'add-text-segment'; addSegment.type = 'button';
  addSegment.textContent = '＋ 新增文字段'; addSegment.disabled = true;
  addSegment.onclick = () => addText();
  $('text-select').parentElement.append(addSegment);
  $('text-select').onchange = event => {
    if (busy || switching) return;
    const item = texts.find(item => item.id === Number(event.target.value));
    if (item) { selectOverlay('text', item); navigateTime(item.start); }
  };
  $('text-delete').onclick = () => {
    if (!selectedText || busy || switching) return;
    pause(); texts.splice(texts.indexOf(selectedText), 1); selectedText = texts.at(-1) || null; renderTexts(); draw();
  };
  for (const key of ['start', 'end']) $(`text-${key}`).onchange = event => {
    if (!selectedText || busy || switching) return;
    pause(); const value = Number(event.target.value), min = Math.min(.1, total());
    if (event.target.value !== '' && Number.isFinite(value)) {
      if (key === 'start') selectedText.start = Math.max(0, Math.min(selectedText.end - min, value));
      else selectedText.end = Math.min(total(), Math.max(selectedText.start + min, value));
    }
    renderTexts(); draw();
  };
  for (const kind of ['text', 'sticker', 'audio']) $(`${kind}-track`).onclick = event => {
    if (busy || switching || event.target.closest('.overlay-item')) return;
    const rect = event.currentTarget.getBoundingClientRect(); navigateTime((event.clientX - rect.left) / rect.width * total());
  };
}

// 按选中类型展示属性，保留各类型的编辑状态。
function showInspector(kind) {
  inspectorMode = kind;
  const names = { video: '视频属性', text: '文字属性', sticker: '画中画 / 贴纸属性', audio: '音频属性' };
  $('inspector-title').textContent = names[kind];
  document.querySelectorAll('[data-inspector]').forEach(button => {
    const active = button.dataset.inspector === kind;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
    $(`inspector-${button.dataset.inspector}`).hidden = !active;
  });
  controls();
}
// 切换素材分类，仅展示当前已支持的素材类型。
function showLibrary(kind) {
  document.querySelectorAll('[data-library]').forEach(button => {
    const active = button.dataset.library === kind;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
    $(`library-${button.dataset.library}`).hidden = !active;
  });
}
// 渲染文字和画中画素材列表，点击后联动属性和时间线。
function renderLibraries() {
  $('text-library').replaceChildren(); $('sticker-library').replaceChildren(); $('decal-library').replaceChildren();
  for (const item of texts) {
    const button = document.createElement('button'); button.textContent = `T  ${item.text || '空文字'}`;
    button.onclick = () => { if (!busy && !switching) { selectOverlay('text', item); navigateTime(item.start); } };
    $('text-library').append(button);
  }
  for (const item of stickers) {
    if (item.decal && !item.name.toLowerCase().includes($('decal-search').value.trim().toLowerCase())) continue;
    const button = document.createElement('button'); button.className = `asset${item === selectedSticker ? ' selected' : ''}`;
    const img = document.createElement('img'); img.src = item.image.src; img.alt = item.name;
    const title = document.createElement('div'); title.textContent = `${item.animation ? 'GIF · ' : ''}${item.name}`;
    button.append(img, title);
    button.onclick = () => { if (!busy && !switching) { selectOverlay('sticker', item); navigateTime(item.start); } };
    $(item.decal ? 'decal-library' : 'sticker-library').append(button);
  }
  $('decal-empty').hidden = $('decal-library').childElementCount > 0;
  $('decal-empty').textContent = $('decal-search').value ? '没有匹配的贴纸' : '导入本地贴纸，开始装饰画面';
}
// 绑定工作台分类、上下文删除、时间线缩放与常用快捷键。
function initWorkspace() {
  initDraftList();
  document.querySelectorAll('[data-library]').forEach(button => button.onclick = () => showLibrary(button.dataset.library));
  document.querySelectorAll('[data-inspector]').forEach(button => button.onclick = () => showInspector(button.dataset.inspector));
  $('delete-selection').onclick = () => {
    if (busy || switching) return;
    if (inspectorMode === 'video') deleteClip();
    else $(inspectorMode === 'text' ? 'text-delete' : inspectorMode === 'audio' ? 'audio-delete' : 'sticker-delete').click();
  };
  $('timeline-zoom').oninput = event => {
    document.querySelector('.timeline-content').style.width = `${event.target.value}%`;
    $('zoom-value').textContent = `${event.target.value}%`;
  };
  // 在素材面板空白区域也接受视频拖入，导入后无需保留大占位框。
  document.querySelector('.sidebar').ondragover = event => event.preventDefault();
  document.querySelector('.sidebar').ondrop = event => {
    if (event.target.closest('#drop')) return;
    event.preventDefault();
    const files = [...event.dataTransfer.files];
    if (!$('library-decal').hidden) importStickers(files, true);
    else if (!$('library-sticker').hidden) importStickers(files);
    else if (files.length && files.every(file => file.type.startsWith('image/'))) importStickers(files);
    else if (files.length && files.every(file => file.type.startsWith('audio/'))) importAudio(files);
    else importVideos(files);
  };
  window.addEventListener('keydown', event => {
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A'].includes(document.activeElement.tagName) || busy || switching) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); $('delete-selection').click(); }
  });
}

// 创建草稿入口和容器，内容和交互由独立草稿管理模块接管。
function initDraftList() {
  const toolbar = $('import')?.parentElement;
  if (!toolbar || $('draft-open')) return;
  const button = document.createElement('button');
  button.id = 'draft-open'; button.type = 'button'; button.textContent = '▣ 草稿';
  toolbar.prepend(button);
  const dialog = document.createElement('dialog');
  dialog.id = 'draft-dialog';
  dialog.innerHTML = '<header><h2>草稿</h2><button id="draft-close" type="button" aria-label="关闭草稿列表">×</button></header><div class="draft-body"><p class="hint">正在加载草稿列表…</p></div>';
  document.body.append(dialog);
  button.onclick = () => dialog.showModal();
  $('draft-close').onclick = () => dialog.close();
}

// 只突出当前编辑对象，避免视频、文字、画中画同时显示选中边框。
function syncSelection() {
  document.querySelectorAll('#clips .clip').forEach((el, index) => {
    const active = inspectorMode === 'video' && index === selected;
    el.classList.toggle('selected', active); el.setAttribute('aria-pressed', active);
  });
  document.querySelectorAll('.overlay-item').forEach(el => {
    const item = inspectorMode === 'text' ? selectedText : inspectorMode === 'audio' ? selectedAudio : selectedSticker;
    const active = el.dataset.kind === inspectorMode && Number(el.dataset.id) === item?.id;
    el.classList.toggle('chosen', active); el.setAttribute('aria-pressed', active);
  });
}
// 按文件名过滤素材，不改动时间线及导出范围。
function filterAssets() {
  const query = $('asset-search').value.trim().toLocaleLowerCase();
  let visible = 0;
  document.querySelectorAll('#assets .asset').forEach(el => {
    el.hidden = !el.querySelector('strong').textContent.toLocaleLowerCase().includes(query);
    if (!el.hidden) visible++;
  });
  $('search-empty').hidden = !query || visible > 0;
}
// 打开导出设置，展示真实画布尺寸、片段总长及当前预览。
function openExportDialog() {
  if (busy || switching || !clips.length) return;
  pause(); draw();
  $('export-preview').src = canvas.toDataURL('image/jpeg', .75);
  $('export-summary').textContent = `${clips.length} 个视频片段 · 时长 ${time(total())}`;
  $('export-dimensions').textContent = `${canvas.width} × ${canvas.height}`;
  $('export-dialog').showModal();
}
// 依据剪映实测布局，将覆盖层置于视频上方，并集中设置导出参数。
function initNativeLayout() {
  const videoRow = $('track').closest('.track-row'), ruler = $('ruler');
  const rulerRow = document.createElement('div'); rulerRow.className = 'track-row ruler-row';
  rulerRow.append(document.createElement('span'), ruler);
  const content = $('timeline-content');
  content.prepend(rulerRow);
  content.insertBefore($('text-track').closest('.track-row'), videoRow);
  content.insertBefore($('sticker-track').closest('.track-row'), videoRow);
  videoRow.classList.add('video-row');
  $('asset-search').oninput = filterAssets;

  $('export-close').onclick = $('export-dismiss').onclick = () => $('export-dialog').close();
  $('export-form').onsubmit = event => {
    event.preventDefault(); $('export-dialog').close(); exportVideo();
  };
}

// 停止配乐节点，暂停、跳转和视频切换时避免音频继续播放。
function stopMusic() {
  for (const voice of musicVoices) { try { voice.source.stop(); } catch {} voice.source.disconnect(); voice.gain.disconnect(); }
  musicVoices = [];
}
// 按作品时间在同一音频时钟上调度配乐，并混入试听和导出音轨。
function scheduleMusic() {
  stopMusic(); if (!playing || !audioCtx) return;
  const t = position(), now = audioCtx.currentTime;
  for (const item of audioClips) {
    if (t >= item.end) continue;
    const offset = item.in + Math.max(0, t - item.start), duration = Math.min(item.end - Math.max(t, item.start), item.buffer.duration - offset);
    if (duration <= 0) continue;
    const source = audioCtx.createBufferSource(), gain = audioCtx.createGain();
    source.buffer = item.buffer; gain.gain.value = item.volume;
    source.connect(gain); gain.connect(audioCtx.destination); gain.connect(audioDest);
    source.start(now + Math.max(0, item.start - t), offset, duration);
    musicVoices.push({ source, gain });
  }
}
// 批量解码本地音频，默认从作品开头播放，超出作品的部分不加入时间线。
async function importAudio(files) {
  if (!clips.length || busy || switching || !files.length) return;
  pause(); busy = 'audio'; controls(); const failures = []; let count = 0;
  try {
    await setupAudio();
    for (const file of files) {
      try {
        const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
        if (!buffer.duration) throw new Error('音频时长无效');
        const item = { id: nextId++, name: file.name, file, buffer, in: 0, start: 0, end: Math.min(total(), buffer.duration), volume: 1 };
        audioClips.push(item); selectedAudio = item; count++;
      } catch { failures.push(file.name); }
    }
    if (count) showInspector('audio');
    renderAudio(); draw(); status(`已导入 ${count} 段音频${failures.length ? `；无法解码：${failures.join('、')}` : ' · 可拖动、分割并设置音量'}`);
  } catch (error) { status(`音频导入失败：${error.message}`); }
  finally { busy = ''; $('audio-file').value = ''; controls(); }
}
// 作品缩短时截断配乐，删除所有视频时释放解码后的音频。
function normalizeAudio() {
  if (!total()) { stopMusic(); audioClips.length = 0; selectedAudio = null; return; }
  for (const item of audioClips) { item.end = Math.min(item.end, total()); item.start = Math.min(item.start, Math.max(0, item.end - .1)); item.end = Math.min(item.end, item.start + item.buffer.duration - item.in); }
}
// 从真实音频采样生成当前片段波形，并缓存相同裁剪范围的结果。
function audioWaveform(item) {
  const key = `${item.in}:${item.end - item.start}`;
  if (item.waveKey === key) return item.wave;
  const c = document.createElement('canvas'); c.width = 240; c.height = 32;
  const x = c.getContext('2d'), samples = item.buffer.getChannelData(0), rate = item.buffer.sampleRate;
  x.fillStyle = '#64c8bc';
  for (let i = 0; i < c.width; i++) {
    const begin = Math.floor((item.in + i / c.width * (item.end - item.start)) * rate);
    const finish = Math.min(samples.length, Math.ceil((item.in + (i + 1) / c.width * (item.end - item.start)) * rate));
    let peak = 0; const step = Math.max(1, Math.floor((finish - begin) / 80));
    for (let j = begin; j < finish; j += step) peak = Math.max(peak, Math.abs(samples[j]));
    const height = Math.max(1, peak * 30); x.fillRect(i, (32 - height) / 2, 1, height);
  }
  item.waveKey = key; item.wave = c.toDataURL(); return item.wave;
}
// 同步配乐列表、属性控件与音频轨道。
function renderAudio() {
  $('audio-library').replaceChildren(); $('audio-select').replaceChildren();
  if (!audioClips.length) $('audio-select').add(new Option('尚未导入音频', ''));
  audioClips.forEach(item => {
    $('audio-select').add(new Option(item.name, item.id));
    const button = document.createElement('button'); button.textContent = `♫ ${item.name} · ${time(item.end - item.start)}`;
    button.onclick = () => { if (!busy && !switching) { selectOverlay('audio', item); navigateTime(item.start); } };
    $('audio-library').append(button);
  });
  if (selectedAudio) {
    $('audio-select').value = selectedAudio.id;
    for (const key of ['start', 'end', 'in']) $(`audio-${key}`).value = selectedAudio[key].toFixed(2);
    $('audio-start').max = $('audio-end').max = total(); $('audio-in').max = selectedAudio.buffer.duration - (selectedAudio.end - selectedAudio.start);
    $('audio-volume').value = selectedAudio.volume * 100; $('audio-volume-value').textContent = `${Math.round(selectedAudio.volume * 100)}%`;
  } else for (const key of ['start', 'end', 'in']) $(`audio-${key}`).value = '';
  renderOverlayTracks(); controls();
}
// 在播放头处分割配乐，右段沿用正确的素材采样偏移。
function splitAudio() {
  if ($('split').disabled || !selectedAudio) return;
  pause(); const item = selectedAudio, t = position();
  const right = { ...item, id: nextId++, start: t, in: item.in + t - item.start };
  item.end = t; audioClips.splice(audioClips.indexOf(item) + 1, 0, right); selectedAudio = right;
  renderAudio(); draw(); status('音频已分割');
}
// 保存配乐时间和音量，保证播放不超过素材末尾。
function editAudio(key, value) {
  if (!selectedAudio || busy || switching) return;
  pause(); const item = selectedAudio, n = Number(value), min = Math.min(.1, item.buffer.duration, total());
  if (value !== '' && Number.isFinite(n)) {
    if (key === 'start') { const duration = item.end - item.start; item.start = Math.max(0, Math.min(total() - duration, n)); item.end = item.start + duration; }
    else if (key === 'end') item.end = Math.max(item.start + min, Math.min(total(), item.start + item.buffer.duration - item.in, n));
    else if (key === 'in') item.in = Math.max(0, Math.min(item.buffer.duration - (item.end - item.start), n));
    else item.volume = Math.max(0, Math.min(2, n / 100));
  }
  renderAudio(); draw();
}
// 绑定音频导入、属性编辑和删除，保留其他轨道的内容。
function initAudio() {
  $('import-audio').onclick = () => $('audio-file').click();
  $('audio-file').onchange = event => importAudio([...event.target.files]);
  $('audio-select').onchange = event => { if (busy || switching) return; const item = audioClips.find(item => item.id === Number(event.target.value)); if (item) { selectOverlay('audio', item); navigateTime(item.start); } };
  for (const key of ['start', 'end', 'in']) $(`audio-${key}`).onchange = event => editAudio(key, event.target.value);
  $('audio-volume').oninput = event => editAudio('volume', event.target.value);
  $('audio-delete').onclick = () => { if (!selectedAudio || busy || switching) return; pause(); audioClips.splice(audioClips.indexOf(selectedAudio), 1); selectedAudio = audioClips.at(-1) || null; renderAudio(); draw(); };
}

// 注册解码成功的字体，添加字库选项后才能应用到文字。
function registerFont(face, label) {
  document.fonts.add(face);
  const option = new Option(label, face.family); option.style.fontFamily = face.family;
  $('font-family').add(option);
}
// 导入本地字体，逐个处理失败文件，不影响现有字体与文字片段。
async function importFonts(files) {
  if (busy || switching || !files.length) return;
  pause(); busy = 'font'; controls(); let lastFont = null; const failures = [];
  try {
    for (const file of files) {
      try {
        if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('不支持的字体格式');
        const face = new FontFace(`LightcutFont${nextId++}`, await file.arrayBuffer());
        await face.load(); registerFont(face, `${file.name.replace(/\.[^.]+$/, '')} · 已导入`); lastFont = face.family;
        draftFonts.set(face.family, { file, face });
      } catch { failures.push(file.name); }
    }
    if (lastFont) {
      $('font-family').value = lastFont;
      if (selectedText) selectedText.font = lastFont;
      renderTexts(); draw();
    }
    status(`${lastFont ? '字体已导入，可用于预览和导出' : '未导入有效字体'}${failures.length ? `；失败：${failures.join('、')}` : ''}`);
  } finally { busy = ''; $('font-file').value = ''; controls(); }
}
// 绑定字体选择和本地字库导入，字体选择按文字片段独立保存。
function initFonts() {
  $('font-family').onchange = editText;
  $('import-font').onclick = () => $('font-file').click();
  $('font-file').onchange = event => importFonts([...event.target.files]);
}

// 读取独立视频画中画并保留原比例缩略图，默认静音防止意外叠加原声。
async function loadPipVideo(file, url) {
  const media = document.createElement('video'); media.muted = true; media.playsInline = true; media.preload = 'auto';
  try {
    await mediaEvent(media, 'loadeddata', () => { media.src = url; media.load(); });
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('视频时长无效');
    const thumb = document.createElement('canvas'), scale = 240 / Math.max(media.videoWidth, media.videoHeight);
    thumb.width = Math.max(1, Math.round(media.videoWidth * scale)); thumb.height = Math.max(1, Math.round(media.videoHeight * scale));
    thumb.getContext('2d').drawImage(media, 0, 0, thumb.width, thumb.height);
    const image = new Image(); image.src = thumb.toDataURL('image/jpeg', .7); await image.decode();
    const item = { id: nextId++, name: `▶ ${file.name}`, url, media, image, in: 0, start: 0, end: Math.min(total(), media.duration), x: .72, y: .28, size: .3, opacity: 1 };
    media.onseeked = () => { if (!playing && !switching) draw(); };
    return item;
  } catch (error) { media.removeAttribute('src'); media.load(); throw error; }
}
// 释放图片或视频画中画资源。
function releaseSticker(item) {
  if (item.media) { item.media.pause(); item.media.onseeked = null; item.media.removeAttribute('src'); item.media.load(); }
  if (!stickers.some(other => other !== item && other.url === item.url)) URL.revokeObjectURL(item.url);
}
// 暂停全部视频画中画，用于主视频暂停、跳转和跨片段切换。
function stopPipVideos() { stickers.forEach(item => item.media?.pause()); }
// 跳转及导出开始前等待画中画解码到对应帧，避免沿用旧画面。
async function preparePipVideos(t) {
  await Promise.all(stickers.filter(item => item.media).map(async item => {
    const target = Math.max(0, Math.min(item.media.duration - .001, item.in + Math.max(0, Math.min(item.end - item.start, t - item.start))));
    await seek(item.media, target);
  }));
}
// 以主时间线为准同步画中画播放；暂停时定位画面，超出区间停止播放。
function syncPipVideos() {
  const t = position();
  for (const item of stickers) {
    if (!item.media) continue;
    const media = item.media, active = t + .00001 >= item.start && t < item.end;
    if (!active || !playing || switching) media.pause();
    if (!active || (playing && video.readyState < 3)) { media.pause(); continue; }
    const target = Math.max(0, Math.min(media.duration - .001, item.in + t - item.start));
    if (!media.seeking && Math.abs(media.currentTime - target) > (playing ? .12 : .002)) media.currentTime = target;
    if (playing && !switching && media.paused && !media.seeking) media.play().catch(error => {
      if (error.name !== 'AbortError') { pause(); if (busy === 'export') stopExport(false, '视频画中画播放失败'); else status('视频画中画播放失败，请重新导入'); }
    });
  }
}

// 分割画中画并保留样式；视频右段使用独立播放器和连续的素材偏移。
async function splitSticker() {
  if ($('split').disabled || !selectedSticker || busy || switching) return;
  pause(); const item = selectedSticker, t = position();
  const right = { ...item, id: nextId++, start: t };
  busy = 'split'; controls();
  let media;
  try {
    if (item.media) {
      media = document.createElement('video'); media.muted = true; media.playsInline = true; media.preload = 'auto';
      right.media = media; right.in = item.in + t - item.start;
      await mediaEvent(media, 'loadeddata', () => { media.src = item.url; media.load(); });
      await seek(media, right.in);
      media.onseeked = () => { if (!playing && !switching) draw(); };
    }
    if (item.animation) right.in = (item.in || 0) + t - item.start;
    item.end = t;
    stickers.splice(stickers.indexOf(item) + 1, 0, right); selectedSticker = right;
    renderStickers(); draw(); status('画中画已分割 · 当前选中右侧片段');
  } catch (error) {
    if (media) { media.removeAttribute('src'); media.load(); }
    status(`画中画分割失败：${error.message}`);
  } finally { busy = ''; controls(); }
}

// 提供可复用的文字默认样式，内容、字体和时间单独管理。
function defaultTextStyle() {
  return { offsetX: 0, offsetY: 0, bold: true, outline: true, background: false, align: 'center', strokeColor: '#000000', strokeWidth: 4, bgColor: '#000000', color: '#ffffff', size: 100, position: .82 };
}
// 将选中文字的装饰属性同步到面板。
function syncTextStyle() {
  const style = { ...defaultTextStyle(), ...selectedText };
  for (const key of ['bold', 'outline', 'background']) $(`text-${key}`).checked = style[key];
  $('text-align').value = style.align; $('text-stroke-color').value = style.strokeColor;
  $('text-stroke-width').value = style.strokeWidth; $('text-bg-color').value = style.bgColor;
}
// 更新文字装饰属性，只改变当前片段。
function editTextStyle() {
  if (!selectedText || busy || switching) return;
  pause();
  Object.assign(selectedText, { bold: $('text-bold').checked, outline: $('text-outline').checked, background: $('text-background').checked, align: $('text-align').value, strokeColor: $('text-stroke-color').value, strokeWidth: Number($('text-stroke-width').value), bgColor: $('text-bg-color').value });
  renderTexts(); draw();
}
// 套用预设时保留已有文字内容、字体、字号及时间；新片段沿用默认字号。
function applyTextPreset(style) {
  if (!clips.length || busy || switching) return;
  pause();
  if (inspectorMode !== 'text' || !selectedText) addText();
  const size = selectedText.size;
  Object.assign(selectedText, defaultTextStyle(), style, { size });
  showInspector('text'); renderTexts(); draw();
  navigateTime(selectedText.start);
}
// 创建可视化样式卡片，并绑定装饰设置和恢复默认操作。
function initTextStyles() {
  for (const { name, category, style: config } of window.LightcutTextPresets) {
    const style = { ...defaultTextStyle(), ...config }, button = document.createElement('button');
    button.dataset.preset = name; button.dataset.category = category; button.title = `应用${name}`;
    const sample = document.createElement('span'); sample.className = 'preset-sample'; sample.textContent = category;
    sample.style.color = style.color; sample.style.fontWeight = style.bold ? '600' : '400';
    if (style.outline) sample.style.textShadow = `-1px -1px ${style.strokeColor},1px -1px ${style.strokeColor},-1px 1px ${style.strokeColor},1px 1px ${style.strokeColor}`;
    if (style.background) sample.style.backgroundColor = style.bgColor + 'bf';
    const label = document.createElement('small'); label.textContent = name;
    button.append(sample, label); button.onclick = () => applyTextPreset(config); $('text-presets').append(button);
  }
  // 分类筛选只影响预设列表，不修改当前文字。
  $('text-preset-category').onchange = () => {
    const category = $('text-preset-category').value;
    document.querySelectorAll('[data-preset]').forEach(button => button.hidden = category !== '全部' && button.dataset.category !== category);
  };
  for (const id of ['text-bold', 'text-outline', 'text-background', 'text-align', 'text-stroke-color', 'text-stroke-width', 'text-bg-color']) $(id).oninput = editTextStyle;
  $('text-reset').onclick = () => {
    if (!selectedText || busy || switching) return;
    pause(); Object.assign(selectedText, defaultTextStyle()); renderTexts(); draw();
  };
}

// 解码 GIF 为本地帧缓存，保留透明度与帧时长，预览和导出共用。
async function loadGifSticker(file, url) {
  if (!window.ImageDecoder || !await ImageDecoder.isTypeSupported('image/gif')) throw new Error('当前浏览器不支持动态 GIF，请使用新版 Chrome 或 Edge');
  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  const frames = []; let duration = 0, bytes = 0;
  try {
    await decoder.tracks.ready; await decoder.completed;
    const count = decoder.tracks.selectedTrack.frameCount;
    if (count > 500) throw new Error('GIF 超过 500 帧，请缩短后导入');
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        const scale = Math.min(1, 1024 / Math.max(image.displayWidth, image.displayHeight));
        const frame = document.createElement('canvas');
        frame.width = Math.max(1, Math.round(image.displayWidth * scale)); frame.height = Math.max(1, Math.round(image.displayHeight * scale));
        bytes += frame.width * frame.height * 4;
        if (bytes > 128 * 1024 * 1024) throw new Error('GIF 解码后过大，请缩小尺寸或缩短后导入');
        frame.getContext('2d').drawImage(image, 0, 0, frame.width, frame.height);
        duration += Math.max(.01, (image.duration || 100000) / 1000000);
        frames.push({ image: frame, end: duration });
      } finally { image.close(); }
    }
    if (!frames.length) throw new Error('GIF 没有可读取的帧');
    const image = new Image(); image.src = frames[0].image.toDataURL('image/png'); await image.decode();
    return { id: nextId++, name: file.name, url, image, decal: true, animation: { frames, duration }, in: 0, x: .72, y: .28, size: .3, opacity: 1, start: 0, end: total() };
  } finally { decoder.close(); }
}
// 根据作品时间取循环帧；暂停稳定，分割后延续原动画相位。
function gifFrame(sticker) {
  const { frames, duration } = sticker.animation;
  const elapsed = (sticker.in || 0) + position() - sticker.start;
  const time = ((elapsed % duration) + duration) % duration;
  return (frames.find(frame => time < frame.end) || frames.at(-1)).image;
}

// 同步贯穿全部轨道的播放头位置，兼容缩放、横向滚动和轨道高度变化。
function syncPlayhead() {
  const head = $('unified-playhead'); if (!head) return;
  head.hidden = !clips.length;
  const content = $('timeline-content').getBoundingClientRect(), ruler = $('ruler').getBoundingClientRect();
  const t = scrubTarget ?? position();
  head.style.left = `${ruler.left - content.left + (total() ? t / total() : 0) * ruler.width}px`;
  head.style.top = `${$('ruler').offsetTop + 12}px`;
  head.setAttribute('aria-valuemax', total().toFixed(3)); head.setAttribute('aria-valuenow', t.toFixed(3));
  head.setAttribute('aria-valuetext', time(t)); head.setAttribute('aria-disabled', String(!clips.length || !!busy));
}
// 串行执行定位并合并中间请求，快速拖动时最终位置不会被异步解码丢弃。
async function flushScrub() {
  if (scrubRunning) return;
  scrubRunning = true;
  try {
    while (scrubPending !== null) {
      const target = scrubPending; scrubPending = null;
      await navigateTime(target);
    }
  } finally {
    scrubRunning = false;
    if (scrubPointer === null) scrubTarget = null;
    syncPlayhead();
  }
}
// 将鼠标位置映射为作品时间，拖动期间立即移动播放头并请求对应画面。
function scrubAt(clientX) {
  const rect = $('ruler').getBoundingClientRect();
  scrubTarget = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * total();
  scrubPending = scrubTarget; syncPlayhead(); flushScrub();
}
// 创建统一播放头，绑定时间尺拖动及键盘按目标帧率逐帧定位。
function initPlayhead() {
  const head = document.createElement('div'); head.id = 'unified-playhead'; head.tabIndex = 0;
  head.setAttribute('role', 'slider'); head.setAttribute('aria-label', '播放头，左右方向键移动一帧');
  head.setAttribute('aria-valuemin', '0'); head.setAttribute('aria-orientation', 'horizontal');
  const handle = document.createElement('span'); handle.className = 'playhead-handle'; head.append(handle);
  $('timeline-content').append(head);
  for (const target of [head, $('ruler')]) {
    target.onpointerdown = event => {
      if (event.button !== 0 || busy || switching || !clips.length || scrubPointer !== null) return;
      event.preventDefault(); event.stopPropagation(); pause();
      scrubPointer = event.pointerId; target.setPointerCapture(event.pointerId); head.focus({ preventScroll: true }); scrubAt(event.clientX);
    };
    target.onpointermove = event => { if (event.pointerId === scrubPointer) scrubAt(event.clientX); };
    target.onpointerup = event => {
      if (event.pointerId !== scrubPointer) return;
      scrubAt(event.clientX); scrubPointer = null;
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      if (!scrubRunning) { scrubTarget = null; syncPlayhead(); }
    };
    target.onpointercancel = target.onlostpointercapture = event => {
      if (event.pointerId !== scrubPointer) return;
      scrubPointer = null; if (!scrubRunning) { scrubTarget = null; syncPlayhead(); }
    };
    target.onclick = event => event.stopPropagation();
  }
  head.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!clips.length || busy || (switching && !scrubRunning)) return;
    pause();
    const t = scrubTarget ?? position();
    scrubTarget = event.key === 'Home' ? 0 : event.key === 'End' ? total() : Math.max(0, Math.min(total(), t + (event.key === 'ArrowLeft' ? -1 : 1) / 30));
    scrubPending = scrubTarget; syncPlayhead(); flushScrub();
  };
  new ResizeObserver(syncPlayhead).observe($('timeline-content'));
}

// 统一计算文字换行、绘制位置和命中范围，拖动与预览、导出共用。
function textLayout(item) {
  const w = canvas.width, h = canvas.height, size = item.size * Math.max(w, h) / 1280;
  ctx.save(); ctx.font = `${item.bold === false ? 400 : 600} ${size}px ${item.font || 'sans-serif'}`;
  const lines = []; let line = '';
  for (const char of item.text.trim()) {
    if (char === '\n' || ctx.measureText(line + char).width > w * .86) { lines.push(line); line = char === '\n' ? '' : char; }
    else line += char;
  }
  if (line) lines.push(line);
  const width = Math.max(0, ...lines.map(text => ctx.measureText(text).width)); ctx.restore();
  const spacing = size * 1.3, target = h * item.position;
  const baseTop = Math.max(size, Math.min(h - size - (lines.length - 1) * spacing, target - (lines.length - 1) * spacing / 2));
  const baseX = item.align === 'left' ? w * .07 : item.align === 'right' ? w * .93 : w / 2;
  const pad = Math.max(size * .3, item.outline === false ? 0 : (item.strokeWidth || 4) * Math.max(w, h) / 2560);
  const boxWidth = width + pad * 2, boxHeight = Math.max(size * 1.3, lines.length * spacing);
  const left = item.align === 'left' ? baseX : item.align === 'right' ? baseX - width : baseX - width / 2;
  const rawLeft = left - pad + (item.offsetX || 0) * w, rawTop = baseTop - size * .65 + (item.offsetY || 0) * h;
  const box = { x: Math.max(0, Math.min(w - boxWidth, rawLeft)), y: Math.max(0, Math.min(h - boxHeight, rawTop)), width: boxWidth, height: boxHeight };
  return { size, lines, spacing, x: baseX + box.x - (left - pad), top: box.y + size * .65, box };
}

// 绘制主视频及片段特效，状态隔离防止影响文字和覆盖层。
function drawMainMedia(media, clip, context = ctx, localTime = position() - offset(selected)) {
  const w = canvas.width, h = canvas.height, mw = media.videoWidth || media.width, mh = media.videoHeight || media.height;
  const scale = Math.min(w / mw, h / mh), effect = clip.effect || { kind: 'none', strength: 1 };
  context.save();
  if (effect.kind === 'shake' || effect.kind === 'pulse') {
    const zoom = effect.kind === 'shake' ? 1 + .06 * effect.strength : 1 + .12 * effect.strength * (.5 + .5 * Math.sin(localTime * Math.PI * 2));
    context.translate(w / 2, h / 2); context.scale(zoom, zoom);
    if (effect.kind === 'shake') context.translate(Math.sin(localTime * 31) * w * .012 * effect.strength, Math.sin(localTime * 43) * h * .012 * effect.strength);
    context.translate(-w / 2, -h / 2);
  }
  if (effect.kind === 'vivid') context.filter = `saturate(${1 + effect.strength * 1.5}) contrast(${1 + effect.strength * .15})`;
  if (effect.kind === 'warm') context.filter = `sepia(${effect.strength * .45}) saturate(${1 + effect.strength * .4})`;
  if (effect.kind === 'cool') context.filter = `saturate(${1 - effect.strength * .2})`;
  if (effect.kind === 'pixelate' && effect.strength > 0) {
    const pixel = clip.pixelCanvas ||= document.createElement('canvas');
    const divisor = 1 + effect.strength * 45;
    const pw = Math.max(1, Math.round(mw / divisor)), ph = Math.max(1, Math.round(mh / divisor));
    if (pixel.width !== pw || pixel.height !== ph) { pixel.width = pw; pixel.height = ph; }
    pixel.getContext('2d').drawImage(media, 0, 0, pw, ph); media = pixel; context.imageSmoothingEnabled = false;
  }
  if (effect.kind === 'grayscale') context.filter = `grayscale(${effect.strength})`;
  if (effect.kind === 'sepia') context.filter = `sepia(${effect.strength})`;
  if (effect.kind === 'blur') context.filter = `blur(${effect.strength * Math.max(w, h) / 100}px)`;
  context.drawImage(media, (w - mw * scale) / 2, (h - mh * scale) / 2, mw * scale, mh * scale); context.filter = 'none';
  if (effect.kind === 'cool') { context.fillStyle = `rgba(30,110,255,${effect.strength * .18})`; context.fillRect(0, 0, w, h); }
  if (effect.kind === 'vignette') {
    const gradient = context.createRadialGradient(w / 2, h / 2, Math.min(w, h) * .15, w / 2, h / 2, Math.hypot(w, h) / 2);
    gradient.addColorStop(0, 'transparent'); gradient.addColorStop(1, `rgba(0,0,0,${effect.strength})`); context.fillStyle = gradient; context.fillRect(0, 0, w, h);
  }
  context.restore();
}
// 约束转场时长，给短片段及相邻转场保留空间。
function transitionDuration(index) {
  const item = clips[index];
  return index > 0 && item?.transition ? Math.min(item.transition.duration, length(clips[index - 1]), length(item) / 2) : 0;
}
// 按作品时间绘制连接处闪色或前段末帧叠化，不更改原有时间模型。
function drawTransition() {
  const elapsed = position() - offset(selected), incoming = currentClip().transition;
  const next = clips[selected + 1]?.transition;
  ctx.save();
  if (incoming && elapsed < transitionDuration(selected)) {
    const d = transitionDuration(selected);
    if (isFrameTransition(incoming.kind) && incoming.frame) {
      const composite = incoming.composite ||= document.createElement('canvas');
      if (composite.width !== canvas.width || composite.height !== canvas.height) { composite.width = canvas.width; composite.height = canvas.height; }
      const context = composite.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, composite.width, composite.height);
      drawMainMedia(incoming.frame, clips[selected - 1], context, length(clips[selected - 1]));
      drawFrameTransition(composite, incoming.kind, elapsed / d);
    } else if (!isFrameTransition(incoming.kind) && elapsed < d / 2) {
      ctx.globalAlpha = 1 - elapsed / (d / 2); ctx.fillStyle = incoming.kind === 'white' ? '#fff' : '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
  if (next && !isFrameTransition(next.kind)) {
    const half = transitionDuration(selected + 1) / 2, remaining = length(currentClip()) - elapsed;
    if (remaining < half) { ctx.globalAlpha = 1 - remaining / half; ctx.fillStyle = next.kind === 'white' ? '#fff' : '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  }
  ctx.restore();
}
// 使用独立解码器缓存前段末帧，避免分割片段共享播放器时互相干扰。
async function prepareTransition(index) {
  const transition = clips[index]?.transition, previous = clips[index - 1];
  if (!previous || !isFrameTransition(transition?.kind)) return;
  const key = `${previous.id}:${previous.out}`;
  if (transition.key === key && transition.frame) return;
  const media = document.createElement('video'); media.muted = true; media.preload = 'auto';
  try {
    await mediaEvent(media, 'loadeddata', () => { media.src = previous.source.url; media.load(); });
    await seek(media, Math.max(previous.in, previous.out - .001));
    const frame = document.createElement('canvas'), scale = Math.min(1, 1280 / Math.max(media.videoWidth, media.videoHeight));
    frame.width = Math.round(media.videoWidth * scale); frame.height = Math.round(media.videoHeight * scale);
    frame.getContext('2d').drawImage(media, 0, 0, frame.width, frame.height); transition.frame = frame; transition.key = key;
  } finally { media.removeAttribute('src'); media.load(); }
}
// 刷新特效参数与转场连接标记，失去原连接的转场自动移除。
function renderEffects() {
  const effect = currentClip()?.effect || { kind: 'none', strength: 1 };
  $('effect-kind').value = effect.kind; $('effect-strength').value = Math.round(effect.strength * 100); $('effect-value').textContent = `${$('effect-strength').value}%`;
  $('effect-target').textContent = currentClip() ? `当前片段：${selected + 1} · ${currentClip().source.name}` : '先导入并选中视频片段';
  const select = $('transition-boundary'), prior = Number(select.value); select.replaceChildren();
  document.querySelectorAll('.transition-marker').forEach(el => el.remove());
  clips.forEach((clip, index) => {
    if (clip.transition && clip.transition.previousId !== clips[index - 1]?.id) delete clip.transition;
    if (!index) return;
    select.add(new Option(`${index} → ${index + 1} · ${clip.source.name}`, clip.id));
    if (!clip.transition) return;
    const marker = document.createElement('button'); marker.className = 'transition-marker'; marker.textContent = '⋈'; marker.title = `${index} → ${index + 1} 转场`;
    marker.style.left = `${offset(index) / total() * 100}%`;
    marker.onclick = event => { event.stopPropagation(); if (busy || switching) return; showLibrary('transitions'); select.value = clip.id; syncTransitionPanel(); };
    $('clips').append(marker);
  });
  select.value = clips.some((c, i) => i > 0 && c.id === prior) ? prior : clips[Math.max(1, selected)]?.id || '';
  syncTransitionPanel(); syncEffectCards();
}
// 显示所选连接的实际时长与效果。
function syncTransitionPanel() {
  const index = clips.findIndex(clip => clip.id === Number($('transition-boundary').value)), transition = clips[index]?.transition;
  $('transition-kind').value = transition?.kind || 'none'; $('transition-duration').value = transition?.duration || .5;
  syncEffectCards();
  $('transition-status').textContent = transition ? `实际时长 ${transitionDuration(index).toFixed(2)} 秒` : '选择连接位置后应用转场；无转场可移除效果。';
}
// 绑定轻量特效和转场编辑，修改后定位到连接处预览。
function initEffects() {
  initEffectCatalog();
  for (const id of ['effect-kind', 'effect-strength']) $(id).oninput = () => {
    if (!currentClip() || busy || switching) return; pause();
    currentClip().effect = { kind: $('effect-kind').value, strength: Number($('effect-strength').value) / 100 };
    $('effect-value').textContent = `${$('effect-strength').value}%`; syncEffectCards(); draw();
  };
  $('transition-boundary').onchange = syncTransitionPanel;
  for (const id of ['transition-kind', 'transition-duration']) $(id).onchange = async () => {
    if (busy || switching) return;
    const index = clips.findIndex(clip => clip.id === Number($('transition-boundary').value)); if (index < 1) return;
    pause(); const kind = $('transition-kind').value, duration = Number($('transition-duration').value);
    if (!Number.isFinite(duration) || duration < .1) { syncTransitionPanel(); return; }
    if (kind === 'none') delete clips[index].transition;
    else clips[index].transition = { kind, duration: Math.min(2, duration), previousId: clips[index - 1].id };
    await navigate(index, clips[index].in); renderEffects(); draw();
  };
}

// 列举需要前段末帧缓存的转场，闪黑和闪白沿用纯色处理。
function isFrameTransition(kind) {
  return ['dissolve', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'circle', 'zoom-fade'].includes(kind);
}
// 在后段动态画面上逐步移除前段末帧，保证任意跳转具有确定结果。
function drawFrameTransition(frame, kind, progress) {
  const p = Math.max(0, Math.min(1, progress)), w = canvas.width, h = canvas.height;
  ctx.save();
  if (kind === 'dissolve' || kind === 'zoom-fade') {
    ctx.globalAlpha = 1 - p;
    if (kind === 'zoom-fade') { ctx.translate(w / 2, h / 2); ctx.scale(1 + p * .5, 1 + p * .5); ctx.translate(-w / 2, -h / 2); }
  } else {
    ctx.beginPath();
    if (kind === 'wipe-left') ctx.rect(w * p, 0, w * (1 - p), h);
    if (kind === 'wipe-right') ctx.rect(0, 0, w * (1 - p), h);
    if (kind === 'wipe-up') ctx.rect(0, h * p, w, h * (1 - p));
    if (kind === 'wipe-down') ctx.rect(0, 0, w, h * (1 - p));
    if (kind === 'circle') { ctx.rect(0, 0, w, h); ctx.moveTo(w / 2 + Math.hypot(w, h) * p / 2, h / 2); ctx.arc(w / 2, h / 2, Math.hypot(w, h) * p / 2, 0, Math.PI * 2); }
    ctx.clip('evenodd');
  }
  ctx.drawImage(frame, 0, 0); ctx.restore();
}
// 扩充本地效果目录，并以快捷卡片复用已有参数入口。
function initEffectCatalog() {
  const catalogs = [
    ['effect-kind', 'effect-cards', [['warm', '暖色'], ['cool', '冷色'], ['vivid', '鲜艳'], ['shake', '轻微抖动'], ['pulse', '呼吸缩放'], ['pixelate', '马赛克']]],
    ['transition-kind', 'transition-cards', [['wipe-left', '从左擦入'], ['wipe-right', '从右擦入'], ['wipe-up', '从上擦入'], ['wipe-down', '从下擦入'], ['circle', '圆形展开'], ['zoom-fade', '放大淡出']]],
  ];
  for (const [id, containerId, entries] of catalogs) {
    const select = $(id); entries.forEach(([value, label]) => select.add(new Option(label, value)));
    const cards = document.createElement('div'); cards.id = containerId; cards.className = 'effect-cards'; select.after(cards);
    for (const option of select.options) {
      const button = document.createElement('button'); button.textContent = option.text; button.dataset.effectSelect = id; button.dataset.value = option.value;
      button.setAttribute(id === 'effect-kind' ? 'data-fx' : 'data-transition', '');
      button.onclick = () => { select.value = option.value; select.dispatchEvent(new Event(id === 'effect-kind' ? 'input' : 'change')); };
      cards.append(button);
    }
  }
}
// 同步快捷卡片选中态，切换片段或修改下拉框后保持一致。
function syncEffectCards() {
  document.querySelectorAll('[data-effect-select]').forEach(button => {
    const active = $(button.dataset.effectSelect).value === button.dataset.value;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
