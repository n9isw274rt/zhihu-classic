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
