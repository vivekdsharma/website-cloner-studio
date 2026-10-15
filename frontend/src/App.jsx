import { useState, useRef, useEffect } from 'react';
import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (typeof window !== 'undefined' && window.location.hostname === 'localhost' && (window.location.port === '5173' || window.location.port === '3000') ? 'http://localhost:5000' : '');

// Senior Developer Micro-Iconography
const GlobeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const TerminalIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const Spinner = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const CheckCircleIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

export default function App() {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(5);
  const [logs, setLogs] = useState([]);
  const [cloning, setCloning] = useState(false);
  const [crawledPages, setCrawledPages] = useState([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [capturedApis, setCapturedApis] = useState([]);
  const [downloading, setDownloading] = useState(false);
  const logsEndRef = useRef(null);

  // Auto-scroll dev console
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Listen for iframe offline navigation messages (e.g. clicking internal links)
  useEffect(() => {
    const handleIframeMessage = (event) => {
      if (event.data && event.data.type === 'STUDIO_NAVIGATE') {
        const targetFile = event.data.fileName;
        const pageIdx = crawledPages.findIndex((p) => p.fileName === targetFile);
        if (pageIdx !== -1) {
          setActivePageIndex(pageIdx);
        }
      }
    };
    window.addEventListener('message', handleIframeMessage);
    return () => window.removeEventListener('message', handleIframeMessage);
  }, [crawledPages]);

  const handleStartClone = (e) => {
    e.preventDefault();
    if (!url || cloning) return;

    setLogs([]);
    setCrawledPages([]);
    setPreviewHtml('');
    setActivePageIndex(0);
    setCapturedApis([]);
    setCloning(true);

    const streamUrl = `${BACKEND_URL}/api/clone-stream?url=${encodeURIComponent(url)}&maxPages=${maxPages}`;
    const eventSource = new EventSource(streamUrl);

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const time = new Date().toLocaleTimeString('en-US', { hour12: false });
        setLogs((prev) => [...prev, { time, text: payload.message, status: payload.status }]);

        if (payload.status === 'complete') {
          const pages = payload.crawledPages || [];
          setCrawledPages(pages);
          setPreviewHtml(payload.html || '');
          setCapturedApis(payload.capturedApis || []);

          const indexPos = pages.findIndex((p) => p.fileName === 'index.html');
          setActivePageIndex(indexPos !== -1 ? indexPos : 0);

          setCloning(false);
          eventSource.close();
        } else if (payload.status === 'error') {
          setCloning(false);
          eventSource.close();
        }
      } catch (err) {
        console.error('SSE Payload parsing error:', err);
      }
    };

    eventSource.onerror = () => {
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      setLogs((prev) => [...prev, { time, text: '[connection] Event stream completed or closed by server.', status: 'info' }]);
      setCloning(false);
      eventSource.close();
    };
  };

  const handleDownloadZip = async () => {
    const pagesPayload = crawledPages && crawledPages.length > 0
      ? crawledPages
      : (previewHtml ? [{ fileName: 'index.html', originalUrl: url || 'Root', html: previewHtml }] : []);

    if (!pagesPayload.length || downloading) return;

    try {
      setDownloading(true);
      const response = await axios.post(
        `${BACKEND_URL}/api/download-zip`,
        { crawledPages: pagesPayload, html: previewHtml, capturedApis },
        { responseType: 'blob' }
      );
      const blob = new Blob([response.data], { type: 'application/zip' });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.setAttribute('download', 'developer-website-package.zip');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(downloadUrl);
    } catch (e) {
      alert('Archive download failed: ' + (e.message || 'Server error'));
    } finally {
      setDownloading(false);
    }
  };

  const activePageFileName = crawledPages[activePageIndex]?.fileName || (previewHtml ? 'index.html' : '');
  const previewServerUrl = activePageFileName ? `${BACKEND_URL}/api/preview/${activePageFileName}` : '';

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#09090b', color: '#f4f4f5', fontFamily: 'Inter, system-ui, -apple-system, sans-serif' }}>
      
      {/* LEFT: WORKSPACE CONTROL PANEL */}
      <aside style={{
        width: '430px',
        minWidth: '430px',
        borderRight: '1px solid rgba(255, 255, 255, 0.08)',
        display: 'flex',
        flexDirection: 'column',
        background: '#0c0c0e',
        padding: '24px',
        gap: '20px'
      }}>
        {/* Brand Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '15px', fontWeight: '600', letterSpacing: '-0.02em', color: '#fff' }}>
                Universal Archiver Engine
              </span>
              <span style={{
                fontSize: '10px',
                fontWeight: '500',
                padding: '2px 6px',
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '4px',
                color: '#a1a1aa'
              }}>
                v2.1 Pro
              </span>
            </div>
            <p style={{ fontSize: '12px', color: '#71717a', marginTop: '2px' }}>
              Declarative Shadow DOM & API Sniffer
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: cloning ? '#f59e0b' : (crawledPages.length > 0 ? '#10b981' : '#52525b'),
              boxShadow: cloning ? '0 0 8px rgba(245, 158, 11, 0.5)' : 'none',
              transition: 'all 0.2s ease'
            }} />
            <span style={{ fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: '500' }}>
              {cloning ? 'Crawling' : (crawledPages.length > 0 ? 'Ready' : 'Idle')}
            </span>
          </div>
        </div>

        {/* Target URL Input Form */}
        <form onSubmit={handleStartClone} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', fontWeight: '500', color: '#a1a1aa', marginBottom: '6px', letterSpacing: '0.02em' }}>
              TARGET URL
            </label>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              background: '#141417',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '6px',
              padding: '0 12px',
              transition: 'border-color 0.15s ease'
            }}>
              <span style={{ color: '#52525b', display: 'flex', alignItems: 'center', marginRight: '8px' }}>
                <GlobeIcon />
              </span>
              <input
                type="url"
                required
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={cloning}
                style={{
                  width: '100%',
                  padding: '10px 0',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#fff',
                  fontSize: '13px',
                  fontFamily: 'inherit'
                }}
              />
            </div>
          </div>

          {/* Crawl Depth Segmented Control */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: '500', color: '#a1a1aa', letterSpacing: '0.02em' }}>
                CRAWL DEPTH
              </label>
              <span style={{ fontSize: '11px', color: '#52525b' }}>{maxPages} pages max</span>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              background: '#141417',
              padding: '3px',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              gap: '3px'
            }}>
              {[1, 3, 5, 10, 20].map((num) => (
                <button
                  key={num}
                  type="button"
                  disabled={cloning}
                  onClick={() => setMaxPages(num)}
                  style={{
                    padding: '6px 0',
                    fontSize: '11px',
                    fontWeight: maxPages === num ? '600' : '400',
                    background: maxPages === num ? '#27272a' : 'transparent',
                    color: maxPages === num ? '#ffffff' : '#71717a',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: cloning ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {num}P
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={cloning}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px',
              background: cloning ? '#27272a' : '#ffffff',
              color: cloning ? '#71717a' : '#09090b',
              border: 'none',
              borderRadius: '6px',
              fontWeight: '500',
              fontSize: '13px',
              cursor: cloning ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s ease',
              marginTop: '4px'
            }}
          >
            {cloning ? (
              <>
                <Spinner />
                <span>Processing Target Pipeline...</span>
              </>
            ) : (
              <span>Start Universal Extraction</span>
            )}
          </button>
        </form>

        {/* Download Artifact Banner */}
        {crawledPages.length > 0 && (
          <div style={{
            background: '#141417',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '6px',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: '#10b981' }}><CheckCircleIcon /></span>
                <span style={{ fontSize: '12px', fontWeight: '500', color: '#f4f4f5' }}>Archive Ready</span>
              </div>
              <span style={{ fontSize: '11px', color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                {crawledPages.length} Pages · {capturedApis.length} APIs
              </span>
            </div>
            <button
              onClick={handleDownloadZip}
              disabled={downloading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '8px',
                background: downloading ? '#27272a' : 'rgba(255, 255, 255, 0.08)',
                color: '#fff',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '5px',
                fontSize: '12px',
                fontWeight: '500',
                cursor: downloading ? 'wait' : 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              {downloading ? <Spinner /> : <DownloadIcon />}
              <span>{downloading ? 'Building Archive...' : 'Download Bundle (.zip)'}</span>
            </button>
          </div>
        )}

        {/* Dev Console & SSE Telemetry */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: '#050506',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '6px',
          overflow: 'hidden'
        }}>
          {/* Console Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            background: '#0a0a0c'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#a1a1aa', fontSize: '11px', fontWeight: '500' }}>
              <TerminalIcon />
              <span>Dev Console</span>
            </div>
            {logs.length > 0 && (
              <button
                onClick={() => setLogs([])}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#52525b',
                  fontSize: '10px',
                  cursor: 'pointer'
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Console Log Feed */}
          <div style={{
            flex: 1,
            padding: '12px',
            overflowY: 'auto',
            fontFamily: '"JetBrains Mono", "Geist Mono", Menlo, Consolas, monospace',
            fontSize: '11px',
            lineHeight: '1.7',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px'
          }}>
            {logs.length === 0 ? (
              <span style={{ color: '#3f3f46' }}>// Awaiting target URL and launch signal...</span>
            ) : (
              logs.map((log, i) => {
                const isError = log.status === 'error' || log.text.includes('[error]');
                const isDone = log.status === 'complete' || log.text.includes('[bundle]');
                const isClone = log.text.includes('[clone]') || log.text.includes('[check]');
                const isReport = log.text.includes('[report]') || log.text.includes('[detect]');
                const isSniff = log.text.includes('[sniff]');
                const isCrawl = log.text.includes('[crawl]');

                let textColor = '#d4d4d8';
                if (isError) textColor = '#f87171';
                else if (isDone || isClone) textColor = '#4ade80';
                else if (isReport) textColor = '#f59e0b';
                else if (isSniff) textColor = '#fbbf24';
                else if (isCrawl) textColor = '#38bdf8';

                return (
                  <div key={i} style={{ display: 'flex', gap: '8px', wordBreak: 'break-all' }}>
                    <span style={{ color: '#52525b', flexShrink: 0 }}>{log.time}</span>
                    <span style={{ color: textColor }}>{log.text}</span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </aside>

      {/* RIGHT: REALISTIC BROWSER PREVIEW FRAMEWORK */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#09090b', padding: '16px' }}>
        
        {/* Browser Mockup Shell */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: '#111113',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '8px',
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)'
        }}>
          
          {/* Top Window Chrome */}
          <div style={{
            height: '40px',
            background: '#161619',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            gap: '12px'
          }}>
            {/* macOS Window Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ef4444', opacity: 0.8 }} />
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', opacity: 0.8 }} />
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10b981', opacity: 0.8 }} />
            </div>

            {/* Address Bar */}
            <div style={{
              flex: 1,
              maxWidth: '560px',
              height: '26px',
              background: '#09090b',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '5px',
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              gap: '8px',
              color: '#71717a',
              fontSize: '11px'
            }}>
              <LockIcon />
              <span style={{ color: '#d4d4d8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {previewServerUrl ? `sandbox://${activePageFileName}` : 'sandbox://idle'}
              </span>
            </div>

            {/* Quick Actions */}
            {previewServerUrl && (
              <a
                href={previewServerUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  color: '#a1a1aa',
                  textDecoration: 'none',
                  fontSize: '11px',
                  marginLeft: 'auto',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  transition: 'background 0.15s ease'
                }}
              >
                <span>New Tab</span>
                <ExternalLinkIcon />
              </a>
            )}
          </div>

          {/* Route Tab Strip (Multi-Page Switcher) */}
          {crawledPages.length > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              padding: '6px 12px',
              gap: '4px',
              background: '#121214',
              borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
              overflowX: 'auto'
            }}>
              {crawledPages.map((page, idx) => {
                const isActive = activePageIndex === idx;
                return (
                  <button
                    key={idx}
                    onClick={() => setActivePageIndex(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 10px',
                      borderRadius: '4px',
                      background: isActive ? '#27272a' : 'transparent',
                      color: isActive ? '#ffffff' : '#71717a',
                      border: 'none',
                      fontSize: '11px',
                      fontFamily: '"JetBrains Mono", monospace',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <span>{page.fileName}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Iframe Viewport Canvas */}
          <div style={{ flex: 1, position: 'relative', background: '#09090b' }}>
            {previewServerUrl ? (
              <iframe
                title="Sandbox Viewport"
                src={previewServerUrl}
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  background: '#ffffff'
                }}
              />
            ) : (
              <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                color: '#52525b'
              }}>
                <div style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '8px',
                  border: '1px dashed #27272a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#71717a'
                }}>
                  <GlobeIcon />
                </div>
                <p style={{ fontSize: '13px', color: '#71717a', fontWeight: '500' }}>
                  No Active Archival Session
                </p>
                <p style={{ fontSize: '11px', color: '#52525b', maxWidth: '320px', textAlign: 'center' }}>
                  Enter any web address and launch the engine. Captured pages and APIs will render here in real time.
                </p>
              </div>
            )}
          </div>

        </div>
      </main>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
