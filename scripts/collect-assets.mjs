// 抓登录态下旧版渲染所需的全部资产：
//   1) /question/<qid>/log 的 HTML（2014 服务端页面：top/bottom/z.css 链接）
//   2) 该 CSS 的完整内容
//   3) 一个真实问题页的 v4 接口返回（做 fixture）
//   4) 旧版页面的截图（视觉基准）
import fs from 'node:fs';
import { connect, evaluate } from './cdp.mjs';

const OUT = process.argv[2] || '../assets';
const QID = process.argv[3] || '20756323';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await connect(9222, /zhihu/);
await c.send('Page.enable');
await c.send('Runtime.enable');

const info = await evaluate(c, 'JSON.stringify({href: location.href, title: document.title})');
console.log('当前页面:', info.value);

// ---------- 1. 拉 /log ----------
const logRes = await evaluate(c, `(async () => {
  const r = await fetch('/question/${QID}/log', { credentials: 'include' });
  return JSON.stringify({ status: r.status, url: r.url, html: (await r.text()).slice(0, 400000) });
})()`);
const log = JSON.parse(logRes.value);
console.log('/log:', log.status, 'bytes:', log.html.length);
fs.writeFileSync(OUT + '/log-question.html', log.html, 'utf8');

// ---------- 2. 从 /log 里找 CSS ----------
const cssHref = (log.html.match(/\/static\/revved\/-\/css\/z\.[0-9a-f]+\.css/) || [])[0];
console.log('CSS href:', cssHref);

if (cssHref) {
  const cssRes = await evaluate(c, `(async () => {
    const r = await fetch(${JSON.stringify(cssHref)}, { credentials: 'include' });
    return JSON.stringify({ status: r.status, len: 0, css: await r.text() });
  })()`);
  const css = JSON.parse(cssRes.value);
  console.log('CSS:', css.status, 'bytes:', css.css.length);
  fs.writeFileSync(OUT + '/classic-live.css', css.css, 'utf8');
}

// ---------- 3. v4 接口样本 ----------
const apiRes = await evaluate(c, `(async () => {
  const r = await fetch('/api/v4/questions/${QID}/answers?limit=3&offset=0&include=' +
    encodeURIComponent('data[*].content,data[*].voteup_count,data[*].updated_time,data[*].author.name,data[*].author.headline,data[*].author.avatar_url'),
    { credentials: 'include', headers: { 'x-requested-with': 'fetch' } });
  return JSON.stringify({ status: r.status, body: await r.text() });
})()`);
const api = JSON.parse(apiRes.value);
console.log('v4 answers:', api.status, 'bytes:', api.body.length);
fs.writeFileSync(OUT + '/sample-answers.json', api.body, 'utf8');

// ---------- 4. 截图基准 ----------
await c.send('Page.navigate', { url: `https://www.zhihu.com/question/${QID}/log` });
await sleep(4000);
await evaluate(c, 'window.scrollTo(0,0)');
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT + '/baseline-log.png', Buffer.from(shot.data, 'base64'));
console.log('截图已保存 baseline-log.png');

// ---------- 5. 旧版问题页截图（/log 本身是 2014 页面） ----------
const dims = await evaluate(c, 'JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent})');
console.log('视口:', dims.value);

c.close();
