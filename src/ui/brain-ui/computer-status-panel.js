// 电脑动态面板结构 — 布局照新闻板块（热点面板）三柱 + 统计条 + 事件流 + 跑马灯
// 类名统一 .cs-*，数据全部来自后端 GET /system-status（真实本机指标，无 mock）

export const createComputerStatusPanel = () => `
<div class="computer-status-panel" id="computer-status-panel">

  <!-- ── 顶部标题栏 ── -->
  <div class="cs-header">
    <div class="cs-brand">
      <span class="cs-brand-name">电脑动态 v1.0</span>
      <span class="cs-brand-dot">●</span>
      <span class="cs-brand-status" id="cs-brand-status">采集中</span>
    </div>
    <div class="cs-title-block">
      <div class="cs-title-en">系统监测</div>
      <div class="cs-title-zh">本机运行状态实时监测</div>
    </div>
    <div class="cs-header-right">
      <div class="cs-header-meta">
        <div class="cs-header-tag"><span class="cs-tag-icon">◈</span>采集链路<br><span class="cs-tag-status" id="cs-tag-link">连接中</span></div>
        <div class="cs-header-tag"><span class="cs-tag-icon">≡</span>数据源<br><span class="cs-tag-status" id="cs-tag-source">本机</span></div>
        <div class="cs-header-tag"><span class="cs-tag-icon">⬡</span>采样间隔<br><span class="cs-tag-status" id="cs-tag-rate">2 秒</span></div>
      </div>
      <div class="cs-clock-block">
        <div class="cs-clock" id="cs-clock">--:--:--</div>
        <div class="cs-live-dot">● 实时</div>
      </div>
      <button class="cs-exit-btn" id="cs-exit-btn" type="button" title="关闭电脑动态">×</button>
    </div>
  </div>

  <!-- ── 统计条 ── -->
  <div class="cs-stats-bar">
    <div class="cs-stat cs-stat--cpu">
      <div class="cs-stat-icon">◉</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">CPU 占用</div>
        <div class="cs-stat-value" id="cs-stat-cpu">—</div>
        <div class="cs-stat-delta" id="cs-stat-cpu-delta">采样窗口 —</div>
      </div>
    </div>
    <div class="cs-stat cs-stat--mem">
      <div class="cs-stat-icon">▤</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">内存占用</div>
        <div class="cs-stat-value" id="cs-stat-mem">—</div>
        <div class="cs-stat-delta" id="cs-stat-mem-delta">— / — GB</div>
      </div>
    </div>
    <div class="cs-stat cs-stat--disk">
      <div class="cs-stat-icon">◫</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">系统盘占用</div>
        <div class="cs-stat-value" id="cs-stat-disk">—</div>
        <div class="cs-stat-delta" id="cs-stat-disk-delta">剩余 — GB</div>
      </div>
    </div>
    <div class="cs-stat cs-stat--power">
      <div class="cs-stat-icon">⚡</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">电池</div>
        <div class="cs-stat-value" id="cs-stat-battery">—</div>
        <div class="cs-stat-delta" id="cs-stat-battery-delta">状态未知</div>
      </div>
    </div>
    <div class="cs-stat cs-stat--net">
      <div class="cs-stat-icon">⇅</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">网络速率</div>
        <div class="cs-stat-value" id="cs-stat-net">—</div>
        <div class="cs-stat-delta" id="cs-stat-net-delta">上传 —</div>
      </div>
    </div>
    <div class="cs-stat cs-stat--temp">
      <div class="cs-stat-icon">🌡</div>
      <div class="cs-stat-body">
        <div class="cs-stat-label">硬件温度</div>
        <div class="cs-stat-value" id="cs-stat-temp">—</div>
        <div class="cs-stat-delta" id="cs-stat-temp-delta">GPU —</div>
      </div>
    </div>
  </div>

  <!-- ── 主体：左柱 + 中柱（仪表）+ 右柱 ── -->
  <div class="cs-body">

    <!-- 左柱 -->
    <div class="cs-col cs-col-left">

      <!-- CPU 每核 -->
      <div class="cs-list-card" id="cs-core-card">
        <div class="cs-card-header">
          <span class="cs-platform-dot cs-dot-cpu"></span>
          <span class="cs-platform-name">CPU 每核占用</span>
          <span class="cs-card-badge">实时</span>
          <span class="cs-card-update" id="cs-core-update">等待采样</span>
        </div>
        <ul class="cs-list" id="cs-core-list">
          <!-- JS 动态填充 -->
        </ul>
      </div>

      <!-- 磁盘卷 -->
      <div class="cs-list-card" id="cs-disk-card">
        <div class="cs-card-header">
          <span class="cs-platform-dot cs-dot-disk"></span>
          <span class="cs-platform-name">磁盘卷</span>
          <span class="cs-card-badge">容量</span>
          <span class="cs-card-update" id="cs-disk-update">等待采样</span>
        </div>
        <ul class="cs-list" id="cs-disk-list">
          <!-- JS 动态填充 -->
        </ul>
      </div>

    </div>

    <!-- 中柱：仪表 + 辅助面板 -->
    <div class="cs-col cs-col-center">

      <div class="cs-gauge-container" id="cs-gauge-container" data-gauge-state="loading" aria-busy="false">
        <div class="cs-gauge-label">负载总览</div>
        <div class="cs-gauge-grid">
          <div class="cs-gauge">
            <svg viewBox="0 0 120 120" class="cs-gauge-svg" aria-hidden="true">
              <circle cx="60" cy="60" r="48" fill="none" stroke="var(--line-strong)" stroke-width="8"/>
              <circle cx="60" cy="60" r="48" fill="none" stroke="var(--cool)" stroke-width="8"
                stroke-dasharray="301.6" stroke-dashoffset="301.6"
                stroke-linecap="round" transform="rotate(-90 60 60)" id="cs-gauge-cpu-arc"/>
            </svg>
            <div class="cs-gauge-center">
              <div class="cs-gauge-num" id="cs-gauge-cpu-num">—</div>
              <div class="cs-gauge-text">CPU</div>
            </div>
          </div>
          <div class="cs-gauge">
            <svg viewBox="0 0 120 120" class="cs-gauge-svg" aria-hidden="true">
              <circle cx="60" cy="60" r="48" fill="none" stroke="var(--line-strong)" stroke-width="8"/>
              <circle cx="60" cy="60" r="48" fill="none" stroke="var(--warm)" stroke-width="8"
                stroke-dasharray="301.6" stroke-dashoffset="301.6"
                stroke-linecap="round" transform="rotate(-90 60 60)" id="cs-gauge-mem-arc"/>
            </svg>
            <div class="cs-gauge-center">
              <div class="cs-gauge-num" id="cs-gauge-mem-num">—</div>
              <div class="cs-gauge-text">内存</div>
            </div>
          </div>
        </div>
        <div class="cs-gauge-status" id="cs-gauge-status" role="status" aria-live="polite">
          <span class="cs-gauge-spinner" aria-hidden="true"></span>
          <span class="cs-gauge-status-message" id="cs-gauge-status-message">正在读取系统状态…</span>
          <button class="cs-gauge-retry" id="cs-gauge-retry" type="button">重试</button>
        </div>
        <div class="cs-gauge-hint" id="cs-gauge-hint">数据每 2 秒自动刷新</div>
      </div>

      <div class="cs-center-aux">

        <div class="cs-aux-box">
          <div class="cs-aux-title">本机信息 <span class="cs-aux-sub">静态</span></div>
          <div class="cs-info-list" id="cs-info-list">
            <div class="cs-info-row"><span class="cs-info-key">主机名</span><span class="cs-info-val" id="cs-info-hostname">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">系统</span><span class="cs-info-val" id="cs-info-os">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">架构</span><span class="cs-info-val" id="cs-info-arch">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">CPU</span><span class="cs-info-val" id="cs-info-cpu">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">Electron 版本</span><span class="cs-info-val" id="cs-info-electron">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">开机时长</span><span class="cs-info-val" id="cs-info-uptime">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">本机地址</span><span class="cs-info-val" id="cs-info-ip">—</span></div>
          </div>
        </div>

        <div class="cs-aux-box">
          <div class="cs-aux-title">爱丽丝自身 <span class="cs-aux-sub">进程</span></div>
          <div class="cs-info-list">
            <div class="cs-info-row"><span class="cs-info-key">进程号</span><span class="cs-info-val" id="cs-self-pid">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">常驻内存</span><span class="cs-info-val" id="cs-self-rss">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">堆占用</span><span class="cs-info-val" id="cs-self-heap">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">运行时长</span><span class="cs-info-val" id="cs-self-uptime">—</span></div>
            <div class="cs-info-row"><span class="cs-info-key">Node 版本</span><span class="cs-info-val" id="cs-self-node">—</span></div>
          </div>
        </div>

      </div>
    </div>

    <!-- 右柱 -->
    <div class="cs-col cs-col-right">

      <!-- 硬件温度 -->
      <div class="cs-list-card" id="cs-temp-card">
        <div class="cs-card-header">
          <span class="cs-platform-dot cs-dot-temp"></span>
          <span class="cs-platform-name">硬件温度</span>
          <span class="cs-card-badge">实时</span>
          <span class="cs-card-update" id="cs-temp-update">等待采样</span>
        </div>
        <div class="cs-info-list" id="cs-temp-list">
          <div class="cs-info-row"><span class="cs-info-key">CPU</span><span class="cs-info-val" id="cs-temp-cpu">—</span></div>
          <div class="cs-info-row"><span class="cs-info-key">主板</span><span class="cs-info-val" id="cs-temp-board">—</span></div>
          <div class="cs-info-row"><span class="cs-info-key">显卡 GPU</span><span class="cs-info-val" id="cs-temp-gpu">—</span></div>
          <div class="cs-info-row"><span class="cs-info-key">硬盘</span><span class="cs-info-val" id="cs-temp-disk">—</span></div>
          <div class="cs-info-row"><span class="cs-info-key">内存</span><span class="cs-info-val" id="cs-temp-mem">—</span></div>
        </div>
        <div class="cs-temp-note" id="cs-temp-note">ACPI 热区不区分 CPU 与主板；硬盘、内存温度需装监控驱动</div>
      </div>

      <!-- 内存明细 -->
      <div class="cs-list-card" id="cs-mem-card">
        <div class="cs-card-header">
          <span class="cs-platform-dot cs-dot-mem"></span>
          <span class="cs-platform-name">内存明细</span>
          <span class="cs-card-badge">占用</span>
          <span class="cs-card-update" id="cs-mem-update">等待采样</span>
        </div>
        <ul class="cs-list" id="cs-mem-list">
          <!-- JS 动态填充 -->
        </ul>
      </div>

      <!-- 进程内存榜 -->
      <div class="cs-list-card" id="cs-proc-card">
        <div class="cs-card-header">
          <span class="cs-platform-dot cs-dot-proc"></span>
          <span class="cs-platform-name">进程内存榜</span>
          <span class="cs-card-badge">占用前 8</span>
          <span class="cs-card-update" id="cs-proc-update">等待采样</span>
        </div>
        <ul class="cs-list" id="cs-proc-list">
          <!-- JS 动态填充 -->
        </ul>
      </div>

    </div>
  </div>

  <!-- ── 采样事件流 ── -->
  <div class="cs-feed-bar">
    <div class="cs-feed-label">
      <span class="cs-feed-live-dot">●</span>
      <span>采样</span>
      <span class="cs-feed-subtitle">实时采样流</span>
      <span class="cs-feed-desc" id="cs-feed-desc">本机指标持续记录</span>
    </div>
    <div class="cs-feed-viewport" id="cs-feed-viewport">
      <div class="cs-feed-track" id="cs-feed-track">
        <!-- JS 动态填充 -->
      </div>
    </div>
    <div class="cs-feed-controls">
      <span class="cs-feed-auto-label" id="cs-feed-auto">自动滚动中</span>
      <button class="cs-feed-nav" id="cs-feed-prev" type="button" aria-label="上一条">‹</button>
      <button class="cs-feed-nav" id="cs-feed-next" type="button" aria-label="下一条">›</button>
    </div>
  </div>

  <!-- ── 底部跑马灯 ── -->
  <div class="cs-ticker-bar">
    <div class="cs-ticker-inner" id="cs-ticker-inner">
      <!-- JS 动态填充（内容翻倍实现无缝滚动） -->
    </div>
  </div>

</div>
`;