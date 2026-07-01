# ⚡ VitalPulse — Bulk Core Web Vitals Checker & Dashboard

VitalPulse is a high-speed, local web application and CLI developer utility designed to scan, audit, track, and export bulk Core Web Vitals (CWV) data for entire websites using Google's official PageSpeed Insights API. 

It lets you perform bulk audits across all pages of your website—either by inputting lists of template URLs or loading XML sitemaps—to monitor performance metrics at scale. It aggregates real-world field metrics (Chrome UX Report / CrUX) and synthetic lab metrics (Lighthouse) into interactive, filterable dashboards and professionally formatted Excel spreadsheets.

---

## ✨ Features

- **Double Strategy Modes**:
  - 🖥️ **Interactive Web Dashboard (UI)**: Built with native CSS/JS and served locally. Includes real-time progress logging, KPI aggregate metrics, responsive paginated tables, search-friendly search inputs, and direct links to live PageSpeed reports.
  - ⚙️ **High-Speed Command Line Tool (CLI)**: Process bulk domains rapidly directly in your terminal, with adjustable worker concurrency.
- **Advanced Export Engine**: Compiles executive summary tabs, metric criteria charts, conditional formatting (Green = Passed, Red = Failed, Gray = No Data), and auto-adjusted layout widths into premium Excel workbooks (`.xlsx`).
- **High-Performance Scalable History**: Persists past runs dynamically in the local `history/` directory using single JSON documents, allowing for fast lazy-loading details and O(1) delete/export speeds.
- **Flexible Inputs**: Load audits using bulk URLs list upload (TXT/CSV/XML sitemaps) or manually.
- **Fully Customized**: Styled with custom, responsive glassmorphism dark/light visual modes and favicon icons.

---

## 🛠️ Prerequisites & Requirements

- **Node.js**: Version 18.0.0 or higher (v24+ recommended).
- **Web Browser**: Any modern web browser (Chrome, Edge, Firefox, Safari).
- **Google PageSpeed Insights API Key (Highly Recommended)**:
  - Free API keys support up to 25,000 requests/day.
  - Get a key in under a minute from the [Google Cloud Console API Library](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com).

---

## 🚀 Installation & Setup

1. **Clone or Extract the Directory**:
   Extract all contents of this package into a folder on your machine.

2. **Open Terminal or Command Prompt**:
   Navigate into the project directory:
   ```bash
   cd VitalPulse
   ```

3. **Install Dependencies**:
   Retrieve the spreadsheet layout engine (`exceljs`):
   ```bash
   npm install
   ```

---

## 💻 Running the Web Dashboard (UI)

1. **Start the Application**:
   Run the package script to start the local HTTP server:
   ```bash
   npm run start
   ```
   *(Note: If PowerShell execution policies block `.ps1` execution, start it explicitly using `cmd.exe /c npm run start` or `node server.js`).*

2. **Open the Dashboard**:
   Navigate to:
   🔗 **[http://localhost:3000/](http://localhost:3000/)**

3. **Dashboard Instructions**:
   - **Configure settings** in the left sidebar: Select device strategy (Mobile, Desktop, or Both), concurrency level, and optionally paste your API key.
   - **Input URLs**: Paste URLs (one per line) or drag-and-drop/upload a `.txt`, `.csv`, or `.xml` list file.
   - **Start the Audit**: Click **Start Bulk Audit** to watch the status update, real-time logging, and aggregates in real-time.
   - **Persistence**: Completed runs automatically save inside the local `history/` directory on the server disk. You can view, search, export to Excel, or delete them anytime in the **History Log** tab.
   - **Manual Export**: Click **Export to Excel** in the top right to download a local copy of the sheet to your browser downloads folder.

---

## ⚙️ Running the Command Line Tool (CLI)

The CLI tool processes inputs directly in the terminal, bypassing the browser dashboard and saving results directly to your disk.

### Command Structure
```bash
node bulk-cli.js --key=YOUR_API_KEY --strategy=both --concurrency=8
```

### Options:
- `--key`: Google PageSpeed Insights API Key.
- `--strategy`: Strategy to query (`both` [default], `mobile`, or `desktop`).
- `--concurrency`: Number of concurrent requests (`4` if API key is provided, `2` if keyless).
- `--sitemap`: (Optional) Feed a live sitemap URL or local sitemap XML file directly instead of `urls.txt`.
  - *Example URL sitemap scan*:
    ```bash
    node bulk-cli.js --key=YOUR_API_KEY --strategy=both --sitemap=https://example.com/sitemap.xml
    ```
  - *Example local sitemap scan*:
    ```bash
    node bulk-cli.js --key=YOUR_API_KEY --strategy=both --sitemap=sitemap.xml
    ```

If no `--sitemap` parameter is provided, the CLI tool automatically reads the target URLs from the local file `urls.txt` (one URL per line).

---

## 📁 Output Reports

Upon completion, reports are saved to your project root directory:
- **`bulk-web-vitals-report.xlsx`** (Main executive summary sheet)
- **`vitalpulse-field-data-report.xlsx`** (Secondary workbook copy)

*Note: If target files are locked (e.g. open in Microsoft Excel), the application will save to a timestamped fallback path (such as `bulk-web-vitals-report-14-30-22.xlsx`) to prevent write crashes.*

---

## 📄 License

This tool is open-source. You are free to modify, extend, and integrate it into your developer pipeline.
