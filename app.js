/**
 * Core Web Vitals Bulk Checker - Client App Logic
 * Integrates Google PageSpeed Insights API, concurrency queuing, and ExcelJS.
 */

// Application State
const state = {
  tasks: [],          // Queue of jobs: { id, url, strategy, status, error, metrics }
  status: 'idle',     // 'idle', 'running', 'cancelled', 'completed'
  concurrency: 5,     // Max 10, default 5
  apiKey: '',
  currentPage: 1,
  pageSize: 10,
  searchTerm: '',
  activeWorkers: 0,
  abortController: null,
  history: [],        // Saved historical runs
  historyPage: 1,     // Current page for history log
  historyPageSize: 6, // Number of history cards per page
  activeTab: 'active', // 'active' or 'history'
  expandedRows: new Set() // Track which row IDs are expanded in the grid
};

// Core Web Vitals Performance Thresholds
const THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 }, // ms
  INP: { good: 200, poor: 500 },   // ms
  CLS: { good: 0.1, poor: 0.25 },  // score
  FCP: { good: 1800, poor: 3000 }, // ms
  FID: { good: 100, poor: 300 },   // ms
  TTFB: { good: 800, poor: 1800 }, // ms
  SCORE: { good: 90, poor: 50 }    // lab performance score out of 100
};

// UI Elements
const els = {
  strategySelect: document.getElementById('strategySelect'),
  concurrencySlider: document.getElementById('concurrencySlider'),
  concurrencyLabel: document.getElementById('concurrencyLabel'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  urlsInput: document.getElementById('urlsInput'),
  fileUploadInput: document.getElementById('fileUploadInput'),
  startAuditBtn: document.getElementById('startAuditBtn'),
  cancelAuditBtn: document.getElementById('cancelAuditBtn'),
  exportExcelBtn: document.getElementById('exportExcelBtn'),
  progressPanel: document.getElementById('progressPanel'),
  progressTitle: document.getElementById('progressTitle'),
  progressPercentage: document.getElementById('progressPercentage'),
  progressBarFill: document.getElementById('progressBarFill'),
  progressCounts: document.getElementById('progressCounts'),
  progressActiveWorkers: document.getElementById('progressActiveWorkers'),
  logConsole: document.getElementById('logConsole'),
  tableSearchInput: document.getElementById('tableSearchInput'),
  resultsTableBody: document.getElementById('resultsTableBody'),
  tablePageInfo: document.getElementById('tablePageInfo'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  themeToggleInput: document.getElementById('themeToggleInput'),
  sitemapUrlInput: document.getElementById('sitemapUrlInput'),
  loadSitemapBtn: document.getElementById('loadSitemapBtn'),
  dashboardTabs: document.getElementById('dashboardTabs'),
  tabBtnActive: document.getElementById('tabBtnActive'),
  tabBtnHistory: document.getElementById('tabBtnHistory'),
  tabPanelActive: document.getElementById('tabPanelActive'),
  tabPanelHistory: document.getElementById('tabPanelHistory'),
  historyList: document.getElementById('historyList'),
  runNameInput: document.getElementById('runNameInput'),
  auditDepthSelect: document.getElementById('auditDepthSelect'),
  historyPageInfo: document.getElementById('historyPageInfo'),
  prevHistoryPageBtn: document.getElementById('prevHistoryPageBtn'),
  nextHistoryPageBtn: document.getElementById('nextHistoryPageBtn'),
  
  // KPI Elements
  valTotalUrls: document.getElementById('valTotalUrls'),
  valPassRate: document.getElementById('valPassRate'),
  valAvgLcp: document.getElementById('valAvgLcp'),
  valAvgCls: document.getElementById('valAvgCls')
};

// Load Saved Configuration on Init
function initConfig() {
  const savedKey = localStorage.getItem('psi_api_key');
  if (savedKey) els.apiKeyInput.value = savedKey;

  const savedConcurrency = localStorage.getItem('psi_concurrency');
  if (savedConcurrency) {
    state.concurrency = Math.min(10, Math.max(1, parseInt(savedConcurrency, 10)));
  } else {
    state.concurrency = 5;
  }
  els.concurrencySlider.value = state.concurrency;
  els.concurrencyLabel.textContent = `Concurrency: ${state.concurrency} Workers`;
}

// Fetch and Render History Timeline
async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) {
      throw new Error(`Failed to fetch: HTTP ${response.status}`);
    }
    state.history = await response.json();
    state.historyPage = 1;
    renderHistoryList();
  } catch (err) {
    console.error('Error loading history:', err);
    log(`Failed to load scan history: ${err.message}`, 'error');
  }
}

// Render dynamic history card list
function renderHistoryList() {
  els.historyList.innerHTML = '';
  
  if (state.history.length === 0) {
    els.historyList.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-state-icon">📁</div>
        <div class="empty-state-title">No Historical Scans Found</div>
        <div class="empty-state-desc">All completed runs will automatically appear here as persistent scan history cards.</div>
      </div>
    `;
    els.historyPageInfo.textContent = 'Showing 0 of 0 entries';
    els.prevHistoryPageBtn.disabled = true;
    els.nextHistoryPageBtn.disabled = true;
    return;
  }

  // History pagination boundaries
  const total = state.history.length;
  const start = (state.historyPage - 1) * state.historyPageSize;
  const end = Math.min(start + state.historyPageSize, total);
  const paginated = state.history.slice(start, end);

  els.historyPageInfo.textContent = `Showing ${start + 1}-${end} of ${total} entries`;
  els.prevHistoryPageBtn.disabled = state.historyPage === 1;
  els.nextHistoryPageBtn.disabled = end >= total;

  paginated.forEach((run) => {
    const card = document.createElement('div');
    
    // Determine card indicator color base on pass rate
    let passCat = 'good';
    if (run.passRate < 50) passCat = 'poor';
    else if (run.passRate < 90) passCat = 'needs-improvement';
    
    card.className = `history-card ${passCat}`;
    
    const formattedDate = new Date(run.date).toLocaleString();
    const runName = run.name || 'Unnamed Scan';
    
    card.innerHTML = `
      <div class="history-card-header">
        <div style="font-weight: 700; font-family: var(--font-display); font-size: 1.05rem; color: var(--text-primary); margin-bottom: 0.25rem; word-break: break-all;">${escapeHtml(runName)}</div>
        <div class="history-card-date" style="margin-bottom: 0.15rem;">${formattedDate}</div>
        <div class="history-card-strategy" style="font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: var(--text-muted);">${run.strategy.toUpperCase()} (${run.total} Audits)</div>
      </div>
      
      <div class="history-card-stats">
        <div class="history-stat-box">
          <span class="history-stat-label">Pass Rate</span>
          <span class="history-stat-value" style="color: var(--color-${passCat});">${run.passRate}%</span>
        </div>
        <div class="history-stat-box">
          <span class="history-stat-label">Avg LCP</span>
          <span class="history-stat-value">${run.avgLcp !== '-' ? run.avgLcp : '-'}</span>
        </div>
        <div class="history-stat-box">
          <span class="history-stat-label">Avg CLS</span>
          <span class="history-stat-value">${run.avgCls !== '-' ? run.avgCls : '-'}</span>
        </div>
      </div>
      
      <div class="history-card-actions">
        <button class="btn-secondary btn-card btn-view" data-id="${run.id}">Review Grid</button>
        <button class="btn-secondary btn-card btn-excel" data-id="${run.id}">Export Excel</button>
        <button class="btn-card danger btn-delete" data-id="${run.id}">Delete</button>
      </div>
    `;
    
    // Add event listeners to card actions
    card.querySelector('.btn-view').addEventListener('click', () => reloadHistoricalRun(run.id));
    card.querySelector('.btn-excel').addEventListener('click', () => exportHistoricalExcel(run.id));
    card.querySelector('.btn-delete').addEventListener('click', () => deleteHistoricalRun(run.id));
    
    els.historyList.appendChild(card);
  });
}

// Reload a past run into the main active audit dashboard
async function reloadHistoricalRun(runId) {
  log(`Fetching past audit run details (ID: ${runId})...`, 'info');
  try {
    const response = await fetch(`/api/history/details?id=${runId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch run details: HTTP ${response.status}`);
    }
    const run = await response.json();
    
    log(`Reloading past audit run from ${new Date(run.date).toLocaleString()}...`, 'info');
    
    // Set the main active state to the past run
    state.tasks = run.tasks;
    state.expandedRows.clear();
    state.currentPage = 1;
    state.status = 'completed'; // ensures UI panels look clean
    
    // Refresh UI
    updateProgressUI();
    updateSummaryKPIs();
    renderTable();
    
    // Toggle tab back to "Current Audit" so they see the populated grid
    switchTab('active');
    
    // Enable the Excel export button
    els.exportExcelBtn.disabled = false;
    
    log(`Loaded ${run.total} audits from historical record into grid. You can search, filter, and expand rows normally.`, 'info');
  } catch (err) {
    log(`Failed to reload historical run: ${err.message}`, 'error');
    console.error(err);
  }
}

// Re-generate and export Excel sheet for a historical run
async function exportHistoricalExcel(runId) {
  log(`Fetching details for historical run (ID: ${runId}) to export...`, 'info');
  try {
    const response = await fetch(`/api/history/details?id=${runId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch details: HTTP ${response.status}`);
    }
    const run = await response.json();
    
    log(`Re-generating Excel spreadsheet for run "${run.name}"...`, 'info');
    
    // Temporarily swap state.tasks to compile the Excel from history
    const activeTasksBackup = state.tasks;
    state.tasks = run.tasks;
    
    // Call existing Excel exporter with historical run's name
    await exportToExcel(run.name);
    
    // Restore original state
    state.tasks = activeTasksBackup;
  } catch (err) {
    log(`Failed to export historical Excel: ${err.message}`, 'error');
    console.error(err);
  }
}

// Delete a historical run record
async function deleteHistoricalRun(runId) {
  const run = state.history.find(r => r.id === runId);
  if (!run) return;
  
  if (!confirm(`Are you sure you want to permanently delete the audit run from ${new Date(run.date).toLocaleString()}?`)) {
    return;
  }
  
  try {
    const response = await fetch(`/api/history?id=${runId}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      log('Deleted run from persistent database.', 'info');
      await loadHistory();
    } else {
      const errMsg = await response.text();
      log(`Failed to delete record: ${errMsg}`, 'error');
    }
  } catch (err) {
    log(`Network error deleting record: ${err.message}`, 'error');
  }
}

// SPA Tab Switching Controller
function switchTab(tabId) {
  if (state.activeTab === tabId) return;
  
  state.activeTab = tabId;
  
  if (tabId === 'active') {
    els.tabBtnActive.classList.add('active');
    els.tabBtnHistory.classList.remove('active');
    els.tabPanelActive.style.display = 'flex';
    els.tabPanelHistory.style.display = 'none';
  } else {
    els.tabBtnActive.classList.remove('active');
    els.tabBtnHistory.classList.add('active');
    els.tabPanelActive.style.display = 'none';
    els.tabPanelHistory.style.display = 'flex';
    
    // Auto-refresh history timeline when opening the tab
    loadHistory();
  }
}

// Attach Tab Switch Click Events
els.tabBtnActive.addEventListener('click', () => switchTab('active'));
els.tabBtnHistory.addEventListener('click', () => switchTab('history'));

// Save config on change
els.apiKeyInput.addEventListener('input', (e) => {
  localStorage.setItem('psi_api_key', e.target.value.trim());
});

els.concurrencySlider.addEventListener('input', (e) => {
  state.concurrency = parseInt(e.target.value, 10);
  els.concurrencyLabel.textContent = `Concurrency: ${state.concurrency} Workers`;
  localStorage.setItem('psi_concurrency', state.concurrency);
});

// Robust XML Sitemap Parser
function parseSitemapXml(xmlString) {
  try {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
    
    // Check for parsing errors
    const parserError = xmlDoc.getElementsByTagName('parsererror');
    if (parserError.length > 0) {
      throw new Error('Invalid XML structure');
    }
    
    const locElements = xmlDoc.getElementsByTagName('loc');
    const urls = [];
    for (let i = 0; i < locElements.length; i++) {
      const url = locElements[i].textContent.trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        urls.push(url);
      }
    }
    return urls;
  } catch (err) {
    // Fallback: simple robust regex extraction if standard XML parsing fails
    const urls = [];
    const matches = xmlString.match(/<loc>(https?:\/\/[^<]+)<\/loc>/gi);
    if (matches) {
      for (const match of matches) {
        const url = match.replace(/<\/?loc>/gi, '').trim();
        urls.push(url);
      }
    }
    return urls;
  }
}

