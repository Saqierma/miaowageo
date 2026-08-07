import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { parseRobots, groupFor, accessState, pathAllowed } from "../src/checks/robots-parse.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/robots/${name}.txt`, import.meta.url), "utf8");

/**
 * 准入判定。这里的第一条测试是整个服务最重要的一条：
 *
 * `Disallow: /` 配上若干 `Allow:` 是**白名单**，不是封禁。
 * 2026-08-06 的实测中，某 B2B 平台正是这个形态，而当时的实现把它报成
 * 「整站封禁 OAI-SearchBot」。拿这种假阳性去打客户电话，会当场失去信任。
 *
 * 按 robots.txt 规范：更具体的规则优先，同等具体度下 Allow 胜过 Disallow。
 */

test("Disallow:/ 加上 Allow 规则 = partial，不是 blocked", () => {
  const groups = parseRobots(fixture("whitelist"));
  const state = accessState(groups, "OAI-SearchBot");
  assert.equal(state.state, "partial");
  assert.deepEqual(state.allow, ["/$", "/knowledge/", "/*/company-profile", "/robots.txt"]);
});

test("Disallow:/ 且没有任何 Allow = blocked", () => {
  const groups = parseRobots(fixture("blanket-block"));
  assert.equal(accessState(groups, "OAI-SearchBot").state, "blocked");
});

test("没有 Disallow:/ = open", () => {
  const groups = parseRobots(fixture("shopify"));
  assert.equal(accessState(groups, "OAI-SearchBot").state, "open");
});

test("没有 robots.txt 视为 open", () => {
  assert.equal(accessState(null, "OAI-SearchBot").state, "open");
});

test("pathAllowed 支持 * 通配符", () => {
  const groups = parseRobots(fixture("whitelist"));
  const group = groupFor(groups, "OAI-SearchBot");
  assert.equal(pathAllowed(group, "/acme/company-profile"), true);
  assert.equal(pathAllowed(group, "/search?q=x"), false);
});

test("pathAllowed 支持 $ 结尾锚点", () => {
  const groups = parseRobots(fixture("whitelist"));
  const group = groupFor(groups, "OAI-SearchBot");
  assert.equal(pathAllowed(group, "/"), true);        // 命中 Allow: /$
  assert.equal(pathAllowed(group, "/other"), false);  // /$ 只匹配根路径本身
});

test("同等长度时 Allow 胜过 Disallow", () => {
  const groups = parseRobots(`User-agent: *\nAllow: /a\nDisallow: /a\n`);
  assert.equal(pathAllowed(groupFor(groups, "X"), "/a"), true);
});

test("更长（更具体）的规则优先", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /\nAllow: /docs/\n`);
  const group = groupFor(groups, "X");
  assert.equal(pathAllowed(group, "/docs/intro"), true);
  assert.equal(pathAllowed(group, "/blog/x"), false);
});

test("更长（更具体）的 Disallow 优先于更短的 Allow（此前只测过反过来的方向）", () => {
  const groups = parseRobots(`User-agent: *\nAllow: /docs/\nDisallow: /docs/internal\n`);
  const group = groupFor(groups, "X");
  assert.equal(pathAllowed(group, "/docs/intro"), true);
  assert.equal(pathAllowed(group, "/docs/internal/secret"), false);
});

/**
 * C1：`ruleToRegExp` 曾经把每个通配符转成「点星号」，通配符相邻或密集出现时
 * 触发 V8 正则引擎的灾难性回溯。这里的 12 个通配符、28 字节的规则，
 * 复现时在本机实测跑到了 70 秒以上；修复后的手写线性匹配器必须
 * 在毫秒级完成，不随通配符数量指数增长。
 */
test("C1：12 个通配符的规则在 100ms 内完成，不发生灾难性回溯", () => {
  const rule = "/" + "a*".repeat(12) + "END";
  const groups = parseRobots(`User-agent: *\nDisallow: ${rule}\n`);
  const group = groupFor(groups, "GPTBot");
  const path = "/" + "a".repeat(40);
  const start = Date.now();
  pathAllowed(group, path);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `耗时 ${elapsed}ms，应远小于 100ms（此前需要几十秒）`);
});

test("C1：Disallow: /a.b 不匹配 /axb —— 点号是字面量，不是正则元字符", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /a.b\n`);
  const group = groupFor(groups, "GPTBot");
  assert.equal(pathAllowed(group, "/axb"), true, "/a.b 中的点号不应被解释成『任意字符』");
  assert.equal(pathAllowed(group, "/a.b"), false, "但字面路径本身必须仍然命中");
});

/**
 * C2：`Disallow: /*` 和 `Disallow: *`（星号在斜杠之外）表达的是和
 * `Disallow: /` 完全相同的「整站不允许」，但旧实现用字符串精确比较
 * `disallow.includes("/")` 判定整站封禁，认不出这两种写法，
 * 会把它们报成「未限制」——这正是本模块要防的假阳性，只是换了扇门进来。
 */
test("C2：Disallow: /* 与 Disallow: * 都应判为 blocked，而不是 open", () => {
  for (const rule of ["/*", "*"]) {
    const groups = parseRobots(`User-agent: OAI-SearchBot\nDisallow: ${rule}\n`);
    const state = accessState(groups, "OAI-SearchBot");
    assert.equal(state.state, "blocked", `规则 "${rule}" 应判为 blocked`);
  }
});

/**
 * C3（准入判定层面）：两个分开的 `User-agent: *` 分组必须合并，
 * 不能只取第一组、把第二组的 Allow 整体丢弃。
 */
test("C3：两个 User-agent: * 分组合并后应为 partial，而不是 blocked", () => {
  const groups = parseRobots(
    `User-agent: *\nDisallow: /\n\nUser-agent: *\nAllow: /knowledge/\nAllow: /blog/\n`,
  );
  const state = accessState(groups, "OAI-SearchBot");
  assert.equal(state.state, "partial");
  assert.ok(state.allow.includes("/knowledge/"));
});

/**
 * I1：`/robots.txt` 和裸的根锚定不算「内容路径」。
 *   - Disallow: / 加 Allow: /robots.txt —— 只放行了 robots.txt 自己，
 *     整站内容仍然被挡住，必须是 blocked，不能因为技术上存在一行 Allow
 *     就报成白名单（partial）。
 *   - Disallow: / 加 Allow: / —— Allow: / 本身就覆盖代表性内容路径，
 *     两条规则同等具体度时 Allow 胜出，站点其实完全开放，必须是 open，
 *     不能因为存在一行 Disallow: / 就报成部分开放。
 */
test("I1：Disallow: / 加 Allow: /robots.txt 判为 blocked，不是 partial", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /\nAllow: /robots.txt\n`);
  assert.equal(accessState(groups, "X").state, "blocked");
});

test("I1：Disallow: / 加 Allow: / 判为 open（本质是全站放行）", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /\nAllow: /\n`);
  assert.equal(accessState(groups, "X").state, "open");
});

test("pathAllowed 对非字符串 pathname 抛错，而不是静默放行", () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /\n`);
  const group = groupFor(groups, "X");
  assert.throws(() => pathAllowed(group, undefined));
});

test("accessState 返回的 allow 数组是拷贝，不是原始引用", () => {
  const groups = parseRobots(`User-agent: *\nAllow: /a\n`);
  const state = accessState(groups, "X");
  state.allow.push("/hack");
  assert.deepEqual(groupFor(groups, "X").allow, ["/a"]);
});
