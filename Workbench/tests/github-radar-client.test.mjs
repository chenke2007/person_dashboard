import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubRadarClient } from "../server/ai-radar/github-client.mjs";
import { GitHubRadarError } from "../server/ai-radar/github-errors.mjs";
import { radarRepositorySchema } from "../server/ai-radar/radar-schema.mjs";

const INSTANT = "2026-09-04T01:00:00.000Z";
const SHA = "a".repeat(40);
const SECRET = "synthetic-test-credential";
function repository(overrides = {}) {
  return { id: 101, full_name: "demo-lab/synthetic-agent", html_url: "https://github.com/demo-lab/synthetic-agent",
    description: "Synthetic demonstration", language: "JavaScript", topics: ["agent"], stargazers_count: 0,
    forks_count: 3, open_issues_count: 1, archived: false, fork: false, license: { spdx_id: "MIT" },
    default_branch: "main", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    pushed_at: null, ...overrides };
}
function json(body, status = 200, headers = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function client(fetchImpl, options = {}) { return createGitHubRadarClient({ fetchImpl, now: () => new Date(INSTANT), ...options }); }
const details = { repositories: [{ fullName: "demo-lab/synthetic-agent", focusAreas: ["agent"] }] };
const source = { fullName: "demo-lab/synthetic-agent", ref: SHA };

test("discovery normalizes canonical metadata, unions focus areas and never exposes credentials", async () => {
  const calls = [];
  const api = client(async (url, options) => { calls.push({ url, options }); return json({ total_count: 1, incomplete_results: false, items: [repository()] }); }, { token: SECRET });
  const result = await api.discoverCandidates({ focusAreas: ["agent", "ai-coding"] });
  assert.equal(result.repositories.length, 1);
  assert.deepEqual(result.repositories[0].focusAreas, ["agent", "ai-coding"]);
  assert.equal(result.repositories[0].stars, 0);
  assert.equal(result.repositories[0].observedAt, INSTANT);
  assert.equal(result.repositories[0].license, "MIT");
  assert.equal(radarRepositorySchema.safeParse(result.repositories[0]).success, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(result.partial, false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://api.github.com");
    assert.equal(call.options.headers.Accept, "application/vnd.github+json");
    assert.equal(call.options.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.equal(call.options.headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(call.options.redirect, "manual");
  }
});

test("discovery follows bounded same-query pagination and filters archived and fork repositories", async () => {
  let calls = 0;
  const api = client(async (url) => {
    calls++;
    const next = new URL(url); next.searchParams.set("page", "2");
    return calls === 1
      ? json({ total_count: 4, incomplete_results: false, items: [repository({ archived: true }), repository({ id: 102, fork: true })] }, 200, { link: `<${next}>; rel="next"` })
      : json({ total_count: 4, incomplete_results: false, items: [repository(), repository({ id: 104, full_name: "demo-lab/other", html_url: "https://github.com/demo-lab/other" })] });
  });
  const result = await api.discoverCandidates({ focusAreas: ["agent"], maxCandidates: 1 });
  assert.equal(calls, 2);
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].id, 101);
  assert.equal(result.truncated, true);
});

test("successful 304 revalidates cached metrics at current time without exposing mutable cache state", async () => {
  let date = new Date(INSTANT), calls = 0;
  const api = client(async (_url, options) => {
    calls++;
    if (calls === 1) return json(repository({ stargazers_count: null, license: null, default_branch: null }), 200, { etag: '"synthetic-v1"' });
    assert.equal(options.headers["If-None-Match"], '"synthetic-v1"');
    return json(null, 304);
  }, { now: () => date });
  const first = await api.getRepositories(details);
  date = new Date(date.getTime() + 60000);
  const second = await api.getRepositories(details);
  assert.equal(second.repositories[0].observedAt, "2026-09-04T01:01:00.000Z");
  assert.deepEqual(second.repositories, first.repositories.map((entry) => ({ ...entry, observedAt: "2026-09-04T01:01:00.000Z" })));
  assert.equal(second.repositories[0].stars, null);
  assert.equal(second.repositories[0].license, null);
  first.repositories[0].description = "mutated caller";
  assert.equal((await api.getRepositories(details)).repositories[0].description, "Synthetic demonstration");
});

test("cache-less 304 is a sanitized failure, not an empty success", async () => {
  const result = await client(async () => json(null, 304)).getRepositories(details);
  assert.equal(result.repositories.length, 0);
  assert.equal(result.errors[0].code, "GITHUB_CACHE_MISS");
  assert.equal(result.partial, true);
});

test("details preserve successful observations, null metrics and sanitized failures", async () => {
  const api = client(async (url) => url.endsWith("/missing") ? json({ message: SECRET }, 404) : json(repository({ stargazers_count: undefined, forks_count: 0 })), { token: SECRET });
  const result = await api.getRepositories({ repositories: [...details.repositories, { fullName: "demo-lab/missing" }] });
  assert.equal(result.repositories.length, 1);
  assert.equal(result.repositories[0].stars, null);
  assert.equal(result.repositories[0].forks, 0);
  assert.equal(result.errors[0].fullName, "demo-lab/missing");
  assert.equal(result.errors[0].code, "GITHUB_NOT_FOUND");
  assert.equal(result.partial, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("primary limit stops all requests across calls until reset and Retry-After both elapse", async () => {
  let date = new Date(INSTANT), calls = 0;
  const api = client(async () => {
    calls++;
    return calls === 1 ? json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(date.getTime() / 1000 + 120), "retry-after": "60" }) : json(repository());
  }, { now: () => date });
  const first = await api.getRepositories({ repositories: [...details.repositories, { fullName: "demo-lab/other" }] });
  assert.equal(calls, 1);
  assert.equal(first.errors[0].code, "GITHUB_PRIMARY_RATE_LIMIT");
  assert.equal(first.retryAt, "2026-09-04T01:02:00.000Z");
  assert.equal((await api.getRepositories(details)).retryAt, first.retryAt);
  assert.equal(calls, 1);
  date = new Date(first.retryAt);
  assert.equal((await api.getRepositories(details)).repositories.length, 1);
  assert.equal(calls, 2);
});

test("secondary limits return increasing minimum one-minute backoff with no automatic retries", async () => {
  let date = new Date(INSTANT), calls = 0;
  const api = client(async () => { calls++; return json({ message: "secondary rate limit" }, calls === 1 ? 429 : 403, { "retry-after": "1" }); }, { now: () => date });
  const first = await api.getRepositories(details);
  assert.equal(first.errors[0].code, "GITHUB_SECONDARY_RATE_LIMIT");
  assert.equal(first.retryAt, "2026-09-04T01:01:00.000Z");
  date = new Date(first.retryAt);
  const second = await api.getRepositories(details);
  assert.equal(second.retryAt, "2026-09-04T01:03:00.000Z");
  assert.equal(calls, 2);
});

test("Retry-After HTTP date is honored and discovery preserves earlier pages on rate limit", async () => {
  let calls = 0;
  const api = client(async (url) => {
    calls++; const next = new URL(url); next.searchParams.set("page", "2");
    return calls === 1 ? json({ total_count: 2, incomplete_results: false, items: [repository()] }, 200, { link: `<${next}>; rel="next"` })
      : json({}, 429, { "retry-after": "Fri, 04 Sep 2026 01:05:00 GMT" });
  });
  const result = await api.discoverCandidates({ focusAreas: ["agent", "ai-coding"] });
  assert.equal(result.repositories.length, 1);
  assert.equal(result.retryAt, "2026-09-04T01:05:00.000Z");
  assert.equal(calls, 2);
});

test("concurrent methods serialize the complete request and response read", async () => {
  let active = 0, peak = 0, calls = 0;
  const api = client(async () => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--; return json(repository());
  });
  const results = await Promise.all([api.getRepositories(details), api.getRepositories(details), api.getRepositories(details)]);
  assert.equal(peak, 1);
  assert.equal(calls, 3);
  assert.ok(results.every((result) => result.repositories.length === 1));
});

test("malicious, changed-query, looping and malformed pagination never receive another request", async () => {
  for (const link of ['<https://evil.example/search/repositories?page=2>; rel="next"', '<http://api.github.com/search/repositories?page=2>; rel="next"', '<https://api.github.com/user>; rel="next"', '<https://api.github.com/search/repositories?q=unbounded&page=2>; rel="next"', 'garbage; rel="next"']) {
    let calls = 0;
    const result = await client(async () => { calls++; return json({ total_count: 1, incomplete_results: false, items: [repository()] }, 200, { link }); }).discoverCandidates({ focusAreas: ["agent"] });
    assert.equal(calls, 1);
    assert.equal(result.errors[0].code, "GITHUB_UNSAFE_PAGINATION");
    assert.equal(result.repositories.length, 1);
  }
});

test("redirects are rejected without forwarding authorization even to a same-origin route", async () => {
  for (const location of ["https://evil.example/steal", "https://api.github.com/user", "https://api.github.com/repos/demo-lab/renamed"]) {
    let calls = 0;
    const result = await client(async (_url, options) => { calls++; assert.equal(options.redirect, "manual"); return json({}, 302, { location }); }, { token: SECRET }).getRepositories(details);
    assert.equal(calls, 1);
    assert.equal(result.errors[0].code, "GITHUB_REDIRECT_REJECTED");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("input validation rejects unknown focus areas and unsafe repository/ref identifiers before fetch", async () => {
  let calls = 0;
  const api = client(async () => { calls++; return json({}); });
  for (const input of [{ focusAreas: ["unknown"] }, { focusAreas: [] }, { focusAreas: ["agent"], maxPages: 0 }]) {
    await assert.rejects(api.discoverCandidates(input), (error) => error instanceof GitHubRadarError && error.code === "GITHUB_INVALID_INPUT");
  }
  for (const fullName of ["../secret", "demo-lab/..", "https://evil.example/a", "demo-lab/a?x=y", "demo-lab/a/b"]) {
    await assert.rejects(api.getRepositories({ repositories: [{ fullName }] }), { code: "GITHUB_INVALID_INPUT" });
  }
  for (const ref of ["../main", "main?token=x", "refs//main", "main@{1}"]) {
    await assert.rejects(api.getReadme({ ...source, ref }), { code: "GITHUB_INVALID_INPUT" });
  }
  assert.equal(calls, 0);
});

test("invalid version payloads and credential echoes cannot become observations or cached values", async () => {
  for (const payload of [{}, repository({ id: "101" }), repository({ archived: undefined }), repository({ stargazers_count: -1 }), repository({ description: SECRET }), repository({ topics: ["bad topic"] }), repository({ full_name: "demo-lab/elsewhere" })]) {
    const result = await client(async () => json(payload), { token: SECRET }).getRepositories(details);
    assert.equal(result.repositories.length, 0);
    assert.equal(result.errors[0].code, "GITHUB_INVALID_PAYLOAD");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("timeouts and transport failures have fixed sanitized errors and release the queue", async () => {
  let signal;
  const api = client(async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 5 });
  const result = await api.getRepositories(details);
  assert.equal(result.errors[0].code, "GITHUB_TIMEOUT");
  assert.equal(signal.aborted, true);
  const failed = await client(async () => { throw new Error(`Authorization: Bearer ${SECRET}`); }, { token: SECRET }).getRepositories(details);
  assert.equal(failed.errors[0].code, "GITHUB_NETWORK_ERROR");
  assert.equal(JSON.stringify(failed).includes(SECRET), false);
});

test("response byte limits apply to streamed JSON and declared content length", async () => {
  for (const response of [new Response("x".repeat(2000)), json(repository(), 200, { "content-length": "9999999" })]) {
    const result = await client(async () => response, { maxResponseBytes: 1024 }).getRepositories(details);
    assert.equal(result.errors[0].code, "GITHUB_RESPONSE_TOO_LARGE");
  }
});

test("README and head commit are on-demand, fixed-ref, separately cached source representations", async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/readme")) return json({ type: "file", name: "README.md", path: "README.md", sha: "b".repeat(40), encoding: "base64", size: 16, content: Buffer.from("# Synthetic demo").toString("base64") });
    return json({ sha: SHA, commit: { committer: { date: INSTANT } } });
  });
  assert.equal(calls.length, 0);
  const readme = await api.getReadme(source);
  assert.deepEqual(readme, { fullName: source.fullName, ref: SHA, sha: "b".repeat(40), path: "README.md", content: "# Synthetic demo", observedAt: INSTANT });
  const head = await api.getHeadCommit(source);
  assert.deepEqual(head, { fullName: source.fullName, ref: SHA, sha: SHA, committedAt: INSTANT, observedAt: INSTANT });
  assert.equal(new URL(calls[0].url).searchParams.get("ref"), SHA);
  assert.ok(calls[1].url.endsWith(`/commits/${SHA}`));
});

test("invalid source payloads and source errors reject with sanitized typed errors", async () => {
  for (const payload of [{ content: "bad" }, { type: "file", path: "../README.md", sha: SHA, encoding: "base64", size: 1, content: "eA==" }]) {
    await assert.rejects(client(async () => json(payload)).getReadme(source), { code: "GITHUB_INVALID_PAYLOAD" });
  }
  await assert.rejects(client(async () => json({ message: SECRET }, 404), { token: SECRET }).getReadme(source), (error) => {
    assert.equal(error.code, "GITHUB_NOT_FOUND"); assert.equal(JSON.stringify(error).includes(SECRET), false); return true;
  });
  await assert.rejects(client(async () => json({ sha: "b".repeat(40), commit: { committer: { date: INSTANT } } })).getHeadCommit(source), { code: "GITHUB_INVALID_PAYLOAD" });
});

test("secondary-limit 403 without Retry-After still stops requests, while ordinary 403 stays forbidden", async () => {
  let calls = 0;
  const api = client(async () => { calls++; return json({ message: "You have exceeded a secondary rate limit. Please wait before retrying." }, 403); });
  const result = await api.getRepositories({ repositories: [...details.repositories, { fullName: "demo-lab/other" }] });
  assert.equal(result.errors[0].code, "GITHUB_SECONDARY_RATE_LIMIT");
  assert.equal(result.retryAt, "2026-09-04T01:01:00.000Z");
  assert.equal(calls, 1);
  assert.equal((await client(async () => json({ message: "Forbidden" }, 403)).getRepositories(details)).errors[0].code, "GITHUB_FORBIDDEN");
});

test("invalid calendar dates and explicit null topics are rejected rather than silently normalized", async () => {
  for (const payload of [repository({ created_at: "2026-02-31T00:00:00Z" }), repository({ topics: null })]) {
    const result = await client(async () => json(payload)).getRepositories(details);
    assert.equal(result.repositories.length, 0);
    assert.equal(result.errors[0].code, "GITHUB_INVALID_PAYLOAD");
  }
});

test("cache identity includes ref and capacity eviction never sends an orphan ETag", async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, etag: options.headers["If-None-Match"] });
    const ref = decodeURIComponent(url.split("/").at(-1));
    return json({ sha: ref, commit: { committer: { date: INSTANT } } }, 200, { etag: `"${ref}"` });
  }, { maxCacheEntries: 1 });
  await api.getHeadCommit(source);
  await api.getHeadCommit({ ...source, ref: "b".repeat(40) });
  await api.getHeadCommit(source);
  assert.ok(calls.every((call) => call.etag === undefined));
  await api.getHeadCommit(source);
  assert.equal(calls.at(-1).etag, `"${SHA}"`);
});

