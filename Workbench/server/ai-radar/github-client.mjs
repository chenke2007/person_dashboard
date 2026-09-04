import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { radarRepositorySchema } from "./radar-schema.mjs";
import { GitHubRadarError, githubFailure } from "./github-errors.mjs";

const ORIGIN = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2026-03-10";
const githubTimestamp = z.string().datetime({ offset: true });
export const GITHUB_RADAR_FOCUS_QUERIES = Object.freeze({
  agent: "topic:ai-agents archived:false fork:false",
  "ai-coding": "topic:ai-coding archived:false fork:false",
  "rag-knowledge": "topic:rag archived:false fork:false",
  "ai-productivity": "topic:ai-productivity archived:false fork:false",
});
const fail = (code) => { throw new GitHubRadarError(code); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function validateFullName(value) {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) || [".", ".."].includes(value.split("/")[1])) fail("GITHUB_INVALID_INPUT");
  return value;
}
function validateRef(value) {
  // Git check-ref-format constraints, without running Git or interpolating commands.
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) ||
      value.includes("..") || value.includes("//") || value.endsWith(".") || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) fail("GITHUB_INVALID_INPUT");
  return value;
}
function areas(value, required = false) {
  if (!Array.isArray(value) || value.length > 4 || (required && value.length === 0) || [...value].some((area) => typeof area !== "string" || !Object.hasOwn(GITHUB_RADAR_FOCUS_QUERIES, area)) || new Set(value).size !== value.length) fail("GITHUB_INVALID_INPUT");
  return [...value];
}
function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (!githubTimestamp.safeParse(value).success || !Number.isFinite(Date.parse(value))) fail("GITHUB_INVALID_PAYLOAD");
  return new Date(value).toISOString();
}
function normalizeRepository(raw, observedAt, expectedName = null) {
  if (!object(raw) || (expectedName && (typeof raw.full_name !== "string" || raw.full_name.toLowerCase() !== expectedName.toLowerCase()))) fail("GITHUB_INVALID_PAYLOAD");
  try { validateFullName(raw.full_name); } catch { fail("GITHUB_INVALID_PAYLOAD"); }
  if (raw.license !== undefined && raw.license !== null && (!object(raw.license) || typeof raw.license.spdx_id !== "string")) fail("GITHUB_INVALID_PAYLOAD");
  const normalized = radarRepositorySchema.safeParse({
    id: raw.id, fullName: raw.full_name, htmlUrl: raw.html_url,
    description: raw.description ?? null, language: raw.language ?? null, topics: raw.topics === undefined ? [] : raw.topics, focusAreas: [],
    stars: raw.stargazers_count ?? null, forks: raw.forks_count ?? null, openIssues: raw.open_issues_count ?? null,
    archived: raw.archived, fork: raw.fork, license: raw.license?.spdx_id === "NOASSERTION" ? null : raw.license?.spdx_id ?? null,
    defaultBranch: raw.default_branch ?? null, createdAt: timestamp(raw.created_at), updatedAt: timestamp(raw.updated_at),
    pushedAt: timestamp(raw.pushed_at), observedAt, preservedAt: null,
  });
  if (!normalized.success) fail("GITHUB_INVALID_PAYLOAD");
  return normalized.data;
}
function nextPage(link, currentUrl) {
  if (!link) return null;
  if (link.length > 8192) fail("GITHUB_UNSAFE_PAGINATION");
  const matches = [];
  for (const entry of link.split(/,(?=\s*<)/)) {
    const parsed = entry.trim().match(/^<([^<>]+)>\s*;\s*rel="([a-z ]+)"$/);
    if (!parsed) fail("GITHUB_UNSAFE_PAGINATION");
    if (parsed[2].split(" ").includes("next")) matches.push(parsed[1]);
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail("GITHUB_UNSAFE_PAGINATION");
  let next;
  try { next = new URL(matches[0]); } catch { fail("GITHUB_UNSAFE_PAGINATION"); }
  const current = new URL(currentUrl);
  if (next.origin !== ORIGIN || next.username || next.password || next.hash || next.pathname !== "/search/repositories") fail("GITHUB_UNSAFE_PAGINATION");
  const page = next.searchParams.get("page");
  if (!/^[1-9]\d*$/.test(page ?? "") || Number(page) !== Number(current.searchParams.get("page")) + 1) fail("GITHUB_UNSAFE_PAGINATION");
  const expected = new URL(current); expected.searchParams.set("page", page);
  const sorted = (url) => [...url.searchParams].map(([key, value]) => `${key}=${value}`).sort();
  if (JSON.stringify(sorted(next)) !== JSON.stringify(sorted(expected))) fail("GITHUB_UNSAFE_PAGINATION");
  return next.href;
}
function batchResult() { return { repositories: [], errors: [], partial: false, retryAt: null, truncated: false }; }
function addFailure(result, error, fullName = null) {
  const failure = githubFailure(error, fullName);
  result.errors.push(failure); result.partial = true;
  if (failure.retryAt) result.retryAt = failure.retryAt;
}

/** Local-only adapter. No environment reads, disk cache, cloning or execution. */
export function createGitHubRadarClient({ fetchImpl = fetch, token = null, userAgent = "personal-ai-workbench",
  now = () => new Date(), sleep = (ms, { signal }) => delay(ms, undefined, { signal }),
  timeoutMs = 15000, maxResponseBytes = 2 * 1024 * 1024, maxCacheEntries = 64, maxCacheBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof sleep !== "function" ||
      (token !== null && (typeof token !== "string" || token.length > 4096 || /[\r\n]/.test(token))) ||
      typeof userAgent !== "string" || !/^[A-Za-z0-9 ._/-]{1,100}$/.test(userAgent) ||
      !integer(timeoutMs, 1, 60000) || !integer(maxResponseBytes, 1, 8 * 1024 * 1024) ||
      !integer(maxCacheEntries, 0, 128) || !integer(maxCacheBytes, 0, 16 * 1024 * 1024)) fail("GITHUB_INVALID_INPUT");
  let queue = Promise.resolve(), cacheBytes = 0, cooldown = null, secondaryStrikes = 0;
  const cache = new Map();
  const milliseconds = () => {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) fail("GITHUB_INVALID_INPUT");
    return value;
  };
  function cachePut(key, entry) {
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (!maxCacheEntries || bytes > maxCacheBytes) return;
    while (cache.size >= maxCacheEntries || cacheBytes + bytes > maxCacheBytes) {
      const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    cache.set(key, { ...structuredClone(entry), bytes }); cacheBytes += bytes;
  }
  function rateLimit(response, body = null) {
    const primary = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
    const secondary = response.status === 429 || (response.status === 403 && (response.headers.has("retry-after") ||
      (typeof body?.message === "string" && /secondary rate limit|abuse detection/i.test(body.message))));
    if (!primary && !secondary) return null;
    const time = milliseconds();
    let retry = time + (primary ? 60000 : 60000 * 2 ** Math.min(secondaryStrikes++, 6));
    const after = response.headers.get("retry-after");
    if (after) {
      const parsed = /^\d+$/.test(after) ? time + Number(after) * 1000 : Date.parse(after);
      if (Number.isFinite(parsed)) retry = Math.max(retry, parsed);
    }
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset && /^\d+$/.test(reset) && Number.isFinite(Number(reset) * 1000)) retry = Math.max(retry, Number(reset) * 1000);
    // Invalid or enormous upstream dates must not escape as RangeErrors.
    retry = Math.min(retry, 8.64e15);
    cooldown = { code: primary ? "GITHUB_PRIMARY_RATE_LIMIT" : "GITHUB_SECONDARY_RATE_LIMIT", retryAt: new Date(retry).toISOString() };
    return new GitHubRadarError(cooldown.code, cooldown);
  }
  async function readJson(response, signal) {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxResponseBytes) fail("GITHUB_RESPONSE_TOO_LARGE");
    if (!response.body || typeof response.body.getReader !== "function") fail("GITHUB_INVALID_PAYLOAD");
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) { cancel(); fail("GITHUB_RESPONSE_TOO_LARGE"); }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks, size).toString("utf8");
      if (token && text.includes(token)) fail("GITHUB_INVALID_PAYLOAD");
      try { return JSON.parse(text); } catch { fail("GITHUB_INVALID_PAYLOAD"); }
    } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  }
  function request(url, representation, parse) {
    const execute = async () => {
      if (cooldown && milliseconds() < Date.parse(cooldown.retryAt)) throw new GitHubRadarError(cooldown.code, cooldown);
      const key = `${API_VERSION}:${ACCEPT}:${representation}:${url}`;
      const cached = cache.get(key);
      const headers = { Accept: ACCEPT, "X-GitHub-Api-Version": API_VERSION, "User-Agent": userAgent };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (cached) headers["If-None-Match"] = cached.etag;
      const controller = new AbortController(), timer = new AbortController();
      let response;
      const work = async () => {
        response = await fetchImpl(url, { headers, redirect: "manual", signal: controller.signal });
        if (controller.signal.aborted) {
          if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
          fail("GITHUB_TIMEOUT");
        }
        if (response.redirected || (response.url && response.url !== url)) fail("GITHUB_REDIRECT_REJECTED");
        if (response.status >= 300 && response.status < 400 && response.status !== 304) fail("GITHUB_REDIRECT_REJECTED");
        const limited = rateLimit(response); if (limited) throw limited;
        if (response.status === 403) {
          // Inspect only bounded JSON for GitHub's documented secondary-limit marker;
          // the upstream message is never copied into errors or cached.
          const body = await readJson(response, controller.signal);
          if (controller.signal.aborted) fail("GITHUB_TIMEOUT");
          const secondary = rateLimit(response, body); if (secondary) throw secondary;
        }
        if (response.status === 304) {
          if (!cached) fail("GITHUB_CACHE_MISS");
          // A successful conditional request confirms the cached values are still
          // current. Refresh observation time without changing their representation.
          const value = structuredClone(cached.value), observedAt = new Date(milliseconds()).toISOString();
          if (representation === "search") value.repositories = value.repositories.map((entry) => ({ ...entry, observedAt }));
          else value.observedAt = observedAt;
          cachePut(key, { etag: cached.etag, value });
          secondaryStrikes = 0; cooldown = null;
          return value;
        }
        if (response.status !== 200) {
          const code = { 401: "GITHUB_AUTH_FAILED", 403: "GITHUB_FORBIDDEN", 404: "GITHUB_NOT_FOUND" }[response.status];
          fail(code ?? (response.status >= 500 ? "GITHUB_UNAVAILABLE" : "GITHUB_HTTP_ERROR"));
        }
        const raw = await readJson(response, controller.signal);
        const value = parse(raw, new Date(milliseconds()).toISOString(), response.headers.get("link"));
        if (token && JSON.stringify(value).includes(token)) fail("GITHUB_INVALID_PAYLOAD");
        if (controller.signal.aborted) fail("GITHUB_TIMEOUT");
        const etag = response.headers.get("etag");
        if (etag && etag.length <= 512 && !/[\r\n]/.test(etag) && (!token || !etag.includes(token))) cachePut(key, { etag, value });
        else if (cached) { cacheBytes -= cached.bytes; cache.delete(key); }
        secondaryStrikes = 0; cooldown = null;
        return structuredClone(value);
      };
      try {
        const timeout = sleep(timeoutMs, { signal: timer.signal }).then(() => { controller.abort(); fail("GITHUB_TIMEOUT"); });
        return await Promise.race([work(), timeout]);
      } catch (error) {
        throw error instanceof GitHubRadarError ? error : new GitHubRadarError("GITHUB_NETWORK_ERROR");
      } finally {
        timer.abort(); controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    };
    const pending = queue.then(execute);
    queue = pending.catch(() => {});
    return pending;
  }
  async function discoverCandidates(input = {}) {
    if (!object(input)) fail("GITHUB_INVALID_INPUT");
    const { focusAreas, maxPages = 3, maxCandidates = 100, perPage = 100 } = input;
    const focus = areas(focusAreas, true);
    if (!integer(maxPages, 1, 5) || !integer(maxCandidates, 1, 500) || !integer(perPage, 1, 100)) fail("GITHUB_INVALID_INPUT");
    const result = batchResult(), found = new Map();
    for (const area of focus) {
      const start = new URL("/search/repositories", ORIGIN);
      start.search = new URLSearchParams({ q: GITHUB_RADAR_FOCUS_QUERIES[area], sort: "stars", order: "desc", per_page: String(perPage), page: "1" }).toString();
      let url = start.href;
      for (let page = 0; url && page < maxPages; page++) {
        try {
          const data = await request(url, "search", (raw, observedAt, link) => {
            if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > perPage || !integer(raw.total_count, 0, Number.MAX_SAFE_INTEGER) || typeof raw.incomplete_results !== "boolean") fail("GITHUB_INVALID_PAYLOAD");
            const repositories = [], errors = [];
            for (const item of raw.items) {
              try { repositories.push(normalizeRepository(item, observedAt)); } catch (error) { errors.push(githubFailure(error)); }
            }
            // Preserve page observations even if the untrusted next link is unusable.
            let next = null;
            try { next = nextPage(link, url); } catch (error) { errors.push(githubFailure(error)); }
            return { repositories, errors, next, incomplete: raw.incomplete_results };
          });
          for (const entry of data.repositories) {
            if (entry.archived || entry.fork) continue;
            const prior = found.get(entry.id);
            if (prior) { if (!prior.focusAreas.includes(area)) prior.focusAreas.push(area); }
            else if (found.size < maxCandidates) found.set(entry.id, { ...entry, focusAreas: [area] });
            else result.truncated = true;
          }
          result.errors.push(...data.errors); result.partial ||= data.errors.length > 0 || data.incomplete;
          url = data.next;
          if (found.size >= maxCandidates) { result.truncated ||= Boolean(url) || focus.indexOf(area) < focus.length - 1; break; }
          if (url && page + 1 === maxPages) result.truncated = true;
        } catch (error) { addFailure(result, error); break; }
      }
      if (result.retryAt || found.size >= maxCandidates) break;
    }
    result.repositories = [...found.values()]; return result;
  }
  async function getRepositories(input = {}) {
    if (!object(input)) fail("GITHUB_INVALID_INPUT");
    const { repositories } = input;
    if (!Array.isArray(repositories) || repositories.length > 200) fail("GITHUB_INVALID_INPUT");
    const inputs = repositories.map((entry) => {
      if (!object(entry)) fail("GITHUB_INVALID_INPUT");
      const fullName = validateFullName(entry.fullName);
      if (token && fullName.includes(token)) fail("GITHUB_INVALID_INPUT");
      return { fullName, focusAreas: areas(entry.focusAreas ?? []) };
    });
    const result = batchResult();
    for (const entry of inputs) {
      try {
        const value = await request(`${ORIGIN}/repos/${entry.fullName}`, "repository", (raw, observedAt) => normalizeRepository(raw, observedAt, entry.fullName));
        result.repositories.push({ ...value, focusAreas: entry.focusAreas });
      } catch (error) { addFailure(result, error, entry.fullName); if (result.retryAt) break; }
    }
    return result;
  }
  function sourceInput(input) {
    if (!object(input)) fail("GITHUB_INVALID_INPUT");
    const fullName = validateFullName(input.fullName), ref = input.ref === undefined ? null : validateRef(input.ref);
    if (token && (fullName.includes(token) || ref?.includes(token))) fail("GITHUB_INVALID_INPUT");
    return { fullName, ref };
  }
  async function getReadme(input) {
    const { fullName, ref } = sourceInput(input);
    const url = new URL(`${ORIGIN}/repos/${fullName}/readme`);
    if (ref !== null) url.searchParams.set("ref", ref);
    return request(url.href, "readme", (raw, observedAt) => {
      if (!object(raw) || raw.type !== "file" || raw.encoding !== "base64" || typeof raw.content !== "string" ||
          typeof raw.path !== "string" || !/^[A-Za-z0-9_. /-]{1,240}$/.test(raw.path) || raw.path.split("/").some((part) => !part || part === "." || part === "..") ||
          !/^[a-f0-9]{40}$/i.test(raw.sha ?? "") || !integer(raw.size, 0, maxResponseBytes)) fail("GITHUB_INVALID_PAYLOAD");
      const encoded = raw.content.replace(/\n/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("GITHUB_INVALID_PAYLOAD");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== raw.size || bytes.toString("base64") !== encoded) fail("GITHUB_INVALID_PAYLOAD");
      let content; try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("GITHUB_INVALID_PAYLOAD"); }
      return { fullName, ref, sha: raw.sha.toLowerCase(), path: raw.path, content, observedAt };
    });
  }
  async function getHeadCommit(input) {
    const { fullName, ref } = sourceInput(input);
    const value = await request(`${ORIGIN}/repos/${fullName}/commits/${encodeURIComponent(ref ?? "HEAD")}`, "head", (raw, observedAt) => {
      if (!object(raw) || !/^[a-f0-9]{40}$/i.test(raw.sha ?? "") || !object(raw.commit) || !object(raw.commit.committer) ||
          (/^[a-f0-9]{40}$/i.test(ref ?? "") && raw.sha.toLowerCase() !== ref.toLowerCase())) fail("GITHUB_INVALID_PAYLOAD");
      return { fullName, ref, sha: raw.sha.toLowerCase(), committedAt: timestamp(raw.commit.committer.date), observedAt };
    });
    // Omitted ref and explicit HEAD share a representation, not caller identity.
    return { ...value, ref };
  }
  return { discoverCandidates, getRepositories, getReadme, getHeadCommit };
}
