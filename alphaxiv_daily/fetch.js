#!/usr/bin/env node
/**
 * alphaxiv_daily/fetch.js
 * 每次运行：
 *   1. 请求 alphaxiv papers/v3/feed（最近30天 cs.IR 热门论文）
 *   2. 与 seen.json 对比，找出新论文
 *   3. 为每篇新论文生成 releases/<date>/<paper_id>.md
 *   4. 更新 seen.json
 *   5. 重新生成 feed.xml (RSS)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 本地开发：自动加载 .env 文件（GitHub Actions 直接用系统环境变量，无需 .env）
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach((line) => {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}

// ── 配置 ──────────────────────────────────────────────────────────────────────
const API_BASE = 'https://api.alphaxiv.org';
const FEED_PARAMS = {
  pageNum: '0',
  pageSize: '200',
  sort: 'Hot',
  interval: '30 Days',
  topics: '["cs.IR"]',
};
const SEEN_FILE = path.join(__dirname, 'seen.json');
const RELEASES_DIR = path.join(__dirname, 'releases');
const FEED_XML = path.join(__dirname, 'feed.xml');
const REPO_URL = process.env.REPO_URL || 'https://github.com/YOUR_USERNAME/YOUR_REPO';

// ── 工具函数 ──────────────────────────────────────────────────────────────────
// 支持通过 HTTPS_PROXY 环境变量指定 HTTP 代理（如 http://127.0.0.1:7897）
// 未设置时直连，GitHub Actions 不需要设置
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

function parseProxy(proxyUrl) {
  const m = proxyUrl.match(/^https?:\/\/([^:]+):(\d+)/);
  if (!m) return null;
  return { host: m[1], port: parseInt(m[2], 10) };
}

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = { 'User-Agent': 'alphaxiv-daily/1.0', ...extraHeaders };
    const proxy = PROXY ? parseProxy(PROXY) : null;

    const doRequest = (socket) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        ...(socket ? { socket, agent: false } : {}),
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          } else {
            resolve(body);
          }
        });
      });
      req.on('error', reject);
      req.end();
    };

    if (!proxy) {
      doRequest(null);
      return;
    }

    // 通过 HTTP CONNECT 鈲道建立代理隙道
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${parsed.hostname}:${parsed.port || 443}`,
      headers: { Host: `${parsed.hostname}:${parsed.port || 443}` },
    });
    connectReq.on('connect', (_res, socket) => doRequest(socket));
    connectReq.on('error', reject);
    connectReq.end();
  });
}


// ── Google Translate 免费接口（无需 API Key）───────────────────────────────
// 本地运行设置 HTTPS_PROXY=http://127.0.0.1:7897；GitHub Actions 不需要设置
// 单次最多 4500 字符，超长自动分块

const GOOGLE_MAX = 4500;

function splitIntoChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (cur) { chunks.push(cur.trim()); cur = ''; }
      for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen).trim());
    } else if ((cur + s).length > maxLen) {
      if (cur) chunks.push(cur.trim());
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * 翻译单段文本（超长自动分块后拼接），失败返回空字符串
 * @param {string} text
 * @returns {Promise<string>}
 */
