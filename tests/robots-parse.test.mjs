import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { parseRobots, groupFor } from "../src/checks/robots-parse.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/robots/${name}.txt`, import.meta.url), "utf8");

/**
 * 解析器只做一件事：把 robots.txt 变成结构化的规则组。准入判定在 Task 3。
 *
 * 这里的每条断言都对应一个已经踩过或已知会踩的坑：
 *   - 连续多个 User-agent 行共享同一组规则（whitelist.txt 的前三行）；
 *   - agent 名必须精确匹配，Applebot-Extended 不得命中 Applebot 组；
 *   - 专属组存在时不得回落到 `*` 组；
 *   - SPA 兜底路由返回 HTML 时，必须判为「没有 robots.txt」而不是解析失败。
 */

test("连续的 User-agent 行共享同一组规则", () => {
  const groups = parseRobots(fixture("whitelist"));
  const first = groups[0];
  assert.deepEqual(first.agents, ["gptbot", "oai-searchbot", "chatgpt-user"]);
  assert.equal(first.allow.length, 4);
  assert.deepEqual(first.disallow, ["/"]);
});

test("groupFor 精确匹配 agent 名，不做子串匹配", () => {
  const groups = parseRobots(`User-agent: Applebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n`);
  // Applebot-Extended 不是 Applebot，必须回落到 * 组
  const extended = groupFor(groups, "Applebot-Extended");
  assert.deepEqual(extended.agents, ["*"]);
  const plain = groupFor(groups, "Applebot");
  assert.deepEqual(plain.agents, ["applebot"]);
});

test("存在专属组时不回落到 * 组", () => {
  const groups = parseRobots(fixture("whitelist"));
  const own = groupFor(groups, "OAI-SearchBot");
  assert.ok(own.agents.includes("oai-searchbot"));
  assert.ok(!own.agents.includes("*"));
});

test("没有专属组时回落到 * 组", () => {
  const groups = parseRobots(fixture("shopify"));
  const fallback = groupFor(groups, "OAI-SearchBot");
  assert.deepEqual(fallback.agents, ["*"]);
});

test("SPA 返回 HTML 时判为没有 robots.txt，而不是解析失败", () => {
  assert.equal(parseRobots(fixture("spa-shell")), null);
});

test("注释与空行被忽略，不影响分组", () => {
  const groups = parseRobots(fixture("shopify"));
  assert.equal(groups.length, 2);
});

/**
 * C3：RFC 9309 §2.2.1 要求合并所有匹配同一 token 的分组，不能只取第一组。
 * CMS 插件、CDN 注入、两个团队各自编辑同一份文件，都会产出「同一个
 * User-agent 重复出现两次」的文件，取第一组会把后面那组的 Allow 整体丢弃。
 */
test("C3：使用爬虫自身 token 的重复分组会被合并，而不是只取第一组", () => {
  const groups = parseRobots(
    `User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /knowledge/\n`,
  );
  assert.equal(groups.length, 2, "解析阶段仍然是两个独立分组");
  const merged = groupFor(groups, "OAI-SearchBot");
  assert.deepEqual(merged.disallow, ["/"]);
  assert.deepEqual(merged.allow, ["/knowledge/"]);
});

test("C3：使用 * 的重复分组也会被合并", () => {
  const groups = parseRobots(
    `User-agent: *\nDisallow: /\n\nUser-agent: *\nAllow: /knowledge/\nAllow: /blog/\n`,
  );
  const merged = groupFor(groups, "OAI-SearchBot");
  assert.deepEqual(merged.disallow, ["/"]);
  assert.deepEqual(merged.allow, ["/knowledge/", "/blog/"]);
});

// ---------------------------------------------------------------------------
// issue #4「robots.txt 匹配的残留缺口」的核实（2026-09）
//
// 提交者说路径匹配是原始字符串比较、没做 RFC 9309 §2.2.2 的归一化——**完全属实**，
// 三种形态实测全部漏判。robots 准入是这个产品的核心判定，在它上面不符合规范，
// 是立身之本上的漏洞。
//
// 规范给的不是「两边 decode」，是四条规则（见 normalizeRobotsPath 的注释）。
// 最容易做错的是保留字符：`%2F` 与 `/` 在路径里是两个东西，decode 了就错了。
// ---------------------------------------------------------------------------

import { pathAllowed, normalizeRobotsPath } from "../src/checks/robots-parse.mjs";

const groupOf = (body) => groupFor(parseRobots(body), "MiaowaGEO-Audit");
const allowed = (body, path) => pathAllowed(groupOf(body), path);

