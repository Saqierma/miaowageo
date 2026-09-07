import { checkResult } from "../types.mjs";
import { stripNoise } from "./html-text.mjs";
import { outcomeToState, OK } from "./fetch-outcome.mjs";

const PASS_AT = 500;
const WARN_AT = 200;

/**
 * 估算「不执行 JavaScript 时，爬虫能读到多少字符」。
 *
 * 先整块剥掉 script / style / noscript / 注释，再去标签、解实体、压空白。
 * 顺序很重要：若先去标签，脚本里的字符串会被当成正文，一个大 JSON 就能让空壳站看起来内容充足。
 */
export function visibleTextLength(html) {
  // 与 html-meta / structured-data 共用同一份去噪（stripNoise），不再各留一份拷贝：
  // 此前这里不剥 svg/template，于是 template 里的正文、几十个内联图标的 <title>
  // 会被算成「静态可读字数」判 pass，而 html-meta 对同一页面判「无 h1」——
  // 同一份报告自相矛盾，正是 html-text.mjs 抽出 stripNoise 要防的漂移。
  // noscript 是本检查独有的口径（不执行 JS 时它其实可见，是否计入是另一次决策），保持不变。
  return stripNoise(html)
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .length;
}

export function readabilityCheck(outcome, pageUrl) {
  const state = outcomeToState(outcome);
  if (state !== OK) {
    return checkResult({
      id: "readability.static-text",
      group: "readability",
      scored: true,
      state: state.state,
      reason: state.reason,
      observation: `${state.observation}静态可读性未测。`,
      evidence: { url: pageUrl },
    });
  }
  const length = visibleTextLength(outcome.body);
  const verdict = length >= PASS_AT ? "pass" : length >= WARN_AT ? "warn" : "fail";
  return checkResult({
    id: "readability.static-text",
    group: "readability",
    scored: true,
    state: "ready",
    verdict,
    observation: `不执行 JavaScript 时，该页面可读到约 ${length} 个字符的正文。`,
    evidence: { url: pageUrl, excerpt: `${length} 字符` },
    limitation: "这是一个技术信号。重要内容是否只在浏览器执行脚本后才出现，需要网站人员确认。",
  });
}
