#!/usr/bin/env bash
# exit on error
set -o errexit

if [ -d "backend" ]; then
  # Running from repository root
  npm install --prefix backend
  npm install --prefix frontend
  npm run build --prefix frontend
  PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer npx --prefix backend puppeteer browsers install chrome
else
  # Running from inside backend/
  npm install
  npm install --prefix ../frontend
  npm run build --prefix ../frontend
  PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer npx puppeteer browsers install chrome
fi
