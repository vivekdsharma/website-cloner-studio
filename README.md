# Universal Dual-Engine Web Archiver & Functional Cloner

A resilient, universal dual-engine website archiver, offline cloner, and API rehydration framework built with **Node.js**, **Puppeteer**, **Cheerio**, and **React**.

---

## Architectural Highlights

### 1. Zero Hardcoded Target Logic
The engine contains **no special-case rules, brand regexes, or hardcoded mock datasets**. Any web address—from static documentation to heavy client-side SPAs—is processed autonomously based on universal web standards and runtime heuristics.

### 2. Mode 1: Resilient Native DOM Scraper & Crawler (Strict Priority)
- **Low-Memory Chromium Sandbox:** Configured with `--single-process`, `--disable-dev-shm-usage`, and `--max-old-space-size=384` to prevent OOM crashes.
- **Media Interception:** Aborts video/audio streams and heavy media payloads generically via resource types and file signatures.
- **Dynamic API Sniffer:** Intercepts JSON and streaming state responses (`application/json`, `text/x-component`, `application/ld+json`), cataloging endpoints for mock server generation.
- **Declarative Shadow DOM:** Recursively pierces open Shadow DOM boundaries and serializes them into standard Declarative Shadow DOM syntax (`<template shadowrootmode="open">`) with a recursion depth limit of 30.
- **Server-Side CSS Inlining:** Cheerio inlines external stylesheets to bypass cross-origin browser constraints.
- **Offline Link Rewriting & Polyfill:** Rewrites same-origin links to relative local files (`page_1.html`) and injects an event delegation polyfill for accordions, tabs, and modals.

### 3. Automated Content Verification Guard
Inspects the extracted Mode 1 DOM:
- **Pass Condition:** Extracted HTML $\ge 1500$ bytes **OR** active Shadow DOM roots exist **OR** visible text $\ge 80$ chars **OR** DOM elements $\ge 20$. Authentic DOM is preserved and BFS link discovery proceeds.
- **Fail Condition:** Extracted HTML $< 1500$ bytes **AND** zero shadow roots **AND** visible text $< 80$ chars **AND** DOM elements $< 20$. Flags a dead/auth-blocked shell and automatically falls back to Mode 2.

### 4. Mode 2: Universal Synthetic Functional Rehydration (Fallback Only)
- Derives metadata (`title`, `domain`, `description`, `keywords`) and sniffed APIs.
- When `GEMINI_API_KEY` is provided, requests a self-contained single-file HTML/Tailwind application from Gemini Flash.
- If offline or without an API key, synthesizes a responsive, functional application with client-side CRUD, live search, `localStorage` persistence, and an interactive API telemetry inspector.

### 5. In-Memory Preview & Production ZIP Packaging
- **Live Preview (`GET /api/preview/:filename`):** Direct RAM cache serving with `sandbox` iframe isolation.
- **ZIP Exporter (`POST /api/download-zip`):** Produces a production-grade bundle with:
  - All crawled HTML files (`index.html`, `page_1.html`, ...)
  - `api_manifest.json`
  - Auto-generated `mock-server.js` (Express mock server with registered endpoints)
  - `package.json` for offline execution
  - `README.md` with instructions

---

## Directory Structure

\`\`\`
universal-web-archiver/
├── backend/
│   ├── .puppeteerrc.cjs    # Puppeteer local cache configuration
│   ├── package.json        # Express, Puppeteer, Cheerio, Axios, Archiver, Cors
│   └── server.js           # Universal Dual-Engine API Server
├── frontend/
│   ├── index.html          # Shell container with Inter & JetBrains Mono fonts
│   ├── package.json        # Vite, React, Axios
│   ├── vite.config.js      # Vite dev server configuration
│   └── src/
│       ├── App.jsx         # Control panel, SSE console, and preview framework
│       └── main.jsx        # React root mounter
└── README.md               # Architecture and setup guide
\`\`\`

---

## Getting Started

### 1. Start the Backend
\`\`\`bash
cd backend
npm install
npm start
\`\`\`
The backend server runs on `http://localhost:5000`.

### 2. Start the Frontend
\`\`\`bash
cd frontend
npm install
npm run dev
\`\`\`
The frontend dev server runs on `http://localhost:3000`.

### 3. Running an Archival Session
1. Enter any target URL in the control panel (e.g., `https://example.com`).
2. Choose a crawl depth (1, 3, 5, 10, or 20 pages).
3. Click **Start Universal Extraction**.
4. Observe real-time SSE telemetry in the Dev Console.
5. Interact with the sandboxed preview or switch sub-page tabs.
6. Click **Download Bundle (.zip)** to obtain the offline archive and mock server.
