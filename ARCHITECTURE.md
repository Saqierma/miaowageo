# Architecture & Design Decisions

The source comments in this repository are written in Chinese, because that is the language
of the people who maintain it. The comments carry the *why* — and the why is the part that
matters. This document exists so that an English-reading contributor is not shut out of it.

It is not a translation of the comments. It is the set of decisions that shaped the code:
what the constraint was, what we chose, and what we gave up. Where a decision is enforced by
a test, the test is named — those tests are the real specification.

---

## 1. Threat model: an anonymous public fetch endpoint is an SSRF gift to the internet

The product is a free checker with no sign-up. Anyone can hand it a URL and it will fetch that
URL from our server. Stated plainly, that is **a public API for making our machine issue HTTP
requests to arbitrary addresses on our attacker's behalf** — the textbook shape of SSRF.

The specific prizes an attacker is after:

- Cloud metadata services (`169.254.169.254`) — instance credentials
- Private ranges (`10/8`, `172.16/12`, `192.168/16`, `127/8`, link-local, ULA)
- Our own public IP — bouncing back into services that trust "local" traffic
- Non-HTTP schemes and non-standard ports used to reach internal daemons

`src/fetchers/net-guard.mjs` is the single place where an address is judged. Everything else
calls into it. The rules that matter:

- **Scheme allowlist**: `http` and `https` only.
- **Every resolved address is judged, not just the first.** A hostname with several A records
  where only one is private is a real evasion; judging one address and connecting to another
  is exactly the bug this file exists to prevent.
- **Our own public egress IP is treated as private.** Configured via
  `MIAOWA_AUDIT_OWN_PUBLIC_IP`. Without it, `http://<our-own-ip>:4319/` reaches the worker's
  own control surface from the outside.
- **Redirects are re-judged at every hop.** A public URL that 302s to `169.254.169.254` is the
  standard bypass; a guard that only checks the URL the user typed does nothing.

Tests: `tests/net-guard.test.mjs`.

---

## 2. Connection pinning: judge an address, then connect to *that* address

Judging an address and then handing the hostname to the HTTP client re-resolves DNS, and the
second resolution can return something different from the first. That is **DNS rebinding**, and
it defeats an otherwise correct guard.

`src/fetchers/safe-fetch.mjs` closes the window: resolve → judge → **connect to the judged IP**
via a custom `lookup` that ignores the hostname entirely (`makePinnedLookup`).

Two details that are easy to get wrong, and both have tests:

**The `Host` header must remain the real hostname.** Pinning fixes *where the socket goes*, not
*what the server is asked for*. Replacing the hostname with the IP breaks virtual-host routing
and, over HTTPS, fails certificate validation — a failure that only shows up in production.

**Caller-supplied headers are spread *before* `host` and `user-agent`, never after:**

```js
headers: {
  ...(extraHeaders ?? {}),      // caller's headers go down first
  host: targetUrl.host,         // these two always win
  "user-agent": userAgent ?? OUTBOUND_USER_AGENT,
}
```

Reverse that order and a caller can overwrite `host`, which silently re-points the request while
the connection stays pinned — the pinning becomes decorative. The UA differential probe needs to
override `user-agent`, so the extension point had to exist; the ordering is what keeps it safe.

**Changing our User-Agent relaxes nothing else.** Pinning, private-address judgement, per-origin
throttling and the redirect cap all apply identically to probe requests. Those are defences, and
they have nothing to do with who we claim to be.

Tests: `tests/safe-fetch.test.mjs` (the group labelled C3).

---

## 3. Headless browser isolation

Some checks need a real browser (see §6). That means loading **arbitrary URLs submitted by
strangers** in Chrome, on our machine.

- **Allowlist proxy** (`src/proxy/allowlist-proxy.mjs`): every outbound request Chrome makes —
  subresources and redirects included — goes through the same address judgement as §1. Chrome's
  own network stack is not trusted to stay on target.
- **AppArmor profile** (`deploy/apparmor-miaowa-chrome`): Ubuntu 24.04 forbids unprivileged user
  namespaces, so Chrome's sandbox will not start. The usual workaround is `--no-sandbox`. We do
  not do that. Instead the binary is granted `userns` capability specifically. Disabling the
  sandbox while loading strangers' pages hands the machine to whoever submits a URL.

The deploy README insists the AppArmor profile be verified **by removing it and observing the
failure**. "It works with the profile installed" proves nothing — it may have worked anyway.

