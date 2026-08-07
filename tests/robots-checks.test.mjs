import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { robotsChecks } from "../src/checks/robots.mjs";

const fixture = (name) => readFileSync(new URL(`../fixtures/robots/${name}.txt`, import.meta.url), "utf8");
const byId = (results, id) => results.find((item) => item.id === id);

/**
 * 爬虫清单到 CheckResult 的映射。
 *
 * 最关键的一条：**计分性是检查项的固有属性，与本次结果无关。**
 * 若 GPTBot 放行时算 pass（进分母）、封禁时算 info（出分母），分母会随结果变化，
 * 不同站点的通过率就失去可比性。因此 GPTBot 恒为 advisory，永不进分母。
 *
 * 第二关键：GPTBot 只影响训练语料，与引用资格无关。
 * 把它被封说成「ChatGPT 看不到你」是市面上最常见的误报——本工具存在的意义之一
 * 就是不犯这个错。
 */

test("scored 爬虫恒为同一组 9 个 id，与结果无关", () => {
  // 此前只比较 length（9 === 9），两份 fixture 其实只在 1/13 个爬虫上有差异，
  // 长度相等并不能证明「同一组」爬虫恒为 scored——换掉其中一个 id 的 scored 值，
  // 这条测试也不会失败。改成比较排序后的 id 列表，才是真正在断言「集合相同」。
  const scoredIds = (name) => robotsChecks(ok(name)).filter((item) => item.scored).map((item) => item.id).sort();
  assert.deepEqual(scoredIds("gptbot-blocked"), scoredIds("shopify"));
});

test("GPTBot 自己被封禁时仍是 advisory、仍不进分母", () => {
  // 用 gptbot-blocked 而不是 blanket-block：后者里 GPTBot 会回落到 * 组的 Allow: /，
  // blocked 分支根本走不到，测试会因为错误的原因通过。
  const gptbot = byId(robotsChecks(ok("gptbot-blocked")), "robots.gptbot");
  assert.equal(gptbot.scored, false);
  assert.equal(gptbot.verdict, "info");
  assert.match(gptbot.observation, /整站不允许抓取/, "确认确实走到了 blocked 分支");
});

test("robots.txt 取不到时，绝不报成「全部放行」", () => {
  const results = robotsChecks({ ok: false, reason: "throttled", status: 429 }, "u");
  assert.equal(results.length, 13);
  for (const item of results) {
    assert.equal(item.state, "no_data", `${item.id} 未测到时不得是 ready`);
    assert.equal(item.verdict, null, `${item.id} 未测到时不得携带 verdict`);
  }
});

test("robots.txt 是 404 时，可以断言全部放行", () => {
  const results = robotsChecks({ ok: false, status: 404, reason: "http_error" }, "u");
  const scored = results.filter((item) => item.scored);
  assert.equal(scored.length, 9);
  for (const item of scored) assert.equal(item.verdict, "pass", "404 明确意味着该站没有 robots.txt");
});

test("OAI-SearchBot 整站封禁 = fail", () => {
  assert.equal(byId(robotsChecks(ok("blanket-block")), "robots.oai-searchbot").verdict, "fail");
});

test("Google-Extended 封禁只记 warn，因为不影响传统搜索排名", () => {
  const outcome = okText(`User-agent: Google-Extended\nDisallow: /\n`);
  assert.equal(byId(robotsChecks(outcome), "robots.google-extended").verdict, "warn");
});

