/**
 * 每一项检查的**大白话解释**：这是什么、不达标会怎样、怎么改。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这一层
 *
 * 报告此前只说**观测事实**：「meta description 共 51 个字符」「页面未声明
 * hreflang」。对懂行的人足够，对这个工具的真实用户——不知道 GEO 是什么、
 * 第一次来查自己官网的中小企业老板——等于什么都没说。
 *
 * 他看到一屏「需改进」，唯一能得到的信息是「我好像有问题」，
 * 而不知道那是什么问题、严不严重、找谁改、改起来多大事。
 *
 * 所以每一项要回答三个问题，缺一不可：
 *
 *   what  这东西是什么？          —— 用他知道的词解释，不用行话
 *   risk  不达标会损失什么？      —— 后果要具体，不能只说「不利于 SEO」
 *   fix   怎么改？               —— 要能照着做，或至少知道该找谁、说什么
 *
 * ---------------------------------------------------------------------------
 * 这一层不参与检测，只负责「翻译」
 *
 * 这些是**静态的科普文案**，与检测结果无关——同一个 id 不管测出什么结果，
 * 解释都一样。所以它不进 checkResult、不占 API 响应体积，
 * 由呈现端按 id 取用；文案要改时也不必重新部署检测机。
 *
 * 代价是 id 必须与检查模块对得上。tests/explain.test.mjs 有一条合约测试
 * **跑真实的检查模块**、拿到全部 id、逐个核对这里有没有解释——漏一个就变红。
 * 人工维护清单迟早会漏，这条测试是唯一可靠的保障。
 *
 * ---------------------------------------------------------------------------
 * 措辞守则（与整个工具的原则一致）
 *
 *   - fix 里**不承诺结果**。「加上 canonical 就能被 AI 引用」是假话。
 *     能说的只有「不加，这个环节一定过不去」。
 *   - 不把「需改进」说成「你的网站坏了」。很多 warn 是合理选择
 *     （单语言站没有 hreflang 完全正确）。
 *   - 凡是需要开发介入的，明说「这项要找开发」，不假装老板自己能点两下搞定。
 */

/** 未列在下面时的兜底——**永远不该被用到**，合约测试守着。 */
const FALLBACK = Object.freeze({
  what: "这一项检查网站的一个技术细节。",
  risk: "具体影响见上方的观测结论。",
  fix: "如需说明，可联系我们。",
});

/**
 * 13 个爬虫准入项共用一份解释：它们问的是同一件事，
 * 只是换了个爬虫名字。逐个写 13 份，只会让读者以为有 13 件事要做。
 */
const CRAWLER_EXPLANATION = Object.freeze({
  what:
    "robots.txt 是放在你网站根目录的一个小文本文件，用来告诉各家爬虫「哪些页面可以抓、哪些不许抓」。" +
    "ChatGPT、Claude、Perplexity、Gemini 各自派出的爬虫，来之前都会先读这个文件。",
  risk:
    "被这个文件挡住的爬虫，完全看不到你的网站——在它对应的那个 AI 里，你等于不存在。" +
    "这跟你内容写得多好没有关系，是一道在门口就被拦下的问题。",
  fix:
    "在浏览器里打开「你的域名/robots.txt」看一眼。如果里面有针对这些爬虫名字的 Disallow: /，" +
    "而你并不想拦它们，把那几行删掉即可。这个文件不存在也没关系，那等于全部放行。" +
    "改完需要让维护网站的人重新发布一次。",
});

/**
 * id → { what, risk, fix }。
 * 顺序按分组排，方便与报告页对照着改文案。
 */
