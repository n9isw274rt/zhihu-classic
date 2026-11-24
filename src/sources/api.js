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
