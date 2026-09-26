const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const archiverPkg = require('archiver');
const archiver = archiverPkg.default || archiverPkg;
const { URL } = require('url');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

let livePreviewPages = {};
let sessionCapturedScripts = [];

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) {
      p = p.slice(0, -1);
    }
    return u.origin + p;
  } catch (e) {
    return rawUrl;
  }
}

// True Declarative Shadow DOM Serializer
async function extractFullDOMIncludingShadow(page) {
  return await page.evaluate(() => {
    function serializeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      if (['iframe', 'video', 'audio', 'noscript'].includes(tag)) {
        return '';
      }

      let html = '<' + tag;
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i];
        if (!attr.name.startsWith('on')) {
          html += ' ' + attr.name + '="' + attr.value.replace(/"/g, '&quot;') + '"';
        }
      }
      html += '>';

      // Preserve Shadow Root using standard Declarative Shadow DOM
      if (node.shadowRoot) {
        html += '<template shadowrootmode="open">';
        for (let i = 0; i < node.shadowRoot.childNodes.length; i++) {
          html += serializeNode(node.shadowRoot.childNodes[i]);
        }
        html += '</template>';
      }

      // Preserve normal/slotted child nodes
      for (let i = 0; i < node.childNodes.length; i++) {
        html += serializeNode(node.childNodes[i]);
      }

      html += '</' + tag + '>';
      return html;
    }

    return '<!DOCTYPE html><html><head>' + document.head.innerHTML + '</head><body>' + serializeNode(document.body) + '</body></html>';
  });
}

// Universal UI Action Engine for offline interactivity
const UNIVERSAL_INTERACTION_SCRIPT = `
<script>
  document.addEventListener('DOMContentLoaded', () => {
    // 1. Inter-page local routing
    document.querySelectorAll('a[data-local-link]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = a.getAttribute('data-local-target');
        if (!target) return;

        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'STUDIO_NAVIGATE', fileName: target }, '*');
        } else {
          window.location.href = target;
        }
      });
    });

    // 2. ComposedPath Deep Event Delegation
    document.addEventListener('click', (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];

      for (const el of path) {
        if (!el || !el.tagName) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') break;

        // Hamburger / Sidebar Toggle
        if (
          el.id === 'guide-button' ||
          (el.matches && el.matches('[aria-label*="Guide"], [aria-label*="menu" i], .navbar-toggler, .hamburger, [class*="hamburger"], [id*="hamburger"]'))
        ) {
          e.preventDefault();
          e.stopPropagation();

          const guide = document.querySelector('#guide, tp-yt-app-drawer, ytd-mini-guide-renderer, .sidebar, aside');
          if (guide) {
            const isHidden = window.getComputedStyle(guide).display === 'none' || guide.hasAttribute('hidden') || guide.getAttribute('opened') === 'false';
            if (isHidden) {
              guide.removeAttribute('hidden');
              guide.setAttribute('opened', '');
              guide.style.setProperty('display', 'block', 'important');
              guide.style.setProperty('visibility', 'visible', 'important');
            } else {
              guide.removeAttribute('opened');
              guide.style.setProperty('display', 'none', 'important');
            }
          }
          return;
        }

        // Tabs Switcher
        if (el.matches && el.matches('[role="tab"], .tab, [data-tab], .nav-link')) {
          const list = el.closest('[role="tablist"], .tabs, nav, ul');
          if (list) {
            list.querySelectorAll('[role="tab"], .tab, [data-tab], .nav-link').forEach(t => {
              t.classList.remove('active', 'selected');
              t.setAttribute('aria-selected', 'false');
            });
            el.classList.add('active', 'selected');
            el.setAttribute('aria-selected', 'true');

            const targetId = el.getAttribute('aria-controls') || el.getAttribute('data-target');
            if (targetId) {
              document.querySelectorAll('[role="tabpanel"], .tab-pane, .tab-content > div').forEach(p => {
                p.style.display = 'none';
              });
              const panel = document.getElementById(targetId.replace('#', ''));
              if (panel) panel.style.display = 'block';
            }
          }
          return;
        }

        // Dropdowns & Collapsibles
        if (el.matches && el.matches('button, summary, [aria-expanded], [data-state], [data-toggle="dropdown"], .dropdown-toggle')) {
          if (el.hasAttribute('aria-expanded')) {
            const isExp = el.getAttribute('aria-expanded') === 'true';
            el.setAttribute('aria-expanded', !isExp);
          }
          if (el.hasAttribute('data-state')) {
            const isClosed = el.getAttribute('data-state') === 'closed';
            el.setAttribute('data-state', isClosed ? 'open' : 'closed');
          }
          let next = el.nextElementSibling;
          while (next) {
            if (!next.matches('script, style')) {
              const comp = window.getComputedStyle(next).display;
              next.style.display = (comp === 'none') ? 'block' : 'none';
              break;
            }
            next = next.nextElementSibling;
          }
          return;
        }
      }
    });
  });
</script>
`;

