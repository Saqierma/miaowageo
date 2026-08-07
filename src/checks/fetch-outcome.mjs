export const OK = Symbol("fetch-ok");

/**
 * reason → { state, observation }。
 *
 * 归类原则：**能不能怪对方**。
 * 对方站点限流、超时、404、跳走了、robots 禁止 —— 都是对方侧的正常事实，记 no_data。
 * 我们自己的进程崩了、配额耗尽 —— 记 not_wired。
 *
 * 这条区分不是文字游戏：报告里「对方站点本次限流」和「我们没测成」
 * 对客户意味着完全不同的下一步。
 *
 * **每个分支还要回传 reason 原因码**（见 types.mjs 的 NO_DATA_REASONS）。
 * observation 是给人读的中文，reason 是给呈现层做判断用的。
 * 两者必须同时给：呈现层要靠 reason 决定顶部结论横幅怎么写，
 * 而从中文文案里正则出一个判断，是这个项目栽过跟头的做法。
 */
const MAP = {
  http_error:            (o) => ({ state: "no_data",   reason: "http_error",            observation: o.status === 404 ? "该资源不存在（404）。" : `对方返回 HTTP ${o.status}，本次未取得内容。` }),
  throttled:             ( ) => ({ state: "no_data",   reason: "throttled",             observation: "对方站点限流，本次未测到。本工具不重试，避免加重对方负担。" }),
  timeout:               ( ) => ({ state: "no_data",   reason: "timeout",               observation: "请求超时，本次未取得内容。可能是网络或对方策略。" }),
  network:               ( ) => ({ state: "no_data",   reason: "network",               observation: "本次无法访问，可能是网络或对方策略。" }),
  too_large:             ( ) => ({ state: "no_data",   reason: "too_large",             observation: "响应体超过本工具的大小上限，本次未解析。" }),
  cross_domain_redirect: (o) => ({ state: "no_data",   reason: "cross_domain_redirect", observation: `该 URL 跳转到其他域（${o.finalUrl ?? "未知"}），本工具不跨域跟随。` }),
  too_many_redirects:    ( ) => ({ state: "no_data",   reason: "too_many_redirects",    observation: "重定向层数过多，本次未取得内容。" }),
  private_address:       ( ) => ({ state: "no_data",   reason: "private_address",       observation: "该地址解析到非公网地址，本工具拒绝访问。" }),
  robots_disallowed:     ( ) => ({ state: "no_data",   reason: "robots_disallowed",     observation: "该站 robots.txt 禁止本工具抓取此路径，据此未取内容。" }),
  worker_error:          ( ) => ({ state: "not_wired", reason: "worker_error",          observation: "检测服务本次未能完成该项。" }),
};

/**
 * **这里刻意不给 404 开特例。**
 *
 * 曾经想过把 404 映射成 `not_applicable`（「这个资源本来就不存在，没什么要修的」），
 * 但那是基于一个错误假设。真正会出现「该资源不存在是正常结论」的三处——
 * `robots.mjs`、`sitemap.mjs`、`agent-channels.mjs`——**都在调用本函数之前
 * 就用 `outcome.status === 404` 拦下了**，各自判成可断言的事实（ready）。
 *
 * 于是能把 404 传到这里的只剩**页面本身**。而页面 404 意味着「用户提交的
 * 这个地址不存在」——那是他必须知道并处理的事，映射成「不适用」
 * （其语义是「无须任何人做任何事」）会把一个真问题说成无事发生。
 */
export function outcomeToState(outcome) {
  if (outcome?.ok) return OK;
  const build = MAP[outcome?.reason] ?? MAP.worker_error;
  return build(outcome ?? {});
}