---

## 4. The three-state model: "not measured" is never "failed"

Every check result carries a state, not just a verdict:

| State | Meaning |
| --- | --- |
| `ready` | We obtained the data and reached a conclusion |
| `no_data` | We could not obtain the data |
| `not_wired` | This tool failed on our side |

When `state !== "ready"`, a machine-readable `reason` from the closed set `NO_DATA_REASONS`
is **mandatory** — `src/types.mjs` throws if it is missing. Making it required rather than
optional immediately exposed three wrapper functions that accepted a `reason` parameter and
never passed it through: they had been silently discarding it, and nothing had noticed.

The presentation layer splits `no_data` four ways, because the reader's next action differs
completely:

- **Not applicable** — the page has no images; nothing to do
- **Not obtained** — the site returned 403/timeout/rate-limit; **this is the one to act on**
- **Not completed** — our service broke; nothing to do with your site
- **Unknown** — legacy rows with no `reason`

Collapsing those into one grey "not measured" produces a report where a site that blocked us
entirely looks like a clean bill of health. That happened, a user asked what the grey rows meant,
and this model is the answer.

**The rule this protects:** if a site refuses us, we do not mark its checks failed. We did not
measure them, so we cannot call them wrong.

Tests: `tests/types.test.mjs`, `tests/no-data-reason-contract.test.mjs`.

---

## 5. The Googlebot control probe: the one place we deliberately make our own life harder

The UA differential matrix requests one page seven times from the same machine, same egress IP,
same moment, changing only the User-Agent (`src/probe/ua-matrix.mjs`).

The naive reading — "our GPTBot probe got a 403, therefore this site blocks GPTBot" — is wrong,
and wrong in a way that would systematically accuse correctly-configured sites.

