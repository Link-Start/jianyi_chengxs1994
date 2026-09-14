'use strict';
// 手机共用原有素材与属性面板，仅切换显示位置，不复制编辑状态或剪辑逻辑。
window.EasyCutMobile = (() => {
  const query = matchMedia('(max-width:760px), (max-width:1000px) and (pointer:coarse)');
  const nav = document.createElement('nav'); nav.className = 'mobile-tools'; nav.setAttribute('aria-label', '手机工作区');
  const choices = [['library', '素材'], ['props', '属性'], ['none', '收起面板']];
  for (const [panel, label] of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.mobilePanel = panel;
    button.onclick = () => show(panel); nav.append(button);
  }
  document.body.append(nav);
  // 手机选择片段时打开属性面板；桌面不受移动端状态影响。
  function show(panel) {
    if (!query.matches) return;
    document.body.dataset.mobilePanel = panel;
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobilePanel === panel)));
  }
  // 跨越手机断点时重置入口，避免旋转或切回桌面后面板状态残留。
  function sync() {
    if (query.matches) show('library');
    else delete document.body.dataset.mobilePanel;
    syncPlayhead();
  }
  query.addEventListener('change', sync); sync();
  return { show };
})();
