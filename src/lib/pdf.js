'use strict';
// PDF files from HTML through headless Chrome or Chromium, the engine that prints the invoice in the browser,
// so a PDF made here looks exactly like the print. On Railway, Chromium comes from railpack.json; elsewhere
// Chrome is found in its usual place, or CHROME_PATH points at it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const config = require('../config');

const PLACES = {
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
};

function chromePath() {
  return [config.chromePath, ...(PLACES[process.platform] || [])].find((p) => p && fs.existsSync(p)) || null;
}

const available = () => Boolean(chromePath());

async function render(html, timeout) {
  const chrome = chromePath();
  if (!chrome) throw Object.assign(new Error('Chrome or Chromium is not installed on this server'), { code: 'NO_CHROME' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mts-pdf-'));
  try {
    const page = path.join(dir, 'page.html');
    const out = path.join(dir, 'page.pdf');
    fs.writeFileSync(page, html);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`,
      '--no-pdf-header-footer',
      // Time for the fonts to load and the page to fit itself on one sheet before it prints.
      '--virtual-time-budget=10000',
      `--print-to-pdf=${out}`,
    ];
    // Containers run as root with a small /dev/shm.
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
    args.push(pathToFileURL(page).href);
    await new Promise((resolve, reject) => {
      execFile(chrome, args, { timeout, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    const pdf = fs.existsSync(out) ? fs.readFileSync(out) : null;
    if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Chrome finished without writing the PDF');
    return pdf;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let queue = Promise.resolve();

/** Prints a complete HTML page to a PDF Buffer. One Chrome at a time, so a long batch never runs several. */
function fromHtml(html, { timeout = 90000 } = {}) {
  const job = queue.then(() => render(html, timeout));
  queue = job.catch(() => {});
  return job;
}

module.exports = { fromHtml, available, chromePath };