// CSV / TXT / XML File Loader
els.fileUploadInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target.result;
    let urls = [];
    
    if (file.name.toLowerCase().endsWith('.xml')) {
      urls = parseSitemapXml(text);
    } else {
      urls = text.split(/[\r\n,]+/)
                 .map(url => url.trim())
                 .filter(url => url.startsWith('http://') || url.startsWith('https://'));
    }
    
    if (urls.length > 0) {
      els.urlsInput.value = urls.join('\n');
      log(`Imported ${urls.length} URLs from ${file.name}.`, 'info');
    } else {
      log(`No valid URLs found in ${file.name}.`, 'error');
    }
  };
  reader.readAsText(file);
});

// Sitemap URL Loader
els.loadSitemapBtn.addEventListener('click', async () => {
  const sitemapUrl = els.sitemapUrlInput.value.trim();
  if (!sitemapUrl) {
    alert('Please enter a valid sitemap.xml URL.');
    return;
  }
  
  els.loadSitemapBtn.disabled = true;
  const originalText = els.loadSitemapBtn.innerHTML;
  els.loadSitemapBtn.innerHTML = '<span>Loading...</span>';
  log(`Fetching sitemap from URL: ${sitemapUrl}...`, 'info');
  
  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: HTTP status ${response.status}`);
    }
    const xmlText = await response.text();
    const urls = parseSitemapXml(xmlText);
    
    if (urls.length > 0) {
      els.urlsInput.value = urls.join('\n');
      log(`Imported ${urls.length} URLs from sitemap URL.`, 'info');
      els.sitemapUrlInput.value = '';
    } else {
      log('No valid URLs found inside the fetched sitemap.xml.', 'error');
    }
  } catch (err) {
    log(`Network or CORS error fetching sitemap: ${err.message}.`, 'error');
    alert(`Could not fetch the sitemap directly due to browser CORS/security restrictions: ${err.message}.\n\nTip: You can download the sitemap.xml file directly in your browser, then use the "Upload List" button to import it instantly!`);
  } finally {
    els.loadSitemapBtn.disabled = false;
    els.loadSitemapBtn.innerHTML = originalText;
  }
});

// Search and Pagination Events
els.tableSearchInput.addEventListener('input', (e) => {
  state.searchTerm = e.target.value.trim().toLowerCase();
  state.currentPage = 1;
  renderTable();
});

els.prevPageBtn.addEventListener('click', () => {
  if (state.currentPage > 1) {
    state.currentPage--;
    renderTable();
  }
});

els.nextPageBtn.addEventListener('click', () => {
  const filtered = getFilteredTasks();
  if (state.currentPage * state.pageSize < filtered.length) {
    state.currentPage++;
    renderTable();
  }
});

els.prevHistoryPageBtn.addEventListener('click', () => {
  if (state.historyPage > 1) {
    state.historyPage--;
    renderHistoryList();
  }
});

els.nextHistoryPageBtn.addEventListener('click', () => {
  if (state.historyPage * state.historyPageSize < state.history.length) {
    state.historyPage++;
    renderHistoryList();
  }
});

// UI logging helper
function log(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const timestamp = new Date().toLocaleTimeString();
  entry.textContent = `[${timestamp}] ${msg}`;
  els.logConsole.appendChild(entry);
  els.logConsole.scrollTop = els.logConsole.scrollHeight;
}

// Helper to evaluate performance status
function getStatusCategory(val, metric) {
  if (val === undefined || val === null) return 'unknown';
  const limits = THRESHOLDS[metric];
  if (!limits) return 'unknown';
  
  if (metric === 'CLS') {
    if (val <= limits.good) return 'good';
    if (val <= limits.poor) return 'needs-improvement';
    return 'poor';
  } else {
    // ms metrics (LCP, INP, FCP, FID) or score
    if (metric === 'SCORE') {
      if (val >= limits.good) return 'good';
      if (val >= limits.poor) return 'needs-improvement';
      return 'poor';
    } else {
      if (val <= limits.good) return 'good';
      if (val <= limits.poor) return 'needs-improvement';
      return 'poor';
    }
  }
}

// Fetch Chrome UX Report (CrUX) API directly for fast field-data queries
async function fetchCruxVitals(url, strategy, apiKey, signal) {
  const baseUrl = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
  const fetchUrl = `${baseUrl}?key=${encodeURIComponent(apiKey)}`;
  
  // Map strategy to CrUX formFactor
  const formFactor = strategy.toUpperCase() === 'MOBILE' ? 'PHONE' : 'DESKTOP';
  
  const payload = {
    url: url,
    formFactor: formFactor
  };
  
  const response = await fetch(fetchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal
  });
  
  if (!response.ok) {
    if (response.status === 404) {
      // No CrUX data for this page, return standard "No Data" structure
      return {
        field: {
          assessment: 'no data',
          isOriginFallback: false,
          lcp: null, inp: null, cls: null, fcp: null, fid: null, ttfb: null
        },
        lab: {
          performanceScore: null, fcp: null, lcp: null, cls: null, tbt: null, speedIndex: null, tti: null, ttfb: null
        },
        opportunities: []
      };
    }
    const errorText = await response.text();
    throw new Error(`CrUX API Error (HTTP ${response.status}): ${errorText}`);
  }
  
  const data = await response.json();
  return parseCruxResponse(data, url, strategy);
}

// Parse Chrome UX Report response into standard metrics payload
function parseCruxResponse(data, url, strategy) {
  const metrics = data.record?.metrics || {};
  
  const getCruxMetric = (metricKey) => {
    const metric = metrics[metricKey];
    if (!metric || !metric.percentiles) return null;
    
    const val = parseFloat(metric.percentiles.p75);
    
    // Categorize based on standard thresholds
    let category = 'good';
    if (metricKey === 'largest_contentful_paint') {
      category = val <= 2500 ? 'good' : (val <= 4000 ? 'needs-improvement' : 'poor');
    } else if (metricKey === 'interaction_to_next_paint') {
      category = val <= 200 ? 'good' : (val <= 500 ? 'needs-improvement' : 'poor');
    } else if (metricKey === 'cumulative_layout_shift') {
      category = val <= 0.1 ? 'good' : (val <= 0.25 ? 'needs-improvement' : 'poor');
    } else if (metricKey === 'first_contentful_paint') {
      category = val <= 1800 ? 'good' : (val <= 3000 ? 'needs-improvement' : 'poor');
    } else if (metricKey === 'experimental_time_to_first_byte') {
      category = val <= 800 ? 'good' : (val <= 1800 ? 'needs-improvement' : 'poor');
    }
    
    return {
      value: val,
      category: category
    };
  };

  const lcp = getCruxMetric('largest_contentful_paint');
  const inp = getCruxMetric('interaction_to_next_paint');
  const cls = getCruxMetric('cumulative_layout_shift');

  let passed = true;
  let hasData = false;
  if (lcp) { passed = passed && lcp.value <= 2500; hasData = true; }
  if (cls) { passed = passed && cls.value <= 0.10; hasData = true; }
  if (inp) { passed = passed && inp.value <= 200; hasData = true; }

  const field = {
    assessment: hasData ? (passed ? 'passed' : 'failed') : 'no data',
    isOriginFallback: false,
    lcp: lcp,
    inp: inp,
    cls: cls,
    fcp: getCruxMetric('first_contentful_paint'),
    fid: null,
    ttfb: getCruxMetric('experimental_time_to_first_byte')
  };

  const lab = {
    performanceScore: null,
    fcp: null,
    lcp: null,
    cls: null,
    tbt: null,
    speedIndex: null,
    tti: null,
    ttfb: null
  };

  return { field, lab, opportunities: [] };
}

// Fetch PageSpeed Insights Data
async function fetchVitals(url, strategy, signal) {
  const apiKey = els.apiKeyInput.value.trim();
  const auditMode = els.auditDepthSelect.value;
  
  // If in quick audit mode and key is available, use fast CrUX query
  if (auditMode === 'fast' && apiKey) {
    try {
      return await fetchCruxVitals(url, strategy, apiKey, signal);
    } catch (err) {
      if (err.message.includes('blocked') || err.message.includes('403') || err.message.includes('PERMISSION_DENIED')) {
        log(`CrUX API Key Blocked (HTTP 403). To enable ultra-fast ~200ms scans, please open your Google Cloud Console (https://console.cloud.google.com/), edit your API Key restrictions under "Credentials", and check "Chrome UX Report API" to allow it. Falling back to PageSpeed Insights (slower)...`, 'warning');
      } else {
        log(`CrUX API fell back to PSI API for ${url}: ${err.message}`, 'warning');
      }
    }
  }
  
  // Otherwise default to standard PageSpeed Insights
  const baseUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
  let fetchUrl = `${baseUrl}?url=${encodeURIComponent(url)}&strategy=${strategy}`;
  if (auditMode !== 'fast') {
    fetchUrl += '&category=performance';
  }
  if (apiKey) {
    fetchUrl += `&key=${encodeURIComponent(apiKey)}`;
  }

  const response = await fetch(fetchUrl, { signal });
  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const errorMsg = errorJson?.error?.message || `HTTP error! Status: ${response.status}`;
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return parsePsiResponse(data);
}

