/**
 * CLI Core Web Vitals Checker & Excel Generator
 * Runs in Node.js, queries Google PageSpeed Insights API with a fallback to local Lighthouse CLI.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ExcelJS = require('exceljs');

const TARGET_URL = 'https://example.com';
const OUTPUT_FILE = path.join(__dirname, 'website-web-vitals.xlsx');

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
  console.log(`[PSI API] Requesting PageSpeed Insights API for [${strategy.toUpperCase()}] ${url}...`);
  
  const response = await fetch(endpoint);
  if (!response.ok) {
    const errorJson = await response.json().catch(() => ({}));
    const errorMsg = errorJson?.error?.message || `HTTP error! Status: ${response.status}`;
    throw new Error(errorMsg);
  }
  
  const data = await response.json();
  return parsePsiResponse(data);
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

// Fallback: Run Lighthouse CLI programmatically on the local machine
function runLocalLighthouse(url, strategy) {
  const tempFile = path.join(__dirname, `lh-temp-${strategy}.json`);
  const presetFlag = strategy === 'desktop' ? '--preset=desktop' : '';
  const cmd = `npx lighthouse "${url}" --output=json --output-path="${tempFile}" --chrome-flags="--headless" ${presetFlag} --quiet`;
  
  if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 1000) {
    console.log(`[LIGHTHOUSE FALLBACK] Found existing temporary report file for [${strategy.toUpperCase()}]: ${tempFile}. Skipping audit run and parsing directly.`);
  } else {
    console.log(`[LIGHTHOUSE FALLBACK] Running local Lighthouse audit for [${strategy.toUpperCase()}] strategy. This runs a headless Chrome test...`);
    console.log(`[LIGHTHOUSE FALLBACK] Executing command: ${cmd}`);
    
    try {
      execSync(cmd, { stdio: 'inherit' });
    } catch (err) {
      if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 1000) {
        console.log(`[LIGHTHOUSE FALLBACK WARNING] execSync failed, but temporary report file was created. Proceeding with parse...`);
      } else {
        console.error(`[LIGHTHOUSE FALLBACK ERROR] Local Lighthouse run failed:`, err.message);
        throw err;
      }
    }
  }
  
  const reportData = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    
    // Parse the Lighthouse JSON file
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
    
    // Field data is not available locally
    const field = {
      assessment: 'Quota Limit Exceeded (Field data requires API key)',
      isOriginFallback: false,
      lcp: null,
      inp: null,
      cls: null,
      fcp: null,
      fid: null
    };
    
    return { field, lab };
}

async function run() {
  console.log(`[START] Initiating Core Web Vitals Audit for ${TARGET_URL}`);
  
  const results = [];
  const strategies = ['mobile', 'desktop'];
  
  for (const strategy of strategies) {
    let success = false;
    
    // Try PageSpeed Insights API first
    try {
      const parsedData = await fetchPsiData(TARGET_URL, strategy);
      results.push({
        url: TARGET_URL,
        strategy,
        status: 'completed',
        metrics: parsedData,
        source: 'PageSpeed Insights API'
      });
      console.log(`[SUCCESS] Retrieved data for [${strategy.toUpperCase()}] strategy using PageSpeed Insights API.`);
      success = true;
    } catch (error) {
      console.warn(`[WARNING] PageSpeed Insights API failed for ${strategy}: ${error.message}`);
      console.log(`[INFO] Attempting fallback to local Lighthouse CLI audit...`);
    }
    
    // Fallback to local Lighthouse CLI if API failed
    if (!success) {
      try {
        const parsedData = runLocalLighthouse(TARGET_URL, strategy);
        results.push({
          url: TARGET_URL,
          strategy,
          status: 'completed',
          metrics: parsedData,
          source: 'Local Lighthouse CLI'
        });
        console.log(`[SUCCESS] Retrieved data for [${strategy.toUpperCase()}] strategy using local Lighthouse CLI.`);
        success = true;
      } catch (lhError) {
        console.error(`[ERROR] Both PSI API and local Lighthouse failed for ${strategy}.`);
        results.push({
          url: TARGET_URL,
          strategy,
          status: 'failed',
          error: `API error: ${lhError.message}`
        });
      }
    }
  }

  const completed = results.filter(r => r.status === 'completed');
  if (completed.length === 0) {
    console.error('[FATAL] Failed to retrieve any valid data. Excel sheet will not be generated.');
    process.exit(1);
  }

  console.log(`[EXCEL] Creating workbook...`);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Core Web Vitals Bulk CLI';
  workbook.created = new Date();

  // Tab 1: Executive Summary
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

  dashSheet.getCell('B4').value = 'Target Website:';
  dashSheet.getCell('B4').font = { bold: true };
  dashSheet.getCell('C4').value = TARGET_URL;
  dashSheet.getCell('C4').font = { bold: true, color: { argb: 'FF3F51B5' } };

  dashSheet.getCell('B5').value = 'Date of Audit:';
  dashSheet.getCell('B5').font = { bold: true };
  dashSheet.getCell('C5').value = new Date().toLocaleString();

  dashSheet.getCell('B6').value = 'Data Source(s):';
  dashSheet.getCell('B6').font = { bold: true };
  dashSheet.getCell('C6').value = completed.map(c => `${c.strategy.toUpperCase()}: ${c.source}`).join(', ');

  // Metrics thresholds title
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

  // Tab 2: Detailed Performance Data
  const dataSheet = workbook.addWorksheet('Core Web Vitals Audit');
  dataSheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: true }];

  const headers = [
    { header: 'Target URL', key: 'url', width: 30 },
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

  completed.forEach((item) => {
    const field = item.metrics.field;
    const lab = item.metrics.lab;

    const isLhFallback = item.source === 'Local Lighthouse CLI';
    const fieldCwvStatus = isLhFallback 
      ? 'Requires API Key' 
      : (field.assessment.toUpperCase() === 'PASSED' || field.assessment.toUpperCase() === 'FAST' ? 'PASSED' : 'FAILED');

    const pagespeedUrl = `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(item.url)}&form_factor=${item.strategy}`;

    const rowValues = {
      url: item.url,
      strategy: item.strategy.toUpperCase(),
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

    row.getCell('url').alignment = { horizontal: 'left' };
    row.getCell('strategy').alignment = { horizontal: 'center' };
    row.getCell('fieldAssessment').alignment = { horizontal: 'center' };
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
    if (fieldCwvStatus === 'PASSED') {
      applyExcelCellStyles(assessmentCell, 'good');
    } else if (fieldCwvStatus === 'FAILED') {
      applyExcelCellStyles(assessmentCell, 'poor');
    } else {
      assessmentCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF7E0' } };
      assessmentCell.font = { color: { argb: 'FFB06000' }, bold: true, size: 9 };
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
    to: { row: completed.length + 1, column: headers.length }
  };

  console.log(`[EXCEL] Writing workbook to file: ${OUTPUT_FILE}`);
  await workbook.xlsx.writeFile(OUTPUT_FILE);
  console.log(`[SUCCESS] Excel report successfully generated and saved!`);

  // Final cleanup of temporary files
  ['mobile', 'desktop'].forEach(strategy => {
    const tempFile = path.join(__dirname, `lh-temp-${strategy}.json`);
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
        console.log(`[CLEANUP] Deleted temporary file: ${tempFile}`);
      } catch (e) {
        // ignore cleanup errors
      }
    }
  });
}

run().catch(err => {
  console.error('[FATAL] Process encountered an unhandled error:', err);
  process.exit(1);
});