Our checkpoint is not inside OpenAI's or Anthropic's published crawler IP ranges. Verified-bot
mechanisms (Cloudflare's, among others) perform reverse-DNS validation and **correctly** refuse
our unverified claim to be GPTBot — while admitting the real one. A 403 to us is, in that case,
evidence that the site is configured *well*.

Googlebot is the control, because essentially nobody blocks Googlebot on purpose:

| Chrome | Googlebot | GPTBot | Conclusion |
| --- | --- | --- | --- |
| 200 | 200 | **403** | A rule aimed at AI crawlers really does exist. Solid — identity verification would have refused the spoofed Googlebot too |
| 200 | **403** | **403** | The site checks unverified bot claims as such. The real GPTBot may well get in. **We report that we cannot tell** |
| 200 | 200 | 200 | Nothing blocked at this layer |
| **403** | — | — | Even a browser UA is refused — likely TLS fingerprinting or a JS challenge. The matrix cannot measure such sites, and says so |

`interpretMatrix` checks the `verification` branch **before** `ai_blocked`. That ordering is the
whole design; reversing it reintroduces the false accusation. There is a test per row.

The same discipline applies downstream. The report's top conclusion banner used to reason
independently — "a headless browser got in, our fetcher did not, therefore GPTBot is likely
blocked too" — and that inference does not hold: both clients are unverified, and the headless
browser used a *browser* UA, which verified-bot mechanisms do not challenge at all. The banner
now defers to the matrix when the matrix has data, and states both possibilities when it does not.
(That banner lives in the website front-end, which is not part of this repository — this repo is
the checking engine. The `interpretation` value it keys off is produced here, by `interpretMatrix`.)

**Honesty note on spoofing.** The probe User-Agents are exact spoofs of the real crawler strings —
WAF rules match on UA, so anything less would not measure the thing we claim to measure. Every
probe also carries `X-Probed-By: MiaowaGEO-Audit (+https://miaowageo.com/geocheck)` so that whoever
reads those server logs can see who was probing. `robots.txt` is still obeyed: changing our
User-Agent does not entitle us to ignore a site's crawling rules. Probes are issued serially
under the shared per-origin throttle — seven simultaneous requests to one site look like an attack.

---

## 6. Training crawlers vs retrieval crawlers — and the bug we shipped

AI vendors operate crawlers in tiers. One company typically has three, doing different jobs:

| Tier | Purpose | Consequence of blocking |
| --- | --- | --- |
| Training | Collects training corpus | A copyright decision. **Does not affect citation eligibility** |
| Retrieval | Builds the search index | **You vanish from that AI's answers** |
| User-triggered | Fetches live when a user asks | Affects that one conversation |

So: **training tier is never scored, retrieval tier always is** (`src/checks/robots.mjs`).
Conflating them is the single most common error in GEO writing, and refusing to make it is a
large part of why this tool exists.

**We made it anyway.** Until August 2026 this table had OpenAI's three tiers right
(GPTBot / OAI-SearchBot / ChatGPT-User) and Anthropic's perfectly symmetric three tiers wrong:
`ClaudeBot` was scored and annotated "affects Claude retrieval", when Anthropic documents it as
training-only; `Claude-SearchBot`, the retrieval crawler, was **absent from the table entirely**.
Two standards inside one file, and the failing one was our own headline claim.

It survived because the tests asserted *facts* — `results.length === 13`, this id is scored —
and no test asserted the *principle*. Fact assertions stop people deleting things. They cannot
stop a wrong classification made on day one, because the wrong classification is what the
assertions were written against.

The fix added three tests that encode the principle itself:

1. Every training-tier crawler is unscored; every retrieval-tier crawler is scored and fails when blocked
2. Every crawler must be assigned to a tier — so a newly added crawler cannot quietly belong to none
3. Each vendor's three tiers must all be present and consistently classified — the asymmetry itself turns red

`CRAWLER_TIERS` is exported from the source rather than duplicated in the test file, precisely so
that test 2 can catch an unclassified addition.

Reference: Anthropic support article 8896518 — ClaudeBot "collecting web content that could
potentially contribute to their training"; Claude-SearchBot "navigates the web to improve search
result quality".

---

## 7. Mutation testing is the discipline, not the test count

Every significant defence in this repository has been mutation-tested: the defensive code is
deleted or inverted, and we confirm a test actually turns red. A test that cannot fail is worse
than no test, because it advertises protection that is not there.

Two lessons learned the hard way, both of which changed how the harness is written:

**The mutation anchor must be present *and unique*.** A `String.replace` anchored on text that
appears twice — once in a comment, once in code — patches the comment. The injection never
happens, the suite stays green, and the result is recorded as "defence verified". The harness now
counts occurrences and refuses to run unless the count is exactly one.

**Tests can pass for the wrong reason.** Three real examples from this codebase:

- A test asserted a DOM regex matched — but the regex also matched an unrelated element, so
  deleting the feature left it green
- A test read `if (mobile) assert(...)` where `mobile` was always `null`, so the assertion never ran
- A test asserted `opts.userAgent === PROBES[i].ua` — comparing the implementation to itself,
  which is true no matter what either side says

The countermeasure is to assert against **literal expected values** and, where practical, against
**real behaviour** — a real `node:http` server rather than a re-implementation of the logic under
test.

**Fixtures should come from reality where reality is available.** The WAF fingerprinting module
failed to recognise Fastly for a while: the rules matched `x-fastly-request-id` and
`server: fastly`, neither of which appears on an actual Fastly response. Hand-written fixtures did
not catch it, because they were written from the same misunderstanding as the code. Real captured
response headers did.

---

## 8. Three stages, three concurrency pools

| Stage | Cost | Concurrency | Rationale |
| --- | --- | --- | --- |
| Light check | A few HTTP requests | User waits synchronously | 11s hard timeout, worst path already 10.7s — **no headroom** |
| Deep check | Launches Chrome, 1–2 GB | **1 globally** | Memory is the binding constraint |
| UA probe | 8 HTTP requests | 4 | Cheap; should not queue behind something expensive |

The probe deliberately does not ride along with the deep check: queueing a stage that issues a
handful of HTTP requests behind a stage that launches a browser and permits exactly one at a time
makes no sense. Both are triggered in parallel from `after()`, each with its own pool and its own
database columns (`<stage>_result` / `_state` / `_checked_at`).

It does not ride along with the light check either — that is the one the user is watching, and its
budget is fully spent.

---

## Where to start reading

| If you want to understand… | Read |
| --- | --- |
| The security boundary | `src/fetchers/net-guard.mjs`, then `src/fetchers/safe-fetch.mjs` |
| What is checked and why it is scored that way | `src/checks/robots.mjs`, `src/types.mjs` |
| The UA differential matrix | `src/probe/ua-matrix.mjs`, then `src/probe/waf-fingerprint.mjs` |
| How results become sentences | `src/explain.mjs` |
| What the project refuses to claim | The `limitation` field on every check result |

The tests are the specification. If a comment and a test disagree, the test is right and the
comment is a bug.
