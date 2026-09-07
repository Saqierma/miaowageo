/**
 * robots.txt 解析、分组合并与准入判定。零依赖，不 import 任何模块——
 * 这样它可以被独立测试，也不会把 checkResult / fetch-outcome 的契约
 * 泄漏进「这份 robots.txt 到底允许什么」这个纯粹的问题里。
 *
 * 刻意不复用 `汇报机器人/src/report-robot-core.mjs` 的 robotsAllowsPath()：
 * 那个函数返回布尔值，而设计文档第五节的 partial 呈现需要「命中哪一组、
 * 那一组放行了哪些路径」。同时它有三处已知缺陷（无通配符、agent 子串误匹配、
 * 多组规则被 flatten），修起来等于重写。原函数保持不动，报告 Worker 仍在用。
 */

/**
 * 把 robots.txt 解析成规则组数组。
 * 返回 null 表示「这不是一份 robots.txt」——SPA 的兜底路由经常对任意路径返回 HTML，
 * 那种情况必须判为「没有 robots.txt」（等价于全部放行），而不是解析失败。
 */
export function parseRobots(text) {
  const source = String(text ?? "");
  if (/^\s*(?:<!doctype|<html)/i.test(source)) return null;

  const groups = [];
  let current = null;
  let expectingAgent = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      // 连续的 User-agent 行共享同一组规则：只有在上一行不是 User-agent 时才开新组。
      if (!expectingAgent || !current) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    if (!current) continue;
    expectingAgent = false;
    if (key === "allow" && value) current.allow.push(value);
    if (key === "disallow" && value) current.disallow.push(value);
  }
  return groups;
}

/**
 * 选出适用于某个 agent 的规则组，并按 RFC 9309 §2.2.1 合并同一 token 的所有分组。
 *
 * 按 RFC 9309：先找精确匹配该产品令牌的组，没有才回落到 `*` 组。
 * **必须是精确匹配，不能用 includes()** —— 否则 `Applebot-Extended` 会命中 `Applebot` 组，
 * 把一个只影响训练语料的爬虫误报成影响 Siri 收录。
 *
 * **同一 token 出现在多个分组里必须合并，不能只取第一组。** CMS 插件、CDN 注入、
 * 两个团队各自编辑同一份文件，都会产出「同一个 User-agent 重复出现两次」的文件；
 * 只取第一组会把后面那组的 Allow 规则整体丢弃，把一份「先整体 Disallow、
 * 再用第二段 Allow 放行」的正常文件报成「没有任何 Allow 放行」。
 * 返回的是全新拼装出来的组对象（数组是拷贝），不修改 parseRobots 返回的原始数据。
 */
export function groupFor(groups, agentName) {
  if (!groups) return null;
  const agent = String(agentName).toLowerCase();
  const own = groups.filter((group) => group.agents.includes(agent));
  const matches = own.length ? own : groups.filter((group) => group.agents.includes("*"));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  return {
    agents: [...new Set(matches.flatMap((group) => group.agents))],
    allow: matches.flatMap((group) => group.allow),
    disallow: matches.flatMap((group) => group.disallow),
  };
}

/**
 * 逐字符双指针的通配符匹配，遇到不匹配时只回溯到「最近一个未用尽的通配符」，
 * 不做穷举式回溯。worst case 是 O(pattern 长度 × path 长度)，不会指数增长。
 *
 * 为什么不用 RegExp：把规则里每个通配符天真地换成「点星号」，
 * 在通配符相邻或密集出现时会触发 V8 正则引擎的灾难性回溯——
 * 12 个通配符、28 字节的规则，对一个 41 字符的路径就能跑到三十几秒，
 * 24 个通配符直接两分钟跑不完。robots.txt 的内容来自不可信的第三方站点，
 * 可能是攻击，也可能只是某个 CMS 插件生成的一条很普通的多段通配规则——
 * 不需要恶意，日常配置就能踩到指数级那一档。而且 V8 的正则匹配跑在主线程上，
 * 一次这样的匹配会拖住**所有并发审计任务**，不只是触发它的那一个站点。
 * 手写的线性匹配从根上排除了这种情况，顺带也不必再考虑「路径里的点号、
 * 加号会不会被正则元字符表当成特殊字符」——因为这里压根没有正则，
 * 每个非通配符字符都只按字面比较。
 *
 * 语义：整个 pathname 必须被 pattern 耗尽才算命中；通配符匹配任意长度
 * （含零长度）的任意字符序列；其余字符一律按字面比较，不做任何转义或
 * 元字符解释。这个函数本身只做「整串匹配」，「不带锚定符号的规则其实是
 * 前缀匹配」这条 robots.txt 语义规则，由调用方 ruleMatches 通过在 pattern
 * 末尾隐式追加一个通配符来实现——消费一段前缀之后，剩下的部分随便。
 */
