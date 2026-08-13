/**
 * WAF / CDN 厂商指纹。**纯函数，零额外请求**——读的是 UA 差分矩阵已经拿到的响应头。
 *
 * ---------------------------------------------------------------------------
 * 为什么值得做
 *
 * 报告里最没用的一句话是「这项要找开发」。而实际上绝大多数 AI 爬虫拦截，
 * 来自 Cloudflare、阿里云 WAF 这类**有固定后台、菜单路径明确**的产品。
 * 认出厂商，「要找开发」就能变成「进控制台点这三下」——对中小企业是质变。
 *
 * ---------------------------------------------------------------------------
 * 认不出时必须说「未能识别」，不许猜
 *
 * 指纹靠的是厂商自己加的响应头，命中就是命中。但没命中的原因可能是：
 * 该站根本没用 CDN、用了但关掉了标识头、或者用了我们不认识的厂商。
 * 这三种情况我们分不开——所以只能说「未能识别」。
 *
 * 猜错的代价很具体：让用户去一个他根本没有的控制台里找一个不存在的开关。
 */

/**
 * 指纹表。**按特异性从强到弱排**，命中即停。
 *
 * 四种匹配形态，任意一条命中即算这家：
 *
 *   - `headers`：该键存在即可。最干净的一种。
 *   - `serverIncludes`：对 `server` / `via` 头做子串匹配。
 *   - `headerValues`：某个头的**值**里含某个子串。
 *     错过 Fastly 就是因为没有这一形态：它的 403 拦截页写的是
 *     `trace: fastly_error_code=663`，键名本身毫无厂商特征。
 *   - `headerPairs`：**两个键同时存在**才算。给那些单独看都不够特异、
 *     但成对出现就是签名的组合用（`x-timer` + `x-served-by` 之于 Fastly）。
 *
 * 另有 `weakServerIncludes`，走单独一轮、单独的措辞，见 identifyVendor。
 *
 * 每一条都必须是**厂商自己加的、别人不会用的**——
 * 用 `server: nginx` 这种通用值做指纹，会把一半互联网认成同一家。
 */
export const FINGERPRINTS = Object.freeze([
  {
    id: "cloudflare",
    name: "Cloudflare",
    headers: ["cf-ray", "cf-cache-status"],
    serverIncludes: ["cloudflare"],
  },
  {
    id: "akamai",
    name: "Akamai",
    headers: ["x-akamai-transformed", "akamai-grn", "x-akamai-request-id"],
    serverIncludes: ["akamaighost", "akamainetstorage"],
  },
  {
    id: "aliyun",
    name: "阿里云 WAF / CDN",
    // eagleid 是阿里云 CDN 的请求追踪头；ali-swift 是它的边缘节点标识。
    headers: ["eagleid", "x-oss-request-id"],
    serverIncludes: ["ali-swift", "aliyunoss"],
    // **tengine 只能当弱信号。** 它是阿里开源的 Nginx 分支（github.com/alibaba/tengine），
    // 任何人都能自己装。公网上跑 Tengine 的绝大多数确实是阿里云 CDN，
    // 但「绝大多数」不是「一定」——按确证处理，就会把自建用户送进一个
    // 他根本没有的控制台，正是本文件开头说的那种代价。
    weakServerIncludes: [
      { needle: "tengine", caveat: "Tengine 是阿里开源的 Nginx 分支，任何人都能自建，所以这不是确证。" },
    ],
  },
  {
    id: "tencent",
    name: "腾讯云 EdgeOne / CDN",
    headers: ["x-nws-log-uuid", "x-daa-tunnel"],
    serverIncludes: ["tencent"],
  },
  {
    id: "cloudfront",
    name: "Amazon CloudFront",
    headers: ["x-amz-cf-id", "x-amz-cf-pop"],
    serverIncludes: ["cloudfront"],
  },
  {
    id: "fastly",
    name: "Fastly",
    // 这几条原本只有前两个，结果对着一个满头 Fastly 特征的站返回「未能识别」：
    // 标准 Fastly 响应里 x-fastly-request-id / fastly-io-info / server: fastly
    // 一个都不出现。下面四条来自实测抓到的真实响应头。
    headers: ["x-fastly-request-id", "fastly-io-info", "fastly-restarts", "fastly-debug-digest"],
    serverIncludes: ["fastly"],
    headerValues: [
      // 被拦时的 Fastly 错误页：trace: fastly_error_code=663
      { header: "trace", includes: "fastly" },
      // 开了 TLS 的服务普遍带 Vary: ..., Fastly-SSL
      { header: "vary", includes: "fastly-ssl" },
    ],
    // x-timer 单独出现时自建 Varnish 也可能有，配上 x-served-by 才是 Fastly 签名。
    headerPairs: [["x-timer", "x-served-by"]],
  },
  {
    id: "sucuri",
    name: "Sucuri",
    headers: ["x-sucuri-id", "x-sucuri-cache"],
    serverIncludes: ["sucuri"],
  },
  {
    id: "baishan",
    name: "白山云 / 又拍云等国内 CDN",
    headers: ["x-ups-upstream-name", "x-bs-request-id"],
    serverIncludes: ["upyun", "baishan"],
  },
]);

