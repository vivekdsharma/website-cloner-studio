const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Chrome binary ko project folder ke andar cache karega taaki runtime pe persist rahe
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};