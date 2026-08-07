import { checkResult } from "../types.mjs";
import { outcomeToState } from "./fetch-outcome.mjs";
import { parseRobots, accessState } from "./robots-parse.mjs";

/**
 * V1 爬虫清单。
 *
 * `scored: false` 的四个只影响训练语料，与引用资格无关，因此永不进分母——
 * 它们呈现事实，不判好坏。
 *
 * `blocked` 列给出整站封禁时的 verdict：只有真正影响「能不能被引用」的才记 fail。
 */
const CRAWLERS = [
  { id: "oai-searchbot",    name: "OAI-SearchBot",      scored: true,  blocked: "fail", note: "OpenAI 官方说明：选择退出的站点不会出现在 ChatGPT 搜索答案中" },
  { id: "perplexitybot",    name: "PerplexityBot",      scored: true,  blocked: "fail", note: "影响 Perplexity 自有索引的收录" },
  { id: "claudebot",        name: "ClaudeBot",          scored: true,  blocked: "fail", note: "影响 Claude 检索" },
  { id: "bingbot",          name: "Bingbot",            scored: true,  blocked: "fail", note: "Microsoft Copilot 一切以 Bing 索引为前提" },
  { id: "google-extended",  name: "Google-Extended",    scored: true,  blocked: "warn", note: "影响 Gemini 的 grounding，不影响传统 Google 搜索排名" },
  { id: "chatgpt-user",     name: "ChatGPT-User",       scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "claude-user",      name: "Claude-User",        scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "perplexity-user",  name: "Perplexity-User",    scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "applebot",         name: "Applebot",           scored: true,  blocked: "warn", note: "影响 Siri 与 Spotlight" },
  { id: "gptbot",           name: "GPTBot",             scored: false, blocked: "info", note: "仅用于训练语料采集，不影响 ChatGPT 的引用资格" },
  { id: "applebot-extended",name: "Applebot-Extended",  scored: false, blocked: "info", note: "仅用于训练语料采集" },
  { id: "amazonbot",        name: "Amazonbot",          scored: false, blocked: "info", note: "训练语料" },
  { id: "ccbot",            name: "CCBot",              scored: false, blocked: "info", note: "Common Crawl 训练语料" },
];

/**
 * 把放行路径列表格式化成 observation 里可以安全展示的一小段文字。
 *
 * 这份列表来自第三方站点自己写的 robots.txt，长度不受我们控制——
 * 曾经在一个有 400 条 Allow 规则的站点上量出过 15,836 字符的单条 observation，
 * 而这段文字会原样进入面向客户的报告。这里只展示前几条、每条截断到合理长度，
 * 其余用「等 N 条」带上真实总数，不丢信息也不放大到不可控的篇幅。
 */
const ALLOW_LIST_MAX_ITEMS = 5;
const ALLOW_LIST_MAX_CHARS = 80;

function formatAllowList(allow) {
  const truncate = (path) => (path.length > ALLOW_LIST_MAX_CHARS ? `${path.slice(0, ALLOW_LIST_MAX_CHARS)}…` : path);
  const shown = allow.slice(0, ALLOW_LIST_MAX_ITEMS).map(truncate).join("、");
  if (allow.length <= ALLOW_LIST_MAX_ITEMS) return shown;
  return `${shown} 等 ${allow.length} 条`;
}

function describe(crawler, access) {
  if (access.state === "blocked") {
    return {
      verdict: crawler.blocked,
      observation: `robots.txt 中针对 ${crawler.name} 的规则实质为整站不允许抓取：现有的 Allow 规则（如果有的话）未覆盖任何内容路径。${crawler.note}。`,
      limitation: "本工具只读取配置，未验证该平台的实际抓取行为是否遵守它。",
    };
  }
  if (access.state === "partial") {
    return {
      verdict: crawler.scored ? "warn" : "info",
      observation: `robots.txt 中针对 ${crawler.name} 为白名单放行，仅开放 ${formatAllowList(access.allow)} 等路径。这是有意配置，不是封禁。`,
      limitation: "未评估这些放行路径是否覆盖了贵站的核心内容页。",
    };
  }
  return { verdict: crawler.scored ? "pass" : "info", observation: `robots.txt 未限制 ${crawler.name} 抓取本站。`, limitation: "放开抓取不等于保证收录或引用。" };
}

/**
 * 把抓取结果转成 13 条 CheckResult（9 条 scored + 4 条 advisory）。
 *
 * **必须接收 outcome 而不是解析后的 groups。** 若只接收 groups，
 * 「robots.txt 是 404（确实没有，等价于放行）」与「429/超时（根本没测到）」
 * 会坍缩成同一个 null，全部报成 pass —— 那是在报告一件从未观测到的事，
 * 是本服务要防的那个假阳性的镜像。
 *
 * 只有真正取到内容（含 404，因为 404 明确意味着「该站没有 robots.txt」）
 * 才进入准入判定；其余失败原因一律按 fetch-outcome 的映射记 no_data。
 */
export function robotsChecks(outcome, robotsUrl = "") {
  const is404 = outcome?.status === 404;
  const usable = outcome?.ok || is404;
  if (!usable) {
    const fallback = outcomeToState(outcome);
    return CRAWLERS.map((crawler) => checkResult({
      id: `robots.${crawler.id}`,
      group: "access",
      scored: crawler.scored,
      state: fallback.state,
      reason: fallback.reason,
      observation: fallback.observation,
      evidence: { url: robotsUrl },
    }));
  }
  // 404 = 该站没有 robots.txt = 全部放行，这是可以断言的事实。
  const groups = is404 ? null : parseRobots(outcome.body);
  return CRAWLERS.map((crawler) => {
    const access = accessState(groups, crawler.name);
    const { verdict, observation, limitation } = describe(crawler, access);
    return checkResult({
      id: `robots.${crawler.id}`,
      group: "access",
      scored: crawler.scored,
      state: "ready",
      verdict,
      observation,
      evidence: { url: robotsUrl },
      limitation,
    });
  });
}
