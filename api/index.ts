import { Hono } from "hono"
import { cors } from "hono/cors"
import { handle } from "hono/vercel"
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from "fs"
import { join, dirname } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

// =============================================================================
// Types
// =============================================================================

interface GitHubPRInfo {
  type: "pull"
  owner: string
  repo: string
  number: number
}

interface GitHubCommitInfo {
  type: "commit"
  owner: string
  repo: string
  sha: string
}

interface GitHubCompareInfo {
  type: "compare"
  owner: string
  repo: string
  base: string
  head: string
}

type GitHubInfo = GitHubPRInfo | GitHubCommitInfo | GitHubCompareInfo

// =============================================================================
// GitHub URL Parsing
// =============================================================================

function parseGitHubUrl(path: string): GitHubInfo | null {
  // Remove leading slash and optional github.com prefix
  path = path.replace(/^\/+/, "").replace(/^github\.com\//, "")

  // Match: owner/repo/pull/123
  const prMatch = path.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)$/)
  if (prMatch && prMatch[1] && prMatch[2] && prMatch[3]) {
    return {
      type: "pull",
      owner: prMatch[1],
      repo: prMatch[2],
      number: parseInt(prMatch[3], 10),
    }
  }

  // Match: owner/repo/commit/sha
  const commitMatch = path.match(/^([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)$/i)
  if (commitMatch && commitMatch[1] && commitMatch[2] && commitMatch[3]) {
    return {
      type: "commit",
      owner: commitMatch[1],
      repo: commitMatch[2],
      sha: commitMatch[3],
    }
  }

  // Match: owner/repo/compare/base...head
  const compareMatch = path.match(/^([^/]+)\/([^/]+)\/compare\/([^.]+)\.\.\.(.+)$/)
  if (compareMatch && compareMatch[1] && compareMatch[2] && compareMatch[3] && compareMatch[4]) {
    return {
      type: "compare",
      owner: compareMatch[1],
      repo: compareMatch[2],
      base: compareMatch[3],
      head: compareMatch[4],
    }
  }

  return null
}

function getCacheKey(info: GitHubInfo): string {
  switch (info.type) {
    case "pull":
      return `gh:${info.owner}/${info.repo}/pull/${info.number}`
    case "commit":
      return `gh:${info.owner}/${info.repo}/commit/${info.sha}`
    case "compare":
      return `gh:${info.owner}/${info.repo}/compare/${info.base}...${info.head}`
  }
}

// =============================================================================
// GitHub API
// =============================================================================

async function fetchGitHubDiff(info: GitHubInfo, token?: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.diff",
    "User-Agent": "critique-vercel",
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  let url: string
  switch (info.type) {
    case "pull":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/pulls/${info.number}`
      break
    case "commit":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/commits/${info.sha}`
      break
    case "compare":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/compare/${info.base}...${info.head}`
      break
  }

  const response = await fetch(url, { headers })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub API error ${response.status}: ${text}`)
  }

  return response.text()
}

// =============================================================================
// Critique CLI Integration
// =============================================================================

async function renderDiffWithCritique(
  diff: string,
  cols: number = 240,
  rows: number = 2000
): Promise<string> {
  // Create temp directory if needed
  const tempDir = join(tmpdir(), "critique")
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }

  // Write diff to temp file
  const tempFile = join(tempDir, `diff-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
  writeFileSync(tempFile, diff, "utf-8")

  try {
    // Find the CLI path - in production it should be in node_modules/.bin/critique
    // or we can use the src/cli.tsx directly
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.tsx")

    // Use Bun.spawn to run the critique CLI with PTY-like output capture
    // The web command uses PTY internally, but we can also try calling it with --stdout
    const proc = Bun.spawn([
      "bun", "run", cliPath,
      "web",
      "--patch", tempFile,
      "--stdout",
      "--cols", String(cols),
      "--rows", String(rows),
    ], {
      env: {
        ...process.env,
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const output = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      throw new Error(`critique failed (exit ${exitCode}): ${stderr}`)
    }

    return output
  } finally {
    // Cleanup temp file
    try {
      unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

// =============================================================================
// In-memory cache (for Vercel's function instance reuse)
// =============================================================================

const cache = new Map<string, { html: string; timestamp: number }>()
const CACHE_TTL_PR = 60 * 60 * 1000 // 1 hour for PRs
const CACHE_TTL_COMMIT = 7 * 24 * 60 * 60 * 1000 // 7 days for commits

function getCachedHtml(key: string): string | null {
  const cached = cache.get(key)
  if (!cached) return null

  const ttl = key.includes("/pull/") ? CACHE_TTL_PR : CACHE_TTL_COMMIT
  if (Date.now() - cached.timestamp > ttl) {
    cache.delete(key)
    return null
  }

  return cached.html
}

function setCachedHtml(key: string, html: string): void {
  cache.set(key, { html, timestamp: Date.now() })

  // Limit cache size to 100 entries
  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono()

// Enable CORS
app.use("*", cors())

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", runtime: "bun" })
})

// Redirect root to GitHub repo
app.get("/", (c) => {
  return c.redirect("https://github.com/remorses/critique")
})

// Handle GitHub PR URLs: /owner/repo/pull/123
app.get("/:owner/:repo/pull/:number", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "pull") {
    return c.text("Invalid PR URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

// Handle GitHub commit URLs: /owner/repo/commit/sha
app.get("/:owner/:repo/commit/:sha", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "commit") {
    return c.text("Invalid commit URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

// Handle compare URLs: /owner/repo/compare/base...head
app.get("/:owner/:repo/compare/:spec", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "compare") {
    return c.text("Invalid compare URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

async function handleGitHubDiff(c: any, info: GitHubInfo) {
  const cacheKey = getCacheKey(info)

  // Check cache first
  const cachedHtml = getCachedHtml(cacheKey)
  if (cachedHtml) {
    return c.html(cachedHtml, 200, {
      "Cache-Control": "public, max-age=300",
      "X-Cache": "HIT",
    })
  }

  try {
    // Fetch diff from GitHub
    const githubToken = process.env.GITHUB_TOKEN
    const diff = await fetchGitHubDiff(info, githubToken)

    if (!diff.trim()) {
      return c.text("No diff content", 404)
    }

    // Render with critique CLI
    const html = await renderDiffWithCritique(diff)

    // Cache the result
    setCachedHtml(cacheKey, html)

    return c.html(html, 200, {
      "Cache-Control": "public, max-age=300",
      "X-Cache": "MISS",
    })
  } catch (error: any) {
    console.error("Error rendering GitHub diff:", error)
    return c.json({ error: error.message || "Failed to render diff" }, 500)
  }
}

// Export for Vercel
export const GET = handle(app)
export const POST = handle(app)
export const OPTIONS = handle(app)

// Also export default for local development
export default app