/** 强特征：命中即确证。 */
function matchStrong(fp, lower) {
  const server = (lower.server ?? "").toLowerCase();
  const via = (lower.via ?? "").toLowerCase();

  for (const h of fp.headers ?? []) {
    if (h in lower) return `响应头 ${h}`;
  }
  for (const { header, includes } of fp.headerValues ?? []) {
    if ((lower[header] ?? "").toLowerCase().includes(includes)) return `${header} 头含 ${includes}`;
  }
  for (const pair of fp.headerPairs ?? []) {
    if (pair.every((h) => h in lower)) return `响应头 ${pair.join(" 与 ")} 同时出现`;
  }
  for (const needle of fp.serverIncludes ?? []) {
    if (server.includes(needle)) return `server: ${lower.server}`;
    if (via.includes(needle)) return `via: ${lower.via}`;
  }
  return null;
}

/** 弱特征：像，但不能当证据用。 */
function matchWeak(fp, lower) {
  const server = (lower.server ?? "").toLowerCase();
  for (const { needle, caveat } of fp.weakServerIncludes ?? []) {
    if (server.includes(needle)) return { evidence: `server: ${lower.server}`, caveat };
  }
  return null;
}

/**
 * 从一组响应头里认厂商。
 *
 * **两轮，不是一轮。** 先把所有厂商的强特征扫一遍，全都不中，才去扫弱特征。
 *
 * 这个顺序不是可有可无的写法问题：弱特征的 `aliyun` 排在强特征的 `fastly` 前面，
 * 单轮循环会让一个「自建 Tengine + 挂了 Fastly」的站被判成阿里云——
 * 一条弱信号盖掉一条确证。分两轮之后，强的永远赢。
 *
 * @param {object} headers 响应头（键大小写不敏感）
 * @returns {{id:string,name:string,evidence:string,confidence:"strong"|"weak",caveat?:string}|null}
 */
export function identifyVendor(headers) {
  if (!headers || typeof headers !== "object") return null;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v ?? "");

  for (const fp of FINGERPRINTS) {
    const evidence = matchStrong(fp, lower);
    if (evidence) return { id: fp.id, name: fp.name, evidence, confidence: "strong" };
  }
  for (const fp of FINGERPRINTS) {
    const weak = matchWeak(fp, lower);
    if (weak) return { id: fp.id, name: fp.name, evidence: weak.evidence, confidence: "weak", caveat: weak.caveat };
  }
  return null;
}

/**
 * 在整张矩阵里认厂商——**任意一个探针的响应头命中都算**。
 *
 * 这一点不是随手写的：被拦截的那个探针拿到的往往正是 WAF 自己生成的
 * 拦截页，厂商标识头反而最全；而正常放行的响应可能走的是源站直出。
 */
export function identifyFromMatrix(rows) {
  let weak = null;
  for (const r of rows ?? []) {
    const v = identifyVendor(r?.headers);
    if (!v) continue;
    if (v.confidence === "strong") return { ...v, seenOn: r.id };
    // **强弱之分在这一层同样要守。** 第一个探针上的弱信号不该盖掉
    // 第三个探针上的确证——所以弱的先扣着，扫完整张表还没有强的才用它。
    weak ??= { ...v, seenOn: r.id };
  }
  return weak;
}

