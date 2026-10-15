#!/usr/bin/env bash
# exit on error
set -o errexit

npm install --prefix backend
npm install --prefix frontend
npm run build --prefix frontend

# Cache and install Chrome for Puppeteer on Render Linux
PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer npx --prefix backend puppeteer browsers install chrome
