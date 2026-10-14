const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const archiverPkg = require('archiver');
const archiver = archiverPkg.default || archiverPkg;
const { URL } = require('url');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// In-memory cache for live preview serving
let livePreviewPages = {};

/**
 * Helper to stream Server-Sent Events to connected client
 */
function sendSSE(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // Client connection closed
  }
}

/**
 * Clean & normalize URLs (removes trailing slashes, fragments, and tracking parameters)
 */
function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    const trackingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref'];
    trackingKeys.forEach(k => u.searchParams.delete(k));

    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) {
      p = p.slice(0, -1);
    }
    const search = u.search ? u.search : '';
    return u.origin + p + search;
  } catch (e) {
    return rawUrl;
  }
}

/**
 * Resilient page evaluate with automatic retry loop for frame detachments / re-renders
 */
async function safePageEvaluate(page, fn, fallback = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!page || page.isClosed()) return fallback;
      return await page.evaluate(fn);
    } catch (e) {
      if (attempt === retries) return fallback;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  return fallback;
}

// -------------------------------------------------------------
// NATIVE CLONING ENGINE (MODE 1: DOM & SHADOW DOM EXTRACTOR)
// -------------------------------------------------------------

/**
 * Serializes the full DOM including open Shadow DOM roots with Declarative Shadow DOM syntax
 */
async function extractFullDOM(page) {
  try {
    const serialized = await page.evaluate(() => {
      if (!document.documentElement) return null;

      // Modern Chromium native Declarative Shadow DOM serialization
      if (typeof document.documentElement.getHTML === 'function') {
        try {
          const nativeHtml = document.documentElement.getHTML({ serializableShadowRoots: true });
          if (nativeHtml && nativeHtml.length > 500) {
            return '<!DOCTYPE html>\n' + nativeHtml;
          }
        } catch (e) {}
      }

      // Universal recursive pierced shadow DOM serializer (depth limit: 30)
      function serializeNode(node, depth = 0) {
        if (depth > 30) return '';
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName.toLowerCase();
        if (['noscript'].includes(tag)) return '';

        let html = '<' + tag;
        for (let i = 0; i < node.attributes.length; i++) {
          const attr = node.attributes[i];
          if (!attr.name.toLowerCase().startsWith('on')) {
            html += ' ' + attr.name + '="' + (attr.value || '').replace(/"/g, '&quot;') + '"';
          }
        }
        html += '>';

        // Declarative Shadow DOM support
        if (node.shadowRoot) {
          html += '<template shadowrootmode="open">';
          for (let i = 0; i < node.shadowRoot.childNodes.length; i++) {
            html += serializeNode(node.shadowRoot.childNodes[i], depth + 1);
          }
          html += '</template>';
        }

        for (let i = 0; i < node.childNodes.length; i++) {
          html += serializeNode(node.childNodes[i], depth + 1);
        }

        const selfClosingTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];
        if (!selfClosingTags.includes(tag)) {
          html += '</' + tag + '>';
        }
        return html;
      }

      return '<!DOCTYPE html>\n' + serializeNode(document.documentElement, 0);
    });

    if (serialized && serialized.length > 300) return serialized;
  } catch (e) {}

  return await page.content().catch(() => '<!DOCTYPE html><html><body></body></html>');
}

/**
 * Universal Interaction Script: Injected into cloned pages for offline navigation & UI toggles
 */