export const CHECK_EXPLANATIONS = Object.freeze({
  // ── AI 搜索准入 ────────────────────────────────────────────────────
  "access.canonical": {
    what:
      "canonical 是页面里的一行标记，用来声明「这一页的正式地址是哪个」。" +
      "同一个页面往往能从好几个网址打开：带 www 的、带跟踪参数的、带斜杠和不带斜杠的。",
    risk:
      "不声明，同一篇内容会被当成好几篇重复内容，彼此分散权重；" +
      "AI 引用时也可能指向一个带着乱七八糟参数的地址。",
    fix:
      "让维护网站的人在每个页面的 <head> 里加一行 canonical，指向你希望对外公开的那个正式网址。" +
      "WordPress、Shopify 这类建站系统装一个 SEO 插件就会自动生成。",
  },
  "access.noindex": {
    what:
      "noindex 是一句「请不要收录这一页」的指令，可以写在页面里，也可以藏在服务器返回的响应头里。",
    risk:
      "**这是最容易「自己把自己关掉」的一项。** 一旦误加在正式页面上，搜索引擎和 AI 会把这一页" +
      "从索引里彻底删掉——网站打得开、人看得见，但搜不到、也不会被任何 AI 引用。",
    fix:
      "最常见的来源是网站从测试环境上线时忘了摘掉。检查页面 <head> 里有没有 " +
      "<meta name=\"robots\" content=\"noindex\">，以及服务器有没有返回 X-Robots-Tag: noindex，有就去掉。",
  },
  "access.sitemap": {
    what:
      "sitemap.xml 是一份你网站所有页面的清单，让爬虫一次性知道你有哪些页面，而不用一层层点进去找。",
    risk:
      "没有它爬虫也能抓，但新页面和藏得深的页面会被发现得慢很多。页面数量多的站尤其明显。",
    fix:
      "WordPress、Shopify 这类建站系统基本都能自动生成，装个 SEO 插件开启即可。" +
      "生成之后把它的地址写进 robots.txt 的 Sitemap: 那一行。",
  },

  // ── 页面元信息与国际化 ─────────────────────────────────────────────
  "metadata.title": {
    what:
      "页面标题，就是浏览器标签页上显示的那行字，也是搜索结果里最大的那行标题。",
    risk:
      "缺了或者写得过长，搜索引擎和 AI 会自己从正文里拼一个——拼出来的往往不是你想让客户看到的那句话。",
    fix:
      "每个页面写一句独立的标题，把「你是做什么的 + 品牌名」说清楚，中文控制在 30 字以内。" +
      "首页尤其不要只写公司名，那对不认识你的人等于没有信息。",
  },
  "metadata.description": {
    what:
      "meta description 是一句页面摘要，通常显示在搜索结果标题下面那两行灰字里。",
    risk:
      "不写，展示什么就完全由搜索引擎决定，它可能随手截一段导航文字或版权声明。" +
      "这是少数几个你能自己控制「客户第一眼看到什么」的地方。",
    fix:
      "每页写一句 70–80 个中文字的摘要，说清这一页能解决什么问题。别所有页面共用同一句。",
  },
  "metadata.h1": {
    what:
      "H1 是页面上最大的那个主标题，用来告诉机器「这一页讲的是什么」。",
    risk:
      "没有 H1，机器判断页面主题只能靠猜。多个 H1 不算错（HTML5 允许），但主题会显得分散。",
    fix:
      "每页放一个 H1，写这一页真正的主题。特别注意别把 logo 图片套在 H1 里当占位——" +
      "那是很常见的做法，但那样 H1 里就一个字都没有了。",
  },
  "metadata.lang": {
    what:
      "<html lang> 是页面最开头的一个语言标记，告诉机器这一页是用什么语言写的。",
    risk:
      "不声明，机器只能靠猜。中英混排的外贸站最容易被判错语言，" +
      "进而被推给错误地区的用户，或者被自动翻译成一团糟。",
    fix:
      "让维护网站的人在 <html> 标签上加一个 lang：英文站写 lang=\"en\"，中文站写 lang=\"zh-CN\"。一行的事。",
  },
  "metadata.hreflang": {
    what:
      "hreflang 用来告诉搜索引擎「这一页还有别的语言版本，分别在哪几个网址」。",
    risk:
      "只有一种语言的站没有它完全正确，**这一项对你不适用，可以不管**。" +
      "但如果你做了中英双语，缺了它，Google 和 AI 不知道该把哪个版本给哪个国家的用户，" +
      "几个语言版本还会互相当成重复内容抢权重。",
    fix:
      "多语言站：让维护网站的人在每一页里把所有语言版本互相声明一遍，" +
      "并加一条 x-default 指向没有匹配语言时的默认版本。",
  },
  "metadata.viewport": {
    what:
      "viewport 是一行告诉手机浏览器「请按屏幕宽度重新排版」的设置。",
    risk:
      "缺了它，手机上打开会显示成缩小的电脑版，要放大才能看清。" +
      "而 Google 现在是**以手机版为准**来评估和收录网站的。",
    fix:
      "在 <head> 里加一行 <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">。" +
      "现在的建站模板基本都自带，缺失通常说明模板已经很老了。",
  },
  "metadata.og": {
    what:
      "Open Graph 是一组标记，决定你的网址被转发到微信、LinkedIn、Facebook 时，" +
      "卡片上显示的标题、描述和缩略图。",
    risk:
      "没有的话，链接分享出去可能只剩一条光秃秃的网址，没有图也没有说明，点击率差很多。",
    fix:
      "加 og:title、og:description、og:image 三个标记，配图建议 1200×630 像素。SEO 插件一般能直接配。",
  },
  "metadata.img-alt": {
    what:
      "alt 是给图片配的一句文字说明。机器看不懂图片本身，只能读这句话。",
    risk:
      "产品图没有 alt，等于这些图对搜索引擎和 AI 完全不存在，图片搜索的流量也拿不到。" +
      "使用读屏软件的访客同样什么都看不到。",
    fix:
      "给有信息量的图片补一句说明，写清图里是什么（例如「304 不锈钢无缝管 直径 25mm」）。" +
      "纯装饰用的图片写 alt=\"\" 就是对的，不用硬编内容。",
  },

  // ── 静态可读性 ────────────────────────────────────────────────────
  "readability.static-text": {
    what:
      "指爬虫在**不运行网页脚本**的情况下，能直接读到多少正文。" +
      "很多用 Vue、React 做的网站，内容是打开页面之后由脚本临时生成的。",
    risk:
      "**这是 GEO 里最致命、也最常见的一项。** 人打开看得见，爬虫拿到的却是一片空白——" +
      "你的产品介绍、公司实力、资质证书，AI 一个字都读不到，自然无从引用。",
    fix:
      "自己先判断：在浏览器里右键选「查看网页源代码」，用 Ctrl+F 搜一段你的正文。" +
      "**搜不到，爬虫也搜不到。** 这一项要改动比较大，需要开发介入，" +
      "把关键内容改成服务端渲染（SSR）或预渲染。",
  },

  // ── 结构化数据 ────────────────────────────────────────────────────
  "structured.jsonld": {
    what:
      "结构化数据是一段藏在页面里、**专门写给机器看**的信息卡，" +
      "用固定格式写明「我们是什么公司、这是什么产品、卖多少钱、在哪里」。",
    risk:
      "没有它，AI 只能从一堆散文里猜你的基本事实，容易猜错，或者干脆不敢引用。" +
      "有它，AI 可以直接摘录，准确率高得多。",
    fix:
      "先补 Organization（公司信息）和 Product（产品）两类。" +
      "可以让开发按 schema.org 的格式加一段 JSON-LD，SEO 插件通常也能生成。",
  },
  "structured.sameas": {
    what:
      "sameAs 用来声明「我们在 LinkedIn、YouTube、Facebook 上的官方账号是这几个」。",
    risk:
      "不影响收录，属于加分项。有了它，AI 更容易确认「网上这几个账号和这家公司是同一家」，回答时更愿意采信。",
    fix:
      "在结构化数据的 Organization 里加一个 sameAs 数组，把官方社媒主页地址列进去。",
  },

  // ── AI 代理可用性 ─────────────────────────────────────────────────
  "agent.accessibility-tree": {
    what:
      "可访问性树是浏览器根据页面结构生成的一张「骨架图」，标明哪里是导航、哪里是正文、哪个是按钮。" +
      "读屏软件和 AI 代理都靠它理解页面。",
    risk:
      "骨架不完整，AI 代理就搞不清页面结构，无法可靠地读取内容，更谈不上代替用户操作（询价、下单）。",
    fix:
      "常见原因是：用 <div> 假装按钮、图片没有 alt、表单控件没有配标签。" +
      "让开发改成语义化标签：按钮用 <button>，导航用 <nav>，表单每个输入框配一个 <label>。",
  },
  "agent.cls": {
    what:
      "CLS 衡量页面加载时内容「乱跳」的程度——你正要点一个按钮，它突然被上面刚加载出来的图片挤走。",
    risk:
      "跳得厉害会让人误点、烦躁离开，Google 也把它算进排名信号里。",
    fix:
      "主要成因是图片和广告位没有预留高度。让开发给 <img> 补上 width 和 height 属性，" +
      "给会动态插入内容的区块预留固定高度。",
  },
  "agent.llms-txt": {
    what:
      "llms.txt 是一份放在网站根目录、专门写给大语言模型看的站点说明文件。",
    risk:
      "**目前还不是强制标准，Google 已明确表示不使用它**，所以这一项没有不扣分，也不影响收录。",
    fix:
      "不建议为它单独花钱。如果你的站有面向开发者的文档，加上会有一点好处，否则可以先放着。",
  },
  "agent.agents-md": {
    what:
      "agents.md 是一份写给 AI 代理看的操作说明，告诉它这个站点能做什么、怎么调用。",
    risk:
      "同样是早期约定，没有不扣分。",
    fix:
      "现阶段属于观望项，不必优先处理。",
  },
  "agent.ucp": {
    what:
      "UCP（Universal Commerce Protocol）是一套让 AI 代理直接完成交易的协议端点，目前处于很早期的阶段。",
    risk:
      "没有不扣分。它面向的是「AI 代替用户直接下单」这个还没普及的场景。",
    fix:
      "电商类站点可以关注它的进展，现阶段不必投入。",
  },

  // ── 性能 ─────────────────────────────────────────────────────────
  "performance.psi-score": {
    what:
      "Google PageSpeed Insights 给出的手机端性能分（满分 100），衡量页面打开的快慢。",
    risk:
      "打开太慢，客户等不及就走了，Google 排名也会受影响。" +
      "海外客户访问放在国内的服务器时，这一点尤其明显。",
    fix:
      "最常见的三件事：压缩图片（很多站首页图有好几 MB）、上 CDN、去掉用不上的第三方脚本。" +
      "分数低于 50 建议优先处理。",
  },
  "performance.crux-field": {
    what:
      "CrUX 是 Google 从**真实 Chrome 用户**那里收集的访问速度数据——不是模拟测出来的，是你真实访客的体感。",
    risk:
      "这一项没有数据**不代表网站有问题**，通常只是访问量还不够 Google 采样，小站很常见。",
    fix:
      "没有数据时不用做什么。有数据且指标偏差时，按上面「性能分」那一项的方向优化。",
  },
});

