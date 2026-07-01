/**
 * Bulk Core Web Vitals Checker & Excel Generator CLI
 * Reads a list of URLs from a text file, performs concurrent performance audits (API with local Lighthouse fallback),
 * and generates a beautifully formatted Excel report.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');

// Bypass self-signed SSL certificate validations (common in corporate proxies)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Parse Arguments
const args = process.argv.slice(2);
const apiKeyArg = args.find(arg => arg.startsWith('--key='));
const apiKey = apiKeyArg ? apiKeyArg.split('=')[1] : null;

const strategyArg = args.find(arg => arg.startsWith('--strategy='));
const selectedStrategy = strategyArg ? strategyArg.split('=')[1].toLowerCase() : 'both'; // 'both', 'mobile', 'desktop'

const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='));
// Safe defaults: 2 concurrent workers for local Lighthouse CLI, 5 for PSI API
const defaultConcurrency = apiKey ? 4 : 2;
const concurrency = concurrencyArg ? parseInt(concurrencyArg.split('=')[1], 10) : defaultConcurrency;

const sitemapArg = args.find(arg => arg.startsWith('--sitemap='));
const sitemapPathOrUrl = sitemapArg ? sitemapArg.split('=')[1] : null;

const INPUT_FILE = path.join(__dirname, 'urls.txt');
const OUTPUT_FILE = path.join(__dirname, 'bulk-web-vitals-report.xlsx');

async function parseSitemapNode(pathOrUrl) {
  let xmlString = '';
  
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    console.log(`[SITEMAP] Fetching online sitemap from: ${pathOrUrl}...`);
    let attempts = 2;
    while (attempts > 0) {
      try {
        const response = await fetch(pathOrUrl);
        if (!response.ok) {
          throw new Error(`HTTP status ${response.status}`);
        }
        xmlString = await response.text();
        break;
      } catch (err) {
        attempts--;
        if (attempts === 0) throw err;
        console.warn(`[SITEMAP RETRY] Temporary issue fetching sitemap: ${err.message}. Retrying in 1.5s...`);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  } else {
    console.log(`[SITEMAP] Reading local sitemap file from: ${pathOrUrl}...`);
    xmlString = fs.readFileSync(pathOrUrl, 'utf8');
  }

  // Robust parsing: use a regex to grab all <loc> values
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

const THRESHOLDS = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  FCP: { good: 1800, poor: 3000 },
  FID: { good: 100, poor: 300 },
  SCORE: { good: 90, poor: 50 }
};

function getStatusCategory(val, metric) {
  if (val === undefined || val === null) return 'unknown';
  const limits = THRESHOLDS[metric];
  if (!limits) return 'unknown';
  
  if (metric === 'CLS') {
    if (val <= limits.good) return 'good';
    if (val <= limits.poor) return 'needs-improvement';
    return 'poor';
  } else {
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

async function fetchPsiData(url, strategy) {
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance`;
  let fetchUrl = endpoint;
  if (apiKey) {
    fetchUrl += `&key=${encodeURIComponent(apiKey)}`;
  }
  
  let attempts = 2;
  while (attempts > 0) {
    try {
      const response = await fetch(fetchUrl);
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        const errorMsg = errorJson?.error?.message || `HTTP error! Status: ${response.status}`;
        throw new Error(errorMsg);
      }
      
      const data = await response.json();
      return parsePsiResponse(data);
    } catch (err) {
      attempts--;
      if (attempts === 0) throw err;
      console.log(`[API RETRY] Temporary network issue for ${url} (${strategy}): ${err.message}. Retrying in 1.5s...`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

function parsePsiResponse(data) {
  const fExperience = data.loadingExperience || {};
  const originExperience = data.originLoadingExperience || {};
  
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
    fid: getFieldMetric('FIRST_INPUT_DELAY_MS')
  };

  if (field.cls) {
    field.cls.value = field.cls.value / 100;
  }

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
    tti: getLabMetric('interactive')
  };

  return { field, lab };
}

// Spawns local headless Chrome Lighthouse evaluation
function runLocalLighthouse(url, strategy, id) {
  const tempFile = path.join(__dirname, `lh-temp-bulk-${id}-${strategy}.json`);
  const presetFlag = strategy === 'desktop' ? '--preset=desktop' : '';
  const cmd = `npx -y lighthouse "${url}" --output=json --output-path="${tempFile}" --chrome-flags="--headless --disable-gpu --disable-software-rasterizer" ${presetFlag} --quiet`;
  
  try {
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 1000) {
      console.log(`[CACHE] Found existing temp JSON report for ${url} [${strategy.toUpperCase()}]. Parsing directly...`);
    } else {
      console.log(`[LIGHTHOUSE] Spawning headless Chrome audit for [${strategy.toUpperCase()}] ${url}...`);
      execSync(cmd, { stdio: 'ignore' }); // ignore stdout/stderr logging to keep console clean
    }

    if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 1000) {
      throw new Error(`Headless report generation failed.`);
    }
    
    const reportData = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    
    // Parse lab vitals
    const audits = reportData.audits || {};
    const categories = reportData.categories || {};
    
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
      tti: getLabMetric('interactive')
    };
    
    const field = {
      assessment: 'Requires API Key',
      isOriginFallback: false,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      fid: null
    };
    
    return { field, lab, tempFile };
  } catch (err) {
    // If command failed but JSON report was written (EPERM cleanup race condition on Windows)
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 1000) {
      console.log(`[LIGHTHOUSE WARNING] Chrome cleanup warned, but temp file is valid. Parsing report...`);
      const reportData = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
      const audits = reportData.audits || {};
      const categories = reportData.categories || {};
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
        tti: getLabMetric('interactive')
      };
      
      const field = {
        assessment: 'Requires API Key',
        isOriginFallback: false,
        lcp: null,
        inp: null,
        cls: null,
        fcp: null,
        fid: null
      };
      return { field, lab, tempFile };
    }
    throw err;
  }
}

async function main() {
  let urls = [];

  if (sitemapPathOrUrl) {
    try {
      urls = await parseSitemapNode(sitemapPathOrUrl);
      console.log(`[SITEMAP] Successfully extracted ${urls.length} URLs from sitemap.`);
    } catch (err) {
      console.error(`[FATAL] Failed to load sitemap: ${err.message}`);
      process.exit(1);
    }
  } else {
    if (!fs.existsSync(INPUT_FILE)) {
      console.error(`[FATAL] Input file not found: ${INPUT_FILE}`);
      process.exit(1);
    }

    urls = fs.readFileSync(INPUT_FILE, 'utf8')
             .split(/[\r\n]+/)
             .map(url => url.trim())
             .filter(url => url.startsWith('http://') || url.startsWith('https://'));
  }

  if (urls.length === 0) {
    console.error(`[FATAL] No valid URLs found to process.`);
    process.exit(1);
  }

  const strategies = selectedStrategy === 'both' ? ['mobile', 'desktop'] : [selectedStrategy];
  const queue = [];
  let id = 0;
  
  for (const url of urls) {
    for (const strategy of strategies) {
      queue.push({
        id: id++,
        url,
        strategy,
        status: 'pending',
        metrics: null,
        source: '',
        error: null,
        tempFile: null
      });
    }
  }

  console.log(`[START] Initiating bulk audit for ${urls.length} URLs across strategies: [${strategies.join(', ').toUpperCase()}]`);
  console.log(`[CONFIG] Concurrency: ${concurrency} workers. API Key: ${apiKey ? 'Provided' : 'None (using Lighthouse local fallback)'}`);

  let completedCount = 0;
  const totalTasks = queue.length;

  const worker = async () => {
    while (true) {
      const task = queue.find(t => t.status === 'pending');
      if (!task) break;

      task.status = 'running';
      const progress = `[${++completedCount}/${totalTasks}]`;
      console.log(`${progress} Starting [${task.strategy.toUpperCase()}] ${task.url}...`);

      let success = false;

      // 1. Try PSI API first
      try {
        const metrics = await fetchPsiData(task.url, task.strategy);
        task.status = 'completed';
        task.metrics = metrics;
        task.source = 'PageSpeed Insights API';
        success = true;
        console.log(`[API SUCCESS] Audited [${task.strategy.toUpperCase()}] ${task.url}`);
      } catch (err) {
        if (!apiKey) {
          // Keyless PSI API is rate-limited
          // Silence the heavy error output to keep bulk runs readable
        } else {
          console.warn(`[API WARNING] API failed for ${task.url} (${task.strategy}): ${err.message}`);
        }
      }

      // 2. Try local Lighthouse fallback
      if (!success) {
        try {
          const { field, lab, tempFile } = runLocalLighthouse(task.url, task.strategy, task.id);
          task.status = 'completed';
          task.metrics = { field, lab };
          task.source = 'Local Lighthouse CLI';
          task.tempFile = tempFile;
          console.log(`[LOCAL SUCCESS] Audited [${task.strategy.toUpperCase()}] ${task.url}`);
        } catch (err) {
          task.status = 'failed';
          task.error = err.message;
          console.error(`[AUDIT FAILED] Failed [${task.strategy.toUpperCase()}] ${task.url}: ${err.message}`);
        }
      }
    }
  };

  // Launch workers
  const workers = [];
  const workerCount = Math.min(concurrency, queue.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  const completedTasks = queue.filter(t => t.status === 'completed');
  console.log(`\n[COMPLETE] Audit run finished. Success: ${completedTasks.length}/${totalTasks}`);

  if (completedTasks.length === 0) {
    console.error('[FATAL] No valid data retrieved. Excel workbook will not be created.');
    process.exit(1);
  }

  // Generate Excel report
  console.log(`[EXCEL] Building workbook: ${OUTPUT_FILE}...`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Bulk Core Web Vitals CLI';
  workbook.created = new Date();

  // Sheet 1: Dashboard
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

  const apiCount = completedTasks.filter(t => t.source === 'PageSpeed Insights API').length;
  const localCount = completedTasks.filter(t => t.source === 'Local Lighthouse CLI').length;
  dashSheet.getCell('B6').value = 'Sources Utilized:';
  dashSheet.getCell('B6').font = { bold: true };
  dashSheet.getCell('C6').value = `${apiCount} via API, ${localCount} via Local Chrome`;

  // Aggregate stats table
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

  // Sheet 2: Data Details
  const dataSheet = workbook.addWorksheet('Core Web Vitals Audit');
  dataSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];

  const headers = [
    { header: 'Target URL', key: 'url', width: 35 },
    { header: 'Device', key: 'strategy', width: 12 },
    { header: 'Field CWV Status', key: 'fieldAssessment', width: 22 },
    { header: 'Data Level', key: 'dataLevel', width: 14 },
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
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1A237E' }
    };
    cell.border = {
      bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } },
      right: { style: 'thin', color: { argb: 'FFECEFF1' } }
    };
  });

  completedTasks.forEach((item) => {
    const field = item.metrics.field;
    const lab = item.metrics.lab;

    const isLhFallback = item.source === 'Local Lighthouse CLI';
    let fieldCwvStatus = 'NO DATA';
    let dataLevelStatus = 'N/A';

    if (isLhFallback) {
      fieldCwvStatus = 'Requires API Key';
    } else {
      dataLevelStatus = field.isOriginFallback ? 'Origin' : 'URL';
      
      const hasLcp = field.lcp !== null && field.lcp !== undefined;
      const hasCls = field.cls !== null && field.cls !== undefined;
      const hasInp = field.inp !== null && field.inp !== undefined;
      const hasFid = field.fid !== null && field.fid !== undefined;
      
      if (!hasLcp && !hasCls && !hasInp && !hasFid) {
        fieldCwvStatus = 'NO DATA';
        dataLevelStatus = 'N/A';
      } else {
        let passed = true;
        if (hasLcp && field.lcp.value > 2500) passed = false;
        if (hasCls && field.cls.value > 0.10) passed = false;
        if (hasInp && field.inp.value > 200) passed = false;
        else if (!hasInp && hasFid && field.fid.value > 100) passed = false;
        
        fieldCwvStatus = passed ? 'PASSED' : 'FAILED';
      }
    }

    const pagespeedUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(item.url)}&form_factor=${item.strategy}`;

    const rowValues = {
      url: item.url,
      strategy: item.strategy.toUpperCase(),
      fieldAssessment: fieldCwvStatus,
      dataLevel: dataLevelStatus,
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

    row.getCell('url').alignment = { horizontal: 'left' };
    row.getCell('strategy').alignment = { horizontal: 'center' };
    row.getCell('fieldAssessment').alignment = { horizontal: 'center' };
    row.getCell('dataLevel').alignment = { horizontal: 'center' };
    row.getCell('pagespeedLink').alignment = { horizontal: 'left' };
    row.getCell('pagespeedLink').font = { color: { argb: 'FF0000FF' }, underline: true };
    row.getCell('labScore').alignment = { horizontal: 'center' };

    ['fieldLcp', 'fieldFcp', 'labLcp', 'labFcp', 'labSpeedIndex'].forEach(key => {
      row.getCell(key).numFmt = '0.00';
      row.getCell(key).alignment = { horizontal: 'right' };
    });
    ['fieldInp', 'fieldFid', 'labTbt'].forEach(key => {
      row.getCell(key).numFmt = '#,##0';
      row.getCell(key).alignment = { horizontal: 'right' };
    });
    ['fieldCls', 'labCls'].forEach(key => {
      row.getCell(key).numFmt = '0.000';
      row.getCell(key).alignment = { horizontal: 'right' };
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
    if (fieldCwvStatus.startsWith('PASSED')) {
      applyExcelCellStyles(assessmentCell, 'good');
    } else if (fieldCwvStatus.startsWith('FAILED')) {
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

  const REPORT_COPY = path.join(__dirname, 'vitalpulse-field-data-report.xlsx');

  async function safeWriteFile(filePath, workbookObj) {
    try {
      await workbookObj.xlsx.writeFile(filePath);
      console.log(`[SUCCESS] Excel workbook successfully saved to: ${filePath}`);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        const parsed = path.parse(filePath);
        const now = new Date();
        const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
        const fallbackPath = path.join(parsed.dir, `${parsed.name}-${timestamp}${parsed.ext}`);
        console.warn(`[WARNING] Target file is locked or busy: ${filePath}. Saving to fallback: ${fallbackPath}`);
        await workbookObj.xlsx.writeFile(fallbackPath);
        console.log(`[SUCCESS] Excel workbook successfully saved to fallback: ${fallbackPath}`);
      } else {
        throw err;
      }
    }
  }

  await safeWriteFile(OUTPUT_FILE, workbook);
  await safeWriteFile(REPORT_COPY, workbook);

  // Clean up temp JSON files
  console.log(`[CLEANUP] Removing temporary report files...`);
  queue.forEach(task => {
    if (task.tempFile && fs.existsSync(task.tempFile)) {
      try {
        fs.unlinkSync(task.tempFile);
      } catch (e) {
        // ignore cleanup errors
      }
    }
  });
  console.log(`[CLEANUP] Complete!`);
}

main().catch(err => {
  console.error(`[FATAL] Process encountered an error:`, err);
  process.exit(1);
});
