'use strict';
// 有限历史只保留配置与 Blob 引用，复用草稿恢复逻辑重建运行时媒体。
window.JianyiHistory = (() => {
  const editor = window.JianyiDraftEditor, undoStack = [], redoStack = [];
  const toolbar = document.querySelector('.timeline-tools');
  const undo = document.createElement('button'), redo = document.createElement('button');
  undo.id = 'undo'; undo.textContent = '↶ 撤销'; undo.title = '撤销（⌘/Ctrl+Z）';
  redo.id = 'redo'; redo.textContent = '↷ 重做'; redo.title = '重做（⌘/Ctrl+Shift+Z / Ctrl+Y）';
  toolbar.insertBefore(undo, $('split')); toolbar.insertBefore(redo, $('split'));
  let current = editor.snapshot(), applying = false, pointer = false, inputUntil = 0;
  // 视图状态随快照恢复，但不单独产生编辑历史。
  function signature(snapshot) {
    const { playhead, selected, inspectorMode, selectedText, selectedSticker, selectedAudio, zoom, ...content } = snapshot.project;
    return JSON.stringify(content);
  }
  // 更新按钮状态，同时阻止弹窗、加载或拖动期间恢复历史。
  function blocked() { return applying || pointer || editor.locked() || !!document.querySelector('dialog[open]'); }
  // 历史为空或工程忙碌时禁用对应工具栏按钮。
  function render() {
    undo.disabled = blocked() || !undoStack.length;
    redo.disabled = blocked() || !redoStack.length;
  }
  // 一次稳定编辑进入历史；上限外快照释放引用，新增编辑清空重做栈。
  function capture() {
    if (blocked()) return;
    const next = editor.snapshot();
    if (signature(next) !== signature(current)) {
      undoStack.push(current); if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
    }
    current = next; render();
  }
  // 切换或新建草稿后重新建立基线，禁止跨作品撤销。
  function reset() {
    undoStack.length = redoStack.length = 0;
    current = editor.snapshot(); inputUntil = 0; pointer = false; render();
  }
  // 恢复成功才移动历史游标，解码失败时保持当前作品和历史可重试。
  async function travel(backward) {
    if (blocked()) return;
    capture();
    const from = backward ? undoStack : redoStack, to = backward ? redoStack : undoStack;
    if (!from.length) return;
    const target = from.at(-1); applying = true; render();
    try {
      await editor.restore(target.project, new Map(target.files.map(file => [file.id, file])), { history: true });
      from.pop(); to.push(current); current = editor.snapshot(); inputUntil = 0;
      status(backward ? '已撤销' : '已重做');
    } catch (error) { status('历史恢复失败：' + error.message); }
    finally { applying = false; render(); }
  }
  undo.onclick = () => travel(true); redo.onclick = () => travel(false);
  // 指针按下前提交上一步，拖动结束后只采集最终结果，包括范围滑块。
  document.addEventListener('pointerdown', event => { capture(); pointer = !event.target.closest('#undo, #redo'); }, true);
  window.addEventListener('pointerup', () => { pointer = false; inputUntil = 0; setTimeout(capture, 0); }, true);
  window.addEventListener('pointercancel', () => { pointer = false; inputUntil = 0; setTimeout(capture, 0); }, true);
  window.addEventListener('blur', () => { pointer = false; });
  // 连续输入在停顿后合并为一步，切换控件前先提交上一组输入。
  document.addEventListener('beforeinput', () => { if (Date.now() >= inputUntil) capture(); }, true);
  document.addEventListener('input', () => { if (!applying) inputUntil = Date.now() + 800; }, true);
  document.addEventListener('focusout', () => { inputUntil = 0; setTimeout(capture, 0); });
  // 键盘激活按钮或连续删除时，也为相邻操作保留独立边界。
  document.addEventListener('click', capture, true);
  // 文本框保留原生文字撤销；画布和时间线使用工程历史快捷键。
  window.addEventListener('keydown', event => {
    if (['Delete', 'Backspace'].includes(event.key) && !event.target.closest('input, textarea, [contenteditable="true"]')) capture();
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.target.closest('input, textarea, [contenteditable="true"], dialog')) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && !(key === 'y' && event.ctrlKey)) return;
    event.preventDefault(); event.stopImmediatePropagation(); travel(key === 'z' && !event.shiftKey);
  }, true);
  window.addEventListener('easycut-project-restored', reset);
  // 异步导入及分割完成后采集；忙碌时不记录中间态。
  setInterval(() => { if (Date.now() >= inputUntil) capture(); render(); }, 150);
  render();
  return { undo: () => travel(true), redo: () => travel(false), reset };
})();