async function translateOne(text) {
  if (!text || !text.trim()) return '';
  const chunks = splitIntoChunks(text.trim(), GOOGLE_MAX);
  const results = [];
  for (const chunk of chunks) {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(chunk)}`;
    try {
      const body = await httpsGet(url);
      const data = JSON.parse(body);
      results.push(data[0].map((seg) => seg[0] || '').join(''));
    } catch (err) {
      // 网络不通（本地未设代理）时静默跳过
      if (!['ETIMEDOUT','ECONNREFUSED','ENOTFOUND','ECONNRESET'].includes(err.code)) {
        console.warn(`[translate] 失败: ${err.message}`);
      }
      return ''; // 任一块失败则放弃整项
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 150));
  }
  return results.join('');
}

/**
 * 逐项翻译数组，每项独立请求，保留结构
 * @param {string[]} texts
 * @returns {Promise<string[]>}
 */
async function translateBatch(texts) {
  const results = [];
  for (const t of texts) {
    results.push(await translateOne(t));
  }
  return results;
}

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2), 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoDate(dateStr) {
  try {
    return new Date(dateStr).toUTCString();
  } catch {
    return new Date().toUTCString();
  }
}

// ── 论文 → Markdown ───────────────────────────────────────────────────────────
async function paperToMarkdown(paper) {
  const arxivId = paper.universal_paper_id || '';
  const arxivUrl = arxivId ? `https://arxiv.org/abs/${arxivId}` : '';
  const alphaxivUrl = arxivId ? `https://www.alphaxiv.org/abs/${arxivId}` : '';
  const pdfUrl = arxivId ? `https://arxiv.org/pdf/${arxivId}` : '';

  const authors = (paper.authors || []).join(', ');
  const topics = (paper.topics || []).filter(t => !t.startsWith('cs.') || t === 'cs.IR').join(', ');
  const pubDate = paper.publication_date
    ? paper.publication_date.slice(0, 10)
    : '';

  const summary = paper.paper_summary;

  // ── 翻译各字段（逐项独立请求，结构清晰）──
  const titleZh      = await translateOne(paper.title || '');
  const abstractZh   = await translateOne(paper.abstract || '');
  const summaryZh    = summary && summary.summary ? await translateOne(summary.summary) : '';
  const opZh  = await translateBatch((summary && summary.originalProblem) || []);
  const solZh = await translateBatch((summary && summary.solution) || []);
  const kiZh  = await translateBatch((summary && summary.keyInsights) || []);
  const resZh = await translateBatch((summary && summary.results) || []);

  // ── 组装 Markdown（中英穿插）──
  let md = `# ${paper.title}\n\n`;
  if (titleZh && titleZh !== paper.title) {
    md += `> **中文标题：** ${titleZh}\n\n`;
  }

  // 基本信息
  md += `**arXiv:** [${arxivId}](${arxivUrl})`;
  if (alphaxivUrl) md += `  |  **alphaxiv:** [查看](${alphaxivUrl})`;
  if (pdfUrl) md += `  |  **PDF:** [下载](${pdfUrl})`;
  md += '\n\n';

  if (paper.github_url) {
    const stars = paper.github_stars != null ? ` ⭐ ${paper.github_stars}` : '';
    md += `**GitHub:** [${paper.github_url}](${paper.github_url})${stars}\n\n`;
  }

  if (authors) md += `**作者：** ${authors}\n\n`;
  if (pubDate) md += `**发布日期：** ${pubDate}\n\n`;
  if (topics) md += `**主题：** ${topics}\n\n`;

  const m = paper.metrics || {};
  const visits = (m.visits_count || {}).all || 0;
  const votes = m.public_total_votes || 0;
  md += `**热度：** 👁 ${visits} 次浏览  |  👍 ${votes} 票\n\n`;

  md += `---\n\n`;

  // Abstract：英文原文 → 中文译文
  if (paper.abstract) {
    md += `## Abstract\n\n${paper.abstract}\n\n`;
    if (abstractZh) md += `**【中文】**\n\n${abstractZh}\n\n`;
  }

  // Summary：英文 → 中文
  if (summary && summary.summary) {
    md += `## Summary\n\n${summary.summary}\n\n`;
    if (summaryZh) md += `**【中文】** ${summaryZh}\n\n`;
  }

  // Original Problem：每条英文后紧跟中文
  if (summary && summary.originalProblem && summary.originalProblem.length) {
    md += `## Original Problem\n\n`;
    summary.originalProblem.forEach((p, i) => {
      md += `- ${p}\n`;
      if (opZh[i]) md += `  > ${opZh[i]}\n`;
    });
    md += '\n';
  }

  // Solution：每条英文后紧跟中文
  if (summary && summary.solution && summary.solution.length) {
    md += `## Solution\n\n`;
    summary.solution.forEach((s, i) => {
      md += `- ${s}\n`;
      if (solZh[i]) md += `  > ${solZh[i]}\n`;
    });
    md += '\n';
  }

  // Key Insights：每条英文后紧跟中文
  if (summary && summary.keyInsights && summary.keyInsights.length) {
    md += `## Key Insights\n\n`;
    summary.keyInsights.forEach((k, i) => {
      md += `- ${k}\n`;
      if (kiZh[i]) md += `  > ${kiZh[i]}\n`;
    });
    md += '\n';
  }

  // Results：每条英文后紧跟中文
  if (summary && summary.results && summary.results.length) {
    md += `## Results\n\n`;
    summary.results.forEach((r, i) => {
      md += `- ${r}\n`;
      if (resZh[i]) md += `  > ${resZh[i]}\n`;
    });
    md += '\n';
  }

  // 完整 JSON
  md += `---\n\n`;
  md += `<details>\n<summary>完整 JSON 数据</summary>\n\n`;
  md += `\`\`\`json\n${JSON.stringify(paper, null, 2)}\n\`\`\`\n\n`;
  md += `</details>\n`;

  return md;
}

