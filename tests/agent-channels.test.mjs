import assert from "node:assert/strict";
import test from "node:test";

import { agentChannelChecks } from "../src/checks/agent-channels.mjs";

const byId = (results, id) => results.find((item) => item.id === id);
const ok = (body) => ({ ok: true, status: 200, body });
const notFound = () => ({ ok: false, status: 404, reason: "http_error" });

const LLMS_TXT_NOTE =
  "该站提供了 llms.txt。需要说明：Google 已明确 Search 不使用该文件，" +
  "第三方大样本研究也显示它对引用预测没有正向贡献。它目前只在面向编码 agent 的文档站场景有价值，" +
  "本工具不建议为搜索可见性去配置它。";

/**
 * UCP / WebMCP / llms.txt 三个协议本身「格局未定」——设计文档第九节自己这么写的。
 * 用未定的协议给网站扣分，是本工具在 llms.txt 上已经拒绝过的矛盾，
 * 因此三项恒为 advisory，无论测到什么结果都不进分母。
 */

test("三个通道全部 scored:false，无论结果是「有」「无」还是「没测到」", () => {
  const results = agentChannelChecks(
    {
      ucp: ok(`{"version":"2026-04-08"}`),
      agentsMd: notFound(),
      llmsTxt: { ok: false, reason: "timeout" },
    },
    "https://example.com",
  );
  assert.equal(results.length, 3);
  for (const item of results) assert.equal(item.scored, false);
});

test("ucp 返回合法 JSON 时，observation 必须带出协议版本号", () => {
  const results = agentChannelChecks(
    { ucp: ok(`{"version":"2026-04-08","transports":["mcp","embedded"]}`), agentsMd: notFound(), llmsTxt: notFound() },
    "https://example.com",
  );
  const item = byId(results, "agent.ucp");
  assert.equal(item.state, "ready");
  assert.match(item.observation, /2026-04-08/);
});

test("ucp 返回的内容不是合法 JSON 时不抛错，如实说明而不是假装没测到", () => {
  const results = agentChannelChecks(
    { ucp: ok("这不是 JSON"), agentsMd: notFound(), llmsTxt: notFound() },
    "https://example.com",
  );
  const item = byId(results, "agent.ucp");
  assert.equal(item.state, "ready");
  assert.equal(item.scored, false);
  assert.match(item.observation, /不是合法 JSON/);
});

test("llms.txt 存在时，observation 必须写明 Google 不使用它、且不建议为搜索可见性配置它", () => {
  const results = agentChannelChecks(
    { ucp: notFound(), agentsMd: notFound(), llmsTxt: ok("# llms.txt\n\n> 示例站点说明") },
    "https://example.com",
  );
  const item = byId(results, "agent.llms-txt");
  assert.equal(item.observation, LLMS_TXT_NOTE);
});

test("llms.txt 缺失时不建议配置它，措辞不得暗示应该为搜索去补上它", () => {
  const results = agentChannelChecks(
    { ucp: notFound(), agentsMd: notFound(), llmsTxt: notFound() },
    "https://example.com",
  );
  const item = byId(results, "agent.llms-txt");
  assert.equal(item.state, "ready");
  assert.match(item.observation, /不建议.*配置/, "措辞必须明确是「不建议配置」，不能只是提到「配置」二字");
});

test("三个通道均为 404（未提供）时，各自如实呈现缺失，而不是报错或坍缩成同一句话", () => {
  const results = agentChannelChecks(
    { ucp: notFound(), agentsMd: notFound(), llmsTxt: notFound() },
    "https://example.com",
  );
  const texts = results.map((item) => item.observation);
  assert.equal(new Set(texts).size, 3, "三个通道的缺失文案必须互不相同");
  for (const item of results) {
    assert.equal(item.state, "ready");
    assert.equal(item.scored, false);
  }
});

test("抓取失败（429/超时）记 no_data，不得判定为「该站没有该通道」", () => {
  const results = agentChannelChecks(
    {
      ucp: { ok: false, status: 429, reason: "throttled" },
      agentsMd: { ok: false, reason: "timeout" },
      llmsTxt: { ok: false, reason: "timeout" },
    },
    "https://example.com",
  );
  for (const item of results) {
    assert.equal(item.state, "no_data");
    assert.equal(item.verdict, null, "no_data 的项不得携带 verdict");
  }
});
