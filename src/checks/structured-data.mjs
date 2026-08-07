import { checkResult } from "../types.mjs";
import { outcomeToState, OK } from "./fetch-outcome.mjs";

const PRIMARY_TYPES = new Set(["Organization", "Product", "LocalBusiness", "Corporation"]);

/** 抽出页面里所有 JSON-LD 块，解析失败的单块跳过而不是整体失败。 */
function extractJsonLd(html) {
  const blocks = String(html ?? "").match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const parsed = [];
  for (const block of blocks) {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    try { parsed.push(JSON.parse(body)); } catch { /* 单块坏了不影响其余块 */ }
  }
  return parsed;
}

/** 递归收集 @type，覆盖 @graph 嵌套与数组形态。 */
function collectTypes(node, out = new Set()) {
  if (Array.isArray(node)) { for (const item of node) collectTypes(item, out); return out; }
  if (!node || typeof node !== "object") return out;
  const type = node["@type"];
  if (typeof type === "string") out.add(type);
  if (Array.isArray(type)) for (const item of type) out.add(item);
  for (const value of Object.values(node)) collectTypes(value, out);
  return out;
}

function hasSameAs(node) {
  if (Array.isArray(node)) return node.some(hasSameAs);
  if (!node || typeof node !== "object") return false;
  if (node.sameAs) return true;
  return Object.values(node).some(hasSameAs);
}

export function structuredChecks(outcome, pageUrl) {
  const state = outcomeToState(outcome);
  if (state !== OK) {
    return [
      checkResult({ id: "structured.jsonld", group: "structured", scored: true, state: state.state, reason: state.reason, observation: `${state.observation}结构化数据未测。`, evidence: { url: pageUrl } }),
      checkResult({ id: "structured.sameas", group: "structured", scored: false, state: state.state, reason: state.reason, observation: `${state.observation}结构化数据未测。`, evidence: { url: pageUrl } }),
    ];
  }
  const blocks = extractJsonLd(outcome.body);
  const types = [...collectTypes(blocks)];
  const primary = types.filter((type) => PRIMARY_TYPES.has(type));

  const jsonld = blocks.length === 0
    ? { verdict: "fail", observation: "页面中未发现任何 JSON-LD 结构化数据。" }
    : primary.length
      ? { verdict: "pass", observation: `页面 JSON-LD 中包含主体类型：${primary.join("、")}。` }
      : { verdict: "warn", observation: `页面有 JSON-LD（类型：${types.join("、") || "无"}），但不含 Organization 或 Product 这类主体类型。` };

  return [
    checkResult({ id: "structured.jsonld", group: "structured", scored: true, state: "ready", verdict: jsonld.verdict, observation: jsonld.observation, evidence: { url: pageUrl } }),
    checkResult({
      id: "structured.sameas",
      group: "structured",
      scored: false,
      state: "ready",
      verdict: "info",
      observation: hasSameAs(blocks) ? "JSON-LD 中已声明 sameAs。" : "JSON-LD 中未声明 sameAs。",
      evidence: { url: pageUrl },
      limitation: "sameAs 只作为实体一致性的参考，本工具不对它判定好坏。",
    }),
  ];
}
