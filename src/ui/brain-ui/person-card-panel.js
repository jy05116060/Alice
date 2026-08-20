export const createPersonCardPanel = () => `
<div class="person-card-panel" id="person-card-panel" aria-live="polite">
  <div class="pc-card">
    <button class="pc-exit-btn" id="pc-exit-btn" type="button" aria-label="关闭人物卡片" title="关闭人物卡片">×</button>
    <div class="pc-profile">
      <div class="pc-hero" id="pc-hero">
        <img id="pc-hero-img" alt="" />
        <div class="pc-hero-fallback" id="pc-hero-fallback">人</div>
      </div>
      <div class="pc-header">
        <div class="pc-head-copy">
          <div class="pc-kicker">人物档案</div>
          <div class="pc-name" id="pc-name">人物卡片</div>
          <div class="pc-title" id="pc-title">等待选择人物</div>
        </div>
      </div>
    </div>
    <div class="pc-summary" id="pc-summary">当你不认识某位公众人物时，Longma 会在这里弹出一张简短人物卡片。</div>
    <div class="pc-section">
      <div class="pc-section-title">识别点</div>
      <ul class="pc-known-list" id="pc-known-list"></ul>
    </div>
    <div class="pc-tags" id="pc-tags"></div>
    <div class="pc-footer">
      <span class="pc-source" id="pc-source">来源：待机</span>
      <span class="pc-updated" id="pc-updated">--</span>
    </div>
  </div>
</div>
`;