/**
 * 厂商专属的修复路径。
 *
 * **只说菜单怎么走，不承诺结果。** 「按这个改就会被 AI 引用」是假话——
 * 我们能说的只有「不改，这一关一定过不去」。
 */
export const VENDOR_GUIDE = Object.freeze({
  cloudflare:
    "进 Cloudflare 控制台 → 选中你的域名 → Security → Bots，" +
    "确认「Verified Bots」处于允许状态（这一项默认放行已验证的 GPTBot、ClaudeBot 等）；" +
    "再到 Security → WAF → Custom rules，检查有没有针对 User-Agent 的自定义拦截规则。" +
    "另外 Security → Settings 里若开了「AI Scrapers and Crawlers」的屏蔽开关，它会直接拦掉 AI 爬虫。",
  akamai:
    "进 Akamai Control Center → Security → Bot Manager，" +
    "在 Bot Category 列表里找到搜索引擎与 AI 爬虫相关的分类，把动作从 Deny 改为 Allow；" +
    "若用的是 Web Application Protector，还要检查 Custom Rules 里有没有按 User-Agent 拦截的条目。",
  aliyun:
    "进阿里云控制台 → Web 应用防火墙 → 防护配置 → 爬虫威胁管理，" +
    "在「合法爬虫」白名单里确认搜索引擎与 AI 爬虫被放行；" +
    "再看「自定义防护策略」里有没有按 User-Agent 匹配的拦截规则。" +
    "如果只用了 CDN 没用 WAF，检查 CDN → 访问控制 → UA 黑白名单。",
  tencent:
    "进腾讯云控制台 → EdgeOne（或 CDN）→ 安全防护 → Bot 管理，" +
    "在「Bot 智能分析」与「客户端画像」里确认搜索引擎类爬虫被放行；" +
    "再检查访问控制里的 User-Agent 黑名单。",
  cloudfront:
    "CloudFront 本身通常不按 User-Agent 拦截，多半是挂在它前面的 AWS WAF。" +
    "进 AWS 控制台 → WAF & Shield → Web ACLs，找到关联这个分发的 ACL，" +
    "检查规则里有没有匹配 User-Agent 的条目；托管规则组 AWSManagedRulesBotControlRuleSet " +
    "也会拦截自报身份的爬虫，需要为搜索/AI 类爬虫加例外。",
  fastly:
    "进 Fastly 控制台 → 你的服务 → VCL / Rules，检查有没有基于 req.http.User-Agent 的拦截逻辑；" +
    "若启用了 Fastly Next-Gen WAF，在其规则里为搜索与 AI 爬虫加放行。",
  sucuri:
    "进 Sucuri 防火墙面板 → Settings → Access Control，" +
    "检查 Blocked User-Agents 列表；另在 Security → Advanced 里确认没有开启激进的 bot 拦截。",
  // 白山云 / 又拍云等：**刻意不写菜单路径**。
  // 我们没有核实过这些控制台的实际菜单层级，编一个看似具体的路径，
  // 会让用户在一个不存在的菜单里找半天——比直接说「不知道」更糟。
  // 认出厂商本身仍然有用：他至少知道该去哪家的文档里搜什么。
});

/**
 * 认出了厂商、但我们没有核实过它控制台菜单路径时的说法。
 *
 * **不编路径。** 这一层的价值在于「照着点三下」，而一个编出来的路径
 * 会把用户送进一个不存在的菜单——比诚实地说不知道更糟。
 */
export function guideFor(vendorId) {
  const guide = VENDOR_GUIDE[vendorId];
  if (guide) return guide;
  return (
    "已识别出这家 CDN / 安全产品，但本工具没有核实过它控制台的菜单路径，" +
    "不在这里编一个。请在该厂商的文档里搜索「User-Agent 黑白名单」或「爬虫/Bot 管理」，" +
    "确认搜索引擎与 AI 爬虫处于放行状态。"
  );
}

/** 认不出厂商时的通用指引——**不假装知道是哪家**。 */
export const GENERIC_GUIDE =
  "未能从响应头识别出 CDN 或 WAF 厂商。可能是没有使用这类产品、" +
  "使用了但关闭了标识头，或者是本工具还不认识的厂商——这三种情况我们分辨不出来。" +
  "请让维护网站的人检查服务器与安全产品里有没有按 User-Agent 拦截的规则。";
