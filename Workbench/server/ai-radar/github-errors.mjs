const messages = Object.freeze({
  GITHUB_INVALID_INPUT: "Invalid GitHub radar request.",
  GITHUB_INVALID_PAYLOAD: "GitHub returned an invalid representation.",
  GITHUB_NETWORK_ERROR: "GitHub could not be reached.",
  GITHUB_TIMEOUT: "GitHub request timed out.",
  GITHUB_RESPONSE_TOO_LARGE: "GitHub response exceeded the size limit.",
  GITHUB_CACHE_MISS: "GitHub returned an unchanged response without a cached representation.",
  GITHUB_REDIRECT_REJECTED: "GitHub redirect was not followed.",
  GITHUB_UNSAFE_PAGINATION: "GitHub pagination failed validation.",
  GITHUB_PRIMARY_RATE_LIMIT: "GitHub primary rate limit reached.",
  GITHUB_SECONDARY_RATE_LIMIT: "GitHub secondary rate limit reached.",
  GITHUB_AUTH_FAILED: "GitHub authentication failed.",
  GITHUB_FORBIDDEN: "GitHub denied this request.",
  GITHUB_NOT_FOUND: "GitHub resource was not found.",
  GITHUB_UNAVAILABLE: "GitHub service is unavailable.",
  GITHUB_HTTP_ERROR: "GitHub request failed.",
});

// Never attach causes, request options, URLs, response bodies or headers.
export class GitHubRadarError extends Error {
  constructor(code, { retryAt = null } = {}) {
    const safeCode = Object.hasOwn(messages, code) ? code : "GITHUB_HTTP_ERROR";
    super(messages[safeCode]);
    this.name = "GitHubRadarError";
    this.code = safeCode;
    this.retryAt = retryAt;
  }
  toJSON() { return { code: this.code, message: this.message, retryAt: this.retryAt }; }
}

export function githubFailure(error, fullName = null) {
  const safe = error instanceof GitHubRadarError ? error : new GitHubRadarError("GITHUB_NETWORK_ERROR");
  return { fullName, ...safe.toJSON() };
}