test("**归一化直接对照 RFC 9309 §2.2.2 的表**", () => {
  const table = [
    ["/foo/bar/%E3%83%84", "/foo/bar/%E3%83%84"], // 已编码的非 ASCII：保持，大写
    ["/foo/bar/ツ",         "/foo/bar/%E3%83%84"], // 字面量非 ASCII：按 UTF-8 编码
    ["/foo/bar/%62%61%7A", "/foo/bar/baz"],        // 非保留 ASCII 的编码：还原
    ["/a%2fb",             "/a%2Fb"],              // 十六进制统一大写
  ];
  for (const [input, expected] of table) {
    assert.equal(normalizeRobotsPath(input), expected, input);
  }
});

test("**规则写编码、路径是字面量：必须拦得住**（issue #4 第一种漏判）", () => {
  assert.equal(allowed("User-agent: *\nDisallow: /%E7%A7%81%E5%AF%86/\n", "/私密/a"), false);
});

test("**规则写字面量、路径是编码：必须拦得住**（issue #4 第二种漏判）", () => {
  assert.equal(allowed("User-agent: *\nDisallow: /私密/\n", "/%E7%A7%81%E5%AF%86/a"), false);
});

test("**编码的十六进制大小写不敏感**（issue #4 第三种漏判）", () => {
  assert.equal(allowed("User-agent: *\nDisallow: /a%2Fb\n", "/a%2fb"), false);
});

test("**保留字符必须保持编码：%2F 不等于 /**——这是最容易做错的一条", () => {
  // 若归一化把 %2F 解成了 /，Disallow: /a%2Fb 就会错误地拦住 /a/b。
  assert.equal(allowed("User-agent: *\nDisallow: /a%2Fb\n", "/a/b"), true, "%2F 被解成了 /，两条不同的路径被当成了一条");
  assert.equal(allowed("User-agent: *\nDisallow: /a/b\n", "/a%2Fb"), true);
});

test("非保留字符的编码会被还原：%62%61%7A 与 baz 是同一个路径", () => {
  assert.equal(allowed("User-agent: *\nDisallow: /%62%61%7A\n", "/baz"), false);
});

test("**通配符与锚定符不受归一化影响**", () => {
  // * 与 $ 是规则的元字符，归一化两侧都不碰它们。
  const body = "User-agent: *\nDisallow: /私密/*.pdf$\n";
  assert.equal(allowed(body, "/%E7%A7%81%E5%AF%86/a.pdf"), false, "通配符中段 + 锚定 + 编码路径");
  assert.equal(allowed(body, "/私密/a.pdfx"), true, "$ 锚定必须仍然生效");
  assert.equal(normalizeRobotsPath("/x*y$"), "/x*y$");
});

test("**具体度按归一化后的长度比较**：同一条规则不因写法不同而具体度不同", () => {
  // Allow 写的是编码形式（字符数多），Disallow 写的是字面量（字符数少）。
  // 若按原始长度比，Allow 会「更具体」而胜出——但这两条实际是同一条规则的前缀关系，
  // 归一化后 Allow 仍然更长（多了 pub/），所以结论是允许；反过来的写法必须给出同样的结论。
  const a = "User-agent: *\nDisallow: /私密/\nAllow: /%E7%A7%81%E5%AF%86/pub/\n";
  const b = "User-agent: *\nDisallow: /%E7%A7%81%E5%AF%86/\nAllow: /私密/pub/\n";
  assert.equal(allowed(a, "/私密/pub/x"), true);
  assert.equal(allowed(b, "/私密/pub/x"), true);
  assert.equal(allowed(a, "/私密/x"), false);
  assert.equal(allowed(b, "/私密/x"), false);
});

test("孤立的 % 与不合法的 %XX 原样保留，不抛错", () => {
  assert.equal(normalizeRobotsPath("/100%/off"), "/100%/off");
  assert.equal(normalizeRobotsPath("/%zz"), "/%zz");
  assert.equal(normalizeRobotsPath("/a%2"), "/a%2");
});

// ---------------------------------------------------------------------------
// 代码审查（2026-09，对 issue #4 修复的审查）补上的防线
// ---------------------------------------------------------------------------

import { accessState as accessStateOf } from "../src/checks/robots-parse.mjs";

