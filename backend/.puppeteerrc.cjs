const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Cache Chrome binary inside project folder for runtime persistence
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