// Parse PSI JSON payload
function parsePsiResponse(data) {
  // Extract overall and field loading experience from Chrome UX report (CrUX)
  const fExperience = data.loadingExperience || {};
  const originExperience = data.originLoadingExperience || {};
  
  // Decide which experience to use, fallback to origin if specific URL experience is empty
  const experience = (fExperience.metrics && Object.keys(fExperience.metrics).length > 0) ? fExperience : originExperience;
  const isFieldFromOrigin = experience === originExperience && fExperience.metrics ? false : (experience === originExperience);

  const getFieldMetric = (metricKey) => {
    const metric = experience.metrics?.[metricKey];
    if (!metric) return null;
    return {
      value: metric.percentile,
      category: metric.category.toLowerCase().replace('_', '-')
    };
  };

  const field = {
    assessment: experience.overall_category ? experience.overall_category.toLowerCase() : 'no data',
    isOriginFallback: isFieldFromOrigin,
    lcp: getFieldMetric('LARGEST_CONTENTFUL_PAINT_MS'),
    inp: getFieldMetric('INTERACTION_TO_NEXT_PAINT'),
    cls: getFieldMetric('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
    fcp: getFieldMetric('FIRST_CONTENTFUL_PAINT_MS'),
    fid: getFieldMetric('FIRST_INPUT_DELAY_MS'),
    ttfb: getFieldMetric('EXPERIMENTAL_TIME_TO_FIRST_BYTE')
  };

  // Adjust CLS division (PageSpeed API returns CLS multiplied by 100 for percentile values in loadingExperience)
  if (field.cls) {
    field.cls.value = field.cls.value / 100;
  }

  // Extract Lab data from Lighthouse Audits
  const audits = data.lighthouseResult?.audits || {};
  const categories = data.lighthouseResult?.categories || {};
  
  const getLabMetric = (auditKey) => {
    const audit = audits[auditKey];
    if (!audit || audit.numericValue === undefined) return null;
    return audit.numericValue;
  };

  const lab = {
    performanceScore: categories.performance?.score !== undefined ? Math.round(categories.performance.score * 100) : null,
    fcp: getLabMetric('first-contentful-paint'),
    lcp: getLabMetric('largest-contentful-paint'),
    cls: getLabMetric('cumulative-layout-shift'),
    tbt: getLabMetric('total-blocking-time'),
    speedIndex: getLabMetric('speed-index'),
    tti: getLabMetric('interactive'),
    ttfb: getLabMetric('server-response-time')
  };

  // Parse detailed Lighthouse opportunities and diagnostics
  const opportunities = [];
  const auditKeys = [
    // LCP
    { key: 'uses-responsive-images', metric: 'LCP' },
    { key: 'modern-image-formats', metric: 'LCP' },
    { key: 'uses-optimized-images', metric: 'LCP' },
    { key: 'offscreen-images', metric: 'LCP' },
    { key: 'render-blocking-resources', metric: 'LCP' },
    { key: 'largest-contentful-paint-element', metric: 'LCP' },
    { key: 'lcp-lazy-loaded', metric: 'LCP' },
    { key: 'preload-lcp-image', metric: 'LCP' },
    
    // INP / TBT
    { key: 'mainthread-work-breakdown', metric: 'INP' },
    { key: 'bootup-time', metric: 'INP' },
    { key: 'dom-size', metric: 'INP' },
    { key: 'unused-javascript', metric: 'INP' },
    { key: 'duplicated-javascript', metric: 'INP' },
    { key: 'long-tasks', metric: 'INP' },
    
    // CLS
    { key: 'layout-shift-elements', metric: 'CLS' },
    { key: 'unsized-images', metric: 'CLS' },
    { key: 'non-composited-animations', metric: 'CLS' },
    
    // FCP
    { key: 'unused-css-rules', metric: 'FCP' },
    { key: 'unminified-css', metric: 'FCP' },
    { key: 'unminified-javascript', metric: 'FCP' },
    { key: 'font-display', metric: 'FCP' },

    // TTFB
    { key: 'server-response-time', metric: 'TTFB' },
    { key: 'redirects', metric: 'TTFB' },
    { key: 'uses-rel-preconnect', metric: 'TTFB' }
  ];

  auditKeys.forEach(({ key, metric }) => {
    const audit = audits[key];
    if (audit && audit.score !== null && audit.score < 1.0) {
      const items = audit.details?.items || [];
      if (items.length > 0 || audit.score < 0.90 || audit.numericValue) {
        opportunities.push({
          id: key,
          metric: metric,
          title: audit.title,
          description: audit.description || '',
          score: audit.score,
          displayValue: audit.displayValue || '',
          numericValue: audit.numericValue || 0,
          items: items.slice(0, 5).map(item => {
            const node = item.node || {};
            let displayUrl = item.url || node.nodeLabel || '';
            if (displayUrl.startsWith('http')) {
              try {
                const parsedUrl = new URL(displayUrl);
                displayUrl = parsedUrl.pathname.split('/').pop() || parsedUrl.hostname;
              } catch(e) {}
            }
            if (!displayUrl) {
              displayUrl = item.groupLabel || node.nodeLabel || 'Inline Resource';
            }
            return {
              url: item.url || '',
              fileName: displayUrl,
              totalBytes: item.totalBytes || 0,
              wastedBytes: item.wastedBytes || 0,
              wastedMs: item.wastedMs || item.duration || 0,
              score: item.score || 0,
              snippet: node.snippet || '',
              selector: node.selector || ''
            };
          })
        });
      }
    }
  });

  return { field, lab, opportunities };
}

// Queue Executive Loop
async function processQueue() {
  state.activeWorkers = 0;
  
  const worker = async () => {
    while (state.status === 'running') {
      // Find the next pending task
      const task = state.tasks.find(t => t.status === 'pending');
      if (!task) break;

      task.status = 'running';
      state.activeWorkers++;
      updateProgressUI();
      renderTable();
      
      log(`Starting audit for [${task.strategy.toUpperCase()}] ${task.url}`, 'info');

      try {
        const metrics = await fetchVitals(task.url, task.strategy, state.abortController.signal);
        task.status = 'completed';
        task.metrics = metrics;
        log(`Successfully audited: [${task.strategy.toUpperCase()}] ${task.url}`, 'info');
      } catch (err) {
        if (err.name === 'AbortError') {
          task.status = 'pending';
          log(`Audit cancelled for: ${task.url}`, 'warning');
          break;
        }
        task.status = 'failed';
        task.error = err.message;
        log(`Failed auditing ${task.url}: ${err.message}`, 'error');
      } finally {
        state.activeWorkers--;
        updateProgressUI();
        updateSummaryKPIs();
        renderTable();
      }
    }
  };

  // Launch parallel workers up to concurrency count
  const workers = [];
  const workerCount = Math.min(state.concurrency, state.tasks.filter(t => t.status === 'pending').length);
  
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  if (state.status === 'running') {
    state.status = 'completed';
    log('Audit run fully completed.', 'info');
    completeAuditRun();
  }
}

els.startAuditBtn.addEventListener('click', () => {
  const runName = els.runNameInput.value.trim();
  if (!runName) {
    alert('Audit Run Name is mandatory.');
    els.runNameInput.focus();
    return;
  }

  const urlText = els.urlsInput.value.trim();
  if (!urlText) {
    alert('Please enter or upload at least one valid URL.');
    return;
  }

  const rawUrls = urlText.split(/[\r\n,]+/)
                         .map(url => url.trim())
                         .filter(url => url.length > 0);

  const formattedUrls = rawUrls.map(url => {
    if (!/^https?:\/\//i.test(url)) {
      return `https://${url}`;
    }
    return url;
  });

  const strategy = els.strategySelect.value;
  const strategies = strategy === 'both' ? ['mobile', 'desktop'] : [strategy];

  // Build the list of tasks
  state.tasks = [];
  let taskId = 0;
  for (const url of formattedUrls) {
    for (const strat of strategies) {
      state.tasks.push({
        id: taskId++,
        url: url,
        strategy: strat,
        status: 'pending',
        error: null,
        metrics: null,
        auditMode: els.auditDepthSelect.value
      });
    }
  }

  // Set running state
  state.status = 'running';
  state.currentPage = 1;
  state.abortController = new AbortController();

  // Update UI Elements
  els.startAuditBtn.disabled = true;
  els.cancelAuditBtn.disabled = false;
  els.exportExcelBtn.disabled = true;
  els.progressPanel.style.display = 'flex';
  els.progressTitle.textContent = 'Auditing URLs...';
  
  els.logConsole.innerHTML = '';
  log(`Starting batch audit of ${state.tasks.length} URL/Device strategies...`, 'info');

  updateProgressUI();
  updateSummaryKPIs();
  processQueue();
});

els.cancelAuditBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to cancel the current audit? Any remaining URLs will be skipped.')) {
    state.status = 'cancelled';
    if (state.abortController) {
      state.abortController.abort();
    }
    log('Audit process cancelled by user.', 'error');
    completeAuditRun();
  }
});