function generateMockServerScript(capturedApis, port = 4000) {
  const routes = (capturedApis || []).map((api, idx) => {
    try {
      const urlObj = new URL(api.url);
      const path = urlObj.pathname;
      return `
// [Endpoint ${idx + 1}] Source: ${api.url}
app.all('${path}', (req, res) => {
  res.json(${JSON.stringify(api.data, null, 2)});
});`;
    } catch (e) {
      return '';
    }
  }).join('\n');

  return `// Auto-generated Developer Mock Backend by Website Cloner Studio
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

${routes}

const PORT = process.env.PORT || ${port};
app.listen(PORT, () => {
  console.log('-------------------------------------------------------');
  console.log('🚀 Developer Mock Backend running on http://localhost:' + PORT);
  console.log('📡 Serving ${(capturedApis || []).length} captured API routes.');
  console.log('-------------------------------------------------------');
});
`;
}

// Live Preview Endpoint for studio iframe
app.get('/api/preview/:filename', (req, res) => {
  const filename = req.params.filename;
  const content = livePreviewPages[filename];
  if (!content) {
    return res.status(404).send('Preview page not found.');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(content);
});

// Main Multi-page Crawl Pipeline
app.get('/api/clone-stream', async (req, res) => {
  const { url, maxPages = 5 } = req.query;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).send('Valid HTTP/HTTPS URL required.');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let browser;
  const capturedApis = [];
  const crawledPages = [];
  sessionCapturedScripts = [];
  const queue = [url];
  const visited = new Set();
  const urlToFilenameMap = {};
  const maxLimit = Math.min(parseInt(maxPages, 10) || 5, 20);
  const targetOrigin = new URL(url).origin;

  try {
    sendSSE(res, { status: 'info', message: '🖥️ Launching Chromium Cloner...' });

    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1440, height: 900 },
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--js-flags="--max-old-space-size=4096"'
      ]
    });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Sniff API responses
    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'] || '';
      const reqUrl = response.url();

      if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) return;

      if (contentType.includes('application/json')) {
        try {
          const json = await response.json();
          if (capturedApis.length < 50 && !capturedApis.some(a => a.url === reqUrl)) {
            capturedApis.push({
              url: reqUrl,
              method: response.request().method(),
              status: response.status(),
              data: json
            });
            const shortUrl = reqUrl.length > 55 ? reqUrl.substring(0, 52) + '...' : reqUrl;
            sendSSE(res, { status: 'info', message: `📡 Sniffed API Endpoint: ${shortUrl}` });
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
      let filename = 'index.html';
      if (pageIndex > 0) {
        try {
          let pathname = new URL(currentUrl).pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]/g, '_');
          filename = `page_${pathname || pageIndex}.html`.replace(/__+/g, '_');
        } catch (e) {
          filename = `page_${pageIndex}.html`;
        }
      }

      urlToFilenameMap[normalizedCurrent] = filename;
      urlToFilenameMap[currentUrl] = filename;

      sendSSE(res, { status: 'info', message: `🌐 [${pageIndex + 1}/${maxLimit}] Processing: ${currentUrl}` });

      try {
        await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 35000 });
      } catch (e) {}

      try {
        await page.waitForSelector('#masthead, header, nav', { timeout: 6000 });
      } catch (e) {}

      await new Promise(r => setTimeout(r, 2000));

      // Extract script tags directly from live DOM
      const pageScriptsInfo = await page.evaluate(() => {
        const inlines = [];
        const externals = [];
        document.querySelectorAll('script').forEach((s) => {
          const src = s.getAttribute('src');
          if (src) {
            externals.push(src);
          } else {
            const code = s.innerText.trim();
            if (code.length > 30) inlines.push(code);
          }
        });
        return { inlines, externals };
      });

      if (pageScriptsInfo.inlines.length > 0) {
        sessionCapturedScripts.push({
          url: `Inline Script (${filename})`,
          fileName: `inline_${filename.replace('.html', '')}.js`,
          content: pageScriptsInfo.inlines.join('\n\n// =====================================\n\n')
        });
      }

      const currentParsedUrl = new URL(currentUrl);
      for (const src of pageScriptsInfo.externals.slice(0, 15)) {
        try {
          const resolvedScriptUrl = new URL(src, currentParsedUrl.href).href;
          if (
            !sessionCapturedScripts.some(s => s.url === resolvedScriptUrl) &&
            !resolvedScriptUrl.includes('google-analytics') &&
            !resolvedScriptUrl.includes('gtag')
          ) {
            const jsRes = await axios.get(resolvedScriptUrl, {
              timeout: 4000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (jsRes.data && typeof jsRes.data === 'string') {
              sessionCapturedScripts.push({
                url: resolvedScriptUrl,
                fileName: `bundle_${sessionCapturedScripts.length + 1}.js`,
                content: jsRes.data
              });
            }
          }
        } catch (e) {}
      }

      const inlineStyles = await page.evaluate(() => {
        let css = '';
        const sheets = Array.from(document.styleSheets).slice(0, 15);
        for (const sheet of sheets) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            for (const rule of rules) css += rule.cssText + '\n';
          } catch (e) {}
        }
        return css;
      });

      const rawHtml = await extractFullDOMIncludingShadow(page);

      const $temp = cheerio.load(rawHtml);$temp('a[href]').each((_, el) => {
        const href = $temp(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const resolved = new URL(href, currentParsedUrl.href);
          if (resolved.origin === targetOrigin) {
            const p = resolved.pathname;
            if (!p.includes('/shorts/') && !p.includes('/watch') && !p.includes('/live')) {
              const cleanHref = normalizeUrl(resolved.href);
              if (!visited.has(cleanHref) && !queue.includes(cleanHref) && queue.length + visited.size < 50) {
                queue.push(cleanHref);
              }
            }
          }
        } catch (e) {}
      });

      crawledPages.push({
        fileName: filename,
        originalUrl: currentUrl,
        rawHtml,
        inlineStyles
      });
    }

    await browser.close();

    sendSSE(res, { status: 'info', message: `📦 Packing ${sessionCapturedScripts.length} JavaScript bundles for developer bundle...` });

    const processedPages = [];
    for (const pageData of crawledPages) {
      const $ = cheerio.load(pageData.rawHtml);
      const parsedPageUrl = new URL(pageData.originalUrl);

      // Strip original scripts from HTML so offline pages do not crash
      $('script').remove();$('link[rel="preload"]').remove();
      $('link[rel="prefetch"]').remove();

      // Inline external stylesheets
      const cssLinks = $('link[rel="stylesheet"]').toArray().slice(0, 8);
      for (const link of cssLinks) {
        const href = $(link).attr('href');
        if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/'))) {
          try {
            const resolvedCssUrl = new URL(href, parsedPageUrl.href).href;
            const cssRes = await axios.get(resolvedCssUrl, { 
              timeout: 4000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (cssRes.data && typeof cssRes.data === 'string') {
              $('head').append(`<style>\n${cssRes.data}\n</style>`);
              $(link).remove();
            }
          } catch (e) {}
        }
      }

      // Convert relative media sources to live absolute URLs
      $('img[src], source[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
          try {
            $(el).attr('src', new URL(src, parsedPageUrl.href).href);
          } catch (e) {}
        }
      });

      if (pageData.inlineStyles) {
        $('head').append(`<style>\n${pageData.inlineStyles}\n</style>`);
      }

      // Remap internal links to local filenames
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        try {
          const resolved = new URL(href, parsedPageUrl.href);
          const normalized = normalizeUrl(resolved.href);

          if (resolved.origin === targetOrigin && urlToFilenameMap[normalized]) {
            const localFileName = urlToFilenameMap[normalized];
            $(el).attr('href', localFileName);$(el).attr('data-local-link', 'true');
            $(el).attr('data-local-target', localFileName);$(el).removeAttr('target');
          } else if (resolved.origin !== targetOrigin) {
            $(el).attr('target', '_blank');$(el).attr('rel', 'noopener noreferrer');
          }
        } catch (e) {}
      });

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

    const rootPage = processedPages[0] ? processedPages[0].html : '';

    sendSSE(res, {
      status: 'complete',
      message: `🎉 All ${processedPages.length} pages ready! Collected ${sessionCapturedScripts.length} scripts in scripts/ folder.`,
      html: rootPage,
      crawledPages: processedPages,
      capturedApis
    });

    res.end();

  } catch (err) {
    if (browser) await browser.close();
    sendSSE(res, { status: 'error', message: `❌ Error: ${err.message}` });
    res.end();
  }
});