const UNIVERSAL_INTERACTION_SCRIPT = `
<script>
  (function() {
    document.addEventListener('DOMContentLoaded', function() {
      // 1. Offline studio multi-page link routing
      document.querySelectorAll('a[data-local-link]').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          var target = a.getAttribute('data-local-target');
          if (!target) return;
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'STUDIO_NAVIGATE', fileName: target }, '*');
          } else {
            window.location.href = target;
          }
        });
      });

      // 2. Real-time live search filter on inputs
      var searchInputs = document.querySelectorAll('input[type="search"], input[name*="search" i], input[id*="search" i], input[placeholder*="search" i]');
      searchInputs.forEach(function(inp) {
        inp.addEventListener('input', function() {
          var query = (inp.value || '').toLowerCase().trim();
          var targets = document.querySelectorAll('article, tr, .card, [class*="card" i], [class*="item" i], ytd-rich-item-renderer, ytd-video-renderer');
          targets.forEach(function(el) {
            if (el.tagName.toLowerCase() === 'tr' && el.parentElement && el.parentElement.tagName.toLowerCase() === 'thead') return;
            var text = (el.innerText || '').toLowerCase();
            if (!query || text.indexOf(query) !== -1) {
              el.style.removeProperty('display');
            } else {
              el.style.display = 'none';
            }
          });
        });
      });

      // 3. Tab and Accordion State Delegator
      document.addEventListener('click', function(e) {
        var path = e.composedPath ? e.composedPath() : [e.target];
        for (var i = 0; i < path.length; i++) {
          var el = path[i];
          if (!el || !el.tagName) continue;

          var tabBtn = el.closest('[role="tab"], [data-tab-target]');
          if (tabBtn) {
            var tabList = tabBtn.closest('[role="tablist"]') || tabBtn.parentElement;
            if (tabList) {
              tabList.querySelectorAll('[role="tab"]').forEach(function(t) {
                t.setAttribute('aria-selected', 'false');
                t.classList.remove('active');
              });
              tabBtn.setAttribute('aria-selected', 'true');
              tabBtn.classList.add('active');
            }
            return;
          }

          var expBtn = el.closest('summary, [aria-expanded], [data-state], .accordion-trigger');
          if (expBtn) {
            var isExp = expBtn.getAttribute('aria-expanded') === 'true' || expBtn.getAttribute('data-state') === 'open';
            expBtn.setAttribute('aria-expanded', (!isExp).toString());
            expBtn.setAttribute('data-state', isExp ? 'closed' : 'open');
            var panel = expBtn.nextElementSibling || (expBtn.parentElement ? expBtn.parentElement.nextElementSibling : null);
            if (panel) {
              var isHidden = window.getComputedStyle(panel).display === 'none' || panel.style.height === '0px' || panel.classList.contains('hidden');
              if (isHidden) {
                panel.classList.remove('hidden');
                panel.style.setProperty('display', 'block', 'important');
              } else {
                panel.style.setProperty('display', 'none', 'important');
              }
            }
            return;
          }
        }
      });
    });
  })();
</script>
`;

// -------------------------------------------------------------
// NON-CLONABLE FALLBACK: TARGET INFORMATION & METADATA REPORT
// -------------------------------------------------------------

/**
 * If a website CANNOT be cloned (e.g. anti-bot walls, strict auth, or empty dead container),
 * this function displays all extracted information, metadata, and sniffed APIs clearly,
 * with no artificial or fake cloning.
 */
