/**
 * robots.txt 解析、分组合并与准入判定。零依赖，不 import 任何模块——
 * 这样它可以被独立测试，也不会把 checkResult / fetch-outcome 的契约
 * 泄漏进「这份 robots.txt 到底允许什么」这个纯粹的问题里。
 *
 * 刻意不复用现成的 robots 解析库：
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

/** 某个路径在该规则组下是否被允许抓取。无适用规则时默认允许。 */
export function pathAllowed(group, pathname) {
  if (typeof pathname !== "string") {
    // 调用方传 undefined 常见于「路径还没算出来就调用」的编程错误。
    // 静默按「允许」处理会让这类 bug 变成「我们抓了一个对方明确禁止的路径」
    // ——这正是本模块要防止的错误的另一种变体，宁可在这里直接抛错。
    throw new TypeError(`pathAllowed 的 pathname 必须是字符串，收到：${typeof pathname}`);
  }
  if (!group) return true;
  const rules = [
    ...group.allow.map((path) => ({ type: "allow", path })),
    ...group.disallow.map((path) => ({ type: "disallow", path })),
  ].filter((rule) => ruleMatches(rule.path, pathname));
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
  return path !== "/robots.txt" && path !== "/$";
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