// ZIP Exporter: Bundles HTML Pages + Unlinked Scripts + APIs + Mock Server + Detailed README
app.post('/api/download-zip', async (req, res) => {
  const { crawledPages, html, capturedApis } = req.body;

  const pagesToBundle = (crawledPages && crawledPages.length > 0)
    ? crawledPages
    : (html ? [{ fileName: 'index.html', originalUrl: 'Root', html }] : []);

  if (!pagesToBundle.length) {
    return res.status(400).send('No content found to bundle');
  }

  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment('developer-website-package.zip');
  archive.pipe(res);

  // 1. Cloned HTML Pages
  pagesToBundle.forEach(p => {
    archive.append(p.html, { name: p.fileName });
  });

  // 2. Unlinked Scripts Folder
  if (sessionCapturedScripts && sessionCapturedScripts.length > 0) {
    sessionCapturedScripts.forEach(s => {
      archive.append(s.content, { name: `scripts/${s.fileName}` });
    });

    const scriptManifest = sessionCapturedScripts.map(s => ({
      file: `scripts/${s.fileName}`,
      sourceUrl: s.url
    }));
    archive.append(JSON.stringify(scriptManifest, null, 2), { name: 'scripts/manifest.json' });
  }

  // 3. API Manifest & Mock Backend Script
  archive.append(JSON.stringify(capturedApis || [], null, 2), { name: 'api_manifest.json' });
  archive.append(generateMockServerScript(capturedApis || []), { name: 'mock-server.js' });

  // 4. Developer README
  const pagesListMarkdown = pagesToBundle.map(p => `  - \`${p.fileName}\` -> Source: ${p.originalUrl}`).join('\n');
  const scriptsCount = sessionCapturedScripts.length;
  const apisCount = (capturedApis || []).length;

  const detailedReadme = `# 🛠️ Developer Reverse-Engineering & Frontend Bundle

This package was automatically generated by **Website Cloner Studio**. Its primary goal is to provide developers with an offline frontend snapshot, sniffed backend APIs, and the original JavaScript source files without causing live hydration or offline crashes.

---

## 📁 Package Directory & File Manifest

### 1. 📄 HTML Pages (\`*.html\`)
${pagesListMarkdown}
- **Description:** These are the crawled and inter-linked offline HTML frontend pages.
- **Functionality:** All internal navigation links have been remapped to relative file paths. An offline UI polyfill is embedded to keep accordions, dropdowns, and tabs functional without external dependencies.

---

### 2. 📂 \`scripts/\` Directory (${scriptsCount} Scripts Captured)
- **\`scripts/bundle_*.js\`**: External JavaScript bundles (framework libraries, custom modules, app components) loaded by the live site.
- **\`scripts/inline_*.js\`**: Inline JavaScript code blocks extracted from the source HTML.
- **\`scripts/manifest.json\`**: Mapping catalog matching each script file to its original live source URL.
- **IMPORTANT NOTE:** These scripts are **intentionally not linked to the HTML files**. Running production bundles offline often triggers React/Next.js hydration mismatches, cross-origin security errors, and missing backend states that cause white or black screens. This directory is provided strictly for **code inspection, reverse-engineering, and architectural reference**.

---

### 3. 📡 \`api_manifest.json\` (${apisCount} Endpoints Sniffed)
- **Description:** Catalog of all network XHR and Fetch API requests intercepted during the crawl.
- **Contents:**
  - HTTP Method (\`GET\`, \`POST\`, etc.)
  - Target URL Path
  - Full JSON response payload returned by the live backend.

---

### 4. 🚀 \`mock-server.js\`
- **Description:** A standalone Node.js and Express mock server.
- **Functionality:** Serves the responses captured in \`api_manifest.json\` as local API routes, allowing you to run a working local backend without writing route handlers from scratch.

---

## ⚡ Setup & Execution Instructions

### Step 1: Run Frontend (Offline Website)
1. Open your terminal inside this extracted directory.
2. Launch a local static web server:
   \`\`\`bash
   npx serve .
   \`\`\`
   *(Alternatively, open \`index.html\` directly in any web browser).*
3. All internal links will navigate locally between pages.

---

### Step 2: Run Mock Backend Server
To serve captured API routes locally:
1. Install dependencies:
   \`\`\`bash
   npm init -y
   npm install express cors
   \`\`\`
2. Start the mock backend:
   \`\`\`bash
   node mock-server.js
   \`\`\`
3. The server runs at \`http://localhost:4000\` and lists all available endpoints in the console.

---

### Step 3: Inspecting Original JavaScript
- Open the \`scripts/\` folder to study client-side application logic, animations, or component implementations.
- Refer to \`scripts/manifest.json\` to identify the original source endpoint for each bundle.
`;

  archive.append(detailedReadme, { name: 'README.md' });

  await archive.finalize();
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Universal Engine running on http://localhost:${PORT}`));