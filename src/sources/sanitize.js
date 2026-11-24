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
