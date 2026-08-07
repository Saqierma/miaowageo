/** 设计文档第五节的五个分组，封闭集合。 */
// metadata 组是 2026-08-07 加的第六组。
//
// 加它的理由是一次真实复盘：此前 18 个计分项里有 9 个是爬虫准入
// （`robots.txt 未限制 X 抓取本站`），占一半，而「没有拦你」是互联网的
// 默认状态——任何站点打开都是一片绿，真正的问题被淹没。
// 而任何 SEO 工具的第一屏内容（title / description / h1 / lang /
// hreflang / Open Graph / viewport / img alt）我们一项都没查。
//
// **改这个数组要同步改 web/lib/site-audit-present.mjs 的 GROUPS**，
// 两边都是封闭集合，对不上时新组的项会被呈现层整个丢掉——
// 而且不会报错，只是那一组凭空消失。
export const CHECK_GROUPS = Object.freeze([
  "access",
  "metadata",
  "readability",
  "structured",
  "agent",
  "performance",
]);

export const STATES = Object.freeze(["ready", "no_data", "not_wired"]);
export const VERDICTS = Object.freeze(["pass", "warn", "fail", "info"]);

/**
 * 一个项**为什么**没测到。封闭集合，state 非 ready 时必填。
 *
 * 加这个字段的理由（2026-08-07，来自一次真实提问）：报告里所有非 ready 的项
 * 都渲染成同一个灰色的「未测到」，而它们其实是两件性质完全不同的事——
 *
 *   - `metadata.img-alt` 未测到，因为**页面里根本没有 <img>**。无害，
 *     没有任何东西需要修，甚至不该计入「没覆盖到」。
 *   - `metadata.title` 未测到，因为**对方返回 403 把我们挡在门外**。
 *     这是本次检测最严重的发现，却和上面那条长得一模一样。
 *
 * Lighthouse 把这两者分成 "Not applicable" 与 "Error" 是对的。
 * 这个字段就是那条分界线，且**必须机器可读**：呈现层要据此写结论横幅，
 * 而结论是给客户看的判断——用中文文案去正则匹配出一个判断，
 * 是这个项目反复栽过跟头的做法。
 */
export const NO_DATA_REASONS = Object.freeze([
  // ── 对方侧没让我们拿到数据。这些**需要网站方采取行动**。
  "http_error",
  "throttled",
  "timeout",
  "network",
  "too_large",
  "cross_domain_redirect",
  "too_many_redirects",
  "private_address",
  "robots_disallowed",
  // ── 数据拿到了，但这一项对该页面/该站点本就不适用。**无须任何人做任何事。**
  "not_applicable",
  // ── 我方没测成。责任在我们，不该让用户以为是他们站点的问题。
  "worker_error",
]);

/**
 * 构造一个 CheckResult。
 *
 * 四条约束在这里强制，而不是靠调用方自觉：
 *   - state 非 ready 时清空 verdict：主站的合约测试断言「非 ready 的项不得渲染 verdict」，
 *     在数据源头清空比在渲染层过滤更可靠。
 *   - scored 必须显式传入：它是检查项的固有属性。若允许缺省，
 *     实现者很容易写成「按结果推断」，那会让分母随结果变化、站点之间失去可比性。
 *   - state 非 ready 时 reason 必填：**故意做成必填而不是可选**。可选的话，
 *     新写的检查会默默漏掉分类，于是「不适用」被算成「够不着」，
 *     结论横幅就会对着一个健康的站点说它把我们挡在门外。漏填要当场炸。
 *   - state 为 ready 时 reason 必须为 null：ready 的项没有「未测到的原因」，
 *     留着一个陈旧的 reason 会让呈现层把已测项也算进未覆盖里。
 */
export function checkResult({ id, group, scored, state, verdict = null, observation, evidence, limitation = null, reason = null }) {
  if (!CHECK_GROUPS.includes(group)) throw new Error(`未知的 group: ${group}`);
  if (!STATES.includes(state)) throw new Error(`未知的 state: ${state}`);
  if (typeof scored !== "boolean") throw new Error(`checkResult 必须显式传入 scored（布尔），收到：${scored}`);
  if (verdict !== null && !VERDICTS.includes(verdict)) throw new Error(`未知的 verdict: ${verdict}`);
  if (state === "ready") {
    if (reason !== null) throw new Error(`${id}：state 为 ready 的项不得带 reason，收到：${reason}`);
  } else if (!NO_DATA_REASONS.includes(reason)) {
    throw new Error(`${id}：state 为 ${state} 时必须给出 reason（取值见 NO_DATA_REASONS），收到：${reason}`);
  }
  return Object.freeze({
    id,
    group,
    scored,
    state,
    verdict: state === "ready" ? verdict : null,
    observation,
    evidence,
    limitation,
    reason: state === "ready" ? null : reason,
  });
}