// Automatically generate and upload the Excel report to the local server disk
async function autoSaveExcelToServer() {
  const completedTasks = state.tasks.filter(t => t.status === 'completed');
  if (completedTasks.length === 0) return;

  log('Initiating automatic Excel report saving on server disk...', 'info');
  
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Core Web Vitals Bulk Checker';
    workbook.created = new Date();

    // 1. DASHBOARD SUMMARY TAB
    const dashSheet = workbook.addWorksheet('Executive Summary');
    dashSheet.views = [{ showGridLines: true }];

    dashSheet.getColumn(1).width = 4;
    dashSheet.getColumn(2).width = 24;
    dashSheet.getColumn(3).width = 20;
    dashSheet.getColumn(4).width = 20;
    dashSheet.getColumn(5).width = 20;

    dashSheet.mergeCells('B2:E2');
    const titleCell = dashSheet.getCell('B2');
    titleCell.value = 'Core Web Vitals Executive Audit Report';
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F51B5' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dashSheet.getRow(2).height = 40;

    dashSheet.getCell('B4').value = 'Date of Audit:';
    dashSheet.getCell('B4').font = { bold: true };
    dashSheet.getCell('C4').value = new Date().toLocaleString();
    
    dashSheet.getCell('B5').value = 'Total Checked:';
    dashSheet.getCell('B5').font = { bold: true };
    dashSheet.getCell('C5').value = completedTasks.length;

    // Aggregates Box
    const passingCount = completedTasks.filter(t => {
      const field = t.metrics?.field;
      if (!field) return false;
      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;
      if (!hasLcp && !hasCls && !hasInp && !hasFid) return false;
      
      let passed = true;
      if (hasLcp && field.lcp.value > 2500) passed = false;
      if (hasCls && field.cls.value > 0.10) passed = false;
      if (hasInp && field.inp.value > 200) passed = false;
      else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
      return passed;
    }).length;
    const passPercentage = Math.round((passingCount / completedTasks.length) * 100);

    dashSheet.getCell('B6').value = 'Core Web Vitals Pass Rate:';
    dashSheet.getCell('B6').font = { bold: true };
    dashSheet.getCell('C6').value = `${passPercentage}%`;
    dashSheet.getCell('C6').font = {
      bold: true,
      color: { argb: passPercentage >= 90 ? 'FF137333' : (passPercentage >= 50 ? 'FFB06000' : 'FFC5221F') }
    };

    dashSheet.getCell('B9').value = 'Google Official Metric Performance Thresholds';
    dashSheet.getCell('B9').font = { size: 12, bold: true };
    dashSheet.mergeCells('B9:E9');
    
    const thRow = dashSheet.getRow(10);
    thRow.values = ['', 'Metric Name', 'Good (Pass)', 'Needs Improvement', 'Poor (Fail)'];
    thRow.font = { bold: true };
    
    const metricDefs = [
      ['Largest Contentful Paint (LCP)', '≤ 2.5s', '2.5s - 4.0s', '> 4.0s'],
      ['Interaction to Next Paint (INP)', '≤ 200ms', '200ms - 500ms', '> 500ms'],
      ['Cumulative Layout Shift (CLS)', '≤ 0.10', '0.10 - 0.25', '> 0.25'],
      ['First Contentful Paint (FCP)', '≤ 1.8s', '1.8s - 3.0s', '> 3.0s'],
      ['Lighthouse Performance Score', '90 - 100', '50 - 89', '< 50']
    ];

    metricDefs.forEach((def, index) => {
      const row = dashSheet.getRow(11 + index);
      row.values = ['', ...def];
      
      const cGood = row.getCell(3);
      cGood.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
      cGood.font = { color: { argb: 'FF137333' }, bold: true };
      cGood.alignment = { horizontal: 'center' };

      const cNI = row.getCell(4);
      cNI.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
      cNI.font = { color: { argb: 'FFB06000' }, bold: true };
      cNI.alignment = { horizontal: 'center' };

      const cPoor = row.getCell(5);
      cPoor.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
      cPoor.font = { color: { argb: 'FFC5221F' }, bold: true };
      cPoor.alignment = { horizontal: 'center' };
    });

    for (let r = 10; r <= 15; r++) {
      for (let c = 2; c <= 5; c++) {
        dashSheet.getCell(r, c).border = {
          top: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          left: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          right: { style: 'thin', color: { argb: 'FFB0BEC5' } }
        };
      }
    }

    // 2. DETAILED RESULTS TAB
    const dataSheet = workbook.addWorksheet('Core Web Vitals Audit');
    dataSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];

    const headers = [
      { header: 'Target URL', key: 'url', width: 35 },
      { header: 'Device', key: 'strategy', width: 12 },
      { header: 'Field CWV Status', key: 'fieldAssessment', width: 22 },
      { header: 'PageSpeed Insights Link', key: 'pagespeedLink', width: 45 },
      { header: 'Field LCP (s)', key: 'fieldLcp', width: 14 },
      { header: 'Field INP (ms)', key: 'fieldInp', width: 15 },
      { header: 'Field CLS', key: 'fieldCls', width: 12 },
      { header: 'Field FCP (s)', key: 'fieldFcp', width: 14 },
      { header: 'Field FID (ms)', key: 'fieldFid', width: 14 },
      { header: 'Lab Performance Score', key: 'labScore', width: 22 },
      { header: 'Lab LCP (s)', key: 'labLcp', width: 14 },
      { header: 'Lab TBT (ms)', key: 'labTbt', width: 14 },
      { header: 'Lab CLS', key: 'labCls', width: 12 },
      { header: 'Lab FCP (s)', key: 'labFcp', width: 14 },
      { header: 'Lab Speed Index (s)', key: 'labSpeedIndex', width: 18 }
    ];
    dataSheet.columns = headers;

    const headerRow = dataSheet.getRow(1);
    headerRow.height = 28;
    headerRow.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A237E' } };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFECEFF1' } }
      };
    });

    completedTasks.forEach((task) => {
      const field = task.metrics.field;
      const lab = task.metrics.lab;

      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;

      let fieldCwvStatus = 'NO DATA';
      if (!hasLcp && !hasCls && !hasInp && !hasFid) {
        fieldCwvStatus = 'NO DATA';
      } else {
        let passed = true;
        if (hasLcp && field.lcp.value > 2500) passed = false;
        if (hasCls && field.cls.value > 0.10) passed = false;
        if (hasInp && field.inp.value > 200) passed = false;
        else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
        
        fieldCwvStatus = passed ? 'PASSED' : 'FAILED';
      }

      const pagespeedUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(task.url)}&form_factor=${task.strategy}`;

      const rowValues = {
        url: task.url,
        strategy: task.strategy.toUpperCase(),
        fieldAssessment: fieldCwvStatus,
        pagespeedLink: { text: pagespeedUrl, hyperlink: pagespeedUrl },
        fieldLcp: field.lcp ? field.lcp.value / 1000 : null,
        fieldInp: field.inp ? field.inp.value : null,
        fieldCls: field.cls ? field.cls.value : null,
        fieldFcp: field.fcp ? field.fcp.value / 1000 : null,
        fieldFid: field.fid ? field.fid.value : null,
        labScore: lab.performanceScore,
        labLcp: lab.lcp ? lab.lcp / 1000 : null,
        labTbt: lab.tbt,
        labCls: lab.cls,
        labFcp: lab.fcp ? lab.fcp / 1000 : null,
        labSpeedIndex: lab.speedIndex ? lab.speedIndex / 1000 : null
      };

      const row = dataSheet.addRow(rowValues);
      row.height = 22;
      row.alignment = { vertical: 'middle' };
      
      row.getCell('url').alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell('strategy').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('fieldAssessment').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('pagespeedLink').alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell('pagespeedLink').font = { color: { argb: 'FF0000FF' }, underline: true };
      row.getCell('labScore').alignment = { horizontal: 'center', vertical: 'middle' };

      ['fieldLcp', 'fieldFcp', 'labLcp', 'labFcp', 'labSpeedIndex'].forEach(key => {
        row.getCell(key).numFmt = '0.00';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });
      ['fieldInp', 'fieldFid', 'labTbt'].forEach(key => {
        row.getCell(key).numFmt = '#,##0';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });
      ['fieldCls', 'labCls'].forEach(key => {
        row.getCell(key).numFmt = '0.000';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });

      const applyExcelCellStyles = (cell, cat) => {
        if (cat === 'good') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
          cell.font = { color: { argb: 'FF137333' }, bold: true };
        } else if (cat === 'needs-improvement') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
          cell.font = { color: { argb: 'FFB06000' }, bold: true };
        } else if (cat === 'poor') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
          cell.font = { color: { argb: 'FFC5221F' }, bold: true };
        }
      };

      const assessmentCell = row.getCell('fieldAssessment');
      if (fieldCwvStatus === 'PASSED') {
        applyExcelCellStyles(assessmentCell, 'good');
      } else if (fieldCwvStatus === 'FAILED') {
        applyExcelCellStyles(assessmentCell, 'poor');
      } else {
        assessmentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        assessmentCell.font = { color: { argb: 'FF757575' }, bold: true, size: 9 };
      }

      if (field.lcp) applyExcelCellStyles(row.getCell('fieldLcp'), getStatusCategory(field.lcp.value, 'LCP'));
      if (field.inp) applyExcelCellStyles(row.getCell('fieldInp'), getStatusCategory(field.inp.value, 'INP'));
      if (field.cls) applyExcelCellStyles(row.getCell('fieldCls'), getStatusCategory(field.cls.value, 'CLS'));
      if (field.fcp) applyExcelCellStyles(row.getCell('fieldFcp'), getStatusCategory(field.fcp.value, 'FCP'));
      if (field.fid) applyExcelCellStyles(row.getCell('fieldFid'), getStatusCategory(field.fid.value, 'FID'));
      if (lab.performanceScore !== null) applyExcelCellStyles(row.getCell('labScore'), getStatusCategory(lab.performanceScore, 'SCORE'));

      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
        };
      });
    });

    dataSheet.columns.forEach((column) => {
      let maxLen = column.header.length;
      column.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.value) {
          const cellLen = cell.value.toString().length;
          if (cellLen > maxLen) {
            maxLen = cellLen;
          }
        }
      });
      column.width = Math.min(Math.max(maxLen + 4, 12), 45);
    });

    dataSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: completedTasks.length + 1, column: headers.length }
    };

    const buffer = await workbook.xlsx.writeBuffer();
    const response = await fetch('/api/save-results', {
      method: 'POST',
      body: buffer
    });
    
    if (response.ok) {
      const resJson = await response.json();
      log(`[AUTO-SAVE] Excel reports successfully saved on server disk to: ${resJson.path.split(/[\\\\/]/).pop()}`, 'success');
    } else {
      log('[AUTO-SAVE ERROR] Server failed to write Excel file.', 'error');
    }
  } catch (err) {
    log(`[AUTO-SAVE ERROR] Excel auto-save failed: ${err.message}`, 'error');
  }
}

// Automatically compile and upload the full run JSON to the history database
async function autoSaveHistoryToServer() {
  const completedTasks = state.tasks.filter(t => t.status === 'completed');
  if (completedTasks.length === 0) return;

  log('Initiating automatic audit run saving in history database...', 'info');

  try {
    // 1. Calculate KPI summary stats
    const strategy = els.strategySelect.value;
    
    const passingCount = completedTasks.filter(t => {
      const field = t.metrics?.field;
      if (!field) return false;
      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;
      if (!hasLcp && !hasCls && !hasInp && !hasFid) return false;
      
      let passed = true;
      if (hasLcp && field.lcp.value > 2500) passed = false;
      if (hasCls && field.cls.value > 0.10) passed = false;
      if (hasInp && field.inp.value > 200) passed = false;
      else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
      return passed;
    }).length;
    const passPercentage = Math.round((passingCount / completedTasks.length) * 100);

    const lcpVals = completedTasks.map(t => t.metrics?.field?.lcp?.value || t.metrics?.lab?.lcp).filter(v => v !== null && v !== undefined);
    let avgLcpText = '-';
    if (lcpVals.length > 0) {
      const avgLcp = Math.round(lcpVals.reduce((sum, v) => sum + v, 0) / lcpVals.length);
      avgLcpText = `${(avgLcp / 1000).toFixed(2)}s`;
    }

    const clsVals = completedTasks.map(t => t.metrics?.field?.cls?.value !== undefined ? t.metrics.field.cls.value : t.metrics?.lab?.cls).filter(v => v !== null && v !== undefined);
    let avgClsText = '-';
    if (clsVals.length > 0) {
      const avgCls = clsVals.reduce((sum, v) => sum + v, 0) / clsVals.length;
      avgClsText = avgCls.toFixed(3);
    }

    // 2. Pre-populate future-proof empty suggestions arrays for each task in this run!
    const savedTasks = completedTasks.map(task => {
      // Ensure there is always a suggestions array reserved for each audited page
      return {
        ...task,
        suggestions: task.suggestions || []
      };
    });

    // 3. Determine run name
    let runName = els.runNameInput.value.trim();
    if (!runName) {
      const firstUrl = completedTasks[0]?.url || 'Bulk Scan';
      try {
        const hostname = new URL(firstUrl).hostname.replace('www.', '');
        runName = `${hostname} Campaign`;
      } catch (e) {
        runName = `${firstUrl} Audit`;
      }
    }

    // 4. Package the run
    const runPackage = {
      id: 'run_' + Date.now(),
      name: runName,
      date: new Date().toISOString(),
      strategy: strategy,
      total: completedTasks.length,
      passed: passingCount,
      passRate: passPercentage,
      avgLcp: avgLcpText,
      avgCls: avgClsText,
      tasks: savedTasks
    };

    // 4. Send POST request to `/api/history`
    const response = await fetch('/api/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(runPackage)
    });

    if (response.ok) {
      log('Scan history record successfully saved to database.', 'success');
      // Refresh timeline list behind the scenes
      await loadHistory();
    } else {
      log('[HISTORY ERROR] Failed to save run history record on server.', 'error');
    }
  } catch (err) {
    log(`[HISTORY ERROR] History auto-save failed: ${err.message}`, 'error');
    console.error(err);
  }
}

function completeAuditRun() {
  state.status = 'completed';
  els.startAuditBtn.disabled = false;
  els.cancelAuditBtn.disabled = true;
  
  // Enable export only if we have at least one completed task
  const hasCompleted = state.tasks.some(t => t.status === 'completed');
  els.exportExcelBtn.disabled = !hasCompleted;
  
  els.progressTitle.textContent = 'Audit Complete';
  updateProgressUI();
  updateSummaryKPIs();
  renderTable();

  // Automatically save report to local server disk and database
  if (hasCompleted) {
    autoSaveExcelToServer();
    autoSaveHistoryToServer();
  }
}

// Progress Bar & Stats Updater
function updateProgressUI() {
  const total = state.tasks.length;
  const completed = state.tasks.filter(t => t.status === 'completed' || t.status === 'failed').length;
  
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  
  els.progressPercentage.textContent = `${percentage}%`;
  els.progressBarFill.style.width = `${percentage}%`;
  els.progressCounts.textContent = `Completed: ${completed} / ${total}`;
  els.progressActiveWorkers.textContent = `Active Workers: ${state.activeWorkers}`;
}

// Update executive metrics
function updateSummaryKPIs() {
  const completedTasks = state.tasks.filter(t => t.status === 'completed');
  
  els.valTotalUrls.textContent = state.tasks.length;
  
  if (completedTasks.length === 0) {
    els.valPassRate.textContent = '0%';
    els.valAvgLcp.textContent = '-';
    els.valAvgCls.textContent = '-';
    return;
  }

  // CWV overall assessment pass rate
  // Google field assessment passes if LCP, CLS, and INP/FID are good
  const passingCount = completedTasks.filter(t => {
    const field = t.metrics?.field;
    if (!field) return false;
    const hasLcp = field.lcp !== null && field.lcp !== undefined;
    const hasCls = field.cls !== null && field.cls !== undefined;
    const hasInp = field.inp !== null && field.inp !== undefined;
    const hasFid = field.fid !== null && field.fid !== undefined;
    if (!hasLcp && !hasCls && !hasInp && !hasFid) return false;
    
    let passed = true;
    if (hasLcp && field.lcp.value > 2500) passed = false;
    if (hasCls && field.cls.value > 0.10) passed = false;
    if (hasInp && field.inp.value > 200) passed = false;
    else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
    return passed;
  }).length;
  const passRate = Math.round((passingCount / completedTasks.length) * 100);
  els.valPassRate.textContent = `${passRate}%`;
  
  // Set card color based on pass rate
  const passCard = els.valPassRate.closest('.metric-card');
  passCard.className = 'metric-card';
  if (passRate >= 90) passCard.classList.add('good');
  else if (passRate >= 50) passCard.classList.add('needs-improvement');
  else passCard.classList.add('poor');

  // LCP Average (Field LCP values in ms)
  const lcpVals = completedTasks.map(t => t.metrics?.field?.lcp?.value || t.metrics?.lab?.lcp).filter(v => v !== null && v !== undefined);
  if (lcpVals.length > 0) {
    const avgLcp = Math.round(lcpVals.reduce((sum, v) => sum + v, 0) / lcpVals.length);
    els.valAvgLcp.textContent = `${(avgLcp / 1000).toFixed(2)}s`;
    
    const lcpCard = els.valAvgLcp.closest('.metric-card');
    lcpCard.className = 'metric-card';
    const cat = getStatusCategory(avgLcp, 'LCP');
    lcpCard.classList.add(cat);
  } else {
    els.valAvgLcp.textContent = '-';
  }

  // CLS Average
  const clsVals = completedTasks.map(t => t.metrics?.field?.cls?.value !== undefined ? t.metrics.field.cls.value : t.metrics?.lab?.cls).filter(v => v !== null && v !== undefined);
  if (clsVals.length > 0) {
    const avgCls = clsVals.reduce((sum, v) => sum + v, 0) / clsVals.length;
    els.valAvgCls.textContent = avgCls.toFixed(3);
    
    const clsCard = els.valAvgCls.closest('.metric-card');
    clsCard.className = 'metric-card';
    const cat = getStatusCategory(avgCls, 'CLS');
    clsCard.classList.add(cat);
  } else {
    els.valAvgCls.textContent = '-';
  }
}

// Filter tasks
function getFilteredTasks() {
  if (!state.searchTerm) return state.tasks;
  return state.tasks.filter(t => t.url.toLowerCase().includes(state.searchTerm));
}

// Toggle row expanded state
function toggleRowExpansion(taskId) {
  if (state.expandedRows.has(taskId)) {
    state.expandedRows.delete(taskId);
  } else {
    state.expandedRows.add(taskId);
  }
  renderTable();
}

// Helper to escape HTML to prevent selector snippets from breaking layout
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

// Generate a unified, high-fidelity grid displaying only the five core numbers
function getCoreMetricsGridHtml(field, lab) {
  const categoriesList = [
    {
      name: 'LCP — Largest Contentful Paint',
      value: field.lcp ? `${(field.lcp.value / 1000).toFixed(2)}s` : (lab.lcp ? `${(lab.lcp / 1000).toFixed(2)}s` : '-'),
      status: field.lcp ? getStatusCategory(field.lcp.value, 'LCP') : (lab.lcp ? getStatusCategory(lab.lcp, 'LCP') : 'unknown'),
      icon: '🖼️',
      desc: 'Measures loading performance. Good is ≤ 2.5s.'
    },
    {
      name: 'INP — Interaction to Next Paint',
      value: field.inp ? `${field.inp.value}ms` : (lab.tbt ? `${lab.tbt}ms TBT` : '-'),
      status: field.inp ? getStatusCategory(field.inp.value, 'INP') : (lab.tbt ? (lab.tbt > 600 ? 'poor' : (lab.tbt > 300 ? 'needs-improvement' : 'good')) : 'unknown'),
      icon: '⚡',
      desc: 'Measures responsiveness. Good is ≤ 200ms.'
    },
    {
      name: 'CLS — Cumulative Layout Shift',
      value: field.cls ? field.cls.value.toFixed(3) : (lab.cls !== null && lab.cls !== undefined ? lab.cls.toFixed(3) : '-'),
      status: field.cls ? getStatusCategory(field.cls.value, 'CLS') : (lab.cls !== null && lab.cls !== undefined ? getStatusCategory(lab.cls, 'CLS') : 'unknown'),
      icon: '📐',
      desc: 'Measures visual stability. Good is ≤ 0.10.'
    },
    {
      name: 'FCP — First Contentful Paint',
      value: field.fcp ? `${(field.fcp.value / 1000).toFixed(2)}s` : (lab.fcp ? `${(lab.fcp / 1000).toFixed(2)}s` : '-'),
      status: field.fcp ? getStatusCategory(field.fcp.value, 'FCP') : (lab.fcp ? getStatusCategory(lab.fcp, 'FCP') : 'unknown'),
      icon: '🎨',
      desc: 'Measures raw load speed. Good is ≤ 1.8s.'
    },
    {
      name: 'TTFB — Time to First Byte',
      value: field.ttfb ? `${field.ttfb.value}ms` : (lab.ttfb ? `${Math.round(lab.ttfb)}ms` : '-'),
      status: field.ttfb ? getStatusCategory(field.ttfb.value, 'TTFB') : (lab.ttfb ? getStatusCategory(lab.ttfb, 'TTFB') : 'unknown'),
      icon: '⏳',
      desc: 'Measures server response time. Good is ≤ 800ms.'
    }
  ];

  let gridHtml = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
  `;

  categoriesList.forEach(c => {
    let statusClass = 'pending';
    if (c.status === 'good') statusClass = 'good';
    else if (c.status === 'needs-improvement') statusClass = 'needs-improvement';
    else if (c.status === 'poor') statusClass = 'poor';

    gridHtml += `
      <div style="border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--bg-secondary); padding: 1rem; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.2s ease;">
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="font-size: 1.25rem;">${c.icon}</span>
          <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">${c.name.split(' — ')[0]}</span>
        </div>
        <div style="margin-bottom: 0.5rem;">
          <div style="font-size: 1.5rem; font-weight: 800; font-family: var(--font-display); color: var(--text-primary);">${c.value}</div>
          <span class="badge ${statusClass}" style="font-size: 0.625rem; padding: 0.15rem 0.4rem; font-weight: 700; border-radius: 9999px; text-transform: uppercase;">${c.status.replace('-', ' ')}</span>
        </div>
        <div style="font-size: 0.7rem; color: var(--text-secondary); line-height: 1.3;">${c.desc}</div>
      </div>
    `;
  });

  gridHtml += `
    </div>
  `;

  return gridHtml;
}