// ── RSS feed 生成 ─────────────────────────────────────────────────────────────
function buildRssFeed(items) {
  // items: [{title, link, description, pubDate, guid}]
  const itemsXml = items
    .slice(0, 100) // RSS 最多保留最近100条
    .map(
      (it) => `  <item>
    <title>${escapeXml(it.title)}</title>
    <link>${escapeXml(it.link)}</link>
    <guid isPermaLink="false">${escapeXml(it.guid)}</guid>
    <pubDate>${it.pubDate}</pubDate>
    <description>${escapeXml(it.description)}</description>
  </item>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>alphaxiv Daily - cs.IR 论文推荐</title>
    <link>${REPO_URL}</link>
    <description>每6小时更新，推荐 alphaxiv 上最近30天 cs.IR 热门论文</description>
    <language>zh-CN</language>
    <atom:link href="${REPO_URL}/raw/main/alphaxiv_daily/feed.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`;
}

function loadRssItems() {
  if (!fs.existsSync(FEED_XML)) return [];
  try {
    const xml = fs.readFileSync(FEED_XML, 'utf8');
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const block = m[1];
      const get = (tag) => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
        const mm = r.exec(block);
        return mm ? mm[1].trim() : '';
      };
      items.push({
        title: get('title').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        link: get('link'),
        guid: get('guid'),
        pubDate: get('pubDate'),
        description: get('description'),
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  // --limit N ：每次最多处理 N 篇新论文（本地测试用，GitHub Actions 不传则处理全部）
  const limitArg = process.argv.indexOf('--limit');
  const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  ensureDir(RELEASES_DIR);

  // 1. 请求 API
  const query = new URLSearchParams(FEED_PARAMS).toString();
  const url = `${API_BASE}/papers/v3/feed?${query}`;
  console.log(`[fetch] GET ${url}`);

  let papers;
  try {
    const body = await httpsGet(url);
    const data = JSON.parse(body);
    papers = data.papers || data;
    if (!Array.isArray(papers)) {
      console.error('[fetch] 响应格式异常:', JSON.stringify(data).slice(0, 300));
      process.exit(1);
    }
  } catch (err) {
    console.error('[fetch] 请求失败:', err.message);
    process.exit(1);
  }

  console.log(`[fetch] 获取到 ${papers.length} 篇论文`);

  // 2. 去重
  const seen = loadSeen();
  let newPapers = papers.filter((p) => p.universal_paper_id && !seen[p.universal_paper_id]);
  console.log(`[fetch] 新论文 ${newPapers.length} 篇`);
  if (newPapers.length > LIMIT) {
    console.log(`[fetch] --limit ${LIMIT}，本次处理前 ${LIMIT} 篇`);
    newPapers = newPapers.slice(0, LIMIT);
  }

  if (newPapers.length === 0) {
    console.log('[fetch] 无新论文，跳过');
    return;
  }

  // 3. 生成 release 文件
  const today = new Date().toISOString().slice(0, 10);
  const dateDir = path.join(RELEASES_DIR, today);
  ensureDir(dateDir);

  const newRssItems = [];

  for (const paper of newPapers) {
    const pid = paper.universal_paper_id;
    // 文件名安全处理：替换斜杠等非法字符
    const safeFilename = pid.replace(/[/\\:*?"<>|]/g, '_');
    const md = await paperToMarkdown(paper);
    const filePath = path.join(dateDir, `${safeFilename}.md`);
    fs.writeFileSync(filePath, md, 'utf8');

    const arxivUrl = `https://arxiv.org/abs/${pid}`;
    const releaseLink = `${REPO_URL}/releases/tag/${pid}`;

    // 摘要截断到 500 字
    const desc = (paper.abstract || '').slice(0, 500) + (paper.abstract && paper.abstract.length > 500 ? '...' : '');

    newRssItems.push({
      title: paper.title || pid,
      link: arxivUrl,
      guid: pid,
      pubDate: isoDate(paper.publication_date),
      description: desc,
    });

    seen[pid] = {
      title: paper.title,
      date: today,
      publication_date: paper.publication_date,
    };

    console.log(`[fetch] 生成: ${filePath}`);
  }

  // 4. 更新 seen.json
  saveSeen(seen);
  console.log(`[fetch] seen.json 已更新，共 ${Object.keys(seen).length} 条记录`);

  // 5. 更新 RSS feed（新条目在前）
  const existingItems = loadRssItems();
  const existingGuids = new Set(existingItems.map((i) => i.guid));
  const mergedItems = [
    ...newRssItems.filter((i) => !existingGuids.has(i.guid)),
    ...existingItems,
  ];
  fs.writeFileSync(FEED_XML, buildRssFeed(mergedItems), 'utf8');
  console.log(`[fetch] feed.xml 已更新，共 ${mergedItems.length} 条（保留最近100条）`);
}

main().catch((err) => {
  console.error('[fetch] 未捕获错误:', err);
  process.exit(1);
});
