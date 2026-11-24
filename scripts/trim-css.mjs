// 生成 assets/css/classic.css：从线上 293KB 的 z.css 里，只保留"我们真的会渲染的元素"用到的规则。
// 做法：在真实经典页（/question/<qid>/log）上注入完整 CSS + 本项目自己的骨架/回答标记，
// 然后按 selector 是否命中 DOM 来裁剪。命中即保留，包括伪类和属性选择器。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, evaluate } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../assets');
const OUT = path.resolve(ASSETS, 'css/classic.css');
const SRC_CSS = path.resolve(ASSETS, 'classic-live.css');
const QID = process.argv[2] || '558072413';

const css = fs.readFileSync(SRC_CSS, 'utf8');
const log = fs.readFileSync(path.resolve(ASSETS, 'log-question.html'), 'utf8');
console.log('源 CSS:', (Buffer.byteLength(css) / 1024).toFixed(1), 'KB');

// 本项目的回答区标记：必须和 src/render/answer.js 的输出结构保持一致。
// 这里只为"让选择器命中"，内容用占位文本即可。
const SAMPLE_ANSWERS = `
<div class="zh-question-head">
  <div class="zh-question-tags"><a class="zm-item-tag" href="/topic/1">话题</a></div>
</div>
<div id="zh-question-answer-wrap">
  <div class="zm-item-answer" data-aid="1" id="answer-1">
    <div class="zm-votebar"><div class="zm-votebar-inner">
      <span class="count">1.2K</span><span class="zm-vote-label">赞同</span>
    </div></div>
    <div class="answer-head">
      <div class="zm-item-answer-author-info"><img class="zm-item-answer-author-avatar Avatar" src="https://pic1.zhimg.com/x.jpg" loading="lazy" alt=""></div>
      <div class="zm-item-answer-author-wrap"><a class="author-link" href="/people/x">作者</a><span class="bio">一句话介绍</span></div>
    </div>
    <div class="zm-item-rich-text"><div class="zm-editable-content">
      <p>段落<strong>加粗</strong><em>斜体</em><a href="https://example.com">链接</a><code>代码</code></p>
      <blockquote>引用</blockquote>
      <ul><li>列表项</li></ul><ol><li>有序</li></ol>
      <figure><img class="zh-zoomable" src="https://pic1.zhimg.com/x.jpg" loading="lazy" alt=""><figcaption>图注</figcaption></figure>
      <pre><code>printf()</code></pre>
      <table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>
      <hr><h1>h1</h1><h2>h2</h2><h3>h3</h3>
    </div></div>
    <div class="zm-meta-panel">
      <a class="toggle-comment" data-aid="1" data-total="3">3 条评论</a>
      <span class="zh-time">发布于 2022-10-07</span>
    </div>
  </div>
  <div class="zh-answer-placeholder">占位</div>
</div>
<div class="zh-pager" id="zh-pager">
  <a class="zh-load-more" role="button" tabindex="0">加载更多回答</a>
  <span class="zh-pager-end">没有更多回答了</span>
</div>
<div class="zm-side-section"><div class="zm-side-section-inner">
  <h3>问题状态</h3>
  <div class="side-row">回答数 <strong>1</strong></div>
  <div class="zg-gray-normal"><a href="?zh_raw=1" id="zh-exit-raw">退出经典版（看原页面）</a></div>
  <div class="zg-gray-normal" id="zh-source-info">当前：官方接口</div>
</div></div>
<div class="zh-img-overlay" style="display:flex"><img alt=""></div>
`;

const c = await connect(9222, /zhihu/);
await c.send('Page.enable');
await c.send('Page.navigate', { url: `https://www.zhihu.com/question/${QID}/log` });
await new Promise((r) => setTimeout(r, 4500));

const injected = await evaluate(c, `(function () {
  // 1) 注入完整 CSS 为同源 style，才能读 cssRules
  var old = document.getElementById('__trim_src');
  if (old) old.remove();
  var st = document.createElement('style');
  st.id = '__trim_src';
  st.textContent = ${JSON.stringify(css)};
  document.head.appendChild(st);

  // 2) 注入本项目自己的标记，让回答区/侧栏/浮层的选择器也能命中
  var oldSample = document.getElementById('__trim_sample');
  if (oldSample) oldSample.remove();
  var host = document.createElement('div');
  host.id = '__trim_sample';
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:960px';
  host.innerHTML = ${JSON.stringify(SAMPLE_ANSWERS)};
  document.body.appendChild(host);

  return st.sheet ? 'ok' : 'failed';
})()`);
if (injected.value !== 'ok') {
  console.error('注入失败', injected);
  process.exit(1);
}

