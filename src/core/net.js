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