function generateWebsiteInfoPage(metadata, capturedApis = [], rawHtml = '') {
  const { title = 'Target Website', domain = 'localhost', description = '', keywords = '', url = '' } = metadata;

  const jsonApis = JSON.stringify(capturedApis || [], null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Target Information</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-[#09090b] text-[#f4f4f5] min-h-screen p-6 md:p-10 font-sans antialiased">
  <div class="max-w-5xl mx-auto space-y-6">

    <!-- Notice Banner -->
    <div class="bg-[#121215] border border-amber-500/30 rounded-xl p-6 shadow-xl relative overflow-hidden">
      <div class="flex items-start justify-between gap-4">
        <div>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <span>⚠</span> Full DOM Cloning Restricted
          </span>
          <h1 class="text-xl md:text-2xl font-bold text-white mt-3">${title || domain}</h1>
          <p class="text-xs text-zinc-400 font-mono mt-1">${url}</p>
        </div>
        <a href="${url}" target="_blank" rel="noreferrer" class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-lg border border-zinc-700 transition">
          Open Original ↗
        </a>
      </div>
      <p class="text-xs text-zinc-400 mt-4 leading-relaxed border-t border-zinc-800/80 pt-3">
        This website cannot be cloned directly due to server-side bot protections, authentication walls, or empty container scripts. All extracted metadata, SEO properties, and network APIs sniffed during connection are displayed below.
      </p>
    </div>

    <!-- Quick Stats Overview -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="bg-[#121215] border border-zinc-800 rounded-xl p-4">
        <span class="text-[11px] font-medium text-zinc-400">Target Host</span>
        <p class="text-sm font-semibold text-white mt-1 font-mono">${domain}</p>
      </div>
      <div class="bg-[#121215] border border-zinc-800 rounded-xl p-4">
        <span class="text-[11px] font-medium text-zinc-400">Captured Network APIs</span>
        <p class="text-sm font-semibold text-emerald-400 mt-1">${capturedApis.length} endpoints</p>
      </div>
      <div class="bg-[#121215] border border-zinc-800 rounded-xl p-4">
        <span class="text-[11px] font-medium text-zinc-400">Extracted Raw Content</span>
        <p class="text-sm font-semibold text-zinc-300 mt-1">${(rawHtml || '').length} bytes</p>
      </div>
    </div>

    <!-- Metadata Details Card -->
    <div class="bg-[#121215] border border-zinc-800 rounded-xl p-6 space-y-4">
      <h2 class="text-xs font-bold text-white uppercase tracking-wider font-mono">Extracted Information & Properties</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div class="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/60">
          <span class="text-zinc-500 font-mono text-[10px] block">PAGE TITLE</span>
          <p class="text-zinc-200 leading-relaxed font-semibold">${title || 'N/A'}</p>
        </div>
        <div class="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/60">
          <span class="text-zinc-500 font-mono text-[10px] block">DOMAIN</span>
          <p class="text-zinc-200 leading-relaxed font-mono">${domain}</p>
        </div>
        <div class="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/60 col-span-1 md:col-span-2">
          <span class="text-zinc-500 font-mono text-[10px] block">META DESCRIPTION</span>
          <p class="text-zinc-200 leading-relaxed">${description || '<span class="text-zinc-600 italic">No meta description found on target.</span>'}</p>
        </div>
        <div class="space-y-1 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/60 col-span-1 md:col-span-2">
          <span class="text-zinc-500 font-mono text-[10px] block">META KEYWORDS</span>
          <p class="text-zinc-200 leading-relaxed">${keywords || '<span class="text-zinc-600 italic">No keywords tag found on target.</span>'}</p>
        </div>
      </div>
    </div>

    <!-- Sniffed Network API Endpoints -->
    <div class="bg-[#121215] border border-zinc-800 rounded-xl p-6 space-y-4">
      <div class="flex items-center justify-between pb-2 border-b border-zinc-800">
        <div>
          <h2 class="text-xs font-bold text-white uppercase tracking-wider font-mono">Captured API Endpoints (${capturedApis.length})</h2>
          <p class="text-[11px] text-zinc-400">Background JSON responses sniffed during page navigation</p>
        </div>
        ${capturedApis.length > 0 ? `
          <button onclick="navigator.clipboard.writeText(document.getElementById('apiJson').innerText);alert('Copied API JSON!');" class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-xs text-white rounded border border-zinc-700">
            Copy JSON
          </button>
        ` : ''}
      </div>

      ${capturedApis.length > 0 ? `
        <div class="space-y-3">
          ${capturedApis.map((a, i) => `
            <div class="bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 space-y-2">
              <div class="flex items-center justify-between text-xs font-mono">
                <span class="text-emerald-400 font-semibold">[${a.method}] ${a.url}</span>
                <span class="text-zinc-500 text-[10px]">Status: ${a.status || 200}</span>
              </div>
              <pre class="bg-black/50 p-2.5 rounded text-[11px] text-zinc-300 overflow-x-auto max-h-36">${JSON.stringify(a.data, null, 2)}</pre>
            </div>
          `).join('')}
          <pre id="apiJson" class="hidden">${jsonApis}</pre>
        </div>
      ` : `
        <p class="text-xs text-zinc-500 py-4 text-center">No background JSON API responses were intercepted for this target.</p>
      `}
    </div>

  </div>
</body>
</html>`;
}

/**
 * Generates an offline Express Mock Server script that binds all captured routes
 */
function generateMockServerScript(capturedApis = [], port = 4000) {
  const routes = (capturedApis || []).map((api, idx) => {
    try {
      const urlObj = new URL(api.url);
      const safePath = urlObj.pathname.replace(/'/g, "\\'");
      return `\n// [Endpoint ${idx + 1}] Source: ${api.url}\napp.all('${safePath}', (req, res) => {\n  console.log('[Mock API Hit] ' + req.method + ' ' + req.url);\n  res.json(${JSON.stringify(api.data, null, 2)});\n});`;
    } catch (e) {
      return '';
    }
  }).join('\n');

  return `const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(\`[\${new Date().toISOString()}] \${req.method} \${req.url}\`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    mockEndpointsCount: ${(capturedApis || []).length},
    timestamp: new Date().toISOString()
  });
});
${routes}

const PORT = process.env.PORT || ${port};
app.listen(PORT, () => {
  console.log('----------------------------------------------------');
  console.log(' Universal Mock API Server running on port: ' + PORT);
  console.log(' Registered mock endpoints: ${(capturedApis || []).length}');
  console.log('----------------------------------------------------');
});
`;
}