// Generate structured, grouped, highly readable performance diagnostics HTML
function getDynamicPageSuggestionsHtml(task) {
  if (!task.metrics) return '';
  
  const field = task.metrics.field || {};
  const lab = task.metrics.lab || {};
  const opportunities = task.metrics.opportunities || [];

  const gridHtml = getCoreMetricsGridHtml(field, lab);

  if (task.auditMode === 'fast') {
    return gridHtml + `
      <div style="background-color: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.5rem;">
        <span style="font-size: 1.25rem; flex-shrink: 0;">ℹ️</span>
        <div style="font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.5;">
          <strong>Quick Audit Details:</strong> Diagnostic opportunities and code suggestions were skipped in Quick Mode to maximize execution speed. If detailed coding recommendations or asset sizes are needed, you can click the button above to view the full live report on PageSpeed Insights.
        </div>
      </div>
    `;
  }
  
  const categories = {
    TTFB: {
      name: 'Time to First Byte (TTFB) — Server Speed',
      label: 'TTFB',
      icon: '⏳',
      displayVal: field.ttfb ? `${field.ttfb.value}ms (Field)` : (lab.ttfb ? `${Math.round(lab.ttfb)}ms (Lab)` : '-'),
      status: field.ttfb ? getStatusCategory(field.ttfb.value, 'TTFB') : (lab.ttfb ? getStatusCategory(lab.ttfb, 'TTFB') : 'unknown'),
      issues: opportunities.filter(opp => opp.metric === 'TTFB')
    },
    FCP: {
      name: 'First Contentful Paint (FCP) — Visual Load Start',
      label: 'FCP',
      icon: '🎨',
      displayVal: field.fcp ? `${(field.fcp.value / 1000).toFixed(2)}s (Field)` : (lab.fcp ? `${(lab.fcp / 1000).toFixed(2)}s (Lab)` : '-'),
      status: field.fcp ? getStatusCategory(field.fcp.value, 'FCP') : (lab.fcp ? getStatusCategory(lab.fcp, 'FCP') : 'unknown'),
      issues: opportunities.filter(opp => opp.metric === 'FCP')
    },
    LCP: {
      name: 'Largest Contentful Paint (LCP) — Primary Content Load',
      label: 'LCP',
      icon: '🖼️',
      displayVal: field.lcp ? `${(field.lcp.value / 1000).toFixed(2)}s (Field)` : (lab.lcp ? `${(lab.lcp / 1000).toFixed(2)}s (Lab)` : '-'),
      status: field.lcp ? getStatusCategory(field.lcp.value, 'LCP') : (lab.lcp ? getStatusCategory(lab.lcp, 'LCP') : 'unknown'),
      issues: opportunities.filter(opp => opp.metric === 'LCP')
    },
    CLS: {
      name: 'Cumulative Layout Shift (CLS) — Visual Stability',
      label: 'CLS',
      icon: '📐',
      displayVal: field.cls ? `${field.cls.value.toFixed(3)} (Field)` : (lab.cls !== null && lab.cls !== undefined ? `${lab.cls.toFixed(3)} (Lab)` : '-'),
      status: field.cls ? getStatusCategory(field.cls.value, 'CLS') : (lab.cls !== null && lab.cls !== undefined ? getStatusCategory(lab.cls, 'CLS') : 'unknown'),
      issues: opportunities.filter(opp => opp.metric === 'CLS')
    },
    INP: {
      name: 'Interaction to Next Paint (INP / TBT) — Responsiveness',
      label: 'INP',
      icon: '⚡',
      displayVal: field.inp ? `${field.inp.value}ms (Field)` : (lab.tbt ? `${lab.tbt}ms TBT (Lab)` : '-'),
      status: field.inp ? getStatusCategory(field.inp.value, 'INP') : (lab.tbt ? (lab.tbt > 600 ? 'poor' : (lab.tbt > 300 ? 'needs-improvement' : 'good')) : 'unknown'),
      issues: opportunities.filter(opp => opp.metric === 'INP')
    }
  };
  
  let categoriesHtml = gridHtml + `
    <div style="font-family: var(--font-display); font-weight: 700; font-size: 0.95rem; color: var(--text-primary); margin-bottom: 0.875rem; display: flex; align-items: center; gap: 0.4rem; border-top: 1px dashed var(--border-color); padding-top: 1.25rem;">
      <span>💡 Granular Diagnostic Recommendations &amp; Opportunities</span>
    </div>
  `;
  Object.keys(categories).forEach(catKey => {
    const cat = categories[catKey];
    
    let statusClass = 'pending';
    if (cat.status === 'good') statusClass = 'good';
    else if (cat.status === 'needs-improvement') statusClass = 'needs-improvement';
    else if (cat.status === 'poor') statusClass = 'poor';
    
    let issuesHtml = '';
    if (cat.issues.length === 0) {
      if (cat.status === 'needs-improvement' || cat.status === 'poor') {
        let adviceText = '';
        if (catKey === 'LCP') {
          adviceText = `Largest Contentful Paint is slow (${cat.displayVal}). Optimize load performance by caching HTML documents, utilizing a CDN to reduce Time to First Byte (TTFB), and preloading critical visual resources.`;
        } else if (catKey === 'INP') {
          adviceText = `Responsiveness is slow (${cat.displayVal}). Lower input delays by splitting large bundles into smaller chunks, offloading heavy CPU computation to Web Workers, and deferring non-critical scripts.`;
        } else if (catKey === 'CLS') {
          adviceText = `Cumulative Layout Shift is elevated (${cat.displayVal}). Ensure all images and embedded frames have explicit dimensions, and dynamic widgets reserve their layout heights to prevent shift jumps.`;
        } else if (catKey === 'TTFB') {
          adviceText = `Initial Server Response Time is elevated (${cat.displayVal}). Optimize your backend script execution, database querying, page caching configurations, or transition to a distributed CDN.`;
        } else if (catKey === 'FCP') {
          adviceText = `First Contentful Paint is elevated (${cat.displayVal}). Remove unused style sheets, minify key scripts, and set font-display attributes to keep texts visible early.`;
        }
        
        issuesHtml = `
          <div style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.875rem 1rem;">
            <div style="color: var(--color-needs-improvement); font-size: 0.8125rem; display: flex; align-items: flex-start; gap: 0.5rem; line-height: 1.4;">
              <span style="font-size: 1rem; flex-shrink: 0;">⚠️</span>
              <span><strong>Recommendation:</strong> ${adviceText}</span>
            </div>
          </div>
        `;
      } else {
        issuesHtml = `
          <div style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.875rem 1rem;">
            <div style="color: var(--color-good); font-size: 0.8125rem; display: flex; align-items: center; gap: 0.35rem; font-weight: 600;">
              <span>✓</span> Passed all standard PageSpeed diagnostics for this metric.
            </div>
          </div>
        `;
      }
    } else {
      issuesHtml = cat.issues.map(opp => {
        const fileList = opp.items && opp.items.length > 0 ? `
          <div style="background-color: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 4px; padding: 0.625rem 0.875rem; font-family: monospace; font-size: 0.78rem; color: var(--text-secondary); line-height: 1.5; word-break: break-all; margin-top: 0.35rem; margin-bottom: 0.5rem; display: flex; flex-direction: column; gap: 0.25rem;">
            ${opp.items.map(item => {
              let details = [];
              if (item.totalBytes) details.push(`Size: ${Math.round(item.totalBytes / 1024)} KB`);
              if (item.wastedBytes) details.push(`potential savings: <strong style="color: var(--color-needs-improvement);">${Math.round(item.wastedBytes / 1024)} KB</strong>`);
              if (item.wastedMs) details.push(`delays paint by <strong style="color: var(--color-poor);">${item.wastedMs}ms</strong>`);
              if (item.score && opp.id === 'layout-shift-elements') details.push(`CLS contribution: <strong style="color: var(--color-poor);">${item.score.toFixed(3)}</strong>`);
              
              const detailText = details.length > 0 ? ` — ${details.join(', ')}` : '';
              const itemLine = `• <strong>${item.fileName}</strong>${detailText}`;
              
              const snippetText = item.snippet ? `<div style="color: var(--text-muted); font-size: 0.72rem; margin-top: 0.15rem; padding-left: 0.75rem; border-left: 2px solid var(--border-color); white-space: pre-wrap; font-family: Courier, monospace; background-color: rgba(0,0,0,0.15); padding: 0.25rem 0.5rem; border-radius: 4px;">${escapeHtml(item.snippet)}</div>` : '';
              
              return `<div>${itemLine}${snippetText}</div>`;
            }).join('')}
          </div>
        ` : '';
        
        const cleanedDesc = opp.description.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:var(--primary);text-decoration:underline;">$1</a>');
        
        return `
          <div style="background-color: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 0.875rem 1rem; display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.75rem;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem;">
              <div style="font-weight: 600; font-size: 0.875rem; color: var(--text-primary);">
                ${opp.title} ${opp.displayValue ? `<span style="color: var(--color-needs-improvement); font-size: 0.8125rem; font-weight: 700;">— ${opp.displayValue}</span>` : ''}
              </div>
              <span class="suggestion-severity-tag ${opp.score < 0.5 ? 'high' : 'medium'}" style="font-size: 0.625rem; flex-shrink: 0; padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 700; text-transform: uppercase;">
                ${opp.score < 0.5 ? 'high' : 'medium'}
              </span>
            </div>
            ${fileList}
            <div style="font-size: 0.8125rem; color: var(--text-secondary); line-height: 1.4;">
              ${cleanedDesc}
            </div>
          </div>
        `;
      }).join('');
    }
    
    categoriesHtml += `
      <div style="border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--bg-secondary); overflow: hidden; margin-bottom: 1rem; box-shadow: var(--shadow-sm);">
        <!-- Banner Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; background-color: var(--bg-tertiary); padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color);">
          <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-family: var(--font-display); font-size: 0.875rem; color: var(--text-primary);">
            <span style="font-size: 1.1rem; display: inline-block; width: 24px; text-align: center;">${cat.icon}</span>
            <span>${cat.name}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-family: monospace; font-weight: 700; font-size: 0.8125rem; color: var(--color-${statusClass});">${cat.displayVal}</span>
            <span class="badge ${statusClass}" style="font-size: 0.625rem; padding: 0.15rem 0.4rem; font-weight: 700; border-radius: 9999px;">${cat.status}</span>
          </div>
        </div>
        
        <!-- Diagnostic Content -->
        <div style="padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;">
          ${issuesHtml}
        </div>
      </div>
    `;
  });
  
  return categoriesHtml;
}