test("**字面量空格等不安全 ASCII 必须编码**——URL.pathname 一侧永远是 %20 形态", () => {
  // 审查发现：规则 4「其余 ASCII 原样保留」放得太宽。orchestrate-light 传进来的
  // pathname 来自 new URL().pathname，空格必然已是 %20；规则里若留成字面量，
  // 站长明令禁止的目录会被判为可抓取，并真的发起抓取。
  assert.equal(allowed("User-agent: *\nDisallow: /my page/\n", "/my%20page/a"), false, "Disallow: /my page/ 没拦住 /my%20page/");
  assert.equal(normalizeRobotsPath("/my page/"), "/my%20page/");
  // **期望值写字面量，不拿 new URL().pathname 当参照。** 第一版这么写了，本地 Node 25
  // 绿、检测机 Node 22 红：WHATWG 路径编码集 2023 年才把 `^` 加进去，不同 Node 内置的
  // URL 实现对 `^` 的处理不同。拿一个随运行时版本变化的输出当期望，是把测试钉在了
  // 移动的靶子上。产品行为本身不受影响——规则与路径两侧走的是同一个归一化函数。
  assert.equal(normalizeRobotsPath("/q{1}^x"), "/q%7B1%7D%5Ex");
  assert.equal(normalizeRobotsPath("/a|b"), "/a|b", "`|` 不在路径编码集里，保持字面量");
  // 两侧同一函数 ⇒ 不管运行时的 URL 把 `^` 编不编码，规则与路径都能对上。
  assert.equal(allowed("User-agent: *\nDisallow: /q{1}^x\n", "/q%7B1%7D%5Ex"), false);
  assert.equal(allowed("User-agent: *\nDisallow: /q{1}^x\n", "/q{1}^x"), false);
});

test("**非保留字符 -._~ 的编码必须还原**（审查发现无测试覆盖）", () => {
  assert.equal(normalizeRobotsPath("/a%2Db%2Ec%5Fd%7Ee"), "/a-b.c_d~e");
  assert.equal(allowed("User-agent: *\nDisallow: /a%2Db\n", "/a-b"), false);
});

test("**代理对（emoji 等 astral 字符）必须按整个码点编码**（审查发现无测试覆盖）", () => {
  // 少了 `i += 1`，低位代理会被单独送进 TextEncoder 变成 %EF%BF%BD（替换字符）。
  assert.equal(normalizeRobotsPath("/🙂/"), "/%F0%9F%99%82/");
  assert.equal(allowed("User-agent: *\nDisallow: /🙂/\n", "/%F0%9F%99%82/a"), false);
  assert.equal(allowed("User-agent: *\nDisallow: /%F0%9F%99%82/\n", "/🙂/a"), false);
});

test("**accessState 与 pathAllowed 同口径：Allow: /robots%2Etxt 不算内容救援**", () => {
  // 审查发现：归一化只加在 pathAllowed，isContentAllowRule 仍拿原始写法比较，
  // `Disallow: /` + `Allow: /robots%2Etxt` 被报成「白名单放行，这是有意配置」。
  const encoded = accessStateOf(parseRobots("User-agent: *\nDisallow: /\nAllow: /robots%2Etxt\n"), "OAI-SearchBot");
  const literal = accessStateOf(parseRobots("User-agent: *\nDisallow: /\nAllow: /robots.txt\n"), "OAI-SearchBot");
  assert.equal(encoded.state, literal.state, "同一条规则的两种写法给出了不同的 state");
  assert.equal(encoded.state, "blocked", "只放行 robots.txt 不是内容救援，整站仍是封禁");
  // 反例：`$` 是保留字符，`%24` 按规则 2 **保持编码**，归一化后是 `/%24` 而不是 `/$`——
  // 它是一条真实的（虽然怪异的）字面量路径规则，不是根锚定，判 partial 才对。
  // 审查时验证器曾断言它会归一化成 /$，那是按「全部 decode」推的，与规范不符。
  const dollar = accessStateOf(parseRobots("User-agent: *\nDisallow: /\nAllow: /%24\n"), "OAI-SearchBot");
  assert.equal(normalizeRobotsPath("/%24"), "/%24", "保留字符 $ 的编码不得被解开");
  assert.equal(dollar.state, "partial");
  // 真实的内容规则（保留字符保持编码）仍然是 partial——证明修法只需归一化、不需要 decode。
  assert.equal(accessStateOf(parseRobots("User-agent: *\nDisallow: /\nAllow: /%2F\n"), "OAI-SearchBot").state, "partial");
});

test("展示给用户的放行路径列表保持站长的原始写法，不被归一化污染", () => {
  // 归一化只用于判定；formatAllowList 要把站长自己写的原文摘进报告。
  const a = accessStateOf(parseRobots("User-agent: *\nDisallow: /\nAllow: /私密/pub/\n"), "OAI-SearchBot");
  assert.deepEqual(a.allow, ["/私密/pub/"]);
});

test("无需归一化的路径原样返回（快速路径），且结果与逐字符路径一致", () => {
  for (const p of ["/admin/", "/wp-admin/", "/*.pdf$", "/?s=", "/a|b"]) {
    assert.equal(normalizeRobotsPath(p), p);
  }
});
