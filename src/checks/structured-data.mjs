import { checkResult } from "../types.mjs";
import { outcomeToState, OK } from "./fetch-outcome.mjs";
import { stripNoise } from "./html-text.mjs";

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

/**
 * 廉价探测：页面是否存在 Microdata / RDFa 形态的结构化数据标注。
 *
 * 不少老建站系统和 WordPress 主题默认输出的是 Microdata（issue #2）。
 * 用它标注了完整 Organization 的站被判成「未发现任何结构化数据」的
 * fail，是一个假结论。我们**只探测、不解析**——解析这两种老格式的
 * 投入产出比不高，「疑似存在」降级为 warn 已经足够让报告说实话。
 *
 * 三个刻意的取舍：
 * - 先剥 script/style/注释（html-text.mjs 的 stripNoise），JS 模板字符串
 *   里的属性名不算页面标注；
 * - RDFa 只认 typeof= / vocab=，**不认裸的 property=**——Open Graph 的
 *   <meta property="og:..."> 满街都是，认了它 fail 分支就永远走不到；
 * - 正则把属性限定在开标签的前 1000 个字符内（[^<>]{0,1000}），并先用
 *   includes 做零成本预筛——绝大多数页面根本不含这些字样，不该为它们
 *   把整页 HTML 交给正则逐个 < 回溯（实测未设界时病态页面要扫几十秒）。
 *
 * 已知盲区：同一开标签内更靠前的属性值含未转义的 `>` 时（如
 * title="a>b"）会漏检。漏检只会退回原来的 fail，不会造出新结论。
 */
function detectLegacyMarkup(html) {
  const s = stripNoise(html);
  const lower = s.toLowerCase();
  const hasAttr = (name, needsValue) =>
    lower.includes(name) &&
    new RegExp(`<[^<>]{0,1000}\\s${name}${needsValue ? "\\s*=" : "[\\s/>=]"}`, "i").test(s);
  const found = [];
  if (hasAttr("itemscope", false) || hasAttr("itemtype", true)) found.push("Microdata");
  if (hasAttr("typeof", true) || hasAttr("vocab", true)) found.push("RDFa");
  return found;
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

/** structured.jsonld 的四种结论。廉价探测只在完全没有 JSON-LD 时介入。 */
function jsonldVerdict(blocks, types, primary, body) {
  if (blocks.length === 0) {
    const legacy = detectLegacyMarkup(body);
    if (legacy.length === 0) {
      return { verdict: "fail", observation: "页面中未发现任何 JSON-LD 结构化数据。", limitation: null };
    }
    return {
      verdict: "warn",
      observation: `页面未发现 JSON-LD，但存在疑似 ${legacy.join(" 与 ")} 形态的结构化标注。`,
      limitation:
        "本工具只探测、不解析 Microdata/RDFa，无法核对其类型与完整性。主流 AI 引擎与 Google 都优先消费 JSON-LD，建议补一份等价的 JSON-LD。",
    };
  }
  if (primary.length) {
    return { verdict: "pass", observation: `页面 JSON-LD 中包含主体类型：${primary.join("、")}。`, limitation: null };
  }
  return {
    verdict: "warn",
    observation: `页面有 JSON-LD（类型：${types.join("、") || "无"}），但不含 Organization 或 Product 这类主体类型。`,
    limitation: null,
  };
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

  const jsonld = jsonldVerdict(blocks, types, primary, outcome.body);

  return [
    checkResult({ id: "structured.jsonld", group: "structured", scored: true, state: "ready", verdict: jsonld.verdict, observation: jsonld.observation, limitation: jsonld.limitation, evidence: { url: pageUrl } }),
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