function wildcardMatch(pattern, pathname) {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let matchFrom = 0;
  while (t < pathname.length) {
    if (p < pattern.length && pattern[p] === pathname[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      starAt = p;
      matchFrom = t;
      p += 1;
    } else if (starAt !== -1) {
      p = starAt + 1;
      matchFrom += 1;
      t = matchFrom;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * RFC 3986 的非保留字符：只有这些字符的百分号编码可以安全地解开。
 * `/`、`?`、`:` 这类保留字符**必须保持编码**——`%2F` 和 `/` 在路径里是两个东西。
 */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * 字面量出现时**必须**编码的 ASCII：控制字符、空格、以及 WHATWG URL 路径编码集里的
 * `" < > ` { } ^`。对照的是 `new URL().pathname` 的实际输出——调用方传进来的
 * pathname 全部来自它，这些字符在那一侧永远是 %XX 形态；规则一侧若留成字面量，
 * `Disallow: /my page/` 就拦不住 `/my%20page/`，与 issue #4 要修的三种漏判同类。
 * `|` 与 `\\` 不在此列：WHATWG 在路径里保留 `|` 为字面量，`\\` 在特殊 scheme 下
 * 会被当成 `/`，两者都不会以字面量形态出现在 pathname 里。
 */
const MUST_ENCODE_ASCII = /[\x00-\x20\x7F"<>`{}^]/;

/** 无需归一化的快速判定：多数规则与路径既无 % 也无非 ASCII，直接原样返回。 */
const NEEDS_NORMALIZATION = /[%\x00-\x20\x7F"<>`{}^\u0080-\uFFFF]/;

/** TextEncoder 无状态，提到模块级；本文件仍然零 import（它是全局对象）。 */
const UTF8 = new TextEncoder();

const hex2 = (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`;

/**
 * 按 RFC 9309 §2.2.2 把路径归一化到可比较的形态（issue #4）。
 *
 * 此前规则与路径做的是**原始字符串比较**，于是：
 *   Disallow: /%E7%A7%81%E5%AF%86/   拦不住   /私密/a
 *   Disallow: /私密/                 拦不住   /%E7%A7%81%E5%AF%86/a
 *   Disallow: /a%2Fb                 拦不住   /a%2fb
 * 三种形态实测全部漏判——而 robots 准入是这个产品的核心判定。
 *
 * 规范给的表（§2.2.2）落成四条规则，**不是笼统地两边 decode**：
 *   1. `%XX` 解出来是非保留 ASCII → 还原成字面量（`%62` → `b`）
 *   2. 其余 `%XX` → 保持编码，十六进制统一大写（`%2f` → `%2F`）
 *   3. 字面量的非 ASCII 字符 → 按 UTF-8 逐字节百分号编码（`私` → `%E7%A7%81`）；
 *      字面量的 MUST_ENCODE_ASCII → 同样编码（空格 → `%20`）
 *   4. 其余 ASCII（含 `/`、`*`、`$`）原样保留——`*` 与 `$` 是规则的元字符，
 *      归一化两侧都不碰它们，语义不变
 *
 * 具体度（moreSpecific）按归一化后的字符串长度比较：这与 Google 的参考实现
 * robotstxt 一致（priority = 转义后 pattern 的长度），§2.2.2 的比较发生在编码之后，
 * 「八位组最多」指的就是编码后的串。
 */
export function normalizeRobotsPath(path) {
  const s = String(path ?? "");
  if (!NEEDS_NORMALIZATION.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3);
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      // UNRESERVED 只含 ASCII，≥0x80 的字节天然落到「保持编码」这一支。
      out += UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      i += 2;
      continue;
    }
    const cp = s.codePointAt(i);
    if (cp > 0x7f) {
      for (const b of UTF8.encode(String.fromCodePoint(cp))) out += hex2(b);
      if (cp > 0xffff) i += 1; // 代理对占两个 UTF-16 单元
      continue;
    }
    if (MUST_ENCODE_ASCII.test(ch)) {
      out += hex2(cp);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 判断一条 robots 规则（`rule.path` 原始写法）是否命中某个 pathname。
 *
 * 两个必须支持的构造，都是真实世界的常见写法：
 *   通配符可以出现在规则中段，例如把某个可变字段换成通配符的写法；
 *   结尾锚定符号表示路径到此为止，只匹配根路径本身、不匹配更长的路径。
 * 没有锚定符号时是前缀匹配——这等价于在规则末尾隐式追加一个通配符后
 * 再做整串匹配，所以这里统一交给 wildcardMatch 处理，只在这里决定
 * 要不要补这个隐式通配符。
 */
function ruleMatches(rulePath, pathname) {
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = anchored ? body : `${body}*`;
  return wildcardMatch(pattern, pathname);
}

/**
 * 规则的具体度比较器。原始字符串越长视为越具体，规范用它决定优先级；
 * 同等具体度下 Allow 胜过 Disallow。
 *
 * 类型相同、长度也相同时必须返回 0——这两条规则谁在数组里排在前面无关紧要，
 * 但比较器函数本身必须满足 cmp(a,b) === -cmp(b,a)，否则 Array#sort
 * 的行为在引擎之间是未定义的。此前只用「left 是不是 allow」判断，
 * 两条同为 disallow（或同为 allow）的规则会让 cmp(a,b) 和 cmp(b,a) 都非零。
 */
function moreSpecific(left, right) {
  if (right.path.length !== left.path.length) return right.path.length - left.path.length;
  if (left.type === right.type) return 0;
  return left.type === "allow" ? -1 : 1;
}

/**
 * 规则的归一化形态，按 group 对象缓存。
 *
 * 归一化只取决于 group，却被放在按 pathname 调用的热路径上：一次审计里同一个
 * group 会被 pathAllowed 调用约 34 次（14 个爬虫 × accessState 的 2 次，加编排层
 * 的 6 次）。不缓存就是把同一批规则逐字符重扫 34 遍。
 *
 * **不在 groupFor 里就地归一化**：group.allow 会原样透传进 accessState 的 allow，
 * 再进 robots.mjs 的 formatAllowList 写进面向客户的报告——那里必须是站长自己写的
 * 原文（`/私密/`），不能变成 `/%E7%A7%81%E5%AF%86/`。比较用形态与展示用形态分开。
 */
const NORMALIZED_RULES = new WeakMap();
function normalizedRules(group) {
  let rules = NORMALIZED_RULES.get(group);
  if (!rules) {
    rules = [
      ...group.allow.map((path) => ({ type: "allow", path: normalizeRobotsPath(path) })),
      ...group.disallow.map((path) => ({ type: "disallow", path: normalizeRobotsPath(path) })),
    ];
    NORMALIZED_RULES.set(group, rules);
  }
  return rules;
}

/** 某个路径在该规则组下是否被允许抓取。无适用规则时默认允许。 */
export function pathAllowed(group, pathname) {
  if (typeof pathname !== "string") {
    // 调用方传 undefined 常见于「路径还没算出来就调用」的编程错误。
    // 静默按「允许」处理会让这类 bug 变成「我们抓了一个对方明确禁止的路径」
    // ——这正是本模块要防止的错误的另一种变体，宁可在这里直接抛错。
    throw new TypeError(`pathAllowed 的 pathname 必须是字符串，收到：${typeof pathname}`);
  }
  if (!group) return true;
  // **两侧都归一化后再比较**（issue #4）。规则在这里就归一化，而不是只在
  // ruleMatches 里——因为 moreSpecific 按 path.length 排优先级，规范说的是
  // 归一化后的八位组长度：`/私密/` 与 `/%E7%A7%81%E5%AF%86/` 是同一条规则，
  // 不该因为写法不同而具体度不同。
  const target = normalizeRobotsPath(pathname);
  const rules = normalizedRules(group).filter((rule) => ruleMatches(rule.path, target));
  if (!rules.length) return true;
  rules.sort(moreSpecific);
  return rules[0].type === "allow";
}

/** 整站层面的「代表性」探针路径，不是真实抓取，只用于状态判定。 */
const ROOT_PATH = "/";
// 前缀刻意选得生僻（双下划线开头），避免和常见的短规则前缀
// （比如 /admin、/api、/assets）意外共享前缀而扭曲判定结果。
const REPRESENTATIVE_CONTENT_PATH = "/__site-audit-representative-content__";

/**
 * 一条 Allow 规则是否算「放行了内容」。
 *
 * `/robots.txt` 和裸的根锚定（值为「斜杠+锚定符号」两个字符）都不算——
 * 前者只是允许抓取 robots.txt 自己，后者只允许首页这一个 URL。
 * 一份文件如果只放行这两类路径、其余全部 Disallow，站点实际上还是
 * 「整站不允许抓取」，不能因为技术上存在 Allow 行就报成白名单或部分开放。
 */
function isContentAllowRule(path) {
  // **先归一化再比较**，与 pathAllowed 同口径。否则 `Allow: /robots%2Etxt`
  // （%2E 归一化后就是 `.`）在 pathAllowed 眼里只放行了 robots.txt、算不上内容救援，
  // 而这里按原始写法看到的是另一个字符串、判成内容路径——整站封禁被报成
  // 「白名单放行，这是有意配置」。`Allow: /%24`（→ `/$`）同理。
  const p = normalizeRobotsPath(path);
  return p !== "/robots.txt" && p !== "/$";
}

/**
 * 某个 agent 的整站准入状态：`open` / `partial` / `blocked`。
 *
 * 判定不再用字符串比较（`disallow.includes("/")`），而是直接问匹配器：
 * 「一个有代表性的内容路径，在这组规则下到底允不允许」。原因是
 * `Disallow: /*` 或 `Disallow: *`（星号而非斜杠）表达的是和 `Disallow: /`
 * 完全相同的「整站不允许」，但字符串比较认不出来，会把它报成「未限制」——
 * 这正是本模块存在的理由要防的那类假阳性，只是换了一扇门进来。
 *
 * 三态定义（该注释的措辞刻意避免使用「星号紧跟斜杠」这个字面序列，
 * 见文件顶部关于块注释提前终结的说明）：
 *   open    —— 代表性内容路径被允许；
 *   blocked —— 根路径和代表性内容路径都被禁止，且没有一条 Allow 规则
 *               覆盖到任何内容路径（`/robots.txt`、裸根锚定除外）；
 *   partial —— 其余情况：根路径可能被放行（例如只 Allow 了首页），
 *               或者存在别的 Allow 规则放行了具体内容区，
 *               但代表性探针本身仍被挡住。
 *
 * 这样「Disallow: / 加 Allow: /robots.txt」不再被误判成白名单（那两条
 * 路径都不算内容），「Disallow: / 加 Allow: /」也不再被误判成部分开放
 * （Allow: / 本身就覆盖了代表性内容路径，直接是 open）。
 */
export function accessState(groups, agentName) {
  const group = groupFor(groups, agentName);
  if (!group) return { state: "open", allow: [], group: null };

  const contentAllowed = pathAllowed(group, REPRESENTATIVE_CONTENT_PATH);
  if (contentAllowed) return { state: "open", allow: [...group.allow], group };

  const rootAllowed = pathAllowed(group, ROOT_PATH);
  const hasContentRescue = group.allow.some(isContentAllowRule);
  if (!rootAllowed && !hasContentRescue) return { state: "blocked", allow: [], group };

  return { state: "partial", allow: [...group.allow], group };
}
