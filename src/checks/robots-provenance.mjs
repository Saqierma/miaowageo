/**
 * robots.txt 的**归属切分**：这份文件里，哪几行是站长写的，哪几行是 CDN 注入的。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须做这件事
 *
 * Cloudflare 的托管 robots.txt 是**前置拼接**：源站已有 robots.txt 时，它把自己
 * 的托管内容 prepend 到原文件之前，合并成一个响应；源站没有时，它直接创建一份。
 * 截至 2026-08 有 380 万以上域名在用这个功能。
 *
 * 后果是：站长打开 `你的域名/robots.txt` 看到 `User-agent: ClaudeBot / Disallow: /`，
 * 第一反应是「我们没写过这个」——他说得对，那确实不是他写的。
 *
 * 报告里最能产生直接行动的一句话就是这个：**「这行不是你写的，是 CDN 的默认值，
 * 去控制台能改回来」**。而在此之前，我们把它当成站长的配置照单报了。
 *
 * ---------------------------------------------------------------------------
 * 唯一的红线：认不出就说认不出，绝不猜归属
 *
 * 把 CDN 注入的规则算到站长头上，会让他去改一个他根本没写过的东西；
 * 把站长自己写的规则算到 CDN 头上，会让他以为「进控制台点一下就能解决」，
 * 而实际上得改源站文件。**两种猜错都比不做这个功能更糟。**
 *
 * 所以这里只在拿到**结构性证据**时才切分，且：
 *   - 只从文件开头连续地吃（托管块是 prepend 的，一定在最前面）
 *   - 遇到第一个不符合托管形态的组就停，剩下的一律算源站
 *   - 完全没有证据时返回 vendor: null，调用方按「整份文件都来自源站」处理
 *
 * ---------------------------------------------------------------------------
 * 特征表要版本化，不能散成正则
 *
 * 这里依赖的是 Cloudflare 自己的输出文本，而对方随时可以改。所以特征集中在
 * 一张带 `source` / `verifiedAt` 的表里：改了之后能一眼看出「这条是什么时候、
 * 依据什么加进来的」，而不是在几百行代码里追一个写死的字符串。
 */

/**
 * 厂商特征表。
 *
 * `markers` 里任意一条命中，才允许尝试切分。每一条都必须是**厂商自己造的东西**，
 * 而不是任何人都可能写出来的普通 robots.txt 语法。
 */
export const PROVENANCE_SIGNATURES = Object.freeze([
  {
    id: "cloudflare",
    name: "Cloudflare",
    source: "https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/",
    verifiedAt: "2026-08-17",
    markers: Object.freeze([
      // Content-Signal 是 Cloudflare 自造的指令。Google 的 John Mueller 公开说过
      // 「据我所知没有任何爬虫或 LLM 使用它，是某个 CDN 造出来的」——
      // 正因为没人用，它作为「这行是 Cloudflare 加的」的指纹反而极其可靠。
      { kind: "directive", key: "content-signal" },
      // 政策文本块。托管功能未启用时，免费套餐仍会展示这段说明。
      { kind: "comment", includes: "content signals" },
    ]),
    /**
     * 托管块里会出现的爬虫组。命中这些**且规则形态是整站 Disallow** 时，
     * 才算托管块的一部分——站长自己也可能封同一个爬虫，但那种情况下
     * 它不会出现在文件最开头的连续托管块里。
     */
    managedAgents: Object.freeze([
      "gptbot", "google-extended", "claudebot", "applebot-extended",
      "meta-externalagent", "ccbot", "bytespider", "amazonbot",
      "perplexitybot", "anthropic-ai", "cohere-ai", "diffbot", "omgili",
    ]),
  },
]);

/**
 * Content-Signal 的字段集合。
 *
 * **这一项永远是参考项，不计分。** Google 的 John Mueller 已公开表示据他所知
 * 没有任何爬虫或 LLM 使用 content-signal 指令，称它「对任何爬虫或 LLM 都没有
 * 任何效果」、是某个 CDN 造出来的。
 *
 * 拿一个没有任何引擎读取的指令去给站点扣分，与本项目把 `llms.txt` 降级为参考项
 * 的理由完全一样——**对它换一套标准，第一原则就守不住了**。
 */
