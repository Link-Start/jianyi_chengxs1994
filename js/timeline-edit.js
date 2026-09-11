'use strict';
// 时间线拖动只在松开时提交主轨修改，避免预览过程中反复归一化辅助轨道。
window.EasyCutTimeline = (() => {
  let enabled = true, active = null, suppressClick = false;
  const toggle = document.createElement('button');
  toggle.id = 'timeline-snap'; toggle.textContent = '吸附'; toggle.title = '吸附播放头和片段边界；按住 Alt 临时关闭';
  toggle.setAttribute('aria-pressed', 'true');
  toggle.onclick = () => { enabled = !enabled; toggle.setAttribute('aria-pressed', String(enabled)); };
  document.querySelector('.timeline-tools').insertBefore(toggle, $('selection'));
  const guide = document.createElement('div'); guide.className = 'timeline-snap-guide'; guide.hidden = true;
  const hint = document.createElement('output'); hint.className = 'timeline-drag-hint'; hint.hidden = true;
  $('track').append(guide, hint);
  // 冻结吸附目标，排除当前操作对象，防止拖动时吸附到自己。
  function targets(excluded) {
    const values = [0, total(), position()]; let start = 0;
    for (const clip of clips) { if (clip !== excluded) values.push(start, start + length(clip)); start += length(clip); }
    for (const item of [...texts, ...stickers, ...audioClips]) if (item !== excluded) values.push(item.start, item.end);
    return [...new Set(values)];
  }
  // 使用固定像素阈值吸附，缩放后仍保持一致手感，只吸附到合法范围内。
  function snap(values, points, scale, min, max, event) {
    guide.hidden = true;
    if (!enabled || event.altKey) return 0;
    let best = 8 / scale, correction = 0, target = null;
    for (const value of values) for (const point of points) {
      const delta = point - value;
      if (delta >= min && delta <= max && Math.abs(delta) < best) { best = Math.abs(delta); correction = delta; target = point; }
    }
    if (target !== null) { guide.hidden = false; guide.style.left = `${target * scale}px`; }
    return correction;
  }
  // 为辅助轨道移动和两端裁剪提供相同吸附规则。
  function overlayDelta(drag, delta, event) {
    const item = drag.item, duration = drag.end - drag.start, minLength = Math.min(.1, total());
    let low, high, edges;
    if (drag.edge === 'left') {
      low = -drag.start;
      if (drag.kind === 'audio' || item.media) low = Math.max(low, -drag.sourceIn);
      high = duration - minLength; edges = [drag.start];
    } else if (drag.edge === 'right') {
      low = minLength - duration; high = total() - drag.end;
      if (drag.kind === 'audio' || item.media) high = Math.min(high, (item.buffer || item.media).duration - drag.sourceIn - duration);
      edges = [drag.end];
    } else { low = -drag.start; high = total() - drag.end; edges = [drag.start, drag.end]; }
    delta = Math.max(low, Math.min(high, delta));
    drag.snapTargets ||= targets(item);
    return delta + snap(edges.map(value => value + delta), drag.snapTargets, drag.width / total(), low - delta, high - delta, event);
  }
  // 为主轨片段添加裁剪手柄和指针拖放；键盘点击仍沿用原有选中行为。
  function bind(button, item) {
    for (const edge of ['left', 'right']) {
      const handle = document.createElement('i'); handle.className = `edge ${edge}`; handle.dataset.edge = edge;
      handle.title = edge === 'left' ? '拖动调整片段起点' : '拖动调整片段终点'; button.append(handle);
    }
    button.onpointerdown = event => {
      if (event.button !== 0 || busy || switching || trackDrag || scrubPointer !== null) return;
      event.preventDefault(); event.stopPropagation(); pause();
      const rect = $('track').getBoundingClientRect(), index = clips.indexOf(item);
      active = { kind: 'video', item, button, id: event.pointerId, x: event.clientX, rect, scale: rect.width / total(), index, start: offset(index), end: offset(index) + length(item), edge: event.target.dataset.edge, points: targets(item), moved: false, value: null, destination: index };
      trackDrag = active; button.setPointerCapture(event.pointerId); button.classList.add('dragging');
      button.onpointermove = move; button.onpointerup = event => finish(event, false);
      button.onpointercancel = event => finish(event, true);
      button.onlostpointercapture = event => { if (active) finish(event, true); };
    };
  }
  // 显示裁剪后的时长或插入线，保持指针按下时的时间比例不变。
  function move(event) {
    const drag = active; if (!drag || drag.id !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    const { item, scale, edge } = drag;
    hint.hidden = false;
    if (edge) {
      const left = edge === 'left', initial = left ? item.in : item.out, minimum = Math.min(.1, item.upper - item.lower);
      const low = left ? item.lower : item.in + minimum, high = left ? item.out - minimum : item.upper;
      let value = Math.max(low, Math.min(high, initial + (event.clientX - drag.x) / scale));
      value += snap([(left ? drag.start : drag.end) + value - initial], drag.points, scale, low - value, high - value, event);
      drag.value = value;
      const start = drag.start + (left ? value - initial : 0), duration = left ? item.out - value : value - item.in;
      drag.button.style.left = `${start * scale}px`; drag.button.style.width = `${duration * scale}px`;
      hint.textContent = `时长 ${time(duration)}`;
    } else {
      const x = (event.clientX - drag.rect.left) / scale; let elapsed = 0, slot = clips.length;
      for (let i = 0; i < clips.length; i++) { if (x < elapsed + length(clips[i]) / 2) { slot = i; break; } elapsed += length(clips[i]); }
      drag.destination = slot > drag.index ? slot - 1 : slot;
      guide.hidden = false; guide.style.left = `${offset(slot) * scale}px`;
      hint.textContent = `移到第 ${drag.destination + 1} 段`;
    }
  }
  // 松开提交一次变更，取消则恢复原样；选中对象跟随排序并刷新转场与预览。
  async function finish(event, cancel) {
    const drag = active; if (!drag || drag.id !== event.pointerId) return;
    active = null; trackDrag = null; guide.hidden = hint.hidden = true;
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    drag.button.classList.remove('dragging');
    if (drag.button.hasPointerCapture(drag.id)) drag.button.releasePointerCapture(drag.id);
    if (cancel) { render(); return; }
    if (!drag.moved) {
      showInspector('video');
      await navigate(drag.index, drag.item.in + Math.max(0, Math.min(length(drag.item), (drag.x - drag.rect.left) / drag.scale - drag.start)));
      return;
    }
    if (drag.edge && drag.value !== null) drag.item[drag.edge === 'left' ? 'in' : 'out'] = drag.value;
    else { clips.splice(drag.index, 1); clips.splice(drag.destination, 0, drag.item); }
    showInspector('video');
    try { await activate(clips.indexOf(drag.item), drag.edge === 'right' ? Math.max(drag.item.in, drag.item.out - .04) : drag.item.in); resize(); status(drag.edge ? '已裁剪片段' : '已调整片段顺序'); }
    catch (error) { render(); status(error.message); }
  }
  // 拖动时吞掉后续点击及快捷键，避免重复定位或修改正在操作的片段。
  document.addEventListener('click', event => {
    if (suppressClick || event.target.closest('.clip .edge')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') finish({ pointerId: active.id }, true);
    if (event.key !== 'Alt') { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('blur', () => { if (active) finish({ pointerId: active.id }, true); });
  // 辅助轨道结束操作后清理吸附提示。
  function clear() { guide.hidden = true; }
  return { bind, overlayDelta, clear };
})();
render();
