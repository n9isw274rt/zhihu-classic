# 知乎 · 经典版

Tampermonkey 用户脚本。把知乎问题页换回 2014 年的经典界面，并且**不再加载知乎自己的页面和 JS**。

## 安装

https://raw.githubusercontent.com/n9isw274rt/zhihu-classic/dist/zhihu-classic.user.js

装一次即可，之后由 Tampermonkey 按 `@version` 自动更新。

## 设计目标

**低资源占用的旧版页面**。三条原则，代码结构都围绕它们：

1. **骨架与数据分离**
   页面模板是静态资产，不认知乎的任何字段。脚本一接管就先把完整骨架画出来（0 网络请求），
   数据回来再往回答区里填。接口全挂时，界面仍然是 2014 的样子，只是内容区显示占位。

2. **样式是仓库里的文件，不是运行时抓的**
   2014 的样式表已裁剪进仓库（`assets/css/classic.css`，293KB → 24KB），构建时内联进脚本。
   不依赖知乎任何一个线上 URL 来"长得对"。

3. **数据源可插拔，按代价从小到大**
   ```
   页面内联 JSON（0 请求）→ 官方 v4 接口（1 请求）→ /question/<id>/log 兜底
   ```
   每一级独立，失败自动降级，绝不整页报错。

## 用法

| 场景 | 行为 |
| --- | --- |
| 打开问题页 | 脚本接管，直接渲染经典版 |
| 临时看原版 | 地址后加 `?zh_raw=1` |
| 退出经典版 | 侧栏「退出经典版（看原页面）」 |
| 加载更多 | 页面底部按钮，每次 20 条 |

## 目录结构

```
src/header.js            元数据（构建时注入版本号）
src/core/html.js         转义、时间/数字格式化
src/core/net.js          统一请求层：超时、重试、并发上限
src/sources/sanitize.js  正文 HTML 清洗（白名单 + 去事件属性）
src/sources/inline.js    数据源：页面内联 JSON
src/sources/api.js       数据源：官方 v4 接口
src/sources/index.js     数据源调度与降级链
src/render/shell.js      静态骨架（顶栏/双栏/侧栏/页脚）
src/render/answer.js     回答渲染（只认内部结构）
src/render/home.js       首页 —— 占位，未实现
src/main.js              入口与编排
assets/css/classic.css   从线上 z.css 裁剪出的经典样式（生成物）
assets/css/overrides.css 本项目的补充/覆盖层（手写）
scripts/trim-css.mjs     重新生成 classic.css（需要本机 Edge + 登录态）
scripts/build.mjs        拼接 + 校验 + 产出 dist
scripts/verify.mjs       真实浏览器端到端验证
```

## 开发

```bash
npm run css      # 重新裁剪经典样式（需要 Edge 开着 9222 调试端口且已登录知乎）
npm run build    # 产出 dist/zhihu-classic.user.js
npm run verify   # 注入真实浏览器，断言骨架/数据/资源占用，截图到 shots/
```

`verify.mjs` 会断言：骨架元素齐全、960px 容器、顶栏 46px、body 带 `zhi` 类、
CSS 已内联、回答已渲染、登录用户名已填、**未加载知乎自家 JS bundle**。

## 首页

`src/render/home.js` 目前只是占位。首页的信息流、热榜需要另外的数据源适配器，
按同样的「骨架先行 + 数据降级」结构接进来即可。

## 发版

```bash
git tag v0.1.1 && git push origin v0.1.1
```

CI 把 `@version` 覆盖成 tag 版本号，推 `dist/` 到 `dist` 分支。版本只能变大，
`@name` / `@namespace` 不要改。

## 已知限制

- 只接管问题页；首页未实现。
- 知乎的 `/api/v4/questions/{id}` 需要签名（恒返回 403），所以问题标题从回答列表的
  `question.title` 或 `/log` 页 `<title>` 取。
- 经典样式表里有些规则是按页面类型写的（例如把 `.zm-votebar` 设为 `display:none`），
  阅读页需要的那部分在 `overrides.css` 里显式打开。
