import { checkResult } from "../types.mjs";
import { outcomeToState } from "./fetch-outcome.mjs";

/** `<loc>` 在 urlset 与 sitemapindex 里都用来包 URL，直接数它比数 `<url>` 更通用。 */
function countLocEntries(body) {
  return (String(body ?? "").match(/<loc\b/gi) ?? []).length;
}

/**
 * `sitemap.xml` 的可达性与内容判定，产出一条 `access.sitemap`。
 *
 * **404 与 429/超时必须分开判定，不能都走 fetch-outcome 的默认映射。**
 * `outcomeToState` 对 `http_error` 统一记 `no_data`（只是文案里提一句「404」），
 * 因为它服务的是「我们连内容都没拿到」这一类通用语义。但对 sitemap 而言，
 * 404 是一个特例：它明确意味着「该站确实没有 sitemap.xml」，这是可以断言的事实，
 * 应该记成 `fail`，而不是和「429 限流、超时」这类「我们根本没测到」的情况混在一起
 * 都报 `no_data`。把后者报成 `fail`，就是在指控一件从未被观测过的事——
 * 这条区分与 `robots.mjs` 里 `robotsChecks` 用 `outcome.status === 404` 分离
 * 「该站没有 robots.txt」与「这次没测到」是同一条原则。
 */
export function sitemapCheck(outcome, sitemapUrl = "") {
  const is404 = outcome?.status === 404;
  const usable = outcome?.ok || is404;

  if (!usable) {
    const fallback = outcomeToState(outcome);
    return checkResult({
      id: "access.sitemap",
      group: "access",
      scored: true,
      state: fallback.state,
      reason: fallback.reason,
      observation: `${fallback.observation}sitemap 未测。`,
      evidence: { url: sitemapUrl },
    });
  }

  if (is404) {
    return checkResult({
      id: "access.sitemap",
      group: "access",
      scored: true,
      state: "ready",
      verdict: "fail",
      observation: "该站点未提供 sitemap.xml（404）。",
      evidence: { url: sitemapUrl },
    });
  }

  const body = outcome.body;
  const isIndex = /<sitemapindex[\s>]/i.test(String(body ?? ""));
  const isUrlset = /<urlset[\s>]/i.test(String(body ?? ""));

  if (isIndex) {
    return checkResult({
      id: "access.sitemap",
      group: "access",
      scored: true,
      state: "ready",
      verdict: "pass",
      observation: "该站点提供了 sitemap index（多文件索引）。",
      evidence: { url: sitemapUrl },
      limitation: "V1 不展开子 sitemap 文件，仅确认索引本身可达，不校验子文件内容。",
    });
  }

  if (isUrlset) {
    const count = countLocEntries(body);
    return checkResult({
      id: "access.sitemap",
      group: "access",
      scored: true,
      state: "ready",
      verdict: count > 0 ? "pass" : "warn",
      observation: count > 0
        ? `该站点 sitemap.xml 可达，包含约 ${count} 条 URL。`
        : "该站点 sitemap.xml 可达，但不含任何 URL 条目。",
      evidence: { url: sitemapUrl, entries: count },
    });
  }

  return checkResult({
    id: "access.sitemap",
    group: "access",
    scored: true,
    state: "ready",
    verdict: "warn",
    observation: "该路径可达，但响应内容既不是 <urlset> 也不是 <sitemapindex>，可能不是有效的 sitemap。",
    evidence: { url: sitemapUrl },
  });
}
