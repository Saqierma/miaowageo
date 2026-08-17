import { checkResult } from "../types.mjs";
import { outcomeToState } from "./fetch-outcome.mjs";
import { parseRobots, accessState } from "./robots-parse.mjs";

/**
 * 爬虫清单。
 *
 * ---------------------------------------------------------------------------
 * 分层原则：训练型不计分，检索型才计分
 *
 * 各家 AI 公司的爬虫是**分层**的，同一家往往有三个独立身份：
 *
 *   训练型     采集训练语料。封禁它是版权决定，**不影响你能不能被引用**
 *   检索型     为搜索回答建索引。封禁它 = 在那家 AI 的答案里消失
 *   用户触发型 用户提问时实时抓取。封禁它只影响那一次对话
 *
 * 把三者混为一谈，是目前大量 GEO 文章共同的错误。所以：
 * **训练型一律 `scored: false`**（呈现事实，不判好坏），
 * **检索型一律 `scored: true` + `blocked: "fail"`**。
 *
 * ---------------------------------------------------------------------------
 * 我们自己在这条原则上栽过一次
 *
 * 2026-08 之前，这张表把 OpenAI 的三层（GPTBot / OAI-SearchBot / ChatGPT-User）
 * 拆对了，却把 Anthropic 完全对称的三层拆错了：ClaudeBot 被标成「影响 Claude
 * 检索」且计分，而它其实**只采训练语料**；真正负责搜索索引的 Claude-SearchBot
 * 压根不在表里。同一个文件里两套标准，正是本项目最主要的方法论卖点在自己身上失效。
 *
 * 一条外部评审指出了它。修法不只是补一行——`tests/robots-checks.test.mjs` 里
 * 现在有两条测试守着**原则本身**（分层原则、三家对称性），而不只是守
 * 「一共有几个爬虫」这类事实。事实型断言只能防止别人删东西，防不住一开始就分错类。
 *
 * 依据：Anthropic 支持文档 8896518，ClaudeBot「collecting web content that could
 * potentially contribute to their training」、Claude-SearchBot「navigates the web
 * to improve search result quality」。
 *
 * ---------------------------------------------------------------------------
 * `blocked` 列给出整站封禁时的 verdict：只有真正影响「能不能被引用」的才记 fail。
 */
const CRAWLERS = [
  // ── 检索型：封禁 = 在那家 AI 的搜索回答里消失 ────────────────────────
  { id: "oai-searchbot",    name: "OAI-SearchBot",      scored: true,  blocked: "fail", note: "OpenAI 官方说明：选择退出的站点不会出现在 ChatGPT 搜索答案中" },
  { id: "claude-searchbot", name: "Claude-SearchBot",   scored: true,  blocked: "fail", note: "Anthropic 官方说明：封禁后不再为搜索优化索引你的内容，降低在 Claude 搜索回答中的可见性" },
  { id: "perplexitybot",    name: "PerplexityBot",      scored: true,  blocked: "fail", note: "影响 Perplexity 自有索引的收录" },
  { id: "bingbot",          name: "Bingbot",            scored: true,  blocked: "fail", note: "Microsoft Copilot 一切以 Bing 索引为前提" },

  // ── 用户触发型与其他：影响有限，记 warn ──────────────────────────────
  { id: "google-extended",  name: "Google-Extended",    scored: true,  blocked: "warn", note: "影响 Gemini 的 grounding，不影响传统 Google 搜索排名" },
  { id: "chatgpt-user",     name: "ChatGPT-User",       scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "claude-user",      name: "Claude-User",        scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "perplexity-user",  name: "Perplexity-User",    scored: true,  blocked: "warn", note: "仅影响用户主动触发的实时抓取" },
  { id: "applebot",         name: "Applebot",           scored: true,  blocked: "warn", note: "影响 Siri 与 Spotlight" },

  // ── 训练型：一律不计分。封禁它们是版权决定，与引用资格无关 ──────────
  { id: "gptbot",           name: "GPTBot",             scored: false, blocked: "info", note: "仅用于训练语料采集，不影响 ChatGPT 的引用资格" },
  { id: "claudebot",        name: "ClaudeBot",          scored: false, blocked: "info", note: "仅用于模型训练语料采集，不影响 Claude 搜索的引用资格" },
  { id: "applebot-extended",name: "Applebot-Extended",  scored: false, blocked: "info", note: "仅用于训练语料采集" },
  { id: "amazonbot",        name: "Amazonbot",          scored: false, blocked: "info", note: "训练语料" },
  { id: "ccbot",            name: "CCBot",              scored: false, blocked: "info", note: "Common Crawl 训练语料" },
];

/**
 * 分层归类，**供测试守原则用**。
 *
 * 单独导出而不是写死在测试里：写死在测试里的话，加一个新爬虫时测试不会提醒你
 * 给它归类——它会安静地不属于任何一层，而分层原则测试照样全绿。
 */
export const CRAWLER_TIERS = Object.freeze({
  training: ["gptbot", "claudebot", "applebot-extended", "amazonbot", "ccbot"],
  retrieval: ["oai-searchbot", "claude-searchbot", "perplexitybot", "bingbot"],
  userTriggered: ["chatgpt-user", "claude-user", "perplexity-user"],
  other: ["google-extended", "applebot"],
});

export { CRAWLERS };

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
 * 把抓取结果转成 14 条 CheckResult（9 条 scored + 5 条 advisory）。
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
