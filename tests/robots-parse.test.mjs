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
