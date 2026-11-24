#!/usr/bin/env node
/**
 * 构建 zhihu-classic.user.js
 *   1. src/header.js 的元数据（注入版本号）
 *   2. assets/css/classic.css 内联进脚本（__CLASSIC_CSS__ 占位）
 *   3. 按依赖顺序拼接 src/ 下的模块，包进一个 IIFE
 *
 * 用法：
 *   node scripts/build.mjs                 # 版本取 header.js 的 @version
 *   node scripts/build.mjs --version 0.1.1
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = 'zhihu-classic.user.js';
const IS_CI = !!process.env.GITHUB_ACTIONS;

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const warn = (m) => console.warn(`\x1b[33m⚠ ${m}\x1b[0m`);

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

/* ---------- 版本 ---------- */

let header = readFileSync(join(ROOT, 'src/header.js'), 'utf8')
  .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
if (!header.startsWith('// ==UserScript==')) fail('src/header.js 第一行必须是 // ==UserScript==');

const headerVersion = /^\/\/ @version\s+(\S+)/m.exec(header)?.[1];
let version = arg('version')
  || (process.env.GITHUB_REF_NAME || '').replace(/^refs\/tags\//, '').replace(/^v/, '')
  || headerVersion;
if (!version) fail('拿不到版本号');
if (!/^\d+(\.\d+){0,3}$/.test(version)) fail(`版本号格式不合法：${version}`);
if (version === headerVersion && !arg('version')) warn(`版本号仍是 ${version}，重复发布用户收不到更新`);

header = header.replace(/^\/\/ @version\s+.*$/m, `// @version      ${version}`).trimEnd() + '\n';

/* ---------- CSS ---------- */

const cssPath = join(ROOT, 'assets/css/classic.css');
let css = '';
try {
  css = readFileSync(cssPath, 'utf8');
} catch (e) {
  fail(`缺少 ${cssPath}：先跑 node scripts/trim-css.mjs 生成（需要本机 Edge + 登录态）`);
}
// 覆盖层必须排在经典样式表之后，才能盖住那条 `display:none`
css += '\n' + readFileSync(join(ROOT, 'assets/css/overrides.css'), 'utf8');

const stripCss = (s) => s
  .replace(/^\uFEFF/, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .trim();
css = stripCss(css);
const cssBytes = Buffer.byteLength(css);
if (cssBytes < 3000) fail(`classic.css 只有 ${cssBytes} 字节，明显没生成完整`);
if (cssBytes > 120000) warn(`内联 CSS 有 ${(cssBytes / 1024).toFixed(0)}KB，超出预算，检查裁剪是否生效`);

/* ---------- 模块拼接 ---------- */

// 顺序即依赖顺序：工具 → 网络 → 清洗 → 数据源 → 渲染 → 入口
const MODULES = [
  'src/core/html.js',
  'src/core/net.js',
  'src/sources/sanitize.js',
  'src/sources/inline.js',
  'src/sources/api.js',
  'src/sources/index.js',
  'src/render/shell.js',
  'src/render/answer.js',
  'src/render/home.js',
  'src/main.js'
];

const parts = MODULES.map((rel) => {
  const p = join(ROOT, rel);
  try {
    statSync(p);
  } catch (e) {
    fail(`缺少模块 ${rel}`);
  }
  return `/* ===== ${rel} ===== */\n` + readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
});

const body = parts.join('\n\n').replace('__CLASSIC_CSS__', JSON.stringify(css));

if (body.indexOf('__CLASSIC_CSS__') !== -1) fail('CSS 占位符替换失败');
if (/==UserScript==/.test(body)) fail('模块里出现了 ==UserScript==，元数据块只能有一份');

const script = header + '\n(function () {\n\'use strict\';\n\n' + body + '\n})();\n';

/* ---------- 校验 ---------- */

if ((script.match(/==UserScript==/g) ?? []).length !== 1) fail('元数据块不止一份');
if (!/^\/\/ ==UserScript==$/m.test(script)) fail('缺少元数据结束行');
for (const key of ['name', 'namespace', 'version', 'match', 'updateURL', 'downloadURL']) {
  if (!new RegExp(`^// @${key}\\s`, 'm').test(script)) fail(`元数据缺少 @${key}`);
}
if (!new RegExp(`^// @version\\s+${version}$`, 'm').test(script)) fail('@version 注入失败');

/* ---------- 产出 ---------- */

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const outPath = join(DIST, OUT);
writeFileSync(outPath, script, 'utf8');

const back = readFileSync(outPath, 'utf8');
if (back.charCodeAt(0) === 0xfeff) fail('产物带 BOM');
if (!back.startsWith('// ==UserScript==')) fail('产物第一行不是元数据');

const total = Buffer.byteLength(script);
console.log('');
console.log(`  \x1b[32m✓\x1b[0m v${version}  →  dist/${OUT}`);
console.log(`    总计 ${(total / 1024).toFixed(1)}KB  (CSS ${(cssBytes / 1024).toFixed(1)}KB + JS ${((total - cssBytes) / 1024).toFixed(1)}KB)`);
console.log(`    ${(script.match(/^\/\/ @downloadURL\s+(\S+)/m) || [])[1] || ''}`);
console.log('');
if (IS_CI && version === headerVersion && !arg('version')) warn('CI 里版本号与源码一致');