const result = await evaluate(c, `(function () {
  var sheet = document.getElementById('__trim_src').sheet;
  var kept = [], dropped = [], special = [];
  var total = 0, keptN = 0;

  // querySelector 看不出 :hover/:focus/:first-child 这类状态，直接用它判断会把
  // 悬停样式、伪元素装饰全删掉（a:hover 就是典型）。所以先剥掉伪类再匹配；
  // 剥完还是空的（如 :root）就保留。宁可多留几百字节，也不能让视觉掉细节。
  function stripPseudo(sel) {
    return sel
      .replace(/::[a-zA-Z-]+(\\([^)]*\\))?/g, '')          // 伪元素
      .replace(/:(?!:)[a-zA-Z-]+(\\([^()]*(\\([^()]*\\))?[^()]*\\))?/g, '')  // 伪类
      .replace(/\\s+/g, ' ')
      .trim();
  }

  function hitOne(sel) {
    sel = String(sel || '').trim();
    if (!sel) return false;
    try { if (document.querySelector(sel)) return true; } catch (e) {}
    var bare = stripPseudo(sel);
    if (!bare) return true;                                  // 纯状态选择器，保守保留
    try { if (document.querySelector(bare)) return true; } catch (e) { return true; }
    return false;
  }

  function hit(selectorText) {
    // 逗号分组：任一子选择器命中就保留整条规则
    var parts = String(selectorText || '').split(',');
    for (var i = 0; i < parts.length; i++) {
      if (hitOne(parts[i])) return true;
    }
    return false;
  }

  function walk(rules) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.type === CSSRule.MEDIA_RULE) {
        var inner = [];
        for (var j = 0; j < rule.cssRules.length; j++) {
          var r2 = rule.cssRules[j];
          if (r2.type !== CSSRule.STYLE_RULE) continue;
          total++;
          if (hit(r2.selectorText)) { inner.push(r2.cssText); keptN++; } else dropped.push(r2.selectorText);
        }
        if (inner.length) {
          special.push('@media ' + rule.conditionText + '{' + inner.join('') + '}');
        }
        continue;
      }
      if (rule.type === CSSRule.STYLE_RULE) {
        total++;
        if (hit(rule.selectorText)) { kept.push(rule.cssText); keptN++; } else dropped.push(rule.selectorText);
        continue;
      }
      // @font-face / @keyframes / @supports 等：保留（体积不大，删了容易出怪问题）
      special.push(rule.cssText);
    }
  }
  walk(sheet.cssRules);

  window.__trimmed = kept.join('\\n') + '\\n' + special.join('\\n');
  return JSON.stringify({
    totalRules: total,
    keptRules: keptN,
    droppedRules: dropped.length,
    keptBytes: new Blob([window.__trimmed]).size,
    droppedSample: dropped.slice(0, 12)
  });
})()`);

const stats = JSON.parse(result.value);
console.log('规则：', stats.totalRules, '→ 保留', stats.keptRules, '（丢', stats.droppedRules, '）');
console.log('体积：', (stats.keptBytes / 1024).toFixed(1), 'KB  ', ((stats.keptBytes / Buffer.byteLength(css)) * 100).toFixed(1) + '%');
console.log('丢弃样例：', stats.droppedSample.join(' | ').slice(0, 300));

const trimmed = await evaluate(c, 'window.__trimmed || ""');
if (!trimmed.value || trimmed.value.length < 2000) {
  console.error('裁剪结果异常');
  process.exit(1);
}

// 只写"从线上裁剪出来的部分"。本项目自己的补充样式在 assets/css/overrides.css，
// 由 build.mjs 拼在 classic.css 之后——分离之后重跑裁剪不会覆盖掉手写覆盖层。
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, trimmed.value.trim() + '\n', 'utf8');
console.log('已写入', OUT, '→', (fs.statSync(OUT).size / 1024).toFixed(1), 'KB');

c.close();
