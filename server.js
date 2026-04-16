#!/usr/bin/env node
/**
 * OnDemand Auditor — Demo Build
 *
 * A standalone HTTP server that serves the Auditor UI and provides:
 *   - Mode 1: "Automated vs OD" — audit a Java test file against its Zephyr test case
 *   - Mode 3: "OD Run Results"  — browse OnDemand batch runs and drill into failures
 *   - Folder Audit              — stream LLM coverage results for all files in a folder
 *
 * MOCK_MODE (default: true)
 *   Set MOCK_MODE=true in .env to use fixture data from the mock/ folder.
 *   No external credentials required — great for demos and local exploration.
 *   Set MOCK_MODE=false and fill in all credentials to run against live systems.
 *
 * Usage:
 *   npm install
 *   node server.js
 *
 * Requires Node.js 18+
 */
'use strict';

require('dotenv').config();

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT, 10) || 3737;
const MOCK_MODE     = process.env.MOCK_MODE !== 'false';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'example-company/securepanel-automation';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const TESTS_BASE    = (process.env.TESTS_BASE_PATH || 'src/test/java/tests/panels').replace(/\/$/, '');

const ZEPHYR_BASE   = (process.env.ZEPHYR_BASE_URL || '').replace(/\/$/, '');
const ZEPHYR_KEY    = process.env.ZEPHYR_API_KEY   || '';
const ZEPHYR_PROJECT_KEY = process.env.ZEPHYR_PROJECT_KEY || 'EX';

const LLM_ENDPOINT   = (process.env.AZURE_OPENAI_ENDPOINT   || '').replace(/\/$/, '');
const LLM_API_KEY    =  process.env.AZURE_OPENAI_KEY        || '';
const LLM_DEPLOYMENT =  process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const LLM_API_VER    =  process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
const ANALYSIS_DEPLOYMENT = process.env.AZURE_OPENAI_ANALYSIS_DEPLOYMENT || LLM_DEPLOYMENT;

const OD_BASE = (process.env.OD_BASE_URL || '').replace(/\/$/, '');
const OD_USER = process.env.OD_USERNAME || '';
const OD_PASS = process.env.OD_PASSWORD || '';

const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS, 10) || 60000;
const LLM_TIMEOUT_MS  = parseInt(process.env.LLM_TIMEOUT_MS,  10) || 120000;
const OD_TIMEOUT_MS   = parseInt(process.env.OD_TIMEOUT_MS,   10) || 15000;

const MOCK_DIR = path.join(__dirname, 'mock');

// ── Logging ────────────────────────────────────────────────────────────────────

function log(tag, msg, extra = '') {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${tag.padEnd(12)} ${msg}${extra ? '  ' + extra : ''}`);
}
function logErr(tag, err) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${ts}] ${tag.padEnd(12)} ❌  ${err instanceof Error ? err.message : err}`);
}

// ── Mock helpers ───────────────────────────────────────────────────────────────

function readMock(filename) {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, filename), 'utf-8'));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function sendError(res, status, msg) {
  sendJSON(res, status, { error: msg });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── HTTPS helpers ──────────────────────────────────────────────────────────────

function httpsGetOnce(reqUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: HTTP_TIMEOUT_MS },
      res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

async function httpsGet(reqUrl, headers = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { status, headers: resHeaders, body } = await httpsGetOnce(reqUrl, headers);
    if (status === 429) {
      const wait = Math.max(5000, (parseInt(resHeaders['retry-after'] || '5', 10)) * 1000);
      log('RateLimit', `429 — waiting ${wait / 1000}s`, `attempt ${attempt + 1}/${retries + 1}`);
      await delay(wait);
      continue;
    }
    if (status >= 400) throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
    return body;
  }
  throw new Error(`HTTP 429 — still rate-limited after ${retries} retries`);
}

function httpsPost(reqUrl, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(reqUrl);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
        timeout: LLM_TIMEOUT_MS,
      },
      res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          else resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── GitHub ─────────────────────────────────────────────────────────────────────

const GH_HEADERS = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept':        'application/vnd.github.v3+json',
  'User-Agent':    'ondemand-auditor/1.0',
};

// Regex to extract a Zephyr ticket key comment from Java source
const TICKET_RE = /\/\/\s*([A-Z]{2,6}-T\d+)/;

async function fetchGitHubTree() {
  const url  = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  log('GitHub', `Fetching tree → ${GITHUB_REPO} @ ${GITHUB_BRANCH}`);
  const body = await httpsGet(url, GH_HEADERS);
  const data = JSON.parse(body);
  return data.tree
    .filter(i => i.type === 'blob' && i.path.startsWith(TESTS_BASE) && i.path.endsWith('.java'))
    .map(i => i.path);
}

