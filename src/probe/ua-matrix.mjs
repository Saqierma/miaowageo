/**
 * UA 差分矩阵：同一个 URL、同一时刻、同一个出口 IP，换七种 User-Agent 各请求一次。
 *
 * ---------------------------------------------------------------------------
 * 为什么这个检查值得单独做
 *
 * 报告里最难解释的一类结论是「你的站可能对 AI 不友好」。而这张矩阵不需要解释：
 *
 *     Chrome      200
 *     ClaudeBot   403
 *
 * 老板看一眼就懂。而且它极其便宜——七个 HTTP 请求，不需要浏览器。
 *
 * ---------------------------------------------------------------------------
 * **本文件最要紧的一段：为什么必须有 Googlebot 这个对照探针**
 *
 * 我们的检测机不在 OpenAI / Anthropic 的 IP 段里。Cloudflare 的 Verified Bots
 * 之类机制会做反向 DNS 校验，**正确地**拒绝我们这个未经验证的 GPTBot 声明——
 * 而真正的 GPTBot 会被放行。
 *
 * 也就是说：**「我们的 GPTBot 探针拿到 403」并不证明真 GPTBot 被拦。**
 * 不处理这一条，这个功能会系统性地冤枉一批配置完全正确的站点，
 * 而且冤枉得毫无迹象——矩阵看起来铁证如山。
 *
 * Googlebot 把两种情况分开（几乎没有人会故意封 Googlebot）：
 *
 *   Chrome 200 / Googlebot 200 / GPTBot 403
 *     → 该站有**针对 AI 爬虫的 UA 规则**。结论扎实：若它在做验证，
 *       我们仿冒的 Googlebot 也会被一起拦下。
 *
 *   Chrome 200 / Googlebot 403 / GPTBot 403
 *     → 该站在做**已验证机器人**校验，拦的是「未经验证的声明」本身。
 *       **真 GPTBot 可能进得去，我们测不出来。** 这种情况必须如实说
 *       「无法判定」，并给出可自查的下一步。
 *
 * 这与项目既有的「没测到 ≠ 不合格」是同一条原则。
 *
 * ---------------------------------------------------------------------------
 * 关于仿冒
 *
 * UA 字符串是逐字节仿冒的（产品决定），因为 WAF 规则往往按精确串匹配，
 * 加了后缀会让一部分规则不命中，测不出真实配置。
 *
 * 但每个探针都额外带一个 `X-Probed-By` 头：WAF 匹配的是 UA，保真度不受影响，
 * 而对方运维查日志时仍能看到究竟是谁在探测。这既是基本的礼貌，
 * 也降低检测机 IP 被归为恶意 spoofer 的概率。
 */

import { checkResult } from "../types.mjs";
import { outcomeToState } from "../checks/fetch-outcome.mjs";

const GROUP = "access";

/** 每个探针都带的身份头。见头注释「关于仿冒」。 */
export const PROBE_IDENTITY_HEADER = Object.freeze({
  "x-probed-by": "MiaowaGEO-Audit (+https://miaowageo.com/geocheck)",
});

/**
 * 七个探针。**顺序即报告里的显示顺序**：先基线，再对照，最后被测对象。
 *
 * `role` 决定它在解读逻辑里的身份，不是装饰：
 *   baseline —— 人用浏览器看到什么
 *   generic  —— 泛化的非浏览器客户端
 *   control  —— 判断「该站是否在做已验证机器人校验」的对照
 *   ai       —— 真正要测的对象
 */
