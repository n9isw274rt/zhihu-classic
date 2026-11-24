// 从真实 /log 页面提取可复用的静态骨架（顶栏、页脚），并脱敏用户信息
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, evaluate } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../assets');
const URL_ = process.argv[2] || 'https://www.zhihu.com/question/558072413/log';

const c = await connect(9222, /zhihu/);
await c.send('Page.enable');
await c.send('Page.navigate', { url: URL_ });
await new Promise((r) => setTimeout(r, 4500));

const r = await evaluate(c, `(function () {
  const out = {};

  // ---- 顶栏 ----
  const top = document.querySelector('.zu-top');
  if (top) out.top = top.outerHTML;

  // ---- 页脚 ----
  const ft = document.querySelector('#zh-footer');
  if (ft) out.footer = ft.outerHTML;

  // ---- 问题侧栏（参考用）----
  const side = document.querySelector('.zu-main-sidebar');
  if (side) out.sidebar = side.outerHTML;

  // ---- body/html class ----
  out.bodyClass = document.body.className.trim();
  out.htmlClass = document.documentElement.className.trim();

  // ---- 页面尺寸 ----
  const cs = getComputedStyle(document.body);
  out.metrics = {
    font: cs.font, color: cs.color, bg: cs.backgroundColor,
    topH: document.querySelector('.zu-top')?.getBoundingClientRect().height,
    wrapW: document.querySelector('.zu-main .zg-wrap, .zg-wrap')?.getBoundingClientRect().width,
  };
  return JSON.stringify(out);
})()`);

const data = JSON.parse(r.value);
console.log('顶栏字节:', data.top?.length, '页脚字节:', data.footer?.length);
console.log('metrics:', JSON.stringify(data.metrics));

// 脱敏：把用户名/头像替换成占位符
function sanitize(html) {
  if (!html) return html;
  return html
    .replace(/\/people\/tjttym123/g, '/people/__USER_TOKEN__')
    .replace(/tjttym123/g, '__USER_NAME__')
    .replace(/https:\/\/pic[x1]\.zhimg\.com\/[^"'\s)]+/g, '__AVATAR_URL__')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\sdata-(?:za|track|click)[a-z-]*="[^"]*"/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

fs.writeFileSync(path.join(ASSETS, 'shell-raw.json'), JSON.stringify({
  top: sanitize(data.top),
  footer: sanitize(data.footer),
  sidebar: sanitize(data.sidebar),
  bodyClass: data.bodyClass,
  htmlClass: data.htmlClass,
  metrics: data.metrics,
}, null, 2), 'utf8');

console.log('已保存 shell-raw.json');
c.close();
