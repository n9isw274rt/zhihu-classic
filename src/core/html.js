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
