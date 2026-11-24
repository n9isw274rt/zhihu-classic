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