export const PROBES = Object.freeze([
  {
    id: "chrome",
    label: "Chrome（普通浏览器）",
    role: "baseline",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    id: "curl",
    label: "curl（泛化非浏览器客户端）",
    role: "generic",
    ua: "curl/8.4.0",
  },
  {
    id: "googlebot",
    label: "Googlebot（对照）",
    role: "control",
    ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
  {
    id: "oai-searchbot",
    label: "OAI-SearchBot",
    role: "ai",
    ua: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  },
  {
    id: "gptbot",
    label: "GPTBot",
    role: "ai",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  },
  {
    id: "claudebot",
    label: "ClaudeBot",
    role: "ai",
    ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  },
  {
    id: "perplexitybot",
    label: "PerplexityBot",
    role: "ai",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot",
  },
]);

/** 探针只要状态码与响应头，正文一概不需要——压到 8 KB，对方少传一大截。 */
export const PROBE_MAX_BYTES = 8 * 1024;
export const PROBE_TIMEOUT_MS = 4000;

/** 2xx / 3xx 都算「进得去」：跳转本身不是拦截。 */
function reachable(status) {
  return typeof status === "number" && status >= 200 && status < 400;
}

/**
 * 跑一遍七个探针。
 *
 * **串行，靠 safe-fetch 既有的同源节流自然铺开。** 七个请求同时打一个站，
 * 从对方视角看本身就像攻击；而这个工具的立场是「标明来意、尽量不添麻烦」。
 *
 * @param {string} pageUrl
 * @param {{ safeFetch: Function, probes?: Array }} deps
 * @returns {Promise<Array<{id,label,role,status,reason,headers,finalUrl}>>}
 */
export async function runUaMatrix(pageUrl, deps = {}) {
  const { safeFetch, probes = PROBES } = deps;
  if (typeof safeFetch !== "function") {
    throw new TypeError("runUaMatrix 需要通过 deps.safeFetch 注入抓取实现");
  }

  const rows = [];
  for (const probe of probes) {
    const outcome = await safeFetch(pageUrl, {
      userAgent: probe.ua,
      extraHeaders: PROBE_IDENTITY_HEADER,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
    });
    rows.push({
      id: probe.id,
      label: probe.label,
      role: probe.role,
      status: outcome?.status ?? null,
      // 正文被 maxBytes 截断时 reason 是 too_large——那不是失败，
      // 是我们主动只要头。状态码照常有效。
      reason: outcome?.reason === "too_large" ? null : (outcome?.reason ?? null),
      headers: outcome?.headers ?? {},
      finalUrl: outcome?.finalUrl ?? null,
      // 只留正文片段，供广告脚本检测用（见 orchestrate-probe 的 detectAdMonetization）。
      // **不进 evidence**：整份报告会原样存库并渲染成表格，把第三方站点的
      // HTML 片段带进去，既撑大存储也把别人的内容搬进了我们的页面。
      body: typeof outcome?.body === "string" ? outcome.body : null,
    });
  }
  return rows;
}

/**
 * 剥掉行里的 `body`，供写进 evidence。
 *
 * 矩阵整个会进 evidence、存进数据库、再渲染成报告页上的表格。
 * 把第三方站点的 HTML 片段一路带过去，既撑大存储，也等于把别人的内容
 * 搬进了我们自己的页面。正文只在进程内用一次（广告脚本检测），用完就扔。
 */
export function stripBodies(rows) {
  return (rows ?? []).map(({ body, ...rest }) => { void body; return rest; });
}

// ---------------------------------------------------------------------------
// 解读
// ---------------------------------------------------------------------------

/**
 * 把矩阵读成一个结论。**这是整个功能里唯一容易说错话的地方。**
 *
 * 返回的 `kind` 是封闭集合，呈现层按它选文案：
 *
 *   all_open          —— 这一层没有拦截
 *   ai_blocked        —— 有针对 AI 爬虫的规则（结论扎实）
 *   verification      —— 在做已验证机器人校验，**我们无法判定真爬虫会不会被拦**
 *   control_ambiguous —— 对照被拦，但有第二种同样成立的解释（见下）
 *   non_browser_block —— 拦的是所有非浏览器客户端
 *   baseline_failed   —— 连普通浏览器都进不去，这一层测不了
 *   inconclusive      —— 数据不足
 *
 * ---------------------------------------------------------------------------
 * 对照探针的前提正在被一个外部事件推翻
 *
 * 这套判定的地基是「几乎没有人会故意封 Googlebot」——所以 Googlebot 也被拦，
 * 就说明站点拦的是「未经验证的机器人声明」，而不是针对 AI。
 *
 * **2026-09-15 起这个前提在一大类站点上不再成立。** Cloudflare 把 Googlebot、
 * Bingbot、Applebot 归为「多用途爬虫」（同时做搜索与训练），并按**最严格的
 * 适用规则**处理；含广告页面上训练类默认封禁，适用于新客户、现有客户的新站点
 * 与**全部免费套餐用户**。也就是说：Cloudflare + 免费套餐 + 含广告的页面上，
 * Googlebot 会因为一个与「已验证机器人校验」毫无关系的理由拿到 403。
 *
 * 若继续照 verification 那一支说「真 GPTBot 可能进得去」，我们会在**放行方向上
 * 说错话**——那比说不出结论糟得多。所以拿到这两个旁证（厂商是 Cloudflare、
 * 页面含广告）时，改判 control_ambiguous：**两种解释都摆出来，不二选一。**
 *
 * 依据：Cloudflare 官方博客「multi-purpose crawlers such as Googlebot, Applebot,
 * and BingBot will be blocked by customers who have selected to block Training」。
 *
 * @param {Array} rows
 * @param {{vendorId?: string|null, adMonetized?: boolean|null}} [context]
 *   旁证。拿不到时按 null 处理，判定退回原来的 verification——
 *   **没有证据就不启用新分支**，宁可少说一种可能。
 */
export function interpretMatrix(rows, context = {}) {
  const by = (role) => (rows ?? []).filter((r) => r.role === role);
  const baseline = by("baseline")[0];
  const generic = by("generic")[0];
  const control = by("control")[0];
  const ai = by("ai");

  if (!baseline || !reachable(baseline.status)) {
    return { kind: "baseline_failed", blockedAi: [], baselineStatus: baseline?.status ?? null };
  }
  if (ai.length === 0) return { kind: "inconclusive", blockedAi: [] };

  const blockedAi = ai.filter((r) => !reachable(r.status));

  if (blockedAi.length === 0) {
    return { kind: "all_open", blockedAi: [] };
  }

  // **对照探针被一起拦下 → 该站在校验「声明」本身，而不是在针对 AI 爬虫。**
  // 这一支必须优先于 ai_blocked：几乎没有人会故意封 Googlebot，
  // 它挂了说明拦的是「未经验证的机器人声明」，真爬虫可能验证得过。
  if (control && !reachable(control.status)) {
    // 两个旁证同时成立时，「已验证机器人校验」不再是唯一解释：
    // Cloudflare 自 2026-09-15 起在含广告页面默认封禁训练类爬虫，
    // 而 Googlebot 被它归为多用途爬虫，会一起被拦。见函数头注释。
    const edgePolicySuspected = context?.vendorId === "cloudflare" && context?.adMonetized === true;
    return {
      kind: edgePolicySuspected ? "control_ambiguous" : "verification",
      blockedAi,
      controlStatus: control.status,
      baselineStatus: baseline.status,
    };
  }

  // 非浏览器客户端一律被拦：范围比「针对 AI」更大，说法要跟着改。
  if (generic && !reachable(generic.status) && blockedAi.length === ai.length) {
    return {
      kind: "non_browser_block",
      blockedAi,
      genericStatus: generic.status,
      baselineStatus: baseline.status,
    };
  }

  return { kind: "ai_blocked", blockedAi, baselineStatus: baseline.status };
}

// ---------------------------------------------------------------------------
// 产出 CheckResult
// ---------------------------------------------------------------------------

const OBSERVATION = {
  all_open: (m, rows) =>
    `以 ${rows.length} 种客户端身份（普通浏览器、curl 与各家 AI 爬虫）分别请求首页，全部取得内容。`,
  ai_blocked: (m) =>
    `普通浏览器身份可以取得内容，但 ${m.blockedAi.map((r) => r.label).join("、")} 的身份被拒绝` +
    `（HTTP ${m.blockedAi.map((r) => r.status ?? "无响应").join(" / ")}）。`,
  verification: (m) =>
    `${m.blockedAi.map((r) => r.label).join("、")} 的身份被拒绝，` +
    `但作为对照的 Googlebot 身份同样被拒绝（HTTP ${m.controlStatus ?? "无响应"}）。`,
  control_ambiguous: (m) =>
    `${m.blockedAi.map((r) => r.label).join("、")} 的身份被拒绝，` +
    `作为对照的 Googlebot 身份同样被拒绝（HTTP ${m.controlStatus ?? "无响应"}）——` +
    "而该站点在 Cloudflare 后面且页面含广告，这使对照失去了区分力。",
  non_browser_block: (m) =>
    `该站点拒绝所有非浏览器客户端：curl 身份返回 HTTP ${m.genericStatus ?? "无响应"}，` +
    `${m.blockedAi.length} 个 AI 爬虫身份同样被拒绝。`,
  baseline_failed: (m) =>
    `连普通浏览器身份都未能取得内容（HTTP ${m.baselineStatus ?? "无响应"}），本项无从判定。`,
  inconclusive: () => "探针数据不足，本项无从判定。",
};

const LIMITATION = {
  control_ambiguous:
    "**这里有两种解释，我们分不开，所以两条都摆出来：**\n" +
    "（一）该站点在做「已验证机器人」校验，拦的是未经验证的身份声明——" +
    "这种情况下真正的 GPTBot、ClaudeBot 走官方 IP 段，很可能进得来。\n" +
    "（二）**Cloudflare 自 2026-09-15 起，在含广告的页面上默认封禁训练类爬虫**，" +
    "而它把 Googlebot 归为「多用途爬虫」（同时做搜索与训练），按最严格的规则一起拦下。" +
    "这项默认变更适用于新客户、现有客户的新站点与**全部免费套餐用户**。" +
    "这种情况下真爬虫是真的被拦了。\n" +
    "该站点同时满足「在 Cloudflare 后面」与「页面含广告」两个条件，所以第二种解释成立得起来。" +
    "**要分辨，只能看你自己那一侧**：Cloudflare 控制台 → Security → Settings → " +
    "AI 爬虫策略，看训练类是否被封禁、以及 Googlebot 有没有单独放行的规则。",
  all_open:
    "本项只测这一个页面在这一刻的响应，不代表全站、也不代表其他时段；" +
    "能取得内容也不等于会被收录或引用。",
  ai_blocked:
    "作为对照的 Googlebot 身份可以正常取得内容，说明该站点并未拒绝所有机器人声明，" +
    "因此这更可能是一条针对特定爬虫的规则。但我们仍是以仿冒身份请求的，" +
    "无法代替真实爬虫验证——建议在服务器日志中核对这几个 User-Agent 的实际响应码。",
  // 这一条是本功能最要紧的一句话。
  verification:
    "**我们无法判定真实的 AI 爬虫会不会被拦。** 本工具从自有服务器发起请求，" +
    "不在这些爬虫官方公布的 IP 段内；Cloudflare 等的「已验证机器人」机制会正确地" +
    "拒绝未经验证的身份声明，而放行真正的爬虫。对照用的 Googlebot 身份同样被拒，" +
    "正是这种机制的典型表现。请在服务器日志中核对这些 User-Agent 的真实响应码。",
  non_browser_block:
    "拦截范围比「针对 AI」更大：连 curl 这类通用客户端也被拒绝。" +
    "同样无法排除是「已验证机器人」机制在起作用。",
  baseline_failed:
    "连普通浏览器身份都取不到内容，说明拦截**不是按 User-Agent 做的**——" +
    "本项的探针都是普通 HTTP 客户端，TLS 指纹与真实浏览器不同；" +
    "做 TLS 指纹识别或 JS 质询的防护会把全部七个探针一起拦下，与它们自称是谁无关。" +
    "这种情况下这张矩阵测不出东西，请看报告里用真实无头浏览器做的那几项。" +
    "也可能是检测点与该站之间的网络路径不通。",
  inconclusive: "探针未能产出足够数据。",
};

const VERDICT = {
  all_open: "pass",
  ai_blocked: "fail",
  // **不是 fail。** 我们没测出真爬虫被拦，判 fail 就是在指控一件没观测到的事。
  verification: "warn",
  // 同理。两种解释里有一种意味着真爬虫进得去，判 fail 同样是指控没观测到的事。
  control_ambiguous: "warn",
  non_browser_block: "fail",
};

/**
 * @param {Array} rows runUaMatrix 的输出
 * @param {string} pageUrl
 * @param {object|null} [failureOutcome] 整个探针阶段没跑成时传进来
 * @returns {object[]} CheckResult[]
 */
export function uaMatrixChecks(rows, pageUrl, failureOutcome = null, context = {}) {
  if (failureOutcome) {
    const s = outcomeToState(failureOutcome);
    return [
      checkResult({
        id: "access.ua-matrix",
        group: GROUP,
        scored: true,
        state: s.state,
        reason: s.reason,
        observation: `${s.observation}User-Agent 差分矩阵未测。`,
        evidence: { url: pageUrl },
      }),
    ];
  }

  const m = interpretMatrix(rows, context);
  const verdict = VERDICT[m.kind];

  if (!verdict) {
    // baseline_failed / inconclusive：**没测到，不是不合格。**
    return [
      checkResult({
        id: "access.ua-matrix",
        group: GROUP,
        scored: true,
        state: "no_data",
        reason: m.kind === "baseline_failed" ? "network" : "worker_error",
        observation: OBSERVATION[m.kind](m, rows ?? []),
        limitation: LIMITATION[m.kind],
        // **interpretation 在这一支也必须带上。** 曾经漏掉过，后果很具体：
        // 报告页顶部的结论横幅拿不到判定，回落到「两者只差一个 User-Agent，
        // 说明按 UA 拦截」这句话——而 baseline_failed 恰恰是**证伪** UA 假说的
        // 那一支（冒充 Chrome 也被拦）。于是同一个页面上，横幅说按 UA 拦截，
        // 下面这条 limitation 写着「拦截不是按 User-Agent 做的」，自相矛盾。
        //
        // 「没测到」≠「没有结论可报」：我们没测出准入状态，但**测出了
        // 拦截不按 UA 走**，那是一条实打实的观测。
        evidence: { url: pageUrl, matrix: stripBodies(rows), interpretation: m.kind },
      }),
    ];
  }

  return [
    checkResult({
      id: "access.ua-matrix",
      group: GROUP,
      scored: true,
      state: "ready",
      verdict,
      observation: OBSERVATION[m.kind](m, rows ?? []),
      limitation: LIMITATION[m.kind],
      // 整张矩阵进 evidence：报告页要把它渲染成表格，
      // 而「能一眼数回到原始观测」是这个项目的既有约定。
      evidence: { url: pageUrl, matrix: stripBodies(rows), interpretation: m.kind },
    }),
  ];
}