export const CONTENT_SIGNAL_FIELDS = Object.freeze({
  search: "建搜索索引、给出链接与摘要",
  "ai-input": "作为实时回答的输入（RAG / grounding）",
  "ai-train": "用于训练或微调模型",
  use: "内容使用方式（Cloudflare 后加的扩展字段）",
});

/**
 * 读出各 User-agent 组下声明的 Content-Signal。
 *
 * 返回按组聚合的结果，因为**「谁的偏好」和「什么偏好」同样重要**：
 * 托管默认值是 `search=yes, ai-train=no`，而 Cloudflare 刻意不替用户设 `ai-input`。
 * 所以「ai-train=no」很可能是 CDN 的默认值而不是站长的决定，
 * 报告必须把「你主动表达的偏好」与「你被默认值代表了的偏好」分开呈现。
 *
 * @param {string} text robots.txt 原文
 * @returns {Array<{agents: string[], signals: Record<string,string>}>}
 */
export function parseContentSignals(text) {
  const source = String(text ?? "");
  if (/^\s*(?:<!doctype|<html)/i.test(source)) return [];

  const out = [];
  let current = null;
  let expectingAgent = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const d = parseDirective(rawLine);
    if (!d) continue;

    if (d.key === "user-agent") {
      if (!expectingAgent || !current) {
        current = { agents: [], signals: {} };
        out.push(current);
      }
      current.agents.push(d.value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    expectingAgent = false;
    if (d.key !== "content-signal" || !current) continue;

    for (const pair of d.value.split(",")) {
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const field = pair.slice(0, eq).trim().toLowerCase();
      const value = pair.slice(eq + 1).trim().toLowerCase();
      // 未知字段照样收下：Cloudflare 已经加过一次新字段（use=reference），
      // 写死一张白名单会让下一次扩展静默消失。
      current.signals[field] = value;
    }
  }
  return out.filter((g) => Object.keys(g.signals).length > 0);
}

/** 去掉行尾空白并统一大小写，供特征匹配用。原文不动。 */
function normalize(line) {
  return line.replace(/\s+$/, "").toLowerCase();
}

function parseDirective(line) {
  const withoutComment = line.replace(/#.*$/, "").trim();
  const sep = withoutComment.indexOf(":");
  if (sep < 1) return null;
  return {
    key: withoutComment.slice(0, sep).trim().toLowerCase(),
    value: withoutComment.slice(sep + 1).trim(),
  };
}

/** 会出现在一个 User-agent 组**内部**的指令。其余（如 Sitemap:）都是全局的，结束当前组。 */
const GROUP_DIRECTIVES = new Set(["allow", "disallow", "content-signal", "crawl-delay"]);

/** `/`、`/*`、`*` 都是「整站」，与 robots-parse.mjs 的 accessState 同口径。 */
function isBlanketPath(value) {
  const v = String(value ?? "").trim();
  return v === "/" || v === "/*" || v === "*";
}

/** 这一行是不是纯注释（或空行）。 */
function isCommentOrBlank(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/**
 * 找出该文件命中的厂商特征。没有命中返回 null。
 *
 * @param {string[]} lines 原始行
 */
function detectVendor(lines) {
  const lower = lines.map(normalize);
  for (const sig of PROVENANCE_SIGNATURES) {
    for (const marker of sig.markers) {
      if (marker.kind === "comment") {
        if (lower.some((l) => l.trim().startsWith("#") && l.includes(marker.includes))) {
          return { sig, via: `注释中的「${marker.includes}」` };
        }
      } else if (marker.kind === "directive") {
        if (lower.some((l) => parseDirective(l)?.key === marker.key)) {
          return { sig, via: `${marker.key} 指令` };
        }
      }
    }
  }
  return null;
}

/**
 * 切分 robots.txt 的归属。
 *
 * @param {string} text robots.txt 原文
 * @returns {{
 *   vendor: {id: string, name: string}|null,
 *   evidence: string|null,
 *   confidence: "high"|"medium"|null,
 *   managedLineCount: number,
 *   originLineCount: number,
 *   managedAgents: string[],
 *   hasContentSignal: boolean,
 * }}
 */
export function splitProvenance(text) {
  const source = String(text ?? "");
  const empty = {
    vendor: null, evidence: null, confidence: null,
    managedLineCount: 0, originLineCount: 0, managedAgents: [], hasContentSignal: false,
  };
  // SPA 兜底返回 HTML 时不是 robots.txt，与 parseRobots 同一约定。
  if (/^\s*(?:<!doctype|<html)/i.test(source)) return empty;

  const lines = source.split(/\r?\n/);
  const detected = detectVendor(lines);
  if (!detected) return { ...empty, originLineCount: lines.length };

  const { sig, via } = detected;
  const managedAgents = new Set(sig.managedAgents);
  const seenAgents = [];
  let hasContentSignal = false;

  // **只从开头连续地吃。** 托管块是 prepend 的，一定在最前面；
  // 一旦遇到不符合托管形态的内容就停下，剩下的全部算源站。
  let cursor = 0;
  let lastManagedLine = -1;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (isCommentOrBlank(line)) {
      // 前导注释/空行归托管块，但**不单独把它当成边界**：
      // 若后面没有任何托管组，lastManagedLine 不会推进，切分点就还在开头。
      cursor += 1;
      continue;
    }

    const directive = parseDirective(line);
    if (!directive) { cursor += 1; continue; }

    if (directive.key !== "user-agent") {
      // 组外的散装指令（Sitemap: 之类）。不吃，直接停——
      // 它更可能是源站的内容。
      break;
    }

    // 收集这一组：连续的 user-agent 行 + 随后的规则行
    const agents = [];
    while (cursor < lines.length) {
      const d = parseDirective(lines[cursor]);
      if (d?.key === "user-agent") { agents.push(d.value.toLowerCase()); cursor += 1; }
      else if (isCommentOrBlank(lines[cursor])) cursor += 1;
      else break;
    }

    let groupHasContentSignal = false;
    let onlyBlanketDisallow = true;
    let sawRule = false;
    const groupStart = cursor;
    while (cursor < lines.length) {
      if (isCommentOrBlank(lines[cursor])) { cursor += 1; continue; }
      const d = parseDirective(lines[cursor]);
      if (!d || d.key === "user-agent") break;
      // **只有组内指令才算这一组的行。** `Sitemap:` 这类全局指令不属于任何组，
      // 遇到就结束当前组，交回外层——外层会按「组外散装指令」停止切分。
      // 此前不区分，一条紧跟在托管组后面的 `Sitemap:` 会被吞进托管块，
      // 站长自己的 sitemap 声明被算成 CDN 注入。
      if (!GROUP_DIRECTIVES.has(d.key)) break;
      if (d.key === "content-signal") { groupHasContentSignal = true; hasContentSignal = true; }
      // `/`、`/*`、`*` 三种写法在 robots 语义里都是「整站」（robots-parse.mjs 的
      // accessState 已按此处理），这里必须用同一口径——否则托管块若写成 `Disallow: /*`，
      // 切分会在此提前停止，CDN 注入的规则被算到站长头上，正是头注释里的红线。
      else if (d.key === "disallow") { sawRule = true; if (!isBlanketPath(d.value)) onlyBlanketDisallow = false; }
      else if (d.key === "allow") { sawRule = true; if (!isBlanketPath(d.value)) onlyBlanketDisallow = false; }
      cursor += 1;
    }
    void groupStart;

    // 判定这一组是不是托管块的一部分：
    //   - 带 Content-Signal → 一定是（那是 Cloudflare 自造的指令）
    //   - 全部 agent 都在托管清单里，且规则形态是整站放行/整站禁止 → 是
    const allManaged = agents.length > 0 && agents.every((a) => managedAgents.has(a) || a === "*");
    const isManagedGroup = groupHasContentSignal || (allManaged && (onlyBlanketDisallow || !sawRule));

    if (!isManagedGroup) {
      // 第一个不符合托管形态的组：**从这里开始全算源站**，不再往下看。
      break;
    }
    for (const a of agents) if (a !== "*") seenAgents.push(a);
    lastManagedLine = cursor - 1;
  }

  // 一条托管组都没吃到 → 只有政策文本，没有具体偏好。
  // 这是免费套餐上「CDN 展示了政策，但站长什么都没配」的典型形态。
  const managedLineCount = lastManagedLine >= 0 ? lastManagedLine + 1 : 0;

  return {
    vendor: { id: sig.id, name: sig.name },
    evidence: via,
    // Content-Signal 在场时归属是硬的；只有政策注释时是软的。
    confidence: hasContentSignal ? "high" : "medium",
    managedLineCount,
    originLineCount: Math.max(0, lines.length - managedLineCount),
    managedAgents: [...new Set(seenAgents)],
    hasContentSignal,
  };
}
