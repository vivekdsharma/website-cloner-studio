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
app.use(express.json({ limit: '50mb' }));

let livePreviewPages = {};
let sessionCapturedScripts = [];

function sendSSE(res, data) {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {}
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

      if (node.shadowRoot) {
        html += '<template shadowrootmode="open">';
        for (let i = 0; i < node.shadowRoot.childNodes.length; i++) {
          html += serializeNode(node.shadowRoot.childNodes[i]);
        }
        html += '</template>';
      }

      for (let i = 0; i < node.childNodes.length; i++) {
        html += serializeNode(node.childNodes[i]);
      }

      html += '</' + tag + '>';
      return html;
    }

    return '<!DOCTYPE html><html><head>' + document.head.innerHTML + '</head><body>' + serializeNode(document.body) + '</body></html>';
  });
}

const UNIVERSAL_INTERACTION_SCRIPT = `
<script>
  document.addEventListener('DOMContentLoaded', () => {
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

    document.addEventListener('click', (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      for (const el of path) {
        if (!el || !el.tagName) continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') break;

        if (el.id === 'guide-button' || (el.matches && el.matches('[aria-label*="Guide"], [aria-label*="menu" i], .navbar-toggler, .hamburger, [class*="hamburger"], [id*="hamburger"]'))) {
          e.preventDefault();
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
              document.querySelectorAll('[role="tabpanel"], .tab-pane, .tab-content > div').forEach(p => p.style.display = 'none');
              const panel = document.getElementById(targetId.replace('#', ''));
              if (panel) panel.style.display = 'block';
            }
          }
          return;
        }

        if (el.matches && el.matches('button, summary, [aria-expanded], [data-state], [data-toggle="dropdown"], .dropdown-toggle')) {
          if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', !(el.getAttribute('aria-expanded') === 'true'));
          if (el.hasAttribute('data-state')) el.setAttribute('data-state', el.getAttribute('data-state') === 'closed' ? 'open' : 'closed');
          let next = el.nextElementSibling;
          while (next) {
            if (!next.matches('script, style')) {
              next.style.display = (window.getComputedStyle(next).display === 'none') ? 'block' : 'none';
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
      return `\n// [Endpoint ${idx + 1}] Source: ${api.url}\napp.all('${urlObj.pathname}', (req, res) => {\n  res.json(${JSON.stringify(api.data, null, 2)});\n});`;
    } catch (e) {
      return '';
    }
  }).join('\n');

  return `const express = require('express');\nconst cors = require('cors');\nconst app = express();\napp.use(cors());\napp.use(express.json());\n${routes}\nconst PORT = process.env.PORT || ${port};\napp.listen(PORT, () => console.log('Mock Server running on http://localhost:' + PORT));`;
}