test("白名单记 warn，且 observation 必须列出放行的路径", () => {
  const result = byId(robotsChecks(ok("whitelist")), "robots.oai-searchbot");
  assert.equal(result.verdict, "warn");
  assert.match(result.observation, /白名单放行/);
  assert.match(result.observation, /\/knowledge\//);
  assert.ok(result.limitation, "partial 必须带 limitation，说明未评估放行路径是否覆盖核心内容");
});

/**
 * C2：`Disallow: /*`（星号在斜杠之外）过去会被字符串精确比较认成「未限制」，
 * 报出 pass + 「robots.txt 未限制 OAI-SearchBot 抓取本站」——一个从未被观测到的
 * 事实性断言，而且拉高了通过率。修复后必须走 blocked 分支，verdict 为 fail，
 * 且 observation 里绝不能出现「未限制」。
 */
test("C2：Disallow: /* 时 OAI-SearchBot 判为 fail，observation 不得声称『未限制』", () => {
  const outcome = okText(`User-agent: OAI-SearchBot\nDisallow: /*\n`);
  const result = byId(robotsChecks(outcome), "robots.oai-searchbot");
  assert.equal(result.verdict, "fail");
  assert.doesNotMatch(result.observation, /未限制/);
});

/**
 * C3：两个分开的 `User-agent: *` 分组合并后应呈现为白名单（partial/warn），
 * 且 observation 里必须提到实际放行的 /knowledge/，不能因为只取了第一组
 * 就报成「整站封禁、没有任何 Allow」。
 */
test("C3：重复的 User-agent: * 分组合并后，observation 提到实际放行的路径", () => {
  const outcome = okText(`User-agent: *\nDisallow: /\n\nUser-agent: *\nAllow: /knowledge/\nAllow: /blog/\n`);
  const result = byId(robotsChecks(outcome), "robots.oai-searchbot");
  assert.equal(result.verdict, "warn");
  assert.match(result.observation, /\/knowledge\//);
});

/**
 * 任务 9：SPA 兜底路由对任意路径（包括 /robots.txt）返回 HTML 时，
 * parseRobots 已经在解析层判过 null，但这里要在 robotsChecks 整条链路上
 * 断言：13 项全部是 ready + open（等价于放行），而不仅仅是解析器层面正确。
 */
test("SPA 兜底返回 HTML 时，robotsChecks 全部 13 项仍是 ready", () => {
  const outcome = okText(`<!doctype html><html><body><div id="app"></div></body></html>`);
  const results = robotsChecks(outcome);
  assert.equal(results.length, 13);
  for (const item of results) assert.equal(item.state, "ready", `${item.id} 应为 ready`);
});

/**
 * 把一次真实的假阳性钉死为永久回归。
 *
 * 早期的一版 robots 判定把环球资源（globalsources.com）对 OAI-SearchBot
 * **精心配置的白名单**（`Disallow: /` 加十条 `Allow:`，含
 * `/*​/company-profile` 供应商主页）报成了「整站封禁 ChatGPT」。
 *
 * 那是一个**从未发生过的事实断言**：站点方明明做对了事——先全禁再逐条放行
 * 是最严谨的写法——却被我们指控成封禁 AI。这类误报比漏报严重得多，
 * 因为它会让一个做对了的人去「修」一个不存在的问题。
 *
 * fixture 是 curl 下来的真实快照（见 fixtures/robots/globalsources-snapshot.txt
 * 顶部的抓取记录），不是直接打线上站：把回归测试挂在对方随时可能变动的
 * 现网配置上，会让这条测试无缘无故变红或变绿，对我们自己的改动毫无信号意义。
 */
test("真实白名单快照不得被报成整站封禁（2026-08-06 假阳性的回归测试）", () => {
  const result = byId(robotsChecks(ok("globalsources-snapshot")), "robots.oai-searchbot");
  assert.equal(result.verdict, "warn", "白名单是有意配置，不是封禁");
  assert.match(result.observation, /白名单放行/);
});

test("放行路径列表过长时会被截断，附带真实条数，而不是原样拼接", () => {
  const rules = Array.from({ length: 12 }, (_, i) => `Allow: /a-very-long-representative-directory-name-${i}/deep/nested/path/segment\n`).join("");
  const outcome = okText(`User-agent: OAI-SearchBot\nDisallow: /\n${rules}`);
  const result = byId(robotsChecks(outcome), "robots.oai-searchbot");
  assert.equal(result.verdict, "warn");
  assert.match(result.observation, /等 12 条/);
  assert.ok(result.observation.length < 2000, `observation 长度应被控制住，实际 ${result.observation.length}`);
});

// —— 测试辅助：robotsChecks 现在接收抓取结果，不是解析结果 ——
function ok(name) { return { ok: true, status: 200, body: fixture(name) }; }
function okText(text) { return { ok: true, status: 200, body: text }; }
