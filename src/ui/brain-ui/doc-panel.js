export const createDocPanel = () => `
<div class="doc-panel" id="doc-panel">

  <!-- 顶部标题栏 -->
  <div class="dp-header">
    <div class="dp-header-left">
      <span class="dp-icon" id="dp-icon">⚙️</span>
      <div class="dp-titles">
        <div class="dp-title" id="dp-title">配置说明</div>
        <div class="dp-subtitle" id="dp-subtitle">语音配置指南</div>
      </div>
    </div>
    <button class="dp-close-btn" id="dp-close-btn" type="button" title="关闭文档面板">×</button>
  </div>

  <!-- Tab 栏独立成行：Tab 过多时自动换行，不再挤压右上角关闭按钮 -->
  <div class="dp-tabs-bar">
    <!-- Tab 由 doc.js 的 renderTabs() 从 /docs 数据化生成并按意图分组 -->
    <div class="dp-tabs" id="dp-tabs"></div>
  </div>

  <!-- 摘要栏 -->
  <div class="dp-summary" id="dp-summary">正在加载文档...</div>

  <!-- 主体内容区 -->
  <div class="dp-body" id="dp-body">

    <!-- 左：章节导航 -->
    <div class="dp-nav" id="dp-nav">
      <!-- JS 动态填充 -->
    </div>

    <!-- 右：内容详情 -->
    <div class="dp-content" id="dp-content">
      <!-- JS 动态填充 -->
    </div>

  </div>

  <!-- 底部：服务商快速链接 -->
  <div class="dp-providers" id="dp-providers">
    <!-- JS 动态填充 -->
  </div>

  <!-- 内联配置区 -->
  <div class="dp-config" id="dp-config"></div>

  <!-- 底部状态栏 -->
  <div class="dp-footer">
    <span class="dp-footer-note" id="dp-footer-note">● 文档已注入上下文 · 可直接告诉 Agent 你遇到的问题</span>
    <span class="dp-footer-ttl" id="dp-footer-ttl">上下文有效期 30 分钟</span>
  </div>

</div>
`;