test("response body timeout uses injected sleep, aborts the stream and leaves the request queue usable", async () => {
  let expire, cancelled = false, calls = 0;
  const api = client(async () => {
    calls++;
    if (calls > 1) return json(repository());
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); }, cancel() { cancelled = true; } }));
  }, { sleep: () => new Promise((resolve) => { expire = resolve; }) });
  const pending = api.getRepositories(details);
  await new Promise((resolve) => setImmediate(resolve));
  expire();
  assert.equal((await pending).errors[0].code, "GITHUB_TIMEOUT");
  assert.equal(cancelled, true);
  assert.equal((await api.getRepositories(details)).repositories.length, 1);
});

test("late fetch completion after timeout cannot poison cooldown or cache", async () => {
  let resolveFetch, calls = 0;
  const api = client(async () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { resolveFetch = resolve; }) : json(repository());
  }, { timeoutMs: 5 });
  assert.equal((await api.getRepositories(details)).errors[0].code, "GITHUB_TIMEOUT");
  resolveFetch(json({}, 429));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await api.getRepositories(details)).repositories.length, 1);
});

test("valid JSON with invalid search shape fails explicitly and incomplete results remain partial", async () => {
  for (const payload of [{ items: [] }, { items: {}, total_count: 0, incomplete_results: false }]) {
    const result = await client(async () => json(payload)).discoverCandidates({ focusAreas: ["agent"] });
    assert.equal(result.errors[0].code, "GITHUB_INVALID_PAYLOAD");
  }
  const result = await client(async () => json({ items: [repository()], total_count: 1, incomplete_results: true })).discoverCandidates({ focusAreas: ["agent"] });
  assert.equal(result.partial, true);
  assert.equal(result.repositories.length, 1);
});