app.get('/api/preview/:filename', (req, res) => {
  const content = livePreviewPages[req.params.filename];
  if (!content) return res.status(404).send('Preview expired or not found.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(content);
});

app.get('/api/clone-stream', async (req, res) => {
  const { url, maxPages = 3 } = req.query;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).send('Valid HTTP/HTTPS URL required.');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Keep-alive timer to prevent Render reverse-proxy timeouts
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 10000);

  let browser;
  const capturedApis = [];
  const crawledPages = [];
  sessionCapturedScripts = [];
  const queue = [url];
  const visited = new Set();
  const urlToFilenameMap = {};
  const maxLimit = Math.min(parseInt(maxPages, 10) || 3, 5); // Keep limits safe on free tier
  const targetOrigin = new URL(url).origin;

  try {
    sendSSE(res, { status: 'info', message: '🖥️ Launching Chromium Engine...' });

    browser = await puppeteer.launch({
      headless: 'new',
      defaultViewport: { width: 1280, height: 720 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--single-process',
        '--js-flags="--max-old-space-size=384"'
      ]
    });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    page.on('response', async (response) => {
      const contentType = response.headers()['content-type'] || '';
      const reqUrl = response.url();
      if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) return;

      if (contentType.includes('application/json')) {
        try {
          const json = await response.json();
          if (capturedApis.length < 25 && !capturedApis.some(a => a.url === reqUrl)) {
            capturedApis.push({
              url: reqUrl,
              method: response.request().method(),
              status: response.status(),
              data: json
            });
            const shortUrl = reqUrl.length > 50 ? reqUrl.substring(0, 47) + '...' : reqUrl;
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
      let filename = pageIndex === 0 ? 'index.html' : `page_${pageIndex}.html`;
      urlToFilenameMap[normalizedCurrent] = filename;
      urlToFilenameMap[currentUrl] = filename;

      sendSSE(res, { status: 'info', message: `🌐 [${pageIndex + 1}/${maxLimit}] Processing: ${currentUrl}` });

      try {
        await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      } catch (e) {}

      await new Promise(r => setTimeout(r, 1500));

      // Extract only up to 5 main script tags to prevent memory bloat
      const pageScriptsInfo = await page.evaluate(() => {
        const inlines = [];
        const externals = [];
        document.querySelectorAll('script').forEach((s) => {
          const src = s.getAttribute('src');
          if (src && externals.length < 6) externals.push(src);
          else if (!src && inlines.length < 3) {
            const code = s.innerText.trim();
            if (code.length > 50 && code.length < 100000) inlines.push(code);
          }
        });
        return { inlines, externals };
      });

      if (pageScriptsInfo.inlines.length > 0) {
        sessionCapturedScripts.push({
          url: `Inline Script (${filename})`,
          fileName: `inline_${filename.replace('.html', '')}.js`,
          content: pageScriptsInfo.inlines.join('\n\n// ---\n\n')
        });
      }

      const currentParsedUrl = new URL(currentUrl);
      for (const src of pageScriptsInfo.externals) {
        try {
          const resolvedScriptUrl = new URL(src, currentParsedUrl.href).href;
          if (!sessionCapturedScripts.some(s => s.url === resolvedScriptUrl) && sessionCapturedScripts.length < 10) {
            const jsRes = await axios.get(resolvedScriptUrl, { timeout: 3000, maxContentLength: 1000000 });
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

      const rawHtml = await extractFullDOMIncludingShadow(page);

      const $temp = cheerio.load(rawHtml);$temp('a[href]').each((_, el) => {
        const href = $temp(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const resolved = new URL(href, currentParsedUrl.href);
          if (resolved.origin === targetOrigin) {
            const cleanHref = normalizeUrl(resolved.href);
            if (!visited.has(cleanHref) && !queue.includes(cleanHref) && queue.length + visited.size < 20) {
              queue.push(cleanHref);
            }
          }
        } catch (e) {}
      });

      crawledPages.push({
        fileName: filename,
        originalUrl: currentUrl,
        rawHtml
      });
    }

    // CRITICAL: Close browser immediately here to free ~300MB RAM before post-processing
    await browser.close();
    browser = null;

    sendSSE(res, { status: 'info', message: `🎨 Post-processing layouts and interlinks...` });

    const processedPages = [];
    for (const pageData of crawledPages) {
      const $ = cheerio.load(pageData.rawHtml);
      const parsedPageUrl = new URL(pageData.originalUrl);

      $('script, link[rel="preload"], link[rel="prefetch"]').remove();

      // Convert relative media to absolute
      $('img[src], source[src]').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !src.startsWith('data:') && !src.startsWith('http')) {
          try {
            $(el).attr('src', new URL(src, parsedPageUrl.href).href);
          } catch (e) {}
        }
      });

      // Remap local navigation
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
        try {
          const resolved = new URL(href, parsedPageUrl.href);
          const normalized = normalizeUrl(resolved.href);
          if (resolved.origin === targetOrigin && urlToFilenameMap[normalized]) {
            const localFileName = urlToFilenameMap[normalized];
            $(el).attr('href', localFileName);
            $(el).attr('data-local-link', 'true');$(el).attr('data-local-target', localFileName);
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

    clearInterval(keepAlive);

    sendSSE(res, {
      status: 'complete',
      message: `🎉 All ${processedPages.length} pages ready! Collected ${sessionCapturedScripts.length} JS bundles.`,
      html: processedPages[0]?.html || '',
      crawledPages: processedPages,
      capturedApis
    });

    res.end();

  } catch (err) {
    clearInterval(keepAlive);
    if (browser) await browser.close();
    sendSSE(res, { status: 'error', message: `❌ Error: ${err.message}` });
    res.end();
  }
});

// ZIP Download Endpoint
app.post('/api/download-zip', async (req, res) => {
  const { crawledPages, html, capturedApis } = req.body;
  const pagesToBundle = (crawledPages && crawledPages.length > 0)
    ? crawledPages
    : (html ? [{ fileName: 'index.html', originalUrl: 'Root', html }] : []);

  if (!pagesToBundle.length) return res.status(400).send('No content found');

  const archive = archiver('zip', { zlib: { level: 9 } });
  res.attachment('developer-website-package.zip');
  archive.pipe(res);

  pagesToBundle.forEach(p => archive.append(p.html, { name: p.fileName }));

  if (sessionCapturedScripts.length > 0) {
    sessionCapturedScripts.forEach(s => archive.append(s.content, { name: `scripts/${s.fileName}` }));
    archive.append(JSON.stringify(sessionCapturedScripts.map(s => ({ file: `scripts/${s.fileName}`, sourceUrl: s.url })), null, 2), { name: 'scripts/manifest.json' });
  }

  archive.append(JSON.stringify(capturedApis || [], null, 2), { name: 'api_manifest.json' });
  archive.append(generateMockServerScript(capturedApis || []), { name: 'mock-server.js' });
  archive.append('# Developer Offline Bundle\nRun `npx serve .` to view cloned site.\nCheck `scripts/` directory for unlinked source code.', { name: 'README.md' });

  await archive.finalize();
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));