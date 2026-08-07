import { checkResult } from "../types.mjs";
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
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
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
