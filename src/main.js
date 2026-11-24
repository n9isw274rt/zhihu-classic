/* 入口与编排。
   核心顺序：先画骨架（0 网络、不依赖知乎数据）→ 再填数据（可降级）→ 界面永远不变。 */

(function () {
  'use strict';

  if (window.__zhClassicBooted) return;
  window.__zhClassicBooted = true;

  var CLASSIC_CSS = __CLASSIC_CSS__;

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
