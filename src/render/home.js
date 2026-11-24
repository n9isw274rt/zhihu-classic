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