test("source errors and JSON escaped echoes cannot expose the configured credential", async () => {
  const escaped = JSON.stringify(repository({ description: SECRET })).replace(SECRET, SECRET.split("").map((letter) => `\\u${letter.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
  const result = await client(async () => new Response(escaped), { token: SECRET }).getRepositories(details);
  assert.equal(result.errors[0].code, "GITHUB_INVALID_PAYLOAD");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  const content = Buffer.from(SECRET);
  await assert.rejects(client(async () => json({ type: "file", path: "README.md", sha: SHA, encoding: "base64", size: content.length, content: content.toString("base64") }), { token: SECRET }).getReadme(source), { code: "GITHUB_INVALID_PAYLOAD" });
});

test("null method inputs and credential-bearing identifiers are sanitized validation errors", async () => {
  const api = client(async () => { throw new Error("must not request"); }, { token: SECRET });
  for (const operation of [() => api.discoverCandidates(null), () => api.getRepositories(null),
    () => api.getRepositories({ repositories: [{ fullName: `demo-lab/${SECRET}` }] }),
    () => api.getReadme({ fullName: `demo-lab/${SECRET}` }), () => api.getHeadCommit({ ...source, ref: SECRET })]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.code, "GITHUB_INVALID_INPUT");
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      return true;
    });
  }
});

test("no second concurrent method begins until the first response body has completed", async () => {
  let release, calls = 0;
  const api = client(async () => {
    calls++;
    if (calls > 1) return json(repository());
    return new Response(new ReadableStream({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(repository()))); controller.close(); };
    } }));
  });
  const first = api.getRepositories(details), second = api.getRepositories(details);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.equal((await first).repositories.length, 1);
  assert.equal((await second).repositories.length, 1);
  assert.equal(calls, 2);
});

test("cached search page keeps its validated next link and page limit prevents further requests", async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    const next = new URL(url); next.searchParams.set("page", String(Number(next.searchParams.get("page")) + 1));
    if (options.headers["If-None-Match"]) return json(null, 304);
    return json({ items: [repository()], total_count: 1000, incomplete_results: false }, 200, { etag: '"page-cache"', link: `<${next}>; rel="next"` });
  });
  const first = await api.discoverCandidates({ focusAreas: ["agent"], maxPages: 2 });
  const second = await api.discoverCandidates({ focusAreas: ["agent"], maxPages: 2 });
  assert.equal(first.truncated, true);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls.at(-1).url).searchParams.get("page"), "2");
});

test("invalid responses do not replace previously validated cache representations", async () => {
  let calls = 0;
  const api = client(async (_url, options) => {
    calls++;
    if (calls === 1) return json(repository(), 200, { etag: '"valid"' });
    assert.equal(options.headers["If-None-Match"], '"valid"');
    if (calls === 2) return json({ malformed: true }, 200, { etag: '"invalid"' });
    return json(null, 304);
  });
  const first = await api.getRepositories(details);
  assert.equal((await api.getRepositories(details)).errors[0].code, "GITHUB_INVALID_PAYLOAD");
  assert.deepEqual((await api.getRepositories(details)).repositories, first.repositories);
});

test("successful 304 resets secondary backoff and cached search observations refresh only after validation", async () => {
  let date = new Date(INSTANT), calls = 0;
  const api = client(async () => {
    calls++;
    if (calls === 1) return json({ items: [repository()], total_count: 1, incomplete_results: false }, 200, { etag: '"freshness"' });
    if (calls === 2 || calls === 4) return json({}, 429);
    return json(null, 304);
  }, { now: () => date });
  const first = await api.discoverCandidates({ focusAreas: ["agent"] });
  assert.equal(first.repositories[0].observedAt, INSTANT);
  const limited = await api.discoverCandidates({ focusAreas: ["agent"] });
  assert.equal(limited.repositories.length, 0);
  assert.equal((await api.discoverCandidates({ focusAreas: ["agent"] })).repositories.length, 0);
  assert.equal(calls, 2);
  date = new Date(limited.retryAt);
  const validated = await api.discoverCandidates({ focusAreas: ["agent"] });
  assert.equal(validated.repositories[0].observedAt, "2026-09-04T01:01:00.000Z");
  assert.equal(validated.repositories[0].stars, 0);
  const limitedAgain = await api.discoverCandidates({ focusAreas: ["agent"] });
  assert.equal(limitedAgain.retryAt, "2026-09-04T01:02:00.000Z");
});

test("discovery and detail focus areas reject nested arrays and non-string entries before fetch", async () => {
  let calls = 0;
  const api = client(async (url) => {
    calls++;
    return url.includes("/search/") ? json({ items: [repository()], total_count: 1, incomplete_results: false }) : json(repository());
  });
  for (const focusAreas of [[["agent"]], [null], [{}], [1], [true], Array(1)]) {
    await assert.rejects(api.discoverCandidates({ focusAreas }), { code: "GITHUB_INVALID_INPUT" });
    await assert.rejects(api.getRepositories({ repositories: [...details.repositories, { fullName: "demo-lab/other", focusAreas }] }), { code: "GITHUB_INVALID_INPUT" });
    assert.equal(calls, 0);
  }
});

test("cached HEAD commits preserve omitted versus explicit ref identity in either call order", async () => {
  for (const firstExplicit of [false, true]) {
    let calls = 0, date = new Date(INSTANT);
    const api = client(async (url, options) => {
      calls++;
      assert.ok(url.endsWith("/commits/HEAD"));
      if (calls === 1) return json({ sha: SHA, commit: { committer: { date: INSTANT } } }, 200, { etag: '"head-ref"' });
      assert.equal(options.headers["If-None-Match"], '"head-ref"');
      return json(null, 304);
    }, { now: () => date });
    const omitted = { fullName: source.fullName }, explicit = { ...omitted, ref: "HEAD" };
    assert.equal((await api.getHeadCommit(firstExplicit ? explicit : omitted)).ref, firstExplicit ? "HEAD" : null);
    date = new Date("2026-09-04T01:01:00.000Z");
    const second = await api.getHeadCommit(firstExplicit ? omitted : explicit);
    assert.equal(second.ref, firstExplicit ? null : "HEAD");
    assert.equal(second.sha, SHA);
    assert.equal(second.observedAt, "2026-09-04T01:01:00.000Z");
    assert.equal(calls, 2);
  }
});
