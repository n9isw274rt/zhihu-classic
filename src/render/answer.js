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
