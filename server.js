const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const HISTORY_DIR = path.join(__dirname, 'history');
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // API Endpoint: Get all historical run records (metadata only)
  if (req.method === 'GET' && req.url === '/api/history') {
    try {
      const files = fs.readdirSync(HISTORY_DIR);
      const history = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = fs.readFileSync(path.join(HISTORY_DIR, file), 'utf8');
            const run = JSON.parse(data);
            delete run.tasks; // Strip heavy task details for lightweight list listing
            history.push(run);
          } catch (err) {
            console.warn(`[WARNING] Failed to parse history file ${file}:`, err.message);
          }
        }
      }
      history.sort((a, b) => new Date(b.date) - new Date(a.date));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(history));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Server read error: ${err.message}`);
    }
    return;
  }

  // API Endpoint: Get details of a single historical run record
  if (req.method === 'GET' && req.url.startsWith('/api/history/details')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const runId = urlObj.searchParams.get('id');
    
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: Missing ID parameter (?id=...)');
      return;
    }
    
    const filePath = path.join(HISTORY_DIR, `${runId}.json`);
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found: Historical run details not found.');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Server read error: ${err.message}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      }
    });
    return;
  }

  // API Endpoint: Save a completed audit run to folder-based history storage
  if (req.method === 'POST' && req.url === '/api/history') {
    let body = [];
    req.on('data', (chunk) => {
      body.push(chunk);
    }).on('end', () => {
      try {
        const newRun = JSON.parse(Buffer.concat(body).toString());
        if (!newRun.id) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request: Missing ID in payload');
          return;
        }
        
        const filePath = path.join(HISTORY_DIR, `${newRun.id}.json`);
        fs.writeFile(filePath, JSON.stringify(newRun, null, 2), 'utf8', (writeErr) => {
          if (writeErr) {
             res.writeHead(500, { 'Content-Type': 'text/plain' });
             res.end(`Server write error: ${writeErr.message}`);
          } else {
             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ success: true }));
          }
        });
      } catch (parseErr) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Bad Request: Invalid JSON payload: ${parseErr.message}`);
      }
    });
    return;
  }

  // API Endpoint: Delete a historical run record by ID
  if (req.method === 'DELETE' && req.url.startsWith('/api/history')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const deleteId = urlObj.searchParams.get('id');
    
    if (!deleteId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request: Missing ID parameter (?id=...)');
      return;
    }
    
    const filePath = path.join(HISTORY_DIR, `${deleteId}.json`);
    fs.unlink(filePath, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found: Run ID not found in history.');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Server error deleting history file: ${err.message}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      }
    });
    return;
  }

  // API Endpoint: Auto-save excel reports from browser UI to local server disk
  if (req.method === 'POST' && req.url === '/api/save-results') {
    let body = [];
    req.on('data', (chunk) => {
      body.push(chunk);
    }).on('end', () => {
      const buffer = Buffer.concat(body);
      const defaultPath1 = path.join(__dirname, 'bulk-web-vitals-report.xlsx');
      const defaultPath2 = path.join(__dirname, 'vitalpulse-field-data-report.xlsx');

      try {
        fs.writeFileSync(defaultPath1, buffer);
        console.log(`[SERVER] Auto-saved completed scan report to: ${defaultPath1}`);
        try {
          fs.writeFileSync(defaultPath2, buffer);
          console.log(`[SERVER] Auto-saved secondary report to: ${defaultPath2}`);
        } catch (e2) {
          console.warn(`[SERVER WARNING] Failed to write secondary report: ${e2.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: defaultPath1 }));
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          const now = new Date();
          const timestamp = `${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
          const fbPath1 = path.join(__dirname, `bulk-web-vitals-report-${timestamp}.xlsx`);
          const fbPath2 = path.join(__dirname, `vitalpulse-field-data-report-${timestamp}.xlsx`);

          console.warn(`[SERVER WARNING] Target file is locked. Saving fallback: ${fbPath1}`);
          try {
            fs.writeFileSync(fbPath1, buffer);
            fs.writeFileSync(fbPath2, buffer);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, fallback: true, path: fbPath1 }));
          } catch (e3) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Fallback write error: ${e3.message}`);
          }
        } else {
          console.error('[SERVER ERROR] Failed to save report:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Server write error: ${err.message}`);
        }
      }
    });
    return;
  }

  // Normalize URL path
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Prevent directory traversal attacks
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const absolutePath = path.join(__dirname, filePath);

  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(absolutePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
