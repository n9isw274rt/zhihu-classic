// ==UserScript==
// @name         知乎 · 经典版
// @namespace    https://github.com/n9isw274rt/zhihu-classic
// @version      0.1.0
// @description  回到 2014 年的知乎经典界面：静态骨架先行渲染，不加载原站页面；数据能从接口拿到就取，拿不到就降级，界面不变。
// @author       n9isw274rt
// @match        https://www.zhihu.com/question/*
// @run-at       document-start
// @noframes
// @grant        none
// @homepageURL  https://github.com/n9isw274rt/zhihu-classic
// @supportURL   https://github.com/n9isw274rt/zhihu-classic/issues
// @updateURL    https://raw.githubusercontent.com/n9isw274rt/zhihu-classic/dist/zhihu-classic.user.js
// @downloadURL  https://raw.githubusercontent.com/n9isw274rt/zhihu-classic/dist/zhihu-classic.user.js
// ==/UserScript==

(function () {
'use strict';

/* ===== src/core/html.js ===== */
/* 通用 HTML 工具：转义、时间、数字格式化。零依赖、无副作用。 */

var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
}

// 只允许站内相对路径或 https 图片，挡住 javascript: 之类
function safeUrl(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/(?!\/)/.test(u)) return u;
  return '';
}

var MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

// 经典版的时间格式：2022-10-07
function fmtDate(unixSec) {
  var n = Number(unixSec);
  if (!n || n < 0) return '';
  var d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + MONTHS[d.getMonth()] + '-' + ('0' + d.getDate()).slice(-2);
}

// 赞同数：1024 → 1K，与旧版一致用整数缩写（不引入 1.2K 这类小数值）
function fmtCount(n) {
  var v = Number(n) || 0;
  if (v >= 10000) return Math.round(v / 1000) + 'K';
  if (v >= 1000) return (Math.round(v / 100) / 10) + 'K';
  return String(v);
}

function num(n) {
  return Number(n) || 0;
}

/* ===== src/core/net.js ===== */
/* 统一请求层：超时、一次重试、并发上限。
   所有网络出口只走这里，方便日后统一加签名、换域名或整体关停。 */

var NET = {
  TIMEOUT: 12000,
  inflight: 0,
  MAX_CONCURRENT: 4,
  // 数据源可用性记录：失败过的源在一段时间内降权，避免每次都等超时
  downUntil: {}
};

function netPending() {
  return NET.inflight >= NET.MAX_CONCURRENT;
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () {
      reject(new Error('TIMEOUT after ' + ms + 'ms'));
    }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); },
                 function (e) { clearTimeout(t); reject(e); });
  });
}

// fetchJSON/fetchText 共用：带 cookie、带 x-requested-with（知乎接口要这个头）
function request(url, asText, retried) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  NET.inflight++;
  var p = fetch(url, {
    credentials: 'include',
    headers: { 'x-requested-with': 'fetch' },
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return asText ? res.text() : res.json();
  });

  return withTimeout(p, NET.TIMEOUT)
    .then(function (v) {
      NET.inflight--;
      return v;
    }, function (e) {
      NET.inflight--;
      if (ctrl) ctrl.abort();
      // 只重试一次。403 也算可重试：实测知乎会瞬时限流，隔一下再发就通了。
      var transient = !e.status || e.status >= 500 || e.status === 403 ||
                      /TIMEOUT|Failed to fetch|NetworkError/.test(String(e.message));
      if (!retried && transient) {
        return new Promise(function (res) { setTimeout(res, 400); })
          .then(function () { return request(url, asText, true); });
      }
      throw e;
    });
}

function fetchJSON(url) {
  return request(url, false, false);
}

function fetchText(url) {
  return request(url, true, false);
}

// 逐个尝试候选地址，第一个成功的胜出；全部失败则抛出最后一个错误
function firstSuccess(tasks) {
  return new Promise(function (resolve, reject) {
    var i = 0;
    var errors = [];
    function next() {
      if (i >= tasks.length) {
        var e = new Error('所有数据源均不可用');
        e.causes = errors;
        return reject(e);
      }
      var task = tasks[i++];
      Promise.resolve()
        .then(task)
        .then(resolve)
        .catch(function (err) {
          errors.push(err);
          console.warn('[zhihu-classic] 数据源失败，降级：', err && err.message);
          next();
        });
    }
    next();
  });
}

/* ===== src/sources/sanitize.js ===== */
/* 正文清洗：知乎返回的 content 是 HTML，直接塞进页面等于让第三方脚本执行。
   用 DOMParser 解析后删除可执行节点和事件属性，再序列化回来——比正则可靠。 */

var ALLOWED_TAGS = {
  P: 1, BR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, DEL: 1, S: 1, SUB: 1, SUP: 1,
  BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, A: 1, IMG: 1, HR: 1,
  H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
  PRE: 1, CODE: 1, SPAN: 1, DIV: 1, FIGURE: 1, FIGCAPTION: 1, TABLE: 1,
  THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1
};

var DROP_TAGS = {
  SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1,
  FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, SVG: 1, MATH: 1,
  VIDEO: 1, AUDIO: 1, SOURCE: 1, TRACK: 1, CANVAS: 1, NOSCRIPT: 1, TEMPLATE: 1
};

function cleanContent(html) {
  if (!html) return '';
  var src = String(html);
  // 快路径：没有标签就是纯文本
  if (src.indexOf('<') === -1) return esc(src);

  var doc;
  try {
    doc = new DOMParser().parseFromString(src, 'text/html');
  } catch (e) {
    return esc(src);
  }
  if (!doc || !doc.body) return esc(src);

  (function walk(node) {
    var kids = Array.prototype.slice.call(node.childNodes);
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.nodeType === 1) {
        if (DROP_TAGS[el.tagName]) {
          el.parentNode.removeChild(el);
          continue;
        }
        // 剥掉所有 on* 事件属性与 style（style 可被用来覆盖整页）
        var attrs = Array.prototype.slice.call(el.attributes || []);
        for (var k = 0; k < attrs.length; k++) {
          var an = attrs[k].name.toLowerCase();
          var av = attrs[k].value;
          if (an.indexOf('on') === 0 || an === 'style' || an === 'srcdoc' ||
              an === 'formaction' || an === 'xlink:href') {
            el.removeAttribute(attrs[k].name);
            continue;
          }
          if ((an === 'href' || an === 'src') && /^\s*(javascript|data|vbscript):/i.test(av)) {
            el.removeAttribute(attrs[k].name);
          }
        }
        if (el.tagName === 'A') {
          // 站内相对链接保留，站外一律 https
          var href = el.getAttribute('href') || '';
          var safe = safeUrl(href);
          if (safe) el.setAttribute('href', safe);
          else el.removeAttribute('href');
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        if (el.tagName === 'IMG') {
          el.setAttribute('loading', 'lazy');
          el.removeAttribute('srcset');
          // 知乎的懒加载图：data-actualsrc / data-original 才是真地址
          if (!el.getAttribute('src') || /^data:/.test(el.getAttribute('src') || '')) {
            var real = el.getAttribute('data-actualsrc') || el.getAttribute('data-original') ||
                       el.getAttribute('data-src') || '';
            if (real) el.setAttribute('src', real);
          }
        }
        if (!ALLOWED_TAGS[el.tagName]) continue;
        walk(el);
      } else if (el.nodeType !== 3) {
        // 注释、CDATA 之类一律删掉
        el.parentNode.removeChild(el);
      }
    }
  })(doc.body);

  return doc.body.innerHTML;
}

/* ===== src/sources/inline.js ===== */
/* 数据源 A：页面内联 JSON（#js-initialData）。
   零网络请求、零等待——只要知乎还把数据内联在 HTML 里，这条就是最快路径。
   注意：问题页首屏通常只带前面几条回答的完整正文，够画首屏。 */

