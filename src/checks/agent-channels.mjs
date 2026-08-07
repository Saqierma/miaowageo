import { checkResult } from "../types.mjs";
import { outcomeToState } from "./fetch-outcome.mjs";

/**
 * `llms.txt` 存在时的固定说明，逐字取自设计文档（不得改写，见 Task 6 步骤 5）：
 * Google 已明确 Search 不使用它，第三方大样本研究也没测出它对引用预测有正向贡献。
 * **这是产品差异化，不是免责声明**——市面上大量服务商在卖「llms.txt 配置服务」，
 * 本工具选择如实说「这个目前对搜索没用」。
 */
const LLMS_TXT_PRESENT_NOTE =
  "该站提供了 llms.txt。需要说明：Google 已明确 Search 不使用该文件，" +
  "第三方大样本研究也显示它对引用预测没有正向贡献。它目前只在面向编码 agent 的文档站场景有价值，" +
  "本工具不建议为搜索可见性去配置它。";

/** 缺失同样不判好坏：既不该说「你该配一个」，也不该暗示这是缺陷。 */
const LLMS_TXT_ABSENT_NOTE =
  "该站未提供 llms.txt。Google 已明确 Search 不使用该文件，缺失不影响搜索可见性，" +
  "本工具不建议专门为此配置它。";

/** `/.well-known/ucp` 常见的版本字段名尚无统一规范，按已知实例依次尝试。 */
function extractUcpVersion(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  return parsed.version ?? parsed.ucp_version ?? parsed.protocol_version ?? parsed.protocolVersion ?? null;
}

function describeUcpBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "该路径可访问，但返回内容不是合法 JSON，可能并非真正的 UCP 端点。";
  }
  const version = extractUcpVersion(parsed);
  return version
    ? `该站提供了 /.well-known/ucp，声明协议版本 ${version}。`
    : "该站提供了 /.well-known/ucp（合法 JSON），但未在常见字段中找到协议版本号。";
}

/**
 * 三个 agent 通道共用的判定形状：抄 `robots.mjs` 里 `robotsChecks` 的 404 特判——
 * 404 是「该站确实没有这个文件」，可以断言；429/超时/网络问题是「这次没测到」，
 * 两者不能都报成「缺失」，否则就是在指控一件没有观测过的事。
 *
 * 与 `robotsChecks` 不同的是，这里不存在 verdict 好坏之分——三个通道全部 `advisory`，
 * 因此不管测到「有」还是「无」，verdict 一律是 `info`：呈现事实，不做背书。
 */
function channelResult({ id, outcome, url, describePresent, describeAbsent }) {
  const is404 = outcome?.status === 404;
  const usable = outcome?.ok || is404;

  if (!usable) {
    const fallback = outcomeToState(outcome);
    return checkResult({
      id,
      group: "agent",
      scored: false,
      state: fallback.state,
      reason: fallback.reason,
      observation: fallback.observation,
      evidence: { url },
    });
  }

  return checkResult({
    id,
    group: "agent",
    scored: false,
    state: "ready",
    verdict: "info",
    observation: is404 ? describeAbsent : describePresent(outcome.body),
    evidence: { url },
  });
}

/**
 * 产出三条 `advisory` 结果：`agent.ucp`、`agent.agents-md`、`agent.llms-txt`。
 *
 * 三者恒为 `scored: false`：UCP、WebMCP、llms.txt 都是格局未定的协议
 * （设计文档第九节明确写着「格局未定」），用未定的协议给网站打分，
 * 是本文档在 llms.txt 上已经拒绝过的矛盾，因此永不进分母。
 *
 * 三个入参都是 `safeFetch` 的返回（Task 8），本函数不自己发起请求。
 */
export function agentChannelChecks({ ucp, agentsMd, llmsTxt }, baseUrl) {
  const urlFor = (path) => (baseUrl ? `${baseUrl}${path}` : path);

  return [
    channelResult({
      id: "agent.ucp",
      outcome: ucp,
      url: urlFor("/.well-known/ucp"),
      describePresent: describeUcpBody,
      describeAbsent: "该站未提供 /.well-known/ucp。UCP 协议目前格局未定，缺失不代表任何问题。",
    }),
    channelResult({
      id: "agent.agents-md",
      outcome: agentsMd,
      url: urlFor("/agents.md"),
      describePresent: () => "该站提供了 /agents.md，其中包含面向 agent 的补充说明。",
      describeAbsent: "该站未提供 /agents.md。",
    }),
    channelResult({
      id: "agent.llms-txt",
      outcome: llmsTxt,
      url: urlFor("/llms.txt"),
      describePresent: () => LLMS_TXT_PRESENT_NOTE,
      describeAbsent: LLMS_TXT_ABSENT_NOTE,
    }),
  ];
}