// -------------------------------------------------------------
// LIVE PREVIEW SERVING ROUTE
// -------------------------------------------------------------
app.get('/api/preview/:filename', (req, res) => {
  const content = livePreviewPages[req.params.filename];
  if (!content) return res.status(404).send('Preview expired or file not found in active session.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(content);
});

// -------------------------------------------------------------
// CLONE STREAM CONTROLLER (SSE)
// -------------------------------------------------------------
app.get('/api/clone-stream', async (req, res) => {
  const { url, maxPages = 5 } = req.query;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).send('Valid HTTP/HTTPS target URL is required.');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 5000);

  let browser = null;
  const capturedApis = [];
  const crawledPages = [];
  const queue = [url];
  const visited = new Set();
  const urlToFilenameMap = {};
  const maxLimit = Math.min(Math.max(parseInt(maxPages, 10) || 5, 1), 20);
  const targetOrigin = new URL(url).origin;

  try {
    sendSSE(res, { status: 'info', message: '[crawler] Launching Chromium Low-Memory Sandbox...' });

    browser = await puppeteer.launch({
      headless: 'new',
      defaultViewport: { width: 1366, height: 768 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--mute-audio',
        '--window-size=1366,768'
      ]
    });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      const reqUrl = request.url();

      const isHeavyMedia = ['media'].includes(type) ||
        /\.(mp4|mp3|webm|ogg|wav|avi|mov|mkv|flv|m3u8|ts)(\?.*)?$/i.test(reqUrl);

      if (isHeavyMedia) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'] || '';
      const reqUrl = response.url();
      if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) return;

      const isDataPayload = contentType.includes('application/json') ||
                            contentType.includes('text/x-component') ||
                            contentType.includes('application/ld+json');

      if (isDataPayload) {
        try {
          const json = await response.json();
          if (capturedApis.length < 50 && !capturedApis.some(a => a.url === reqUrl)) {
            capturedApis.push({
              url: reqUrl,
              method: response.request().method(),
              status: response.status(),
              data: json
            });
            const parsedPath = new URL(reqUrl).pathname;
            const shortPath = parsedPath.length > 35 ? parsedPath.substring(0, 32) + '...' : parsedPath;
            sendSSE(res, { status: 'info', message: `[sniff] ${response.request().method()} ${shortPath} -> cached (${response.status()})` });
          }
        } catch (e) {}
      }
    });

    while (queue.length > 0 && crawledPages.length < maxLimit) {
      const currentUrl = queue.shift();
      const normalizedCurrent = normalizeUrl(currentUrl);

      if (visited.has(normalizedCurrent)) continue;
      visited.add(normalizedCurrent);

      const pageIndex = crawledPages.length;
      const filename = pageIndex === 0 ? 'index.html' : `page_${pageIndex}.html`;
      urlToFilenameMap[normalizedCurrent] = filename;
      urlToFilenameMap[currentUrl] = filename;

      sendSSE(res, { status: 'info', message: `[crawl] (${pageIndex + 1}/${maxLimit}) Navigating: ${currentUrl}` });

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        await new Promise(r => setTimeout(r, 1500));
      }

      // Active SPA hydration check: wait until DOM has meaningful nodes (up to 6s)
      for (let s = 0; s < 15; s++) {
        const elCount = await safePageEvaluate(page, () => {
          return document.body ? document.body.querySelectorAll('*').length : 0;
        }, 0);
        if (elCount > 30) break;
        await new Promise(r => setTimeout(r, 400));
      }

      // Settle delay & micro-scroll to activate framework hydration & lazy components
      await new Promise(r => setTimeout(r, 1000));
      await safePageEvaluate(page, () => window.scrollBy(0, 350));
      await new Promise(r => setTimeout(r, 600));
      await safePageEvaluate(page, () => window.scrollBy(0, -150));

      let rawHtml = await extractFullDOM(page);

      const pageInfo = await safePageEvaluate(page, () => {
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || '').trim() : '';
        const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ||
                         document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
        const metaKeywords = document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
        const hasShadow = !!document.querySelector('*')?.shadowRoot;
        const elementCount = document.body ? document.body.querySelectorAll('*').length : 0;

        return {
          title: document.title || '',
          metaDesc,
          metaKeywords,
          hasShadow,
          visibleTextLength: bodyText.length,
          elementCount
        };
      }, { title: '', metaDesc: '', metaKeywords: '', hasShadow: false, visibleTextLength: 0, elementCount: 0 });

      // Verification Logic:
      // Can be cloned: HTML >= 1500 bytes OR active shadow roots OR visible text >= 80 chars OR DOM elements >= 20
      // Cannot be cloned: Empty shell / auth-blocked (< 1500 bytes, < 20 elements)
      const canBeCloned = rawHtml.length >= 1500 || pageInfo.hasShadow || pageInfo.visibleTextLength >= 80 || pageInfo.elementCount >= 20;
      let isInfoReport = false;

      if (canBeCloned) {
        sendSSE(res, { status: 'info', message: `[clone] Target verified (${Math.round(rawHtml.length / 1024)} KB, ${pageInfo.elementCount} elements). Authentic website cloned.` });
      } else {
        sendSSE(res, { status: 'info', message: `[report] Target cannot be cloned directly (Protected/Auth-wall). Displaying target information report...` });
        const metadata = {
          title: pageInfo.title || new URL(currentUrl).hostname,
          domain: new URL(currentUrl).hostname,
          description: pageInfo.metaDesc,
          keywords: pageInfo.metaKeywords,
          url: currentUrl
        };
        rawHtml = generateWebsiteInfoPage(metadata, capturedApis, rawHtml);
        isInfoReport = true;
      }

      const inlineStyles = isInfoReport ? '' : await safePageEvaluate(page, () => {
        let css = '';
        const sheets = Array.from(document.styleSheets).slice(0, 15);
        for (const sheet of sheets) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            for (const rule of rules) css += rule.cssText + '\n';
          } catch (e) {}
        }
        return css;
      }, '');

      // Multi-page link discovery (only for cloneable sites)
      if (!isInfoReport) {
        let currentParsedUrl = new URL(currentUrl);
        try { currentParsedUrl = new URL(page.url() || currentUrl); } catch (e) {}

        const liveDiscoveredLinks = await safePageEvaluate(page, () => {
          const found = [];
          function collect(root) {
            if (!root) return;
            const links = root.querySelectorAll('a[href]');
            links.forEach(a => {
              const h = a.getAttribute('href');
              if (h && !h.startsWith('#') && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:')) {
                found.push(h);
              }
            });
            const allEls = root.querySelectorAll('*');
            for (let i = 0; i < allEls.length; i++) {
              if (allEls[i].shadowRoot) collect(allEls[i].shadowRoot);
            }
          }
          collect(document);
          return Array.from(new Set(found));
        }, []);

        for (const rawHref of (liveDiscoveredLinks || [])) {
          try {
            const resolved = new URL(rawHref, currentParsedUrl.href);
            if (resolved.origin === targetOrigin) {
              const isBinary = /\.(pdf|zip|rar|tar|gz|exe|dmg|iso|docx|xlsx|pptx|png|jpg|jpeg|gif|webp|svg|ico)$/i.test(resolved.pathname);
              if (!isBinary) {
                const cleanHref = normalizeUrl(resolved.href);
                if (!visited.has(cleanHref) && !queue.includes(cleanHref) && queue.length + visited.size < 60) {
                  queue.push(cleanHref);
                }
              }
            }
          } catch (e) {}
        }
      }

      crawledPages.push({
        fileName: filename,
        originalUrl: currentUrl,
        rawHtml,
        inlineStyles: inlineStyles || '',
        isInfoReport
      });

      if (isInfoReport) {
        break;
      }
    }

    await browser.close();
    browser = null;

    sendSSE(res, { status: 'info', message: '[bundle] Cheerio post-processing & asset inlining...' });

    const processedPages = [];
    for (const pageData of crawledPages) {
      if (pageData.isInfoReport) {
        processedPages.push({
          fileName: pageData.fileName,
          originalUrl: pageData.originalUrl,
          html: pageData.rawHtml
        });
        continue;
      }

      const $ = cheerio.load(pageData.rawHtml);
      const parsedPageUrl = new URL(pageData.originalUrl);

      // Strip crash-inducing scripts, tracking tags, and prefetch links
      $('script, link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], noscript').remove();

      // Inline external CSS server-side to eliminate CORS restrictions
      const cssLinks = $('link[rel="stylesheet"]').toArray().slice(0, 10);
      for (const link of cssLinks) {
        const href = $(link).attr('href');
        if (href) {
          try {
            const resolvedCssUrl = new URL(href, parsedPageUrl.href).href;
            const cssRes = await axios.get(resolvedCssUrl, {
              timeout: 3500,
              maxContentLength: 1500000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (cssRes.data && typeof cssRes.data === 'string') {
              $('head').append(`<style>\n${cssRes.data}\n</style>`);
              $(link).remove();
            } else {
              $(link).attr('href', resolvedCssUrl);
            }
          } catch (e) {
            try { $(link).attr('href', new URL(href, parsedPageUrl.href).href); } catch (err) {}
          }
        }
      }

      // Inject captured computed/inline styles
      if (pageData.inlineStyles) {
        $('head').append(`<style>\n${pageData.inlineStyles}\n</style>`);
      }

      // Normalize relative media and resource paths to absolute URLs
      $('img[src], source[src], video[poster]').each((_, el) => {
        const srcAttr = $(el).attr('src') ? 'src' : 'poster';
        const src = $(el).attr(srcAttr);
        if (src && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
          try { $(el).attr(srcAttr, new URL(src, parsedPageUrl.href).href); } catch (e) {}
        }
      });

      // Normalize srcset attributes
      $('img[srcset], source[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
          const normalizedSrcset = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const [u, ...descriptor] = trimmed.split(/\s+/);
            if (u && !u.startsWith('data:') && !u.startsWith('http')) {
              try {
                return `${new URL(u, parsedPageUrl.href).href} ${descriptor.join(' ')}`.trim();
              } catch (e) {
                return trimmed;
              }
            }
            return trimmed;
          }).join(', ');
          $(el).attr('srcset', normalizedSrcset);
        }
      });

      // Rewrite internal hyperlinks to point to local captured files
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
        try {
          const resolved = new URL(href, parsedPageUrl.href);
          const normalized = normalizeUrl(resolved.href);
          if (resolved.origin === targetOrigin && urlToFilenameMap[normalized]) {
            const localFileName = urlToFilenameMap[normalized];
            $(el).attr('href', localFileName);
            $(el).attr('data-local-link', 'true');
            $(el).attr('data-local-target', localFileName);
          } else if (resolved.origin === targetOrigin && urlToFilenameMap[resolved.href]) {
            const localFileName = urlToFilenameMap[resolved.href];
            $(el).attr('href', localFileName);
            $(el).attr('data-local-link', 'true');
            $(el).attr('data-local-target', localFileName);
          }
        } catch (e) {}
      });

      // Inject offline interaction polyfill
      $('body').append(UNIVERSAL_INTERACTION_SCRIPT);

      processedPages.push({
        fileName: pageData.fileName,
        originalUrl: pageData.originalUrl,
        html: $.html()
      });
    }

    livePreviewPages = {};
    processedPages.forEach(p => {
      livePreviewPages[p.fileName] = p.html;
    });

    clearInterval(keepAlive);

    sendSSE(res, {
      status: 'complete',
      message: `[bundle] Cloned ${processedPages.length} pages & captured ${capturedApis.length} dynamic APIs successfully.`,
      html: processedPages[0]?.html || '',
      crawledPages: processedPages,
      capturedApis
    });

    res.end();

  } catch (err) {
    clearInterval(keepAlive);
    if (browser) await browser.close().catch(() => {});
    sendSSE(res, { status: 'error', message: `[error] Execution failure: ${err.message}` });
    res.end();
  }
});