var SOURCE_INLINE = {
  name: 'inline',

  // 从 document 里找 json-inline / js-initialData 并解析成对象；找不到返回 null
  read: function () {
    var el = document.getElementById('js-initialData');
    if (!el) return null;
    try {
      var data = JSON.parse(el.textContent || '{}');
      return data;
    } catch (e) {
      return null;
    }
  },

  // 把 initialData 里能用的回答转成内部结构
  collect: function (data, qid) {
    var state = data && data.initialState;
    var entities = state && state.entities;
    if (!entities) return [];

    var answers = entities.answers || {};
    var out = [];
    Object.keys(answers).forEach(function (key) {
      var raw = answers[key];
      if (!raw) return;
      // 只取属于当前问题的回答
      var q = raw.question && raw.question.id;
      if (qid && q && String(q) !== String(qid)) return;
      var mapped = SOURCE_INLINE.map(raw);
      if (mapped) out.push(mapped);
    });

    // 顺序：initialData 里没有显式排序时，按赞同数降序（旧版默认按质量排）
    out.sort(function (a, b) { return num(b.votes) - num(a.votes); });
    return out;
  },

  map: function (raw) {
    if (!raw || !raw.id) return null;
    var author = raw.author || {};
    return {
      id: String(raw.id),
      contentHtml: cleanContent(raw.content || raw.excerpt || ''),
      author: {
        name: String(author.name || ''),
        token: String(author.url_token || ''),
        headline: String(author.headline || ''),
        avatar: String(author.avatar_url || '')
      },
      votes: num(raw.voteup_count),
      comments: raw.comment_count == null ? null : num(raw.comment_count),
      updatedTime: num(raw.updated_time || raw.created_time),
      url: '/question/' + (raw.question && raw.question.id ? raw.question.id : '') + '/answer/' + raw.id
    };
  },

  // 问题元信息（标题、回答数、浏览量）
  meta: function (data, qid) {
    var state = data && data.initialState;
    var questions = state && state.entities && state.entities.questions;
    if (!questions) return null;
    var q = questions[qid] || questions[String(qid)];
    if (!q) return null;
    return {
      title: String(q.title || ''),
      answerCount: q.answer_count == null ? null : num(q.answer_count),
      viewCount: q.visit_count == null ? null : num(q.visit_count)
    };
  },

  // 当前登录用户（顶栏用），拿不到就返回 null，骨架会自动显示"登录"
  user: function (data) {
    var state = data && data.initialState;
    var acct = state && (state.account || state.currentUser);
    var u = acct && (acct.currentUser || acct);
    if (!u || !u.name) return null;
    return {
      name: String(u.name || ''),
      token: String(u.url_token || ''),
      avatar: String(u.avatar_url || '')
    };
  }
};

/* ===== src/sources/api.js ===== */
/* 数据源 B：官方 v4 接口。
   这是"有就用、没有就降级"的一环，不能成为唯一来源。
   注意 include 的坑：voteup_count 和 comment_count 同时要，后者会被吞掉，
   所以列表只取正文+赞同，评论数另发一条轻请求补。 */

var SOURCE_API = {
  name: 'api',

  LIST_INCLUDE: 'data[*].content,data[*].voteup_count,data[*].updated_time,' +
                'data[*].author.name,data[*].author.headline,data[*].author.avatar_url,' +
                'data[*].author.url_token',

  PAGE_SIZE: 20,

  answersUrl: function (qid, offset, limit, include) {
    return '/api/v4/questions/' + encodeURIComponent(qid) + '/answers?limit=' + limit +
      '&offset=' + offset + '&include=' + encodeURIComponent(include || SOURCE_API.LIST_INCLUDE);
  },

  fetchPage: function (qid, offset, limit) {
    limit = limit || SOURCE_API.PAGE_SIZE;
    return fetchJSON(SOURCE_API.answersUrl(qid, offset, limit)).then(function (j) {
      var data = (j && j.data) || [];
      var mapped = [];
      for (var i = 0; i < data.length; i++) {
        var m = SOURCE_INLINE.map(data[i]);
        if (m) mapped.push(m);
      }
      // 标题顺带从回答里带出来：/api/v4/questions/{id} 需要签名，实测恒返回 403，
      // 而 answers 每条都带 question.title，白捡一个元信息来源。
      var title = '';
      for (var k = 0; k < data.length; k++) {
        if (data[k] && data[k].question && data[k].question.title) {
          title = String(data[k].question.title);
          break;
        }
      }
      return {
        items: mapped,
        totals: num(j && j.paging && j.paging.totals),
        isEnd: !!(j && j.paging && j.paging.is_end),
        title: title
      };
    });
  },

  // 评论数：单独一条，不参与首屏
  fetchCommentCounts: function (qid, offset, limit) {
    var include = 'data[*].comment_count';
    return fetchJSON(SOURCE_API.answersUrl(qid, offset, limit, include)).then(function (j) {
      var data = (j && j.data) || [];
      var byId = {};
      for (var i = 0; i < data.length; i++) {
        if (data[i] && data[i].comment_count != null) {
          byId[String(data[i].id)] = num(data[i].comment_count);
        }
      }
      return byId;
    });
  },

  // 兜底元信息：2014 年的服务端页面，<title> 里就是问题标题。
  // 它同时是"接口全挂时还能知道这是哪个问题"的最后一道信息来源。
  fetchLogTitle: function (qid) {
    return fetchText('/question/' + encodeURIComponent(qid) + '/log').then(function (html) {
      var m = /<title>([^<]*)<\/title>/i.exec(html || '');
      if (!m) throw new Error('log 页没有 title');
      var title = m[1]
        .replace(/^问题日志\s*[-·—]\s*/, '')
        .replace(/\s*-\s*知乎\s*$/, '')
        .trim();
      if (!title) throw new Error('log 页标题为空');
      return { title: title, answerCount: null, viewCount: null };
    });
  },

  fetchMe: function () {
    return fetchJSON('/api/v4/me').then(function (j) {
      if (!j || !j.name) throw new Error('me 结构不符');
      return {
        name: String(j.name || ''),
        token: String(j.url_token || ''),
        avatar: String(j.avatar_url || '')
      };
    });
  }
};

/* ===== src/sources/index.js ===== */
/* 数据源调度：按"代价从小到大"依次尝试。
   任何一级成功就停；全部失败也返回一个带 cause 的空结果，由 UI 画占位——绝不抛到顶层白屏。 */

var SOURCES = {
  // 拉首屏回答：缓存 → 内联 JSON → v4 接口
  firstAnswers: function (qid) {
    return firstSuccess([
      // 1) 页面内联 JSON：0 请求
      function () {
        var data = SOURCE_INLINE.read();
        var items = SOURCE_INLINE.collect(data, qid);
        if (items.length) {
          return { items: items, totals: items.length, isEnd: false, from: 'inline' };
        }
        throw new Error('内联 JSON 里没有本问题的回答');
      },
      // 2) v4 接口：1 请求
      function () {
        return SOURCE_API.fetchPage(qid, 0, SOURCE_API.PAGE_SIZE).then(function (page) {
          if (!page.items.length) throw new Error('接口返回 0 条回答');
          page.from = 'api';
          return page;
        });
      }
    ]);
  },

  // 问题元信息：内联 → 经典 log 页；全失败返回 null（标题退化成占位，不阻塞阅读）
  questionMeta: function (qid) {
    return firstSuccess([
      function () {
        var m = SOURCE_INLINE.meta(SOURCE_INLINE.read(), qid);
        if (m && m.title) return m;
        throw new Error('内联 JSON 里没有问题元信息');
      },
      function () {
        return SOURCE_API.fetchLogTitle(qid);
      }
    ]).catch(function () { return null; });
  },

  // 当前用户：内联 → 接口，失败返回 null（顶栏显示"登录"，不影响阅读）
  user: function () {
    return firstSuccess([
      function () {
        var u = SOURCE_INLINE.user(SOURCE_INLINE.read());
        if (u && u.name) return u;
        throw new Error('内联 JSON 里没有当前用户');
      },
      function () {
        return SOURCE_API.fetchMe();
      }
    ]).catch(function () { return null; });
  },

  // 后续分页：只有接口，没有就说明到底了
  moreAnswers: function (qid, offset, limit) {
    return SOURCE_API.fetchPage(qid, offset, limit);
  },

  // 评论数：失败就维持"查看评论"，不报错
  commentCounts: function (qid, offset, limit) {
    return SOURCE_API.fetchCommentCounts(qid, offset, limit).catch(function () { return {}; });
  }
};

/* ===== src/render/shell.js ===== */
/* 静态骨架：2014 版的页面框架。
   这一层完全不碰网络、不认知乎字段——骨架能不能渲染，和数据源可用性无关。
   顶栏/页脚的结构取自真实 /static 旧版页面，类名与 z.css 一一对应。 */

