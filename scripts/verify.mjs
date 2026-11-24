// 端到端验证：把 dist 脚本注入真实登录态浏览器，打开问题页，截图 + 断言
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, evaluate } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.resolve(ROOT, 'dist/zhihu-classic.user.js');
const SHOTS = path.resolve(ROOT, 'shots');
const QID = process.argv[2] || '558072413';
const src = fs.readFileSync(SRC, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, cond, extra) => results.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : (extra || '')]);

const c = await connect(9222, /zhihu/);
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Network.enable');

// 统计脚本执行期间发起了多少请求、其中多少是知乎自己的 JS bundle
const reqs = [];
c.ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch (e) { return; }
  if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url);
});

// 干净的起点
await c.send('Page.navigate', { url: 'about:blank' });
await sleep(500);
await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
reqs.length = 0;

const t0 = Date.now();
await c.send('Page.navigate', { url: `https://www.zhihu.com/question/${QID}` });
await sleep(4500);
const elapsed = Date.now() - t0;

const state = await evaluate(c, `JSON.stringify({
  href: location.href,
  title: document.title,
  booted: !!window.__zhClassicBooted,
  hasTop: !!document.querySelector('.zu-top'),
  hasFooter: !!document.querySelector('#zh-footer'),
  hasWrap: !!document.querySelector('.zu-main'),
  bodyClass: document.body.className,
  answerCount: document.querySelectorAll('.zm-item-answer').length,
  placeholder: (document.querySelector('.zh-answer-placeholder')||{}).textContent || null,
  qTitle: (document.querySelector('#zh-question-title a')||{}).textContent || null,
  sourceInfo: (document.getElementById('zh-source-info')||{}).textContent || null,
  votes: (document.querySelector('.zm-votebar .count')||{}).textContent || null,
  user: (document.querySelector('.zu-top-nav-userinfo .name')||{}).textContent || null,
  pager: (document.querySelector('#zh-pager')||{}).textContent.trim() || null,
  cssLen: (document.getElementById('zh-classic-css')||{}).textContent.length || 0,
  topH: (document.querySelector('.zu-top')||{getBoundingClientRect:()=>({})}).getBoundingClientRect().height,
  wrapW: (document.querySelector('.zu-main')||{getBoundingClientRect:()=>({})}).getBoundingClientRect().width,
  font: getComputedStyle(document.body).font,
})`);
const st = JSON.parse(state.value);
console.log('状态:', JSON.stringify(st, null, 1));

check('脚本接管成功', st.booted === true);
check('顶栏渲染', st.hasTop === true);
check('页脚渲染', st.hasFooter === true);
check('960px 容器', Math.round(st.wrapW) === 960, String(st.wrapW));
check('顶栏高度 ≈46px', Math.abs(st.topH - 45.67) < 2, String(st.topH));
check('body 带 zhi 类', /zhi/.test(st.bodyClass || ''), st.bodyClass);
check('经典 CSS 已内联', st.cssLen > 5000, String(st.cssLen));
check('问题标题已填', !!st.qTitle && st.qTitle !== '加载中…', String(st.qTitle));
check('回答了已渲染', st.answerCount > 0, String(st.answerCount));
check('顶栏显示登录用户', !!st.user && st.user.length > 0, String(st.user));
check('数据源已标明', !!st.sourceInfo && st.sourceInfo !== '等待中…', String(st.sourceInfo));

// 资源占用：知乎自己的 JS bundle 一个都不该执行/加载
const zhihuJs = reqs.filter((u) => /zhihu\.com\/.*\.js/.test(u) || /static\.zhihu\.com\/.*\.js/.test(u));
check('未加载知乎自家 JS bundle', zhihuJs.length === 0, zhihuJs.slice(0, 3).join(', '));
console.log('网络请求数:', reqs.length, '耗时:', elapsed + 'ms');
console.log('请求列表:', reqs.slice(0, 15).join('\n  '));

// 截图
await evaluate(c, 'window.scrollTo(0,0)');
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(SHOTS, 'question-page.png'), Buffer.from(shot.data, 'base64'));
console.log('截图: shots/question-page.png');

console.log('');
console.log(results.map((r) => r[0] + '  ' + r[1] + (r[2] ? '   [' + r[2] + ']' : '')).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log('FAILED=' + failed);
c.close();
process.exit(failed ? 1 : 0);