// -------------------------------------------------------------
// PRODUCTION ZIP BUNDLE EXPORTER
// -------------------------------------------------------------
app.post('/api/download-zip', async (req, res) => {
  const { crawledPages, html, capturedApis } = req.body;
  const pagesToBundle = (crawledPages && crawledPages.length > 0)
    ? crawledPages
    : (html ? [{ fileName: 'index.html', originalUrl: 'Root', html }] : []);

  if (!pagesToBundle.length) {
    return res.status(400).send('No content available to bundle.');
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment('developer-website-package.zip');
  archive.pipe(res);

  pagesToBundle.forEach(p => {
    archive.append(p.html, { name: p.fileName });
  });

  archive.append(JSON.stringify(capturedApis || [], null, 2), { name: 'api_manifest.json' });
  archive.append(generateMockServerScript(capturedApis || []), { name: 'mock-server.js' });

  const pkgJson = {
    name: 'cloned-web-archive',
    version: '1.0.0',
    description: 'Universal cloned web package with offline preview and mock server',
    main: 'mock-server.js',
    scripts: {
      start: 'node mock-server.js',
      serve: 'npx serve .'
    },
    dependencies: {
      express: '^4.19.2',
      cors: '^2.8.5'
    }
  };
  archive.append(JSON.stringify(pkgJson, null, 2), { name: 'package.json' });

  const readme = `# Developer Website Package

This archive was produced by the **Universal Web Archiver & Cloner**.

## Included Files
- \`index.html\` & crawled sub-pages: Authentic cloned HTML pages with Declarative Shadow DOM and inlined styles.
- \`api_manifest.json\`: All dynamic JSON API endpoints and payloads captured during crawling.
- \`mock-server.js\`: Standalone Express server providing working mock routes for all sniffed APIs.
- \`package.json\`: Dependency definitions for offline preview and mock server execution.

## Quick Start (Offline Preview)

To run the static website locally without CORS restrictions:
\`\`\`bash
npx serve .
\`\`\`

To launch the accompanying dynamic mock API server:
\`\`\`bash
npm install
npm start
\`\`\`
`;
  archive.append(readme, { name: 'README.md' });

  await archive.finalize();
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`[Universal Archiver Engine] Listening on port ${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] Port ${PORT} is already in use by another process.`);
    console.error(`To free port ${PORT} in PowerShell, run:`);
    console.error(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force`);
    console.error(`Or start the server on a different port:`);
    console.error(`  $env:PORT="5001"; npm start\n`);
    process.exit(1);
  } else {
    console.error('[Universal Archiver Engine Error]:', err);
  }
});