var SHELL = {
  // 顶栏。用户信息是"可填空"的：拿不到就空着，不影响布局。
  top: function (user) {
    var u = user || {};
    var name = u.name ? esc(u.name) : '';
    var avatar = u.avatar ? esc(safeUrl(u.avatar)) : '';
    var profile = name
      ? '<div class="top-nav-profile">' +
          '<a href="/people/' + esc(u.token || '') + '" class="zu-top-nav-userinfo">' +
            '<span class="name">' + name + '</span>' +
            (avatar ? '<img class="Avatar" src="' + avatar + '" alt="' + name + '">' : '') +
          '</a>' +
        '</div>'
      : '<div class="top-nav-profile">' +
          '<a href="https://www.zhihu.com/signin" class="zu-top-nav-userinfo">' +
            '<span class="name">登录</span>' +
          '</a>' +
        '</div>';
    return '<div role="navigation" class="zu-top">' +
      '<div class="zg-wrap modal-shifting clearfix" id="zh-top-inner">' +
        '<a href="/" class="zu-top-link-logo" id="zh-top-link-logo">知乎</a>' +
        profile +
      '</div>' +
    '</div>';
  },

  footer: function () {
    return '<div id="zh-footer" class="zh-footer">' +
      '<div class="content zg-wrap clearfix">' +
        '<ul>' +
          '<li><a href="https://liukanshan.zhihu.com" target="_blank">刘看山</a></li>' +
          '<li><a href="/question/19581624" target="_blank">知乎指南</a></li>' +
          '<li><a href="/app" target="_blank">移动应用</a></li>' +
          '<li><a href="/careers">加入知乎</a></li>' +
          '<li><a href="/terms" target="_blank">知乎协议</a></li>' +
          '<li><a href="/jubao" target="_blank">举报投诉</a></li>' +
          '<li><a href="/term/privacy" target="_blank">隐私政策</a></li>' +
          '<li><a href="/contact">联系我们</a></li>' +
        '</ul>' +
        '<span class="copy">&copy; ' + new Date().getFullYear() + ' 知乎</span>' +
      '</div>' +
    '</div>';
  },

  // 问题页整页。answersHtml 传空字符串就是"骨架态"——这就是断网也必须能画出来的东西。
  question: function (ctx) {
    var c = ctx || {};
    return '<!DOCTYPE html>' +
      '<html lang="zh-CN" class="' + (c.htmlClass || 'js') + '">' +
      '<head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="renderer" content="webkit">' +
        '<title>' + esc(c.title || '知乎') + '</title>' +
        '<style id="zh-classic-css">' + c.css + '</style>' +
      '</head>' +
      '<body class="' + (c.bodyClass || 'zhi') + '">' +
        SHELL.top(c.user) +
        '<div class="zg-wrap zu-main clearfix" role="main">' +
          '<div class="zu-main-content">' +
            '<div class="zu-main-content-inner">' +
              (c.tagsHtml || '') +
              '<div id="zh-question-title">' +
                '<h2 class="zm-item-title zm-editable-content">' +
                  '<a href="' + esc(c.questionUrl || '/question/' + (c.qid || '')) + '">' +
                    esc(c.questionTitle || '加载中…') +
                  '</a>' +
                '</h2>' +
              '</div>' +
              '<div class="zh-question-head">' + (c.headHtml || '') + '</div>' +
              '<div id="zh-question-answer-wrap">' + (c.answersHtml || '') + '</div>' +
              '<div class="zh-pager" id="zh-pager"></div>' +
            '</div>' +
          '</div>' +
          '<div class="zu-main-sidebar">' + (c.sidebarHtml || '') + '</div>' +
        '</div>' +
        SHELL.footer() +
      '</body></html>';
  },

  // 侧栏：问题状态 + 出口
  sidebar: function (ctx) {
    var c = ctx || {};
    var stat = '';
    if (c.answerCount != null) {
      stat += '<div class="side-row">回答数 <strong>' + num(c.answerCount) + '</strong></div>';
    }
    if (c.viewCount != null) {
      stat += '<div class="side-row">被浏览 <strong>' + num(c.viewCount) + '</strong> 次</div>';
    }
    return '<div class="zm-side-section">' +
        '<div class="zm-side-section-inner">' +
          '<h3>问题状态</h3>' +
          stat +
          '<div class="zg-gray-normal">' +
            '<a href="?zh_raw=1" id="zh-exit-raw">退出经典版（看原页面）</a>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="zm-side-section">' +
        '<div class="zm-side-section-inner">' +
          '<h3>数据源</h3>' +
          '<div class="zg-gray-normal" id="zh-source-info">等待中…</div>' +
        '</div>' +
      '</div>';
  },

  // 骨架态下的回答区占位：有边框、有高度，不会塌成一团空白
  placeholder: function (text) {
    return '<div class="zh-answer-placeholder">' + esc(text || '正在获取回答…') + '</div>';
  }
};

/* ===== src/render/answer.js ===== */
/* 回答渲染：只认内部结构，不认知乎字段。
   内部结构（由 sources/ 负责生产）：
     { id, contentHtml, author: {name, token, headline, avatar},
       votes, comments, updatedTime, url } */

var ANSWER = {
  // 单条回答。contentHtml 已经在 source 层清洗过（去 script/style/on* 属性）。
  item: function (a) {
    var author = a.author || {};
    var token = author.token || '';
    var nameHtml = token
      ? '<a class="author-link" href="/people/' + esc(token) + '">' + esc(author.name || '匿名用户') + '</a>'
      : '<span class="author-link">' + esc(author.name || '匿名用户') + '</span>';
    var avatar = author.avatar
      ? '<img class="zm-item-img-avatar Avatar" src="' + esc(safeUrl(author.avatar)) + '" alt="' + esc(author.name || '') + '" loading="lazy">'
      : '';
    var headline = author.headline
      ? '<span class="bio">' + esc(author.headline) + '</span>'
      : '';

    return '<div class="zm-item-answer" data-aid="' + esc(a.id) + '" id="answer-' + esc(a.id) + '">' +
      '<div class="zm-votebar">' +
        '<span class="count">' + esc(fmtCount(a.votes)) + '</span>' +
        '<span class="zm-vote-label">赞同</span>' +
      '</div>' +
      '<div class="zm-item-answer-author-info">' +
        (avatar
          ? '<a class="zm-item-link-avatar" href="/people/' + esc(token) + '">' + avatar + '</a>'
          : '') +
        nameHtml +
        headline +
      '</div>' +
      '<div class="zm-item-rich-text">' +
        '<div class="zm-editable-content">' + (a.contentHtml || '') + '</div>' +
      '</div>' +
      '<div class="zm-meta-panel">' +
        // 评论数先只显示"查看评论"，数字回来后由 main 补 —— 不让它挡首屏
        '<a class="toggle-comment" data-aid="' + esc(a.id) + '" data-total="0">查看评论</a>' +
        (a.updatedTime ? '<span class="zh-time">发布于 ' + esc(fmtDate(a.updatedTime)) + '</span>' : '') +
      '</div>' +
    '</div>';
  },

  list: function (items) {
    if (!items || !items.length) return '';
    return items.map(ANSWER.item).join('');
  }
};

/* ===== src/render/home.js ===== */
/* 首页 —— 占位，未实现。
   接的时候按同样的结构来：
     - 骨架：SHELL.home() 画双栏信息流外壳（不依赖数据）
     - 数据：新增 sources/home.js，按 inline → api → dom 降级
     - 渲染：render/home.js 只吃内部结构，不认知乎字段
   现在这个文件只是为了把位置占住，并把"首页还没做"这件事写进代码里。 */

var HOME = {
  implemented: false,

  render: function () {
    return '<div class="zh-answer-placeholder">首页经典版还没做</div>';
  }
};

/* ===== src/main.js ===== */
/* 入口与编排。
   核心顺序：先画骨架（0 网络、不依赖知乎数据）→ 再填数据（可降级）→ 界面永远不变。 */