/**
 * 取某个检查项的解释。
 *
 * `robots.*` 走前缀匹配：13 个爬虫共用一份，且折叠后的条目 id 会带上
 * `.rollup` 后缀（见 collapseCrawlerItems），也必须能命中。
 */
export function explainFor(id) {
  if (typeof id !== "string" || id.length === 0) return FALLBACK;
  if (id.startsWith("robots.")) return CRAWLER_EXPLANATION;
  return CHECK_EXPLANATIONS[id] ?? CHECK_EXPLANATIONS[id.replace(/\.rollup$/, "")] ?? FALLBACK;
}

/** 有没有为这个 id 写过解释——合约测试用，不走兜底。 */
export function hasExplanation(id) {
  if (typeof id !== "string") return false;
  if (id.startsWith("robots.")) return true;
  return Object.hasOwn(CHECK_EXPLANATIONS, id.replace(/\.rollup$/, ""));
}

// ---------------------------------------------------------------------------
// 待办清单
// ---------------------------------------------------------------------------

/**
 * 优先级。数字小的排前面。
 *
 * **排序依据是「不改的后果有多严重」，不是「改起来有多容易」。**
 * noindex 排第一，因为它是唯一一个「一行配置让整页从所有索引里消失」的项；
 * 静态可读性第二，因为它让 AI 一个字都读不到。
 * 排在后面的不是不重要，是先修前面的收益更大。
 */
