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