// Render dynamic results table
function renderTable() {
  const filtered = getFilteredTasks();
  els.resultsTableBody.innerHTML = '';
  
  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    tr.id = 'emptyRow';
    tr.innerHTML = `
      <td colspan="9">
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-title">${state.tasks.length === 0 ? 'No Audit Performed Yet' : 'No Matching Results'}</div>
          <div class="empty-state-desc">${state.tasks.length === 0 ? 'Enter web addresses in the left column and click "Start Bulk Audit"' : 'Try adjusting your search criteria.'}</div>
        </div>
      </td>
    `;
    els.resultsTableBody.appendChild(tr);
    els.tablePageInfo.textContent = 'Showing 0 of 0 entries';
    els.prevPageBtn.disabled = true;
    els.nextPageBtn.disabled = true;
    return;
  }

  // Pagination bounds
  const total = filtered.length;
  const start = (state.currentPage - 1) * state.pageSize;
  const end = Math.min(start + state.pageSize, total);
  const paginated = filtered.slice(start, end);
  
  els.tablePageInfo.textContent = `Showing ${start + 1}-${end} of ${total} entries`;
  els.prevPageBtn.disabled = state.currentPage === 1;
  els.nextPageBtn.disabled = end >= total;

  for (const task of paginated) {
    const tr = document.createElement('tr');
    
    // Expand button cell
    const tdExpand = document.createElement('td');
    if (task.status === 'completed') {
      const isExpanded = state.expandedRows.has(task.id);
      const btn = document.createElement('button');
      btn.className = `row-expand-btn ${isExpanded ? 'expanded' : ''}`;
      btn.innerHTML = '▶';
      btn.title = 'Toggle suggestions and diagnostics';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRowExpansion(task.id);
      });
      tdExpand.appendChild(btn);
    }
    tr.appendChild(tdExpand);
    
    // URL cell
    const tdUrl = document.createElement('td');
    tdUrl.className = 'cell-url';
    tdUrl.title = task.url;
    tdUrl.innerHTML = `<a href="${task.url}" target="_blank" rel="noopener noreferrer">${task.url}</a>`;
    tr.appendChild(tdUrl);

    // Strategy cell
    const tdStrat = document.createElement('td');
    tdStrat.innerHTML = `<span class="strategy-badge ${task.strategy}">${task.strategy}</span>`;
    tr.appendChild(tdStrat);

    if (task.status === 'pending') {
      tr.innerHTML += `<td colspan="6"><span class="badge pending">Pending</span></td>`;
    } else if (task.status === 'running') {
      tr.innerHTML += `<td colspan="6"><span class="badge pending" style="animation: pulse 1.5s infinite;">Analyzing...</span></td>`;
    } else if (task.status === 'failed') {
      tr.innerHTML += `<td colspan="6"><span class="badge poor" title="${task.error}">Failed: ${task.error}</span></td>`;
    } else if (task.status === 'completed' && task.metrics) {
      const field = task.metrics.field;
      const lab = task.metrics.lab;

      // Field CWV Overall Assessment calculated strictly by core metrics
      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;
      
      let passBadge = '<span class="badge pending">N/A</span>';
      if (hasLcp || hasCls || hasInp || hasFid) {
        let passed = true;
        if (hasLcp && field.lcp.value > 2500) passed = false;
        if (hasCls && field.cls.value > 0.10) passed = false;
        if (hasInp && field.inp.value > 200) passed = false;
        else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
        
        passBadge = passed
          ? '<span class="badge good">Passed</span>'
          : '<span class="badge poor">Failed</span>';
      }
      
      const tdAssessment = document.createElement('td');
      tdAssessment.innerHTML = `${passBadge}${field.isOriginFallback ? ' <span style="font-size:0.625rem;color:var(--text-muted);" title="Data represents domain origin, not specific URL">*</span>' : ''}`;
      tr.appendChild(tdAssessment);

      // LCP cell
      const tdLcp = document.createElement('td');
      if (field.lcp) {
        const cat = getStatusCategory(field.lcp.value, 'LCP');
        tdLcp.innerHTML = `
          <div class="metric-val-cell">
            <span class="metric-val" style="color: var(--color-${cat});">${(field.lcp.value / 1000).toFixed(2)}s</span>
            <span class="metric-cat">${cat}</span>
          </div>
        `;
      } else {
        tdLcp.innerHTML = '<span style="color:var(--text-muted);">-</span>';
      }
      tr.appendChild(tdLcp);

      // INP cell
      const tdInp = document.createElement('td');
      if (field.inp) {
        const cat = getStatusCategory(field.inp.value, 'INP');
        tdInp.innerHTML = `
          <div class="metric-val-cell">
            <span class="metric-val" style="color: var(--color-${cat});">${field.inp.value}ms</span>
            <span class="metric-cat">${cat}</span>
          </div>
        `;
      } else {
        tdInp.innerHTML = '<span style="color:var(--text-muted);">-</span>';
      }
      tr.appendChild(tdInp);

      // CLS cell
      const tdCls = document.createElement('td');
      if (field.cls) {
        const cat = getStatusCategory(field.cls.value, 'CLS');
        tdCls.innerHTML = `
          <div class="metric-val-cell">
            <span class="metric-val" style="color: var(--color-${cat});">${field.cls.value.toFixed(3)}</span>
            <span class="metric-cat">${cat}</span>
          </div>
        `;
      } else {
        tdCls.innerHTML = '<span style="color:var(--text-muted);">-</span>';
      }
      tr.appendChild(tdCls);

      // FCP cell
      const tdFcp = document.createElement('td');
      if (field.fcp) {
        const cat = getStatusCategory(field.fcp.value, 'FCP');
        tdFcp.innerHTML = `
          <div class="metric-val-cell">
            <span class="metric-val" style="color: var(--color-${cat});">${(field.fcp.value / 1000).toFixed(2)}s</span>
            <span class="metric-cat">${cat}</span>
          </div>
        `;
      } else {
        tdFcp.innerHTML = '<span style="color:var(--text-muted);">-</span>';
      }
      tr.appendChild(tdFcp);

      // Lighthouse Performance Score
      const tdLab = document.createElement('td');
      if (lab.performanceScore !== null) {
        const score = lab.performanceScore;
        const cat = getStatusCategory(score, 'SCORE');
        tdLab.innerHTML = `<span class="lighthouse-score-badge ${cat}">${score}</span>`;
      } else {
        tdLab.innerHTML = '<span style="color:var(--text-muted);">-</span>';
      }
      tr.appendChild(tdLab);
    }
    
    els.resultsTableBody.appendChild(tr);

    // Expandable Drawer row
    if (task.status === 'completed' && state.expandedRows.has(task.id)) {
      const detailTr = document.createElement('tr');
      detailTr.className = 'detail-row';
      
      const detailTd = document.createElement('td');
      detailTd.className = 'detail-cell';
      detailTd.colSpan = 9;
      
      const pagespeedUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(task.url)}&form_factor=${task.strategy}`;
      
      const parsedSuggestionsHtml = getDynamicPageSuggestionsHtml(task);
      
      detailTd.innerHTML = `
        <div class="detail-drawer" style="padding: 1.5rem 2rem; border-bottom: 2px solid var(--border-color); background-color: rgba(99, 102, 241, 0.005);">
          <!-- Drawer Header with Direct Link -->
          <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.875rem; margin-bottom: 1.25rem; flex-wrap: wrap; gap: 0.75rem;">
            <div class="drawer-title" style="margin-bottom: 0; display: flex; align-items: center; gap: 0.5rem;">
              <span>🛠️ Core Web Vitals Diagnostic Recommendations &amp; Audit Fixes</span>
            </div>
            <a href="${pagespeedUrl}" target="_blank" rel="noopener noreferrer" class="btn-secondary" style="width: auto; padding: 0.5rem 1rem; font-size: 0.78rem; font-weight: 600; height: auto; text-decoration: none; display: inline-flex; align-items: center; gap: 0.4rem; margin: 0; color: var(--primary); border-color: var(--primary); background-color: var(--primary-light); transition: all 0.2s ease;">
              <span>🔍 View full live audit on PageSpeed Insights ↗</span>
            </a>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            ${parsedSuggestionsHtml}
          </div>
        </div>
      `;
      
      detailTr.appendChild(detailTd);
      els.resultsTableBody.appendChild(detailTr);
    }
  }
}

// CSS keyframe injection for pulse animation in browser
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
`;
document.head.appendChild(styleSheet);

