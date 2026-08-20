// 世界杯模式面板：iframe 壳，内容是独立的转播大屏页 worldcup-broadcast-v2.html
// （由应用的 /src/ui/brain-ui/ 静态路由提供；页面自带数据拉取、缩放与刷新逻辑，
//   面板只负责开关、互斥与状态上报，见 worldcup.js）
export const createWorldcupPanel = () => `
<div class="worldcup-panel" id="worldcup-panel">
  <iframe id="worldcup-frame" class="worldcup-frame" title="世界杯赛况大屏"></iframe>
  <button class="wc-exit-btn" id="wc-exit-btn" type="button" title="关闭世界杯模式">×</button>
</div>
`