const PRIORITY = Object.freeze({
  "access.noindex": 10,
  "readability.static-text": 20,
  "metadata.title": 40,
  "metadata.description": 45,
  "structured.jsonld": 50,
  "metadata.h1": 55,
  "access.canonical": 60,
  "metadata.viewport": 65,
  "agent.accessibility-tree": 70,
  "access.sitemap": 75,
  "metadata.lang": 80,
  "performance.psi-score": 85,
  "metadata.og": 90,
  "metadata.img-alt": 95,
  "metadata.hreflang": 100,
  "agent.cls": 105,
});

/** robots 类统一给 30：仅次于 noindex 与静态可读性。 */
const CRAWLER_PRIORITY = 30;

function priorityOf(id) {
  if (typeof id === "string" && id.startsWith("robots.")) return CRAWLER_PRIORITY;
  return PRIORITY[id] ?? 500;
}

/**
 * 从原始检查项里挑出「需要用户处理的」，按严重程度排好，配上大白话说明。
 *
 * **只收 fail 与 warn，不收 pass。** 通过的项没有待办；
 * 把它们也列出来只会稀释真正要做的事。
 *
 * `blocked`（对方 403 把我们挡在门外）**不进这个清单**——那不是某一项的
 * 待办，而是整份报告的前提，顶部结论横幅已经专门讲了它。
 * 混进来会让用户以为有十几件事要做，其实是同一件。
 *
 * @param {Array<object>} items 未折叠的原始检查项
 * @returns {Array<{id:string, verdict:string, observation:string, what:string, risk:string, fix:string}>}
 */
export function actionPlan(items) {
  const seen = new Set();
  const out = [];
  for (const r of items ?? []) {
    if (r?.state !== "ready") continue;
    if (r.verdict !== "fail" && r.verdict !== "warn") continue;
    // 13 个爬虫共用一条待办：逐个列会变成十几行同样的话。
    const key = typeof r.id === "string" && r.id.startsWith("robots.") ? "robots.*" : r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = explainFor(r.id);
    out.push({
      id: r.id,
      verdict: r.verdict,
      observation: r.observation ?? "",
      what: e.what,
      risk: e.risk,
      fix: e.fix,
      priority: priorityOf(r.id),
    });
  }
  // fail 一律排在 warn 前面；同级按上面的严重程度表。
  return out.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === "fail" ? -1 : 1;
    return a.priority - b.priority;
  });
}
