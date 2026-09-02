/**
 * HTML 文本的共享工具：去噪与显示宽度。**纯函数，零依赖。**
 *
 * 抽出来的原因：script/style/注释的剥离逻辑曾在 html-meta.mjs 与
 * structured-data.mjs 各存一份拷贝（static-readability.mjs 还有第三份
 * 变体），拷贝之间已经开始漂移。检查项对「什么算页面内容」必须口径
 * 一致，否则两个检查会对同一页面说出互相矛盾的话。
 */

/**
 * 剥掉 script/style/注释。顺序很重要：脚本里常有含 `<title>`、`itemscope`
 * 字样的模板字符串，先去噪才不会把它们当成页面内容。
 *
 * 未闭合的 script/style/注释一律剥到文档末尾——浏览器的解析行为正是
 * 如此（后面的字节全被当成脚本文本/样式/注释），照剥才不会让 JS 源码
 * 冒充页面内容。
 */
export function stripNoise(html) {
  return String(html ?? "")
    .replace(/<script[\s\S]*?(?:<\/script>|$)/gi, " ")
    .replace(/<style[\s\S]*?(?:<\/style>|$)/gi, " ")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
}

// ---------------------------------------------------------------------------
// 显示宽度
//
// 东亚宽字符（EAW 里的 Wide/Fullwidth）计 2、组合标记与连接符计 0、
// 其余计 1。范围表是常用块的近似清单，不是完整的 Unicode EAW 实现——
// 够用且零依赖（Node 没有公开的 EAW API）。
// ---------------------------------------------------------------------------

const WIDE_RANGES = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首、康熙部首、CJK 符号与标点（含 、。）
  [0x3041, 0x33ff], // 平假名、片假名、注音、CJK 括号
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII 与全角标点
  [0xffe0, 0xffe6], // 全角货币符号
  [0x1f300, 0x1faff], // 常用 emoji
  [0x20000, 0x3fffd], // CJK 扩展 B 及以后
];

// 计 0 宽的码点：组合标记（NFD 形态的重音、越南语声调）、ZWNJ/ZWJ
// （emoji 连接序列）、变体选择符。不计 0 会把带声调的拉丁文本与
// emoji 序列的宽度系统性算大，凭空造出「标题过长」。
const ZERO_RANGES = [
  [0x0300, 0x036f], // 组合变音符号
  [0x1ab0, 0x1aff], // 组合变音符号扩展
  [0x1dc0, 0x1dff], // 组合变音符号补充
  [0x200c, 0x200d], // ZWNJ / ZWJ
  [0x20d0, 0x20ff], // 符号用组合标记
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfe20, 0xfe2f], // 组合半符号
];

const inRanges = (ranges, cp) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/**
 * 文本的显示宽度，单位是「半角字符」：全角计 2、半角计 1。
 * 先 NFC 归一，é 的分解形态与合成形态算出同一个宽度。
 * 仍是近似——比例字体下同为半角的 i 和 W 宽度并不相同，
 * emoji 连接序列也只是少算而非精确。
 */
export function displayWidth(text) {
  let units = 0;
  for (const ch of String(text ?? "").normalize("NFC")) {
    const cp = ch.codePointAt(0);
    if (inRanges(ZERO_RANGES, cp)) continue;
    units += inRanges(WIDE_RANGES, cp) ? 2 : 1;
  }
  return units;
}