async function fetchGitHubFile(filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  const url     = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encoded}?ref=${GITHUB_BRANCH}`;
  const body    = await httpsGet(url, GH_HEADERS);
  const data    = JSON.parse(body);
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
}

function buildNestedTree(filePaths) {
  const root = { children: {} };
  filePaths.forEach(p => {
    const rel   = p.slice(TESTS_BASE.length + 1);
    const parts = rel.split('/');
    let   node  = root;
    let   cumPath = TESTS_BASE;
    parts.forEach((part, i) => {
      cumPath = cumPath + '/' + part;
      if (!node.children[part]) {
        node.children[part] = i === parts.length - 1
          ? { type: 'file', name: part, filename: part, path: p, ticketKey: null, children: {} }
          : { type: 'folder', name: part, folderPath: cumPath, children: {} };
      }
      node = node.children[part];
    });
  });
  const toArray = obj =>
    Object.values(obj.children).map(n => ({
      ...n,
      children: n.type === 'folder' ? toArray(n) : undefined,
    }));
  return toArray(root);
}

// ── Zephyr ─────────────────────────────────────────────────────────────────────

const ZEPHYR_HEADERS = {
  'Authorization': `Bearer ${ZEPHYR_KEY}`,
  'Content-Type':  'application/json',
};

async function getZephyrTestCase(ticketKey) {
  const url  = `${ZEPHYR_BASE}/rest/atm/1.0/testcase/${ticketKey}`;
  const body = await httpsGet(url, ZEPHYR_HEADERS);
  return JSON.parse(body);
}

// ── HTML utilities ─────────────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function odStripTags(s) {
  return s ? s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
}

// ── Java parser ────────────────────────────────────────────────────────────────

// Extract REPORT("...") blocks from Java source — these are the automation checkpoints
// that the LLM will map to Zephyr test steps.
function parseJavaBlocks(source) {
  const blocks = [];
  const re = /REPORT\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  let m;
  let i = 0;
  while ((m = re.exec(source)) !== null) {
    const report  = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    const line    = source.slice(0, m.index).split('\n').length;
    const rawText = source.split('\n').slice(line - 1, line + 4).join('\n').trim();
    blocks.push({ index: i++, report, rawText, lineNumber: line });
  }
  return blocks;
}

// ── LLM ────────────────────────────────────────────────────────────────────────

// System prompt for Pass 1: match Java REPORT() blocks to Zephyr steps
function buildMatchPrompt(javaBlocks, zephyrSteps, userContext) {
  const blocksText = javaBlocks.map((b, i) =>
    `[JAVA-${i}] "${b.report}" (line ${b.lineNumber})`
  ).join('\n');

  const stepsText = zephyrSteps.map(s => {
    const parts = [`[STEP-${s.index}] ${s.description}`];
    if (s.automationStep) parts.push(`  Automation: ${s.automationStep}`);
    if (s.requirements?.length) parts.push(`  Requirements: ${s.requirements.join('; ')}`);
    return parts.join('\n');
  }).join('\n\n');

  // Domain knowledge placeholders — replace with your actual content for production use
  const domainContext = [
    '[WEBAPI_METHOD_MAPPING]',
    '[ENUM_VALUE_MAPPING]',
    '[CROSS_API_EQUIVALENCE]',
  ].join('\n');

  return `You are a QA coverage analyst. Match each Java automation checkpoint to the Zephyr test step it covers.

Domain knowledge:
${domainContext}
${userContext ? '\nAdditional context from reviewer:\n' + userContext : ''}

Java REPORT() blocks (automation checkpoints):
${blocksText}

Zephyr test steps:
${stepsText}

For each Java block, identify which Zephyr step it covers. Respond with a JSON array of match objects:
[
  {
    "javaIndex": 0,
    "zephyrIndex": 0,
    "status": "matched" | "warning" | "unmatched",
    "confidence": 0.0–1.0,
    "issue": null | "explanation of concern"
  }
]

