import { useState, useRef, useEffect } from 'react';
import axios from 'axios';

export default function App() {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(5);
  const [logs, setLogs] = useState([]);
  const [cloning, setCloning] = useState(false);
  const [crawledPages, setCrawledPages] = useState([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [capturedApis, setCapturedApis] = useState([]);
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Handle intra-iframe navigation messages
  useEffect(() => {
    const handleIframeMessage = (event) => {
      if (event.data && event.data.type === 'STUDIO_NAVIGATE') {
        const targetFile = event.data.fileName;
        const pageIdx = crawledPages.findIndex(p => p.fileName === targetFile);
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

    const streamUrl = `http://localhost:5000/api/clone-stream?url=${encodeURIComponent(url)}&maxPages=${maxPages}`;
    const eventSource = new EventSource(streamUrl);

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setLogs((prev) => [...prev, payload.message]);

        if (payload.status === 'complete') {
          const pages = payload.crawledPages || [];
          setCrawledPages(pages);
          setPreviewHtml(payload.html || '');
          setCapturedApis(payload.capturedApis || []);

          const indexPos = pages.findIndex(p => p.fileName === 'index.html');
          setActivePageIndex(indexPos !== -1 ? indexPos : 0);

          setCloning(false);
          eventSource.close();
        } else if (payload.status === 'error') {
          setCloning(false);
          eventSource.close();
        }
      } catch (err) {
        console.error('SSE Error:', err);
      }
    };

    eventSource.onerror = () => {
      setLogs((prev) => [...prev, '❌ Connection closed.']);
      setCloning(false);
      eventSource.close();
    };
  };

  const handleDownloadZip = async () => {
    const pagesPayload = (crawledPages && crawledPages.length > 0)
      ? crawledPages
      : (previewHtml ? [{ fileName: 'index.html', html: previewHtml }] : []);

    if (!pagesPayload.length) return;

    try {
      const response = await axios.post(
        'http://localhost:5000/api/download-zip',
        { 
          crawledPages: pagesPayload, 
          html: previewHtml,
          capturedApis
        },
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
    } catch (e) {
      alert('Download failed');
    }
  };

  const activePageFileName = crawledPages[activePageIndex]?.fileName || (previewHtml ? 'index.html' : '');
  const previewServerUrl = activePageFileName ? `http://localhost:5000/api/preview/${activePageFileName}` : '';

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'system-ui, sans-serif', backgroundColor: '#0f172a', color: '#f8fafc', overflow: 'hidden' }}>
      
      {/* LEFT CONTROL PANEL */}
      <div style={{ width: '450px', minWidth: '450px', borderRight: '1px solid #334155', display: 'flex', flexDirection: 'column', padding: '24px', boxSizing: 'border-box' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 'bold', margin: '0 0 6px 0', color: '#38bdf8' }}>
          Website Cloner Studio
        </h1>
        <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 16px 0' }}>
          Multi-page Link Remapper, CSS Inliner, JS Bundler & API Sniffer.
        </p>

        <form onSubmit={handleStartClone} style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '14px' }}>
          <input
            type="url"
            required
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={cloning}
            style={{
              padding: '12px 14px',
              backgroundColor: '#1e293b',
              border: '1px solid #475569',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '14px',
              outline: 'none'
            }}
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ fontSize: '13px', color: '#94a3b8' }}>Pages to Crawl:</label>
            <select
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
              disabled={cloning}
              style={{
                backgroundColor: '#1e293b',
                color: '#fff',
                border: '1px solid #475569',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '13px'
              }}
            >
              <option value="3">3 Pages</option>
              <option value="5">5 Pages</option>
              <option value="10">10 Pages</option>
              <option value="15">15 Pages</option>
              <option value="20">20 Pages</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={cloning}
            style={{
              padding: '12px',
              backgroundColor: cloning ? '#475569' : '#0284c7',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: '600',
              cursor: cloning ? 'not-allowed' : 'pointer',
              fontSize: '14px'
            }}
          >
            {cloning ? 'Cloning & Interlinking...' : 'Launch Universal Clone'}
          </button>
        </form>

        {(crawledPages.length > 0 || previewHtml) && (
          <button
            onClick={handleDownloadZip}
            style={{
              padding: '12px',
              backgroundColor: '#10b981',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: '600',
              cursor: 'pointer',
              fontSize: '14px',
              marginBottom: '14px'
            }}
          >
            ⬇️ Download Developer Package ({crawledPages.length} Pages + JS Files + Mock APIs)
          </button>
        )}

        <div style={{ flex: 1, backgroundColor: '#020617', borderRadius: '8px', border: '1px solid #1e293b', padding: '14px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6' }}>
          <div style={{ color: '#64748b', marginBottom: '8px' }}>--- ENGINE LOGS ---</div>
          {logs.map((log, index) => (
            <div key={index} style={{ color: log.startsWith('❌') ? '#ef4444' : log.startsWith('🎉') ? '#10b981' : log.startsWith('⚡') ? '#38bdf8' : log.startsWith('📡') ? '#f59e0b' : '#cbd5e1' }}>
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* RIGHT PREVIEW PANEL */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#1e293b' }}>
        
        {/* Page Switcher Tabs */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#0f172a', overflowX: 'auto' }}>
          {crawledPages.length > 0 ? (
            crawledPages.map((p, idx) => (
              <button
                key={idx}
                onClick={() => setActivePageIndex(idx)}
                style={{
                  backgroundColor: activePageIndex === idx ? '#0284c7' : '#1e293b',
                  color: '#fff',
                  border: '1px solid #475569',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                📄 {p.fileName}
              </button>
            ))
          ) : (
            <span style={{ fontSize: '13px', color: '#94a3b8' }}>Preview Window</span>
          )}
        </div>

        <div style={{ flex: 1, padding: '16px', boxSizing: 'border-box' }}>
          {previewServerUrl ? (
            <iframe
              title="Cloned View"
              src={previewServerUrl}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                borderRadius: '8px',
                backgroundColor: '#ffffff'
              }}
            />
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '14px' }}>
              Enter any website URL to preview cloned pages and switch tabs here.
            </div>
          )}
        </div>
      </div>

    </div>
  );
}