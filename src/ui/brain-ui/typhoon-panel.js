// 台风模式面板：iframe 壳。内容页自行获取 /typhoons 并渲染路径大屏。
export const createTyphoonPanel = () => `
<div class="typhoon-panel" id="typhoon-panel">
  <iframe id="typhoon-frame" class="typhoon-frame" title="台风实时监测大屏"></iframe>
  <button class="ty-exit-btn" id="ty-exit-btn" type="button" title="关闭台风监测">×</button>
</div>
`