// ExcelJS Generator Engine
async function exportToExcel(customFilename) {
  log('Starting Excel workbook generation...', 'info');
  
  const completedTasks = state.tasks.filter(t => t.status === 'completed');
  if (completedTasks.length === 0) {
    alert('No completed audit results to export.');
    return;
  }

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Core Web Vitals Bulk Checker';
    workbook.created = new Date();

    // 1. DASHBOARD SUMMARY TAB
    const dashSheet = workbook.addWorksheet('Executive Summary');
    dashSheet.views = [{ showGridLines: true }];

    // Set Column Widths for Dashboard
    dashSheet.getColumn(1).width = 4;
    dashSheet.getColumn(2).width = 24;
    dashSheet.getColumn(3).width = 20;
    dashSheet.getColumn(4).width = 20;
    dashSheet.getColumn(5).width = 20;

    // Title Title block
    dashSheet.mergeCells('B2:E2');
    const titleCell = dashSheet.getCell('B2');
    titleCell.value = 'Core Web Vitals Executive Audit Report';
    titleCell.font = { name: 'Arial', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F51B5' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dashSheet.getRow(2).height = 40;

    // Metadata Row
    dashSheet.getCell('B4').value = 'Date of Audit:';
    dashSheet.getCell('B4').font = { bold: true };
    dashSheet.getCell('C4').value = new Date().toLocaleString();
    
    dashSheet.getCell('B5').value = 'Total Checked:';
    dashSheet.getCell('B5').font = { bold: true };
    dashSheet.getCell('C5').value = completedTasks.length;

    // Aggregates Box
    const passingCount = completedTasks.filter(t => {
      const field = t.metrics?.field;
      if (!field) return false;
      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;
      if (!hasLcp && !hasCls && !hasInp && !hasFid) return false;
      
      let passed = true;
      if (hasLcp && field.lcp.value > 2500) passed = false;
      if (hasCls && field.cls.value > 0.10) passed = false;
      if (hasInp && field.inp.value > 200) passed = false;
      else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
      return passed;
    }).length;
    const passPercentage = Math.round((passingCount / completedTasks.length) * 100);

    dashSheet.getCell('B6').value = 'Core Web Vitals Pass Rate:';
    dashSheet.getCell('B6').font = { bold: true };
    dashSheet.getCell('C6').value = `${passPercentage}%`;
    dashSheet.getCell('C6').font = {
      bold: true,
      color: { argb: passPercentage >= 90 ? 'FF137333' : (passPercentage >= 50 ? 'FFB06000' : 'FFC5221F') }
    };

    // Thresholds Definition Table Header
    dashSheet.getCell('B9').value = 'Google Official Metric Performance Thresholds';
    dashSheet.getCell('B9').font = { size: 12, bold: true };
    dashSheet.mergeCells('B9:E9');
    
    const thRow = dashSheet.getRow(10);
    thRow.values = ['', 'Metric Name', 'Good (Pass)', 'Needs Improvement', 'Poor (Fail)'];
    thRow.font = { bold: true };
    
    const metricDefs = [
      ['Largest Contentful Paint (LCP)', '≤ 2.5s', '2.5s - 4.0s', '> 4.0s'],
      ['Interaction to Next Paint (INP)', '≤ 200ms', '200ms - 500ms', '> 500ms'],
      ['Cumulative Layout Shift (CLS)', '≤ 0.10', '0.10 - 0.25', '> 0.25'],
      ['First Contentful Paint (FCP)', '≤ 1.8s', '1.8s - 3.0s', '> 3.0s'],
      ['Lighthouse Performance Score', '90 - 100', '50 - 89', '< 50']
    ];

    metricDefs.forEach((def, index) => {
      const row = dashSheet.getRow(11 + index);
      row.values = ['', ...def];
      
      // Color-code the boxes for demonstration
      const cGood = row.getCell(3);
      cGood.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
      cGood.font = { color: { argb: 'FF137333' }, bold: true };
      cGood.alignment = { horizontal: 'center' };

      const cNI = row.getCell(4);
      cNI.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
      cNI.font = { color: { argb: 'FFB06000' }, bold: true };
      cNI.alignment = { horizontal: 'center' };

      const cPoor = row.getCell(5);
      cPoor.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
      cPoor.font = { color: { argb: 'FFC5221F' }, bold: true };
      cPoor.alignment = { horizontal: 'center' };
    });

    // Thin borders around thresholds table
    for (let r = 10; r <= 15; r++) {
      for (let c = 2; c <= 5; c++) {
        dashSheet.getCell(r, c).border = {
          top: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          left: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          bottom: { style: 'thin', color: { argb: 'FFB0BEC5' } },
          right: { style: 'thin', color: { argb: 'FFB0BEC5' } }
        };
      }
    }


    // 2. DETAILED RESULTS TAB
    const dataSheet = workbook.addWorksheet('Core Web Vitals Audit');
    dataSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];

    // Column mapping and header keys
    const headers = [
      { header: 'Target URL', key: 'url', width: 35 },
      { header: 'Device', key: 'strategy', width: 12 },
      { header: 'Field CWV Status', key: 'fieldAssessment', width: 22 },
      { header: 'PageSpeed Insights Link', key: 'pagespeedLink', width: 45 },
      { header: 'Field LCP (s)', key: 'fieldLcp', width: 14 },
      { header: 'Field INP (ms)', key: 'fieldInp', width: 15 },
      { header: 'Field CLS', key: 'fieldCls', width: 12 },
      { header: 'Field FCP (s)', key: 'fieldFcp', width: 14 },
      { header: 'Field FID (ms)', key: 'fieldFid', width: 14 },
      { header: 'Lab Performance Score', key: 'labScore', width: 22 },
      { header: 'Lab LCP (s)', key: 'labLcp', width: 14 },
      { header: 'Lab TBT (ms)', key: 'labTbt', width: 14 },
      { header: 'Lab CLS', key: 'labCls', width: 12 },
      { header: 'Lab FCP (s)', key: 'labFcp', width: 14 },
      { header: 'Lab Speed Index (s)', key: 'labSpeedIndex', width: 18 }
    ];
    dataSheet.columns = headers;

    // Style Header Row
    const headerRow = dataSheet.getRow(1);
    headerRow.height = 28;
    headerRow.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1A237E' } // Dark royal blue header
      };
      cell.border = {
        bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFECEFF1' } }
      };
    });

    // Write Data Rows
    completedTasks.forEach((task) => {
      const field = task.metrics.field;
      const lab = task.metrics.lab;

      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;

      let fieldCwvStatus = 'NO DATA';
      if (!hasLcp && !hasCls && !hasInp && !hasFid) {
        fieldCwvStatus = 'NO DATA';
      } else {
        let passed = true;
        if (hasLcp && field.lcp.value > 2500) passed = false;
        if (hasCls && field.cls.value > 0.10) passed = false;
        if (hasInp && field.inp.value > 200) passed = false;
        else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
        
        fieldCwvStatus = passed ? 'PASSED' : 'FAILED';
      }

      const pagespeedUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(task.url)}&form_factor=${task.strategy}`;

      const rowValues = {
        url: task.url,
        strategy: task.strategy.toUpperCase(),
        fieldAssessment: fieldCwvStatus,
        pagespeedLink: {
          text: pagespeedUrl,
          hyperlink: pagespeedUrl
        },
        fieldLcp: field.lcp ? field.lcp.value / 1000 : null,
        fieldInp: field.inp ? field.inp.value : null,
        fieldCls: field.cls ? field.cls.value : null,
        fieldFcp: field.fcp ? field.fcp.value / 1000 : null,
        fieldFid: field.fid ? field.fid.value : null,
        labScore: lab.performanceScore,
        labLcp: lab.lcp ? lab.lcp / 1000 : null,
        labTbt: lab.tbt,
        labCls: lab.cls,
        labFcp: lab.fcp ? lab.fcp / 1000 : null,
        labSpeedIndex: lab.speedIndex ? lab.speedIndex / 1000 : null
      };

      const row = dataSheet.addRow(rowValues);
      row.height = 22;
      row.alignment = { vertical: 'middle' };
      
      // Formatting and alignments
      row.getCell('url').alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell('strategy').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('fieldAssessment').alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell('pagespeedLink').alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell('pagespeedLink').font = { color: { argb: 'FF0000FF' }, underline: true };
      row.getCell('labScore').alignment = { horizontal: 'center', vertical: 'middle' };

      // Set decimal/number formats
      ['fieldLcp', 'fieldFcp', 'labLcp', 'labFcp', 'labSpeedIndex'].forEach(key => {
        row.getCell(key).numFmt = '0.00';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });
      ['fieldInp', 'fieldFid', 'labTbt'].forEach(key => {
        row.getCell(key).numFmt = '#,##0';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });
      ['fieldCls', 'labCls'].forEach(key => {
        row.getCell(key).numFmt = '0.000';
        row.getCell(key).alignment = { horizontal: 'right', vertical: 'middle' };
      });

      // Color Palette helper inside excel
      const applyExcelCellStyles = (cell, cat) => {
        if (cat === 'good') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
          cell.font = { color: { argb: 'FF137333' }, bold: true };
        } else if (cat === 'needs-improvement') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
          cell.font = { color: { argb: 'FFB06000' }, bold: true };
        } else if (cat === 'poor') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
          cell.font = { color: { argb: 'FFC5221F' }, bold: true };
        }
      };

      // 1. Overall assessment cell color
      const assessmentCell = row.getCell('fieldAssessment');
      if (fieldCwvStatus === 'PASSED') {
        applyExcelCellStyles(assessmentCell, 'good');
      } else if (fieldCwvStatus === 'FAILED') {
        applyExcelCellStyles(assessmentCell, 'poor');
      } else {
        assessmentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        assessmentCell.font = { color: { argb: 'FF757575' }, bold: true, size: 9 };
      }

      // 2. Field LCP color
      if (field.lcp) {
        applyExcelCellStyles(row.getCell('fieldLcp'), getStatusCategory(field.lcp.value, 'LCP'));
      }
      // 3. Field INP color
      if (field.inp) {
        applyExcelCellStyles(row.getCell('fieldInp'), getStatusCategory(field.inp.value, 'INP'));
      }
      // 4. Field CLS color
      if (field.cls) {
        applyExcelCellStyles(row.getCell('fieldCls'), getStatusCategory(field.cls.value, 'CLS'));
      }
      // 5. Field FCP color
      if (field.fcp) {
        applyExcelCellStyles(row.getCell('fieldFcp'), getStatusCategory(field.fcp.value, 'FCP'));
      }
      // 6. Field FID color
      if (field.fid) {
        applyExcelCellStyles(row.getCell('fieldFid'), getStatusCategory(field.fid.value, 'FID'));
      }
      // 7. Lab score color
      if (lab.performanceScore !== null) {
        applyExcelCellStyles(row.getCell('labScore'), getStatusCategory(lab.performanceScore, 'SCORE'));
      }

      // Add borders to each data cell
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
        };
      });
    });

    // Auto-fit column widths logically based on content length
    dataSheet.columns.forEach((column) => {
      let maxLen = column.header.length;
      column.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.value) {
          const cellLen = cell.value.toString().length;
          if (cellLen > maxLen) {
            maxLen = cellLen;
          }
        }
      });
      // Cap at 45 characters, add padding of 4
      column.width = Math.min(Math.max(maxLen + 4, 12), 45);
    });

    // Enable Autofilters on full data range
    dataSheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: completedTasks.length + 1, column: headers.length }
    };

    // Save/write the spreadsheet to browser download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    
    // Sanitize filename to ensure compatibility across OS platforms
    const sanitizeFilename = (name) => {
      if (typeof name !== 'string') name = String(name);
      return name.replace(/[^a-z0-9_\-\s]/gi, '_').trim();
    };
    const runName = (typeof customFilename === 'string' && customFilename) || els.runNameInput.value.trim() || 'core-web-vitals-audit';
    const filename = `${sanitizeFilename(runName)}.xlsx`;

    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    log('Excel workbook exported successfully.', 'info');
  } catch (error) {
    log(`Excel generation failed: ${error.message}`, 'error');
    console.error(error);
  }
}

els.exportExcelBtn.addEventListener('click', () => exportToExcel());

// Theme Switcher Logic
els.themeToggleInput.addEventListener('change', (e) => {
  if (e.target.checked) {
    document.body.classList.remove('light-theme');
    els.themeToggleText.textContent = 'Dark UI Mode';
  } else {
    document.body.classList.add('light-theme');
    els.themeToggleText.textContent = 'Light UI Mode';
  }
});

// Initialization
initConfig();
renderTable();
loadHistory();