Rules:
- "matched": Java block clearly covers the Zephyr step requirement
- "warning": Partial or ambiguous coverage — explain in "issue"
- "unmatched": No Java block covers this step — set javaIndex to null
- Include one entry per Zephyr step (javaIndex may be null for unmatched)
- A Java block may appear multiple times if it covers multiple steps
`;
}

async function callLLM(javaBlocks, zephyrSteps, userContext = '') {
  const prompt = buildMatchPrompt(javaBlocks, zephyrSteps, userContext);
  const url = `${LLM_ENDPOINT}/openai/deployments/${LLM_DEPLOYMENT}/chat/completions?api-version=${LLM_API_VER}`;
  const reqBody = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a precise QA coverage analyst. Always respond with valid JSON.' },
      { role: 'user',   content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  });
  const raw  = await httpsPost(url, { 'api-key': LLM_API_KEY }, reqBody);
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content || '[]';
  const parsed = JSON.parse(content);
  const matches = Array.isArray(parsed) ? parsed : (parsed.matches || []);
  return { matches };
}

// Pass 2: deep analysis for "warning" matches
async function runWarningAnalysis(report) {
  const warnings = report.matches.filter(m => m.status === 'warning' && m.issue);
  if (!warnings.length) return [];

  const warningDetail = warnings.map(m => {
    const javaBlock  = m.javaIndex !== null ? report.javaBlocks[m.javaIndex] : null;
    const zephyrStep = report.zephyrSteps.find(s => s.index === m.zephyrIndex);
    return [
      `Zephyr Step ${m.zephyrIndex}: ${zephyrStep?.description || ''}`,
      `Java Block: "${javaBlock?.report || '(none)'}"`,
      `Issue flagged: ${m.issue}`,
    ].join('\n');
  }).join('\n\n');

  const url = `${LLM_ENDPOINT}/openai/deployments/${ANALYSIS_DEPLOYMENT}/chat/completions?api-version=${LLM_API_VER}`;
  const reqBody = JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a QA test coverage analyst. Be concise and specific.' },
      {
        role: 'user',
        content: `Analyze these test coverage warnings. For each, give a verdict (true_gap / false_positive / inconclusive) and a one-sentence recommendation.\n\n${warningDetail}\n\nRespond as JSON array: [{ "zephyrIndex": N, "verdict": "...", "reasoning": "...", "recommendation": "..." }]`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });
  const raw  = await httpsPost(url, { 'api-key': LLM_API_KEY }, reqBody);
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content || '[]';
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : (parsed.analysis || []);
  } catch { return []; }
}

// Full audit pipeline: parse Java → look up Zephyr → call LLM → (optional) analysis pass
async function runAudit(javaSource, zephyrCase, userContext = '') {
  const javaBlocks = parseJavaBlocks(javaSource);
  log('Parser', `Java parsed`, `${javaBlocks.length} REPORT() blocks`);

  const rawSteps = (zephyrCase.testScript?.steps ?? []).sort((a, b) => a.index - b.index);
  const zephyrSteps = rawSteps.map((s, i) => ({
    index:          i,
    description:    stripHtml(s.description    ?? ''),
    expectedResult: stripHtml(s.expectedResult ?? ''),
    manualStep:     stripHtml(s.description    ?? ''),
    automationStep: '',
    requirements:   [],
  }));

  log('LLM', `Pass 1 (${LLM_DEPLOYMENT})`, `${javaBlocks.length} blocks → ${zephyrSteps.length} steps`);
  let matches;
  try {
    ({ matches } = await callLLM(javaBlocks, zephyrSteps, userContext));
  } catch (err) {
    logErr('LLM', err);
    matches = zephyrSteps.map(s => ({
      status: 'unmatched', javaIndex: null, zephyrIndex: s.index, confidence: 0, issue: String(err.message),
    }));
  }

  const stepStatus = {};
  matches.forEach(m => {
    if (m.zephyrIndex === null) return;
    const rank = { matched: 1, warning: 2, unmatched: 3 };
    const prev = stepStatus[m.zephyrIndex];
    if (!prev || rank[m.status] > rank[prev]) stepStatus[m.zephyrIndex] = m.status;
  });
  const summary = { matched: 0, warnings: 0, unmatched: 0 };
  zephyrSteps.forEach(s => {
    const st = stepStatus[s.index] || 'unmatched';
    if (st === 'matched')   summary.matched++;
    if (st === 'warning')   summary.warnings++;
    if (st === 'unmatched') summary.unmatched++;
  });
  log('Audit', `Complete → ${zephyrCase.key}`, `✅ ${summary.matched} matched  ⚠ ${summary.warnings} warnings  ❌ ${summary.unmatched} unmatched`);

  const report = { ticketKey: zephyrCase.key, javaBlocks, zephyrSteps, expandedFrom: [], matches, summary };

  const hasWarnings = matches.some(m => m.status === 'warning' && m.issue);
  if (hasWarnings) {
    log('LLM', `Pass 2 (${ANALYSIS_DEPLOYMENT})`, `analyzing ${matches.filter(m => m.status === 'warning').length} warnings`);
    try {
      report.analysis = await runWarningAnalysis(report);
    } catch (err) {
      logErr('Audit', `Warning analysis failed (non-fatal): ${err.message}`);
    }
  }

  return report;
}

// ── OD Portal ──────────────────────────────────────────────────────────────────

let odCookies = '';

async function odLogin() {
  if (odCookies) return;
  log('OD', 'Logging in...');
  const loginUrl = `${OD_BASE}/j_spring_security_check`;
  const formBody = `username=${encodeURIComponent(OD_USER)}&password=${encodeURIComponent(OD_PASS)}`;
  const res = await new Promise((resolve, reject) => {
    const u = new URL(loginUrl);
    const req = https.request(
      {
        hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) },
        timeout: OD_TIMEOUT_MS,
      },
      resolve
    );
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
  const setCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [];
  odCookies = setCookies.map(c => c.split(';')[0]).join('; ');
  log('OD', 'Login complete');
}

async function odFetch(odPath) {
  await odLogin();
  return httpsGet(`${OD_BASE}${odPath}`, { 'Cookie': odCookies, 'User-Agent': 'ondemand-auditor/1.0' });
}

// ── OD HTML parsers ────────────────────────────────────────────────────────────

function parseJobsHtml(html) {
  const jobs = [];
  const rowRe = /id='job_(\d+)'([\s\S]*?)(?=id='job_\d+'|<\/tbody>|<\/table>)/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const id    = m[1];
    const chunk = m[2];
    const dateM  = /(\d{4}-\d{2}-\d{2}[\s\d:]+)/.exec(chunk);
    const suiteM = /<td[^>]*lang='[^']*'[^>]*>([^<]{5,})<\/td>/i.exec(chunk);
    const percM  = /lang='(\d[\d.]*)'/i.exec(chunk);
    const status = /testFail/i.test(chunk) ? 'failed' : /testPass/i.test(chunk) ? 'passed' : 'unknown';
    const serverRe = /<td[^>]*lang='([^']+)'[^>]*>[^<]*<\/td>/gi;
    let serverVal = '';
    let sm;
    while ((sm = serverRe.exec(chunk)) !== null) {
      if (sm[1] && !/^\d/.test(sm[1])) { serverVal = sm[1]; break; }
    }
    jobs.push({
      id,
      suiteName:  suiteM ? suiteM[1].replace(/\s*\([^)]*\)\s*$/, '').trim() : `Job ${id}`,
      date:       dateM ? dateM[1].trim() : '',
      passPerc:   percM ? percM[1] + '%' : '?%',
      status,
      env:        serverVal,
      system:     '',
    });
  }
  return jobs;
}

function parseBatchesHtml(html) {
  const batches = [];
  const labels = {};
  const labelRe = /<span[^>]*id="batch-(\d+)"[^>]*>([\s\S]*?)<\/span>/gi;
  let lm;
  while ((lm = labelRe.exec(html)) !== null) {
    labels[lm[1]] = lm[2].replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const rowRe = /id='batch_id_(\d+)'\s+value='([^']+)'/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const id    = m[1];
    const batchName = m[2];
    const label = labels[id] || batchName;
    const dateM = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.exec(label);
    batches.push({
      id, batchName, batchLabel: label,
      date:  dateM ? dateM[1] : '',
      title: label.replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/, '').trim(),
    });
  }
  return batches;
}

function parseResultsHtml(html) {
  const results = [];
  const rowRe = /<tr[^>]*onclick='showFailInfo\((\d+)\)'[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const resultId = m[1];
    const rowHtml  = m[2];
    const spanM    = /<span class='(test\w+)'/i.exec(rowHtml);
    const cls      = spanM ? spanM[1] : '';
    const result   = /testFail/i.test(cls) ? 'failed' : /testPass/i.test(cls) ? 'passed' : 'unknown';
    const tds = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tm;
    while ((tm = tdRe.exec(rowHtml)) !== null) tds.push(odStripTags(tm[1]).trim());
    const name = (tds[1] || '').replace(/\s*\(ID:\s*\d+\)\s*$/, '').trim();
    if (name || resultId) results.push({ resultId, name, result, date: tds[0] || '', duration: tds[3] || '' });
  }
  return results;
}

function parseFailDetailHtml(html) {
  const get = re => { const m = re.exec(html); return m ? odStripTags(m[1]).trim() : ''; };
  const jiraLinkM = /Jira Test ID:[\s\S]*?href='[^']*'>([A-Z]+-T\d+)<\/a>/i.exec(html);
  const jiraTextM = /Jira Test ID:[^<\n]*?([A-Z]{2,}-T\d+)/i.exec(html);
  const jiraId    = (jiraLinkM || jiraTextM || [])[1] || '';
  const classM    = /Test class:[^<\n]*?web:\s*([\w.]+)/i.exec(html) || /Test class:\s*([\w.]+Test\b)/i.exec(html);
  const webClass  = classM ? classM[1].trim() : '';
  const stepsSection = (/<b>Step details:<\/b>\s*<br>([\s\S]*?)(?:<br>\s*<b>Fail reason:|<\/div>|$)/i.exec(html) || [])[1] || '';
  const steps = stepsSection
    .split(/<br\s*\/?>/i)
    .map(s => odStripTags(s).trim())
    .filter(s => s.length > 5 && /PASSED|FAILED/i.test(s))
    .map(s => {
      const resM = /(PASSED|FAILED)/i.exec(s);
      const durM = /\(([^)]+)\)\s*$/.exec(s);
      const text = s.replace(/^\d{2}:\d{2}:\d{2}\s+\+\d+\s+Step:\s+/, '').replace(/\s+-\s+(PASSED|FAILED)\s*(?:\([^)]*\))?\s*$/, '').trim();
      return { text, result: resM ? resM[1].toLowerCase() : 'unknown', duration: durM ? durM[1] : '' };
    });
  const failSection = (/<b>Fail reason:<\/b>\s*<br>([\s\S]*?)(?:<br>\s*<b>Screenshots|<\/div>|$)/i.exec(html) || [])[1] || '';
  const failLines   = odStripTags(failSection.replace(/<br\s*\/?>/gi, '\n')).split('\n').map(l => l.trim()).filter(Boolean);
  const failMessage = failLines.find(l => !/^at /.test(l)) || '';
  return { jiraId, webClass, steps, failMessage, failReason: failLines.join('\n') };
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const u        = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = u.pathname;

  // ── Static files ──────────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/auditor.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'auditor.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      sendError(res, 500, 'auditor.html not found');
    }
    return;
  }

  // ── GET /api/client-config ────────────────────────────────────────────────────
  if (pathname === '/api/client-config' && req.method === 'GET') {
    if (MOCK_MODE) {
      sendJSON(res, 200, readMock('client-config.json'));
      return;
    }
    sendJSON(res, 200, { zephyrBaseUrl: ZEPHYR_BASE, githubRepo: GITHUB_REPO, githubBranch: GITHUB_BRANCH });
    return;
  }

  // ── GET /api/tree ─────────────────────────────────────────────────────────────
  if (pathname === '/api/tree' && req.method === 'GET') {
    if (MOCK_MODE) {
      log('Tree', 'Serving mock tree');
      sendJSON(res, 200, readMock('tree.json'));
      return;
    }
    try {
      log('Tree', `Fetching from GitHub`);
      const filePaths = await fetchGitHubTree();
      const keyMap = {};
      const sample  = filePaths.slice(0, 80);
      for (const fp of sample) {
        try {
          const src = await fetchGitHubFile(fp);
          const m   = TICKET_RE.exec(src);
          keyMap[fp] = m ? m[1] : null;
        } catch { keyMap[fp] = null; }
      }
      const tree = buildNestedTree(filePaths);
      (function stampKeys(nodes) {
        nodes.forEach(n => {
          if (n.type === 'file') n.ticketKey = keyMap[n.path] ?? null;
          else if (n.children) stampKeys(n.children);
        });
      }(tree));
      sendJSON(res, 200, { tree, totalFiles: filePaths.length });
    } catch (err) {
      logErr('Tree', err); sendError(res, 500, err.message);
    }
    return;
  }

  // ── GET /api/file?path=... ────────────────────────────────────────────────────
  if (pathname === '/api/file' && req.method === 'GET') {
    const filePath = u.searchParams.get('path');
    if (!filePath) { sendError(res, 400, 'Missing ?path='); return; }
    if (MOCK_MODE) {
      const filename = filePath.split('/').pop().replace('.java', '').toLowerCase();
      const mockMap  = {
        'armawaygroup':   'file-t1001.json',
        'armstaygroup':   'file-t1002.json',
        'dismissalert':   'file-t1003.json',
      };
      const mockFile = Object.entries(mockMap).find(([k]) => filename.includes(k));
      if (mockFile) { sendJSON(res, 200, readMock(mockFile[1])); return; }
      sendError(res, 422, 'No Zephyr ticket key found in this file (mock: file not mapped).');
      return;
    }
    try {
      const source = await fetchGitHubFile(filePath);
      const m      = TICKET_RE.exec(source);
      if (!m) { sendError(res, 422, 'No Zephyr ticket key found in this file.'); return; }
      sendJSON(res, 200, { filename: filePath.split('/').pop(), source, ticketKey: m[1] });
    } catch (err) { logErr('File', err); sendError(res, 500, err.message); }
    return;
  }

  // ── POST /api/audit ───────────────────────────────────────────────────────────
  if (pathname === '/api/audit' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    log('Audit', `Starting → ${body.ticketKey}`);
    if (MOCK_MODE) {
      const mockMap = { 'EX-T1001': 'audit-t1001.json', 'EX-T1002': 'audit-t1002.json', 'EX-T1003': 'audit-t1003.json' };
      const mockFile = mockMap[body.ticketKey];
      if (mockFile) {
        // Simulate LLM processing time
        await delay(1200 + Math.random() * 800);
        sendJSON(res, 200, readMock(mockFile));
        return;
      }
      sendError(res, 422, `No mock audit available for ticket ${body.ticketKey}`);
      return;
    }
    try {
      const zephyrCase = await getZephyrTestCase(body.ticketKey);
      const report     = await runAudit(body.source, zephyrCase, body.userContext || '');
      sendJSON(res, 200, { report, filename: body.filename || body.ticketKey });
    } catch (err) { logErr('Audit', err); sendError(res, 500, err.message); }
    return;
  }

  // ── GET /api/folder-audit?folder=... — SSE stream ────────────────────────────
  if (pathname === '/api/folder-audit' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    const sse = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };

    if (MOCK_MODE) {
      const mockFiles = [
        { key: 'EX-T1001', filename: 'ArmAwayGroupTest.java', auditFile: 'audit-t1001.json',
          path: 'src/test/java/tests/panels/arming/ArmAwayGroupTest.java' },
        { key: 'EX-T1002', filename: 'ArmStayGroupTest.java', auditFile: 'audit-t1002.json',
          path: 'src/test/java/tests/panels/arming/ArmStayGroupTest.java' },
        { key: 'EX-T1003', filename: 'DismissAlertTest.java', auditFile: 'audit-t1003.json',
          path: 'src/test/java/tests/panels/arming/DismissAlertTest.java' },
      ];
      sse('start', { total: mockFiles.length, folder: u.searchParams.get('folder') || '' });
      let totMatched = 0, totWarned = 0, totUnmatched = 0;
      for (let i = 0; i < mockFiles.length; i++) {
        const f = mockFiles[i];
        await delay(600 + Math.random() * 400);
        sse('progress', { done: i + 1, total: mockFiles.length, name: f.filename });
        await delay(1000 + Math.random() * 600);
        const mock       = readMock(f.auditFile);
        const report     = mock.report;
        const { summary } = report;
        const totalSteps = report.zephyrSteps.length;
        const coverage   = totalSteps > 0 ? Math.round(summary.matched / totalSteps * 100) : 0;
        const githubUrl  = `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${f.path}`;
        totMatched   += summary.matched;
        totWarned    += summary.warnings;
        totUnmatched += summary.unmatched;
        // result: flat fields so the UI can render without digging into summary
        sse('result', {
          filename: f.filename, path: f.path, ticketKey: f.key, githubUrl,
          matched: summary.matched, warnings: summary.warnings, unmatched: summary.unmatched,
          coverage, totalSteps, done: i + 1,
          report, matches: report.matches, zephyrSteps: report.zephyrSteps,
          javaBlocks: report.javaBlocks, expandedFrom: report.expandedFrom,
        });
        // analysis arrives as a separate event (mirrors live behaviour)
        if (report.analysis && report.analysis.length) {
          await delay(400);
          sse('analysis', { filename: f.filename, ticketKey: f.key, analysis: report.analysis });
        }
      }
      await delay(300);
      sse('done', { totals: { matched: totMatched, warned: totWarned, unmatched: totUnmatched, files: mockFiles.length, skipped: 0 } });
      res.end();
      return;
    }

    try {
      const folderPrefix = u.searchParams.get('folder') || '';
      const allPaths     = await fetchGitHubTree();
      const paths        = folderPrefix ? allPaths.filter(p => p.startsWith(folderPrefix + '/')) : allPaths;
      sse('start', { total: paths.length, folder: folderPrefix });
      let done = 0;
      for (const filePath of paths) {
        const filename = filePath.split('/').pop();
        done++;
        sse('progress', { done, total: paths.length, name: filename });
        try {
          const source = await fetchGitHubFile(filePath);
          const m      = TICKET_RE.exec(source);
          if (!m) continue;
          const ticketKey  = m[1];
          const zephyrCase = await getZephyrTestCase(ticketKey);
          const report     = await runAudit(source, zephyrCase);
          const githubUrl  = `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${filePath}`;
          sse('result', { filename, path: filePath, ticketKey, githubUrl, ...report });
        } catch (err) {
          sse('result', { filename, error: err.message });
        }
      }
      sse('done', { total: paths.length });
    } catch (err) { sse('fatal', { message: err.message }); }
    res.end();
    return;
  }

  // ── GET /api/od/batches ───────────────────────────────────────────────────────
  if (pathname === '/api/od/batches' && req.method === 'GET') {
    if (MOCK_MODE) { sendJSON(res, 200, readMock('batches.json')); return; }
    try {
      const html    = await odFetch('/falcor/reportsByBatch');
      const batches = parseBatchesHtml(html);
      sendJSON(res, 200, { batches });
    } catch (err) { logErr('OD', err); sendError(res, 500, err.message); }
    return;
  }

  // ── GET /api/od/batch-runs?batchName=... ──────────────────────────────────────
  if (pathname === '/api/od/batch-runs' && req.method === 'GET') {
    const batchName = u.searchParams.get('batchName') || '';
    if (!batchName) { sendError(res, 400, 'Missing batchName'); return; }
    if (MOCK_MODE) {
      // Route to the right mock file by batch title
      const mockFile = batchName.includes('Smoke') ? 'batch-runs-smoke.json' : 'batch-runs-sprint.json';
      sendJSON(res, 200, readMock(mockFile));
      return;
    }
    try {
      const html = await odFetch(`/runnerApp/api/getSuitesByBatch?batchName=${encodeURIComponent(batchName)}`);
      sendJSON(res, 200, { runs: parseJobsHtml(html) });
    } catch (err) { logErr('OD', err); sendError(res, 500, err.message); }
    return;
  }

  // ── GET /api/od/results?runId=... ─────────────────────────────────────────────
  if (pathname === '/api/od/results' && req.method === 'GET') {
    const runId = u.searchParams.get('runId');
    if (!runId) { sendError(res, 400, 'Missing runId'); return; }
    if (MOCK_MODE) {
      const mockFile = `results-run-${runId}.json`;
      try { sendJSON(res, 200, readMock(mockFile)); }
      catch { sendError(res, 404, `No mock results for runId ${runId}`); }
      return;
    }
    try {
      const html   = await odFetch(`/runnerApp/api/getResultsByRunId?runId=${runId}&edit=true`);
      const results = parseResultsHtml(html);
      const stats   = { total: results.length, passed: results.filter(r => r.result === 'passed').length, failed: results.filter(r => r.result === 'failed').length };
      sendJSON(res, 200, { results, stats });
    } catch (err) { logErr('OD', err); sendError(res, 500, err.message); }
    return;
  }

  // ── GET /api/od/faildetail?resultId=... ───────────────────────────────────────
  if (pathname === '/api/od/faildetail' && req.method === 'GET') {
    const resultId = u.searchParams.get('resultId');
    if (!resultId) { sendError(res, 400, 'Missing resultId'); return; }
    if (MOCK_MODE) {
      const mockFile = `faildetail-${resultId}.json`;
      try { sendJSON(res, 200, readMock(mockFile)); }
      catch { sendError(res, 404, `No mock fail detail for resultId ${resultId}`); }
      return;
    }
    try {
      const html   = await odFetch(`/runnerApp/api/getFailReasonDetails?id=${resultId}&scope=falcor`);
      sendJSON(res, 200, parseFailDetailHtml(html));
    } catch (err) { logErr('OD', err); sendError(res, 500, err.message); }
    return;
  }

  // ── POST /api/od/analyze-failures ────────────────────────────────────────────
  if (pathname === '/api/od/analyze-failures' && req.method === 'POST') {
    if (MOCK_MODE) {
      // Return a canned analysis for demo purposes
      const body       = JSON.parse(await readBody(req));
      const suiteName  = (body.suiteName || '').toLowerCase();
      let analysis;
      if (suiteName.includes('arm away')) {
        analysis = {
          verdict: 'environment',
          headline: '2 of 5 tests failed — both failures share the same environment (demo-device-01). Likely an infra or device-state issue, not a regression.',
          patterns: [
            { title: 'Device-scoped failures', affectedCount: 2, description: 'Both failed tests ran on demo-device-01. The 3 passing tests ran on the same device at an earlier time slot, suggesting a device state drift after 09:07.', suggestion: 'Re-run on a freshly reset device to confirm environment isolation.' },
            { title: 'Longer duration on failures', affectedCount: 2, description: 'Failed tests averaged 49s vs 24s for passing tests. Elevated duration often indicates a device responsiveness issue or command timeout rather than a logic regression.', suggestion: 'Check device logs for network latency or OD agent heartbeat gaps around 09:09–09:11.' },
          ],
        };
      } else if (suiteName.includes('arm stay')) {
        analysis = {
          verdict: 'regression',
          headline: '3 of 5 tests failed across both devices. Failure pattern is consistent with a recent firmware change — not environment-specific.',
          patterns: [
            { title: 'Cross-device failures', affectedCount: 3, description: 'Failures appear on both demo-device-01 and demo-device-02, ruling out a single device state issue.', suggestion: 'Review recent panel firmware changelog for ARM STAY bypass logic changes.' },
            { title: 'Interior sensor bypass not asserting', affectedCount: 2, description: 'Two failures reference assertBypassed() returning unexpected state, consistent with a firmware change to sensor bypass behaviour in ARM STAY mode.', suggestion: 'Compare assertBypassed() behaviour against firmware version prior to last sprint push.' },
          ],
        };
      } else {
        analysis = {
          verdict: 'flaky',
          headline: 'Failures appear intermittent — no consistent device, time, or assertion pattern detected.',
          patterns: [
            { title: 'Non-deterministic timing', affectedCount: 1, description: 'The single failure occurred mid-run between two passing tests of similar type, suggesting a transient system state.', suggestion: 'Add a retry layer or waitForStableState() guard before the failing assertion.' },
          ],
        };
      }
      sendJSON(res, 200, analysis);
      return;
    }
    try {
      // In live mode this would call an LLM or analysis service
      sendError(res, 501, 'Live failure analysis not implemented in this build');
    } catch (err) { logErr('OD', err); sendError(res, 500, err.message); }
    return;
  }

  // ── GET /api/od/audit-all?runId=... — SSE stream ─────────────────────────────
  if (pathname === '/api/od/audit-all' && req.method === 'GET') {
    const runId = u.searchParams.get('runId');
    if (!runId) { sendError(res, 400, 'Missing runId'); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    const sse = (type, data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); };

    if (MOCK_MODE) {
      // Find which mock results file applies
      const resultsFile = `results-run-${runId}.json`;
      let resultsData;
      try { resultsData = readMock(resultsFile); }
      catch { sse('fatal', { message: `No mock results for runId ${runId}` }); res.end(); return; }

      const failures = resultsData.results.filter(r => r.result === 'failed');
      sse('start', { total: failures.length });

      // Mock audit data keyed by resultId
      const mockAudits = {
        '10014': { jiraId: 'EX-T1001', webClass: 'tests.panels.arming.ArmAwayGroupTest',
          auditFile: 'audit-t1001.json', failFile: 'faildetail-10014.json' },
        '10015': { jiraId: 'EX-T1001', webClass: 'tests.panels.arming.ArmAwayGroupTest',
          auditFile: 'audit-t1001.json', failFile: 'faildetail-10015.json' },
        '10023': { jiraId: 'EX-T1002', webClass: 'tests.panels.arming.ArmStayGroupTest',
          auditFile: 'audit-t1002.json', failFile: 'faildetail-10023.json' },
        '10033': { jiraId: 'EX-T1003', webClass: 'tests.panels.arming.DismissAlertTest',
          auditFile: 'audit-t1003.json', failFile: 'faildetail-10033.json' },
      };

      for (let i = 0; i < failures.length; i++) {
        const result = failures[i];
        const done   = i + 1;
        sse('progress', { done, total: failures.length, name: result.name });
        await delay(400 + Math.random() * 300);

        const mock = mockAudits[result.resultId];
        if (!mock) {
          sse('result', { name: result.name, jiraId: '', jiraUrl: '', webClass: '', githubUrl: '',
            failReason: 'Mock data not available for this result', coverage: null, totalSteps: 0,
            matchedSteps: 0, unmatchedSteps: [], noJava: true, noJira: true });
          continue;
        }

        await delay(1000 + Math.random() * 600);
        const failDetail = readMock(mock.failFile);
        const auditData  = readMock(mock.auditFile);
        const report     = auditData.report;
        const { summary } = report;
        const coverage  = summary.matched + summary.warnings + summary.unmatched > 0
          ? Math.round(summary.matched / (summary.matched + summary.warnings + summary.unmatched) * 100) : 0;
        const unmatchedSteps = report.zephyrSteps
          .filter(s => {
            const m = report.matches.find(m => m.zephyrIndex === s.index);
            return !m || m.status === 'unmatched';
          })
          .map(s => s.description);

        sse('result', {
          name:                 result.name,
          jiraId:               mock.jiraId,
          jiraUrl:              `https://jira.example.com/jira/secure/Tests.jspa#/testCase/${mock.jiraId}`,
          webClass:             mock.webClass,
          githubUrl:            `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/src/test/java/${mock.webClass.replace(/\./g, '/')}.java`,
          failReason:           failDetail.failMessage,
          failedOdStep:         failDetail.steps.find(s => s.result === 'failed')?.text || '',
          failedOdStepDuration: failDetail.steps.find(s => s.result === 'failed')?.duration || '',
          testDuration:         result.duration,
          coverage,
          totalSteps:           report.zephyrSteps.length,
          matchedSteps:         summary.matched,
          unmatchedSteps,
          peerPassingTests:     [],
          noJava:               false,
          noJira:               false,
        });
      }

      sse('done', { total: failures.length });
      res.end();
      return;
    }

    // Real mode
    try {
      const html     = await odFetch(`/runnerApp/api/getResultsByRunId?runId=${runId}&edit=true`);
      const allResults = parseResultsHtml(html);
      const failures   = allResults.filter(r => r.result === 'failed' && r.resultId);
      sse('start', { total: failures.length });
      const allPaths = await fetchGitHubTree();
      let done = 0;
      for (const result of failures) {
        done++;
        const shortName = result.name.replace(/\s*\(ID:\s*\d+\)\s*$/, '');
        sse('progress', { done, total: failures.length, name: shortName });
        try {
          const detailHtml = await odFetch(`/runnerApp/api/getFailReasonDetails?id=${result.resultId}&scope=falcor`);
          const detail     = parseFailDetailHtml(detailHtml);
          const base       = detail.webClass ? detail.webClass.split('.').pop() : '';
          const javaPath   = base ? allPaths.find(p => p.endsWith(`/${base}.java`)) : null;
          let coverage = null, unmatchedSteps = [], totalSteps = 0, matchedSteps = 0;
          if (javaPath && detail.jiraId) {
            const src       = await fetchGitHubFile(javaPath);
            const zephyr    = await getZephyrTestCase(detail.jiraId);
            const report    = await runAudit(src, zephyr);
            totalSteps      = report.zephyrSteps.length;
            const stepStatus = {};
            report.matches.forEach(m => {
              if (m.zephyrIndex === null) return;
              const rank = { matched: 1, warning: 2, unmatched: 3 };
              if (!stepStatus[m.zephyrIndex] || rank[m.status] > rank[stepStatus[m.zephyrIndex]]) stepStatus[m.zephyrIndex] = m.status;
            });
            matchedSteps   = Object.values(stepStatus).filter(s => s === 'matched').length;
            unmatchedSteps = report.zephyrSteps.filter(s => !stepStatus[s.index] || stepStatus[s.index] === 'unmatched').map(s => s.description);
            coverage       = totalSteps > 0 ? Math.round(matchedSteps / totalSteps * 100) : 0;
          }
          const failedStep = detail.steps.find(s => s.result === 'failed');
          sse('result', {
            name: shortName, jiraId: detail.jiraId || '', webClass: detail.webClass || '',
            jiraUrl: detail.jiraId ? `${ZEPHYR_BASE}/secure/Tests.jspa#/testCase/${detail.jiraId}` : '',
            githubUrl: javaPath ? `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${javaPath}` : '',
            failReason: detail.failMessage || '',
            failedOdStep: failedStep?.text || '', failedOdStepDuration: failedStep?.duration || '',
            testDuration: result.duration || '', peerPassingTests: [],
            totalSteps, matchedSteps, unmatchedSteps, coverage,
            noJava: !javaPath, noJira: !detail.jiraId,
          });
        } catch (err) {
          sse('result', { name: shortName, error: err.message, jiraId: '', coverage: null });
        }
      }
      sse('done', { total: failures.length });
    } catch (err) { sse('fatal', { message: err.message }); }
    res.end();
    return;
  }

  // ── GET /api/zephyr/search ────────────────────────────────────────────────────
  if (pathname === '/api/zephyr/search' && req.method === 'GET') {
    // In mock mode and real, return empty — the UI uses the ticket key embedded in the Java file
    sendJSON(res, 200, { testCases: [] });
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────────
  sendError(res, 404, `Not found: ${pathname}`);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  const mode = MOCK_MODE ? 'MOCK MODE (no credentials needed)' : 'LIVE MODE';
  console.log(`\n✅  OnDemand Auditor Demo  →  ${url}`);
  console.log(`   Mode  : ${mode}`);
  console.log(`   Repo  : ${GITHUB_REPO} @ ${GITHUB_BRANCH}`);
  console.log(`   Ctrl+C to stop\n`);
  exec(`start "" "${url}"`);
});