(function () {
  'use strict';

  if (window.__zhClassicBooted) return;
  window.__zhClassicBooted = true;

  var CLASSIC_CSS = "body, ul, ol, li, p, h1, h2, h3, h4, h5 { margin: 0px; padding: 0px; } button, input, select, textarea { margin: 0px; font-family: inherit; font-size: 100%; } img { border: 0px; } a { text-decoration: none; } a:hover { text-decoration: underline; } .clearfix { } .clearfix::before, .clearfix::after { display: table; content: \"\"; } .clearfix::after { clear: both; } .hide-text { font: 0px / 0 a; color: transparent; text-shadow: none; background-color: transparent; border: 0px; } body.zhi { padding-top: 46px; -webkit-font-smoothing: subpixel-antialiased; } a { color: rgb(34, 85, 153); } a:active { outline: 0px; } body { -webkit-tap-highlight-color: rgba(0, 0, 0, 0); } div[contenteditable], input, textarea, button, a:link { -webkit-tap-highlight-color: rgba(225, 225, 225, 0.5); } input[type=\"text\"]:focus, input[type=\"password\"]:focus, textarea:focus { outline: 0px; } input[type=\"text\"], input[type=\"password\"]:focus { appearance: none; } body { font-family: \"Helvetica Neue\", Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.7; overflow-wrap: break-word; color: rgb(34, 34, 34); background-color: rgb(255, 255, 255); } button { padding: 0px; line-height: 1.7; } h1, h2, h3, h4, h5 { font-weight: 700; font-size: 14px; outline: 0px; } i, em { font-style: italic; } ins { text-decoration: none; padding: 3px 0px; background: rgb(234, 240, 221); color: rgb(91, 121, 24); } .zg-section { margin: 0px 0px 10px; display: block; } .zg-clear::before, .zg-clear::after { content: \" \"; display: block; height: 0px; visibility: hidden; } .zg-clear::after { clear: both; } .zg-clear { height: 1%; } .zg-r5px, .goog-tooltip { border-radius: 5px; } .zg-right { float: right; } .zg-bull { padding: 0px 3px; color: rgb(187, 187, 187); font-family: Arial; } .zg-gray-normal, .zg-link-gray-normal, .zg-link-gray { color: rgb(153, 153, 153); font-weight: 400; } .zg-item-log-detail { border-left: 3px solid rgb(221, 221, 221); padding: 5px 10px; margin: 5px 0px; } .zg-item-log-detail::before, .zg-item-log-detail::after { display: table; content: \"\"; } .zg-item-log-detail::after { clear: both; } .zg-item-log-detail::before, .zg-item-log-detail::after { display: table; content: \"\"; } .zg-item-log-detail::after { clear: both; } .zg-wrap { width: 960px; margin: 0px auto; clear: both; } .zu-main { min-height: 340px; padding: 25px 0px 50px; position: relative; z-index: 2; } .zu-main-content { float: left; width: 100%; } .zu-main-content-inner { position: relative; margin: 0px 328px 0px 0px; } .zu-main-sidebar { position: relative; float: left; margin: 0px 0px 0px -270px; width: 270px; } .zh-footer { clear: both; text-align: right; } .zh-footer, .zh-footer a { color: rgb(153, 153, 153); } .zh-footer .content { padding: 20px 15px; border-top: 1px solid rgb(204, 204, 204); } .zh-footer ul, .zh-footer li { display: inline; } .zh-footer li { list-style: none; } .zh-footer li + li::before { content: \"•\"; margin-right: 3px; padding: 0px 3px; font-family: Arial; color: rgb(187, 187, 187); } .zh-footer .copy { float: left; } input::-webkit-input-placeholder, textarea::-webkit-input-placeholder { color: rgb(153, 153, 153); } input::placeholder, textarea::placeholder { color: rgb(153, 153, 153); } .icon, .tr-icon, .tr-inline-icon, .goog-option-selected .goog-menuitem-checkbox, .zu-edit-button-icon, .zu-top-live-icon, .zh-global-backtotop, .zh-hovercard-arrow, .modal-dialog-title-close, .icon-external, .zg-icon, .zm-profile-icon, .zm-profile-header-icon, .icon-info, .icon-green-check, .icon-big-arrow-left, .icon-big-arrow-right, .icon-weibo, .icon-qzone, .icon-weibo-corner, .icon-big-white-sina, .icon-big-white-qq, .icon-big-white-mail, .icon-delete, .icon-edit { width: 16px; height: 16px; background-image: url(\"/static/revved/img/sprites-1.9.2.4c54885a.png\"); background-repeat: no-repeat; display: inline-block; vertical-align: middle; } .zg-icon-dropdown-menu { margin: 2px; height: 18px; width: 28px; vertical-align: bottom; background-position: -53px -146px; } .zg-icon-settings { width: 16px; height: 16px; background-position: -88px -148px; margin-right: 1px; vertical-align: -5px; } .zg-btn-blue, .zg-btn-green, .zg-btn-red, .zg-btn-white, .zg-btn-disabled { font-size: 14px; line-height: 1.7; vertical-align: middle; display: inline-block; text-align: center; padding: 4px 10px; cursor: pointer; border-radius: 3px; white-space: nowrap; box-sizing: border-box; text-decoration: none !important; } .zg-btn-green, .zg-btn-follow { width: auto; min-width: 78px; text-shadow: rgba(255, 255, 255, 0.3) 0px 1px 0px; background: linear-gradient(rgb(173, 218, 77), rgb(134, 184, 70)); border: 1px solid rgb(109, 143, 41); box-shadow: rgba(255, 255, 255, 0.5) 0px 1px 0px inset, rgba(0, 0, 0, 0.2) 0px 1px 0px; color: rgb(62, 94, 0) !important; } .zg-btn-green:active, .zg-btn-follow:active { background: linear-gradient(rgb(154, 194, 68), rgb(120, 165, 62)); box-shadow: rgba(0, 0, 0, 0.3) 0px 1px 2px inset; } .zg-btn-white { text-shadow: rgb(255, 255, 255) 0px 1px 0px; background: linear-gradient(rgb(248, 248, 249), rgb(230, 230, 232)); border: 1px solid rgb(187, 187, 187); box-shadow: rgb(255, 255, 255) 0px 1px 0px inset, rgba(0, 0, 0, 0.1) 0px 1px 0px; color: rgb(102, 102, 102) !important; } .zg-btn-white:active { background: rgb(221, 221, 221); box-shadow: none; } .zg-follow { color: rgb(105, 142, 191); } html.no-touchevents .zg-follow:hover { color: rgb(34, 85, 153); } .zg-btn-blue, .zg-btn-green, .zg-btn-white, a.follow { } [class*=\"sprite-global-icon-\"] { display: inline-block; vertical-align: middle; } .sprite-global, [class*=\"sprite-global-\"] { background-image: url(\"/static/revved/img/global/sprites.auto.5f2afee2.png\"); background-repeat: no-repeat; } .sprite-global-icon-magnifier-dark { background-position: -82px 0px; width: 15px; height: 15px; } code, .editable pre, .highlight pre { font-family: Menlo, Monaco, Consolas, \"Andale Mono\", \"lucida console\", \"Courier New\", monospace; } .Avatar { width: 25px; height: 25px; border-radius: 3px; background-color: rgb(238, 238, 238); } html.is-AppPromotionBarVisible body { padding-bottom: 60px; } .zu-global-nitify-inner { margin: 0px 30px 0px 25px; } .zu-home-noti-inner { margin: 0px 0px 10px; padding: 0px; } .zm-item { margin: 6px 0px 0px; } .zm-item-answer, .zm-item { position: relative; padding: 0px; outline: 0px; } .zm-item-answer { margin-left: 48px; } .zm-item-answer .answer-head { min-height: 25px; } #zh-question-log-list-wrap .zm-item { padding: 10px 0px 5px; margin: 0px; } #zh-question-answer-wrap .zm-item-answer, .zm-item-answer + .zm-item-answer, .zm-item + .zm-item { border-top: 1px solid rgb(238, 238, 238); } .zm-item + .zm-item { padding-top: 7px; } #zh-question-collapsed-wrap > .zm-item-answer, #zh-question-answer-wrap > .zm-item-answer { padding: 10px 0px 5px; } .zm-meta-panel { padding: 5px 0px; margin-bottom: -5px; background: rgb(255, 255, 255); } .zm-meta-panel > a, .zm-meta-panel > span { color: rgb(153, 153, 153); vertical-align: middle; } .zm-item-meta { position: relative; margin-bottom: 5px; } .zm-item-title { margin: 0px 30px 3px 0px; } .zm-item-answer-author-info { margin: 0px 0px 1px; } #zh-question-title > .zm-item-title { display: inline; margin: 0px; } #zh-question-title { margin: 0px 0px 5px; } .zm-tag-editor { margin: 0px 0px 5px; } #zh-question-title > .zm-item-title { font-size: 18px; } #zh-question-side-header-wrap { position: relative; z-index: 2; } #zh-question-side-header-wrap .follow-button { margin-right: 10px; } #zh-question-collapsed-wrap, #zh-question-answer-wrap { border-bottom: 1px solid rgb(238, 238, 238); } .entry-body .zm-item-vote-info, .entry-body .full-content, .zm-item-answer .zm-votebar, .zm-item-feed .zm-votebar, .zm-item-answer .zm-item-vote-info, .zm-item-feed .zm-item-vote-info { display: none; } .zh-question-followers-sidebar { margin: 15px 0px; } .zm-item-rich-text p, .zm-editable-content p, .editable p, .zm-item-rich-text h2, .zm-editable-content h2, .editable h2 { margin: 12px 0px; } .zm-item-rich-text p:first-child, .zm-editable-content p:first-child, .editable p:first-child, .zm-item-rich-text h2:first-child, .zm-editable-content h2:first-child, .editable h2:first-child { margin-top: 0px; } .zm-item-rich-text ul, .zm-editable-content ul, .editable ul, .zm-item-rich-text ol, .zm-editable-content ol, .editable ol { margin: 0.8em 0px; padding: 0px; } .zm-item-rich-text li, .zm-editable-content li, .editable li { margin: 0px 0px 5px; list-style-position: inside; } blockquote { margin: 0.8em 0px; padding: 0px 0px 0px 10px; font-style: normal; font-size: 100%; line-height: 22px; border-left: 3px solid rgb(208, 229, 242); } .zu-top { position: fixed; top: 0px; left: 0px; z-index: 20; width: 100%; height: 45px; background: linear-gradient(rgb(8, 110, 213), rgb(5, 93, 181)); border-bottom: 1px solid rgb(4, 78, 151); box-shadow: rgba(0, 0, 0, 0.25) 0px 1px 2px, rgba(255, 255, 255, 0.15) 0px 1px 0px inset; } .zu-top .zg-wrap { position: relative; height: inherit; } .zu-top-link-logo { float: left; width: 61px; height: 100%; background-image: url(\"/static/revved/img/sticky_header/new_logo.ede2316d.png\"); background-repeat: no-repeat; background-position: 0px 8px; text-indent: -9999px; color: rgb(255, 255, 255); } .zu-top-link-logo:active { opacity: 0.8; } .zu-top-search { position: relative; float: left; margin: 7px 0px 0px 12px; } .zu-top-search-form { position: relative; width: 367px; } .zu-top-search-form .zu-top-search-button { position: absolute; top: 0px; right: 0px; width: 40px; height: 100%; background: linear-gradient(rgb(14, 123, 239), rgb(13, 115, 218)); border: 1px solid rgb(4, 91, 178); border-top-right-radius: 4px; border-bottom-right-radius: 4px; box-shadow: rgba(0, 0, 0, 0.05) 0px 1px 2px, rgba(255, 255, 255, 0.15) 0px 1px 1px inset; box-sizing: border-box; outline: 0px; cursor: pointer; } .zu-top-search-form .zu-top-search-button::before { content: \"\"; display: inline-block; height: 100%; vertical-align: middle; } .zu-top-search-input { padding: 7px 50px 7px 10px; width: 100%; color: rgb(73, 82, 92); font-size: 14px; line-height: 17px; background-color: rgb(225, 234, 242); border: 1px solid rgb(4, 91, 178); border-radius: 4px; box-shadow: rgba(0, 0, 0, 0.2) 0px 1px 3px inset, rgba(255, 255, 255, 0.1) 0px 1px 0px; outline: 0px; box-sizing: border-box; transition: 0.2s ease-in-out; } .zu-top-search-input::-webkit-input-placeholder { color: rgb(141, 155, 168); } .zu-top-search-input::placeholder { color: rgb(141, 155, 168); } .zu-top-search-input:focus { background-color: rgb(255, 255, 255); box-shadow: rgba(0, 0, 0, 0.2) 0px 1px 3px inset, rgba(255, 255, 255, 0.3) 0px 1px 15px; } .top-nav-topic-selector { position: relative; z-index: 10; } .top-nav-dropdown { display: none; margin: 0px; position: absolute; left: 0px; } .top-nav-dropdown li { margin: 0px; list-style: none; } .top-nav-dropdown li a { display: block; width: 145px; height: 40px; line-height: 40px; color: rgb(255, 255, 255); text-decoration: none; border-top: 1px solid rgb(13, 90, 165); box-shadow: rgba(0, 0, 0, 0.4) 0px 1px 1px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; cursor: pointer; } html.no-touchevents .top-nav-dropdown a:hover { background-color: rgb(2, 103, 204); } .top-nav-dropdown li:first-child > a { border-top: 0px; } .top-nav-dropdown li:last-child > a { border-radius: 0px 0px 4px 4px; } .top-nav-dropdown img, .top-nav-dropdown span { vertical-align: middle; } .top-nav-profile { float: right; position: relative; min-width: 120px; margin-left: 15px; z-index: 10; } .top-nav-profile a { display: block; width: 120px; background-color: rgb(9, 95, 179); text-shadow: rgba(0, 0, 0, 0.12) 0px 1px 1px; font-size: 14px; } .top-nav-profile .top-nav-dropdown { top: 46px; } .top-nav-profile .top-nav-dropdown a { width: 120px; } .open .top-nav-dropdown, html.no-touchevents .top-nav-profile:hover .top-nav-dropdown { display: block; } .top-nav-profile .zu-top-nav-userinfo { position: relative; height: 45px; line-height: 45px; text-indent: 46px; color: rgb(255, 255, 255); text-decoration: none; border-top: 0px; background: transparent; box-shadow: none; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; } .zu-top-nav-userinfo.selected, html.no-touchevents .top-nav-profile:hover .zu-top-nav-userinfo { background: linear-gradient(rgb(5, 95, 184), rgb(9, 95, 179)); box-shadow: rgba(0, 0, 0, 0.12) 0px 0px 2px inset; height: 46px !important; } html.no-touchevents .zu-top-nav-userinfo:hover { background-color: rgb(4, 109, 214); } .zu-top-nav-userinfo .Avatar { position: absolute; top: 9px; left: 10px; border: 1px solid rgba(0, 0, 0, 0.1); box-shadow: rgba(255, 255, 255, 0.1) 0px 1px 0px; background-color: transparent; } .top-nav-dropdown .zg-icon { width: 20px; height: 20px; margin: 0px 11px 0px 15px; vertical-align: -7px; } .zg-icon-dd-home { background-position: -6px -7px; } .zg-icon-dd-pm { background-position: -6px -34px; } .zg-icon-dd-settings { background-position: -6px -60px; } .zg-icon-dd-logout { background-position: -6px -87px; } .zu-top-nav { float: left; position: relative; } .zu-top-nav-live { position: absolute; left: 108px; top: 45px; width: 290px; z-index: 9; background: rgb(255, 255, 255); outline: 0px; } .zu-top-nav-ul { padding: 0px; margin: 0px 0px 0px 18px; } .zu-top-nav-li { position: relative; float: left; margin: 0px; list-style: none; } .zu-top-nav-link, .zu-top-nav-link:visited, .zu-top-nav-link:active { color: rgb(238, 238, 238); } .zu-top-nav-link:hover { color: rgb(255, 255, 255); text-decoration: none; } .zu-top-nav-link { width: 54px; height: 45px; line-height: 45px; text-align: center; display: block; color: rgb(242, 244, 245); text-shadow: rgba(0, 0, 0, 0.12) 0px 1px 1px; font-size: 14px; } .zg-noti-number { background: rgb(191, 16, 49); border: 1px solid rgb(177, 19, 49); box-shadow: rgba(0, 0, 0, 0.1) 0px 1px 2px, rgba(255, 255, 255, 0.15) 0px 1px 0px inset; color: rgb(255, 255, 255); display: inline-block; font-size: 11px; font-weight: 700; text-size-adjust: none; padding: 0px 5px; height: 16px; line-height: 16px; border-radius: 16px; text-indent: 0px; text-align: center; text-decoration: none; } .zu-top-nav-count, .zu-top-nav-userinfo .zu-top-nav-pm-count { z-index: 12; top: 5px; position: absolute; } .zu-top-nav-userinfo .zu-top-nav-pm-count { left: 29px; } .top-nav-profile .top-nav-dropdown .zu-top-nav-pm-count { vertical-align: 1px; margin-left: 8px; } .zu-main-sidebar h3, .zm-side-section h3, .zu-main-sidebar h2, .zm-side-section h2 { margin-bottom: 10px; } .zm-side-section { position: relative; margin-bottom: 15px; } .zm-side-section + .zm-side-section > .zm-side-section-inner { padding: 15px 0px 0px; border-top: 1px solid rgb(238, 238, 238); } .zm-side-section-inner h3 { margin-bottom: 10px; } .zu-global-notify { position: relative; top: -2px; padding: 5px 0px 3px; color: rgb(102, 102, 102); background: rgb(251, 249, 229); box-shadow: rgba(0, 0, 0, 0.1) 0px 1px 1px; } .zu-global-notify-close { float: right; margin: 0px -30px 0px 0px; width: 20px; height: 20px; opacity: 0.5; text-indent: -9999px; background: url(\"/static/revved/img/sprites-1.9.2.4c54885a.png\") -245px -144px no-repeat; } .zu-global-notify-close:hover { opacity: 1; } .zu-global-notify-icon { float: left; margin: 2px 0px 0px -25px; width: 20px; height: 16px; background: url(\"/static/revved/img/sprites-1.9.2.4c54885a.png\") -225px -146px no-repeat; } .zh-backtotop { position: fixed; bottom: 113px; left: 50%; z-index: 19; margin-left: 230px; } .zh-backtotop .btn-action { display: block; width: 38px; height: 38px; background-color: rgb(221, 221, 221); border-radius: 3px; border: 0px; cursor: pointer; position: relative; } .zh-backtotop .arrow, .zh-backtotop .stick { position: absolute; right: 0px; left: 0px; margin: auto; } .zh-backtotop .arrow { width: 0px; height: 0px; top: -1px; border-width: 9px; border-style: solid; border-color: transparent transparent rgb(170, 170, 170); border-image: initial; } .zh-backtotop .stick { width: 8px; height: 14px; top: 15px; border-radius: 1px; background-color: rgb(170, 170, 170); } html.no-touchevents .zh-backtotop .btn-action:hover { background-color: rgb(226, 226, 226); } html.no-touchevents .zh-backtotop .btn-action:hover .arrow { border-bottom-color: rgb(187, 187, 187); } html.no-touchevents .zh-backtotop .btn-action:hover .stick { background-color: rgb(187, 187, 187); } .zh-hovercard-arrow, .zu-top-live-icon { height: 15px; width: 23px; z-index: 101; position: absolute; } .zh-hovercard-arrow.top, .zu-top-live-icon { top: -11px; left: 25px; background-position: -168px -165px; } .zu-top-live-icon { top: -12px; } #zh-tooltip, #zh-hovercard { position: absolute; background: 0px center; z-index: 100; animation: 0.05s ease-in 0s 1 normal both running none; } .zu-top-nav-live { border-radius: 5px; border: 1px solid rgb(187, 187, 187); } .zu-top-nav-live-inner { padding: 10px; border-radius: 5px; border: 3px solid rgb(244, 244, 244); background: rgb(255, 255, 255); } .zm-noti7-frame { width: 100%; height: 300px; overflow: hidden; position: relative; } .zm-noti7-frame-border { height: 1px; width: 100%; position: relative; background: linear-gradient(to right, rgba(250, 250, 250, 0.1) 0px, rgba(240, 240, 240, 0.8) 1%, rgb(221, 221, 221) 4%, rgb(221, 221, 221) 96%, rgba(240, 240, 240, 0.8) 99%, rgba(250, 250, 250, 0.1) 100%); } .zm-noti7-frame-border.top::after { content: \"\"; position: absolute; top: 0px; height: 1px; box-shadow: rgba(0, 0, 0, 0.05) 0px 1px 1px; left: 4px; right: 4px; z-index: 10; } .zm-noti7-frame-border.bottom::after { content: \"\"; position: absolute; top: 0px; height: 1px; box-shadow: rgba(0, 0, 0, 0.05) 0px -1px 1px; left: 4px; right: 4px; z-index: 10; } .zm-noti7-content { width: 315px; height: 100%; overflow-y: scroll; position: relative; } .zu-noti7-popup .zm-noti7-popup-tab-container { outline: 0px; } .zu-noti7-popup .noti-spinner-loading { width: 24px; height: 24px; display: inline-block; background-repeat: no-repeat; } .zm-noti7-popup-footer { vertical-align: middle; } .zm-noti7-popup-footer a { color: rgb(153, 153, 153); display: inline-block; padding: 6px 12px; } .zu-noti7-popup .zu-top-nav-live-inner { padding: 0px; border: 0px; box-shadow: rgba(0, 0, 0, 0.3) 0px 1px 4px; margin: 0px; } .zu-noti7-popup .zu-home-noti-inner { margin: 0px; } .zu-noti7-popup.zu-top-nav-live { width: 315px; left: 52px; top: 48px; border: 1px solid rgb(221, 221, 221); display: none; } .zu-noti7-popup .zu-top-live-icon { left: 144px; width: 25px; background: url(\"/static/revved/img/sprites-1.9.2.4c54885a.png\") -228px -186px no-repeat; } .zm-noti7-popup-loading { padding: 119px 0px; vertical-align: middle; text-align: center; } .zm-noti7-popup-tab-item { float: left; width: 33%; text-align: center; vertical-align: middle; position: relative; cursor: pointer; background: 0px center; border: 0px; outline: 0px; } .zm-noti7-popup-tab-item + .zm-noti7-popup-tab-item { border-left: 1px solid rgb(238, 238, 238); } .zm-noti7-popup-tab-item .icon { position: relative; display: inline-block; width: 22px; line-height: 16px; margin: 9px; text-indent: -9999px; opacity: 0.6; } .zm-noti7-popup-tab-item:active .icon, html.no-touchevents .zm-noti7-popup-tab-item:hover .icon { opacity: 1; } .zm-noti7-popup-tab-item.message .icon { background-position: -94px -66px; } .zm-noti7-popup-tab-item.user .icon { background-position: -123px -65px; } .zm-noti7-popup-tab-item.thanks .icon { background-position: -151px -65px; margin: 10px 0px 6px; } .zm-votebar .count { display: block; } .zm-votebar { float: left; margin-left: -48px; } .zm-item-tag, .zm-tag-editor-edit-item { background: rgb(239, 246, 250); padding: 1px 10px 0px; border-radius: 30px; text-decoration: none; margin: 0px 5px 5px 0px; display: inline-block; float: left; white-space: nowrap; } html.no-touchevents .zm-item-tag:hover, html.no-touchevents .zm-item-tag-x:hover { background: rgb(34, 85, 153); color: rgb(255, 255, 255); text-decoration: none; } @-webkit-keyframes fadeIn { 0% { opacity: 0; } 100% { opacity: 1; } } @keyframes fadeIn { 0% { opacity: 0; } 100% { opacity: 1; } } @-webkit-keyframes fadeInUp { 0% { opacity: 0; transform: translateY(20px); } 100% { opacity: 1; transform: none; } } @keyframes fadeInUp { 0% { opacity: 0; transform: translateY(20px); } 100% { opacity: 1; transform: none; } } @-webkit-keyframes fadeOut { 0% { opacity: 1; } 100% { opacity: 0; } } @keyframes fadeOut { 0% { opacity: 1; } 100% { opacity: 0; } } @-webkit-keyframes fadeOutDown { 0% { opacity: 1; } 100% { opacity: 0; transform: translateY(20px); } } @keyframes fadeOutDown { 0% { opacity: 1; } 100% { opacity: 0; transform: translateY(20px); } } @media (max-width: 767px){.zg-wrap { width: auto; padding-left: 6px; padding-right: 6px; }.zu-main-content-inner { margin: 0px; }.zu-main-content { float: none; }.zu-main-sidebar { float: none; margin: 0px; }} @media (min-width: 768px) and (max-width: 959px){.zg-wrap { width: auto; padding-left: 6px; padding-right: 6px; }.zu-main-content-inner { margin: 0px 300px 0px 0px; }} @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 2dppx), (min-resolution: 192dpi){.icon, i[class^=\"z-icon-\"], .modal-dialog-title-close, .goog-option-selected .goog-menuitem-checkbox, .zg-content-img-icon, .zg-content-video-icon, .tr-icon, .tr-inline-icon, .zg-icon, .icon-external, .feed-item .ignore, .side-topic-item .up, .side-topic-item .delete, .zu-edit-button-icon, .zg-blue-edit, .zm-add-question-detail-icon, .zh-hovercard-arrow, .zu-top-live-icon, .zm-item-top-btn, .zm-profile-icon, .zm-profile-header-icon, .zm-profile-empty-icon, .zu-global-notify-icon, .zu-global-notify-close, .zm-modal-dialog-guide-title-msg, .zm-modal-dialog-guide-title-dropdown, .zm-noti7-popup-tab-item .icon, .zu-noti7-popup .zu-top-live-icon, .icon-info, .icon-green-check, .icon-big-arrow-left, .icon-big-arrow-right, .icon-weibo, .icon-qzone, .icon-weibo-corner, .icon-big-white-sina, .icon-big-white-qq, .icon-big-white-mail, .icon-delete, .icon-edit { background-image: url(\"/static/revved/img/sprites-1.9.2@2x.6e638473.png\"); background-size: 308px 250px; }} @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi){.sprite-global, [class*=\"sprite-global-\"] { background-image: url(\"/static/revved/img/global/sprites@2x.auto.c84bb23a.png\"); background-size: 97px 94px; }} @supports (-webkit-backdrop-filter:blur(18px)) { .GaussianBlur { background-color: rgba(255, 255, 255, 0.68); } } @media (max-width: 1024px){body.zhi { padding-top: 0px !important; }.zu-top { position: static; }.zu-top .modal-shifting { position: static !important; }} @media (max-width: 959px){.zu-top-search-form { width: 240px; }} @media (max-width: 959px){.zu-top-nav-link { width: auto; padding: 0px 10px; }} @media only screen and (-webkit-min-device-pixel-ratio: 2), only screen and (min-device-pixel-ratio:2){.zu-top-link-logo { background-image: url(\"/static/revved/img/sticky_header/new_logo@2x.9187366b.png\") !important; background-size: 61px 30px; }.zg-icon-dd-home { background-position: -5px -7px; }.zg-icon-dd-pm { background-position: -5px -36px; }.zg-icon-dd-settings { background-position: -5px -60px; }.zg-icon-dd-logout { background-position: -5px -87px; }} @-webkit-keyframes select-region { 0% { box-shadow: rgb(198, 226, 255) 0px 0px inset; } 100% { box-shadow: rgb(198, 226, 255) 300px 0px inset; } } @keyframes select-region { 0% { box-shadow: rgb(198, 226, 255) 0px 0px inset; } 100% { box-shadow: rgb(198, 226, 255) 300px 0px inset; } } @-webkit-keyframes move1 { 0% { left: 30px; top: 75px; } 100% { left: 309px; top: 75px; } } @keyframes move1 { 0% { left: 30px; top: 75px; } 100% { left: 309px; top: 75px; } } @-webkit-keyframes move2 { 0% { top: 75px; } 62.5% { top: 75px; } 100% { top: 100px; } } @keyframes move2 { 0% { top: 75px; } 62.5% { top: 75px; } 100% { top: 100px; } } @-webkit-keyframes move3 { 0% { top: 100px; } 100% { top: 125px; } } @keyframes move3 { 0% { top: 100px; } 100% { top: 125px; } } @-webkit-keyframes move4 { 0% { top: 125px; } 100% { top: 147px; } } @keyframes move4 { 0% { top: 125px; } 100% { top: 147px; } } @-webkit-keyframes noty-show { 0% { opacity: 0; } 100% { opacity: 1; } } @keyframes noty-show { 0% { opacity: 0; } 100% { opacity: 1; } } .zh-answer-placeholder{padding:24px 0;color:#999;text-align:center} .zh-pager{padding:20px 0 40px;text-align:center} .zh-load-more{display:inline-block;padding:6px 20px;border:1px solid #ddd;border-radius:3px;background:#fff;color:#698ebf;cursor:pointer;font-size:13px} .zh-load-more:hover{border-color:#698ebf} .zh-pager-end{color:#999;font-size:13px} .zh-time{margin-left:12px;color:#999;font-size:12px} .zh-zoomable{cursor:zoom-in} .zh-img-overlay{display:none;position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.85);align-items:center;justify-content:center;cursor:zoom-out} .zh-img-overlay img{max-width:92vw;max-height:92vh;box-shadow:0 4px 24px rgba(0,0,0,.5)} html, body { background: #fff; } body { overflow-x: hidden; } .zu-top { min-width: 0; } .zu-top-link-logo { display: block; overflow: hidden; text-indent: -9999px; white-space: nowrap; } .zu-top .zg-wrap, .zu-top .content { width: auto !important; max-width: 960px !important; margin: 0 auto !important; box-sizing: border-box !important; } .zh-footer { overflow-x: hidden; } .zh-footer .content, .zh-footer .zg-wrap { width: auto !important; max-width: 960px !important; margin: 0 auto !important; box-sizing: border-box !important; } .zu-main-content-inner { margin: 0 !important; box-sizing: border-box !important; width: 100% !important; } @media (min-width: 901px) { .zu-main.zg-wrap { width: 960px !important; max-width: 100% !important; margin: 0 auto !important; padding: 20px 0 50px; box-sizing: border-box; } .zu-main-content { float: left; width: calc(100% - 306px); max-width: 640px; } .zu-main-sidebar { float: right; width: 290px; display: block !important; } .zu-top .zg-wrap { width: 960px !important; max-width: 100% !important; } } @media (max-width: 900px) { .zu-main.zg-wrap { width: auto !important; margin: 0 !important; padding: 12px 14px 40px; } .zu-main-content { float: none !important; width: auto !important; } .zu-main-content-inner { width: auto !important; } .zu-main-sidebar { display: none !important; } .zu-top .zg-wrap { width: auto !important; } } .zh-question-head { border-bottom: 1px solid #eee; margin: 0 0 8px; padding: 0 0 14px; } #zh-question-title { margin: 0 0 12px; } #zh-question-title .zm-item-title { font-size: 18px; font-weight: 700; line-height: 1.5; color: #222; } #zh-question-title .zm-item-title a { color: #222; text-decoration: none; } .zm-item-answer { position: relative; padding: 18px 0 14px; margin-left: 48px; } #zh-question-answer-wrap .zm-item-answer { border-top: 1px solid #eee; } #zh-question-answer-wrap .zm-item-answer:first-child { border-top: 0; } #zh-question-answer-wrap .zm-votebar { display: block !important; } .zm-votebar { float: left; margin-left: -48px; width: 40px; text-align: center; } .zm-votebar .count { display: block !important; font-size: 12px; line-height: 16px; margin-top: 2px; color: #698ebf; } .zm-votebar .zm-vote-label { display: block; font-size: 12px; color: #999; } .zm-item-answer-author-info { position: relative; overflow: hidden; margin: 0 0 6px; } .zm-item-answer .zm-item-link-avatar { float: left; margin: 0 8px 0 0; height: 25px; width: 25px; } .zm-item-answer .zm-item-img-avatar { width: 25px; height: 25px; border-radius: 2px; display: block; } .zm-item-answer-author-info .author-link { display: inline-block; line-height: 25px; color: #259; font-weight: 700; text-decoration: none; } .zm-item-answer-author-info .author-link:hover { color: #698ebf; text-decoration: underline; } .zm-item-answer-author-info .bio { display: inline; margin-left: 8px; color: #999; font-size: 12px; } .zm-item-rich-text { margin-top: 8px; color: #222; font-size: 14px; line-height: 1.7; overflow-wrap: break-word; word-break: break-word; } .zm-item-rich-text p { margin: 12px 0; } .zm-item-rich-text figure { margin: 14px 0; } .zm-item-rich-text figcaption { font-size: 12px; color: #999; text-align: center; margin-top: 6px; } .zm-item-rich-text img { max-width: 100%; height: auto; display: block; } .zm-item-rich-text a { color: #175199; text-decoration: none; } .zm-item-rich-text a:hover { text-decoration: underline; } .zm-item-rich-text h1, .zm-item-rich-text h2, .zm-item-rich-text h3 { font-size: 16px; font-weight: 700; margin: 18px 0 10px; line-height: 1.5; } .zm-item-rich-text ul, .zm-item-rich-text ol { padding-left: 24px; margin: 12px 0; } .zm-item-rich-text li { margin: 4px 0; } .zm-item-rich-text blockquote { border-left: 3px solid #ddd; padding: 2px 0 2px 14px; color: #666; margin: 14px 0; } .zm-item-rich-text code { background: #f2f2f2; border-radius: 3px; padding: 2px 5px; font-family: Consolas, Menlo, monospace; font-size: 13px; word-break: break-word; } .zm-item-rich-text pre { background: #f7f7f7; border: 1px solid #eee; border-radius: 3px; padding: 12px; margin: 14px 0; overflow-x: auto; max-width: 100%; } .zm-item-rich-text pre code { background: none; border: 0; padding: 0; word-break: normal; white-space: pre; } .zm-item-rich-text table { border-collapse: collapse; margin: 14px 0; display: table; max-width: 100%; table-layout: auto; } .zm-item-rich-text table th, .zm-item-rich-text table td { border: 1px solid #ddd; padding: 5px 10px; font-size: 13px; } .zm-item-rich-text table th { background: #f7f7f7; font-weight: 700; } .zm-meta-panel { margin: 12px 0 0; font-size: 13px; color: #999; line-height: 24px; } .zm-meta-panel::after { content: \"\"; display: table; clear: both; } .zm-meta-panel a { display: inline-block; color: #999; text-decoration: none; margin-right: 18px; cursor: pointer; } .zm-meta-panel a:hover { color: #698ebf; } .zm-side-section { background: #fff; border: 1px solid #ddd; border-radius: 3px; padding: 12px 14px; margin-bottom: 12px; font-size: 13px; color: #555; } .zm-side-section h3 { font-size: 14px; margin: 0 0 8px; color: #222; } .zm-side-section .side-row { color: #8590a6; margin: 4px 0; } .zh-pager { text-align: center; padding: 24px 0 8px; } .zh-pager a { display: inline-block; padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; color: #698ebf; text-decoration: none; background: #fff; font-size: 13px; cursor: pointer; } .zh-pager a:hover { border-color: #698ebf; } .zh-pager a:focus-visible { outline: 2px solid #0e6eb8; outline-offset: 2px; } .zh-pager-end { color: #999; font-size: 13px; } .zh-answer-placeholder { padding: 56px 0; text-align: center; color: #999; font-size: 14px; } .zh-time { color: #999; font-size: 12px; } .zh-zoomable { cursor: zoom-in; } .zh-img-overlay { display: none; position: fixed; inset: 0; z-index: 2147483646; background: rgba(0, 0, 0, .9); align-items: center; justify-content: center; cursor: zoom-out; } .zh-img-overlay img { max-width: 94vw; max-height: 92vh; box-shadow: 0 0 40px rgba(0, 0, 0, .6); }";

  var qid = (location.pathname.match(/question\/(\d+)/) || [])[1];
  if (!qid) {
    // 首页（HOME）还没实现，位置留在 src/render/home.js。
    // 接的时候在这里按路由分派：if (location.pathname === '/') bootHome();
    return;
  }
  // 逃生口：带 zh_raw=1 完全不接管，原样看知乎
  if (/[?&]zh_raw=1(?:&|$)/.test(location.search)) return;

  var state = {
    qid: qid,
    offset: 0,
    totals: null,
    isEnd: false,
    loadingMore: false,
    from: '',
    // 元信息分多路到达（回答接口带标题、log 页带标题、内联带计数），必须合并而不是互相覆盖
    meta: { title: '', answerCount: null, viewCount: null }
  };

  /* ---------- 第一步：画骨架 ---------- */

  function paintSkeleton(meta, user) {
    var html = SHELL.question({
      qid: qid,
      css: CLASSIC_CSS,
      bodyClass: 'zhi',
      htmlClass: 'js',
      title: (meta && meta.title ? meta.title + ' - ' : '') + '知乎',
      questionTitle: (meta && meta.title) || '加载中…',
      answersHtml: SHELL.placeholder('正在获取回答…'),
      sidebarHtml: SHELL.sidebar({
        answerCount: meta ? meta.answerCount : null,
        viewCount: meta ? meta.viewCount : null
      }),
      user: user
    });
    takeOver(html);
  }

  // document.write 接管：解析器就此中止，知乎自己的 JS bundle 不会执行
  function takeOver(html) {
    try {
      document.open();
      document.write(html);
      document.close();
      return true;
    } catch (e) {
      console.error('[zhihu-classic] 接管文档失败', e);
      return false;
    }
  }

  /* ---------- 第二步：填数据 ---------- */

  // 多路元信息合并：任何一路只补自己有的字段，不覆盖别路已经拿到的值
  function fillMeta(patch, user) {
    if (patch) {
      if (patch.title) state.meta.title = patch.title;
      if (patch.answerCount != null) state.meta.answerCount = patch.answerCount;
      if (patch.viewCount != null) state.meta.viewCount = patch.viewCount;
    }
    var m = state.meta;
    if (m.title) {
      document.title = m.title + ' - 知乎';
      var titleEl = document.querySelector('#zh-question-title .zm-editable-content a');
      if (titleEl) titleEl.textContent = m.title;
    }
    var side = document.querySelector('.zu-main-sidebar');
    if (side && (m.answerCount != null || m.viewCount != null || m.title)) {
      side.innerHTML = SHELL.sidebar({ answerCount: m.answerCount, viewCount: m.viewCount });
    }
    if (user) {
      var top = document.querySelector('.zu-top');
      if (top) top.outerHTML = SHELL.top(user);
    }
    // 侧栏可能刚被重建，数据源状态必须重新写一遍
    setSourceInfo();
  }

  function fillAnswers(page) {
    var wrap = document.getElementById('zh-question-answer-wrap');
    if (!wrap) return;
    if (!page.items.length) {
      wrap.innerHTML = SHELL.placeholder('这个问题还没有回答');
      return;
    }
    wrap.innerHTML = ANSWER.list(page.items);
    state.offset = page.items.length;
    state.totals = page.totals;
    state.isEnd = page.isEnd;
    state.from = page.from || '';
    // 标题顺带从回答里补（接口不保证 question 元信息可用）
    if (page.title) fillMeta({ title: page.title, answerCount: page.totals || null }, null);
    else if (page.totals != null) fillMeta({ answerCount: page.totals }, null);
    // fillMeta 会重建侧栏，所以状态文字必须最后写，否则会被重置成"等待中…"
    setSourceInfo();
    renderPager();
    // 评论数不挡首屏
    SOURCES.commentCounts(qid, 0, page.items.length).then(applyCommentCounts, function () {});
    enlargeImages();
  }

  function applyCommentCounts(byId) {
    Object.keys(byId).forEach(function (id) {
      var link = document.querySelector('.toggle-comment[data-aid="' + id + '"]');
      if (!link) return;
      link.textContent = byId[id] + ' 条评论';
      link.setAttribute('data-total', String(byId[id]));
    });
  }

  function setSourceInfo() {
    var el = document.getElementById('zh-source-info');
    if (!el) return;
    if (!state.from) return;   // 数据还没回来，保持"等待中…"
    el.textContent = '当前：' + (state.from === 'inline' ? '页面内联数据' : '官方接口');
  }

  /* ---------- 分页 ---------- */

  function renderPager() {
    var pager = document.getElementById('zh-pager');
    if (!pager) return;
    if (state.isEnd) {
      pager.innerHTML = state.offset ? '<span class="zh-pager-end">没有更多回答了</span>' : '';
      return;
    }
    pager.innerHTML = '<a class="zh-load-more" role="button" tabindex="0">加载更多回答</a>';
  }

  function loadMore() {
    if (state.loadingMore || state.isEnd) return;
    state.loadingMore = true;
    var btn = document.querySelector('.zh-load-more');
    if (btn) btn.textContent = '加载中…';

    SOURCES.moreAnswers(qid, state.offset, 20).then(function (page) {
      state.loadingMore = false;
      var wrap = document.getElementById('zh-question-answer-wrap');
      if (!wrap) return;
      if (page.items.length) {
        wrap.insertAdjacentHTML('beforeend', ANSWER.list(page.items));
        enlargeImages();
        SOURCES.commentCounts(qid, state.offset, page.items.length).then(applyCommentCounts, function () {});
      }
      state.offset += page.items.length;
      state.isEnd = page.isEnd || !page.items.length;
      if (page.totals) state.totals = page.totals;
      renderPager();
    }, function (e) {
      state.loadingMore = false;
      var pager = document.getElementById('zh-pager');
      if (pager) {
        pager.innerHTML = '<span class="zh-pager-end">加载失败：' + esc(e && e.message) + '</span>';
      }
    });
  }

  /* ---------- 交互 ---------- */

  function bindEvents() {
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      if (t.closest('#zh-exit-raw')) {
        ev.preventDefault();
        var url = location.pathname + addQuery(location.search, 'zh_raw', '1');
        location.replace(url);
        return;
      }

      var more = t.closest('.zh-load-more');
      if (more) {
        ev.preventDefault();
        loadMore();
        return;
      }

      var img = t.closest('.zm-editable-content img');
      if (img && img.src) {
        ev.preventDefault();
        openImage(img.src);
      }
    }, true);

    document.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Enter' || ev.key === ' ') && document.activeElement &&
          document.activeElement.classList && document.activeElement.classList.contains('zh-load-more')) {
        ev.preventDefault();
        loadMore();
      }
    });
  }

  function addQuery(search, key, val) {
    var parts = String(search || '').replace(/^\?/, '').split('&').filter(function (s) {
      return s && s.indexOf(key + '=') !== 0;
    });
    parts.push(key + '=' + val);
    return '?' + parts.join('&');
  }

  // 正文图片点击放大：单一浮层，不用第三方库
  var overlay = null;
  function openImage(src) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'zh-img-overlay';
      overlay.innerHTML = '<img alt="">';
      overlay.addEventListener('click', function () {
        overlay.style.display = 'none';
        document.body.style.overflow = '';
      });
      document.body.appendChild(overlay);
    }
    overlay.querySelector('img').src = src;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  // 给正文图片打上"可点"标记（不改内容，只加类名）
  function enlargeImages() {
    var imgs = document.querySelectorAll('#zh-question-answer-wrap .zm-editable-content img');
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].classList.contains('zh-zoomable')) {
        imgs[i].classList.add('zh-zoomable');
      }
    }
  }

  /* ---------- 启动 ---------- */

  function boot() {
    // 骨架先落地：此时还没有任何网络请求
    paintSkeleton(null, null);
    bindEvents();

    // 数据和骨架并行：骨架已经可见，这两条谁先回来谁先填
    SOURCES.user().then(function (u) { fillMeta(null, u); }, function () {});
    SOURCES.questionMeta(qid).then(function (m) { fillMeta(m, null); }, function () {});

    SOURCES.firstAnswers(qid).then(fillAnswers, function (e) {
      var wrap = document.getElementById('zh-question-answer-wrap');
      if (!wrap) return;
      wrap.innerHTML = SHELL.placeholder('获取回答失败：' + (e && e.message ? e.message : '未知错误') +
        '。可以点右下角「退出经典版」查看原页面。');
      console.error('[zhihu-classic] 所有数据源均失败', e);
    });
  }

  boot();
})();
})();
