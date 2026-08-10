# 大型 B2B 平台：准入没问题，元信息有缺口

> 18 个计分项：**13 通过 / 2 需改进 / 3 未通过**。

| | |
| --- | --- |
| 被测站点 | https://www.made-in-china.com |
| 检测日期 | 2026-08-07 |
| 计分项 | 18 |
| 已通过 / 需改进 / 未通过 / 未测到 | **13 / 2 / 3 / 0** |
| 在线报告 | 见 [miaowageo.com/geocheck](https://miaowageo.com/geocheck) 重新检测复核 |

## 这个案例说明了什么

与上一例对照：同为大平台，技术准入面的差距可以非常大。

## 报告里最要紧的几条

| 判定 | 观测 |
| --- | --- |
| 未通过 | 页面中未发现任何 JSON-LD 结构化数据。 |
| 未通过 | 该站点未提供 sitemap.xml（404）。 |
| 未通过 | 浏览器构建出的可访问性树结构不完整（Lighthouse：Accessibility tree is not well-formed）。 |
| 需改进 | PageSpeed Insights 移动端性能分 80（满分 100）。 |
| 需改进 | CrUX 真实用户数据共 5 项指标：CLS FAST、TTFB AVERAGE、FCP FAST、INP FAST、LCP FAST。 |

## 原始数据

完整的检查结果在 [`raw/06-made-in-china.json`](raw/06-made-in-china.json)，共 26 项（含参考项）。
每一项都带 `observation`（观测到什么）与 `limitation`（这条结论的边界在哪）。

---

← [返回案例索引](README.md) ｜ [返回项目首页](../README.md)
