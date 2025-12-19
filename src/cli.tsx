#!/usr/bin/env bun
import { cac } from "cac";
import {
  render,
  onResize,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import { createSignal, createEffect, onMount, onCleanup, For, Show, type JSX } from "solid-js";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { createCliRenderer, MacOSScrollAccel, RGBA, type CliRendererConfig } from "@opentui/core";
import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Dropdown from "./dropdown.tsx";
import * as watcher from "@parcel/watcher";
import { debounce } from "./utils.ts";

const execAsync = promisify(exec);

const IGNORED_FILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "composer.lock",
];

const BACKGROUND_COLOR = "#0f0f0f";

// Theme colors for diff
const ADDED_BG = RGBA.fromHex("#0d2818");
const REMOVED_BG = RGBA.fromHex("#2d0f0f");
const ADDED_LINE_NUMBER_BG = RGBA.fromHex("#1a4d2e");
const REMOVED_LINE_NUMBER_BG = RGBA.fromHex("#4d1a1a");
const LINE_NUMBER_BG = RGBA.fromHex("#0a0a0a");
const LINE_NUMBER_FG = RGBA.fromHex("#666666");

interface ParsedFile {
  fileName: string;
  diff: string;
  additions: number;
  deletions: number;
}

function parseGitDiff(gitDiff: string): ParsedFile[] {
  const files: ParsedFile[] = [];

  // Split by file headers
  const fileChunks = gitDiff.split(/(?=^diff --git )/gm).filter(chunk => chunk.trim());

  for (const chunk of fileChunks) {
    // Extract filename from the diff header
    const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    if (!headerMatch) continue;

    const fileName = headerMatch[2] || headerMatch[1] || "unknown";
    const baseName = fileName.split("/").pop() || "";

    // Skip ignored files
    if (IGNORED_FILES.includes(baseName) || baseName.endsWith(".lock")) {
      continue;
    }

    // Count additions and deletions
    const lines = chunk.split("\n");
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    // Skip files with too many lines
    if (additions + deletions > 6000) continue;

    files.push({
      fileName,
      diff: chunk,
      additions,
      deletions,
    });
  }

  // Sort by size (smaller first)
  return files.sort((a, b) => (a.additions + a.deletions) - (b.additions + b.deletions));
}

function detectFiletype(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const mapping: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    sql: "sql",
  };
  return mapping[ext || ""] || "text";
}

function execSyncWithError(
  command: string,
  options?: any,
): { data?: any; error?: string } {
  try {
    const data = execSync(command, options);
    return { data };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || String(error);
    return { error: stderr };
  }
}

const cli = cac("critique");

class ScrollAcceleration {
  public multiplier: number = 1;
  private macosAccel: MacOSScrollAccel;
  constructor() {
    this.macosAccel = new MacOSScrollAccel();
  }
  tick(delta: number) {
    return this.macosAccel.tick(delta) * this.multiplier;
  }
  reset() {
    this.macosAccel.reset();
  }
}

// Simple reactive store using signals
const [currentFileIndex, setCurrentFileIndex] = createSignal(0);

interface AppProps {
  files: ParsedFile[];
}

function App(props: AppProps): JSX.Element {
  const dimensions = useTerminalDimensions();
  const [width, setWidth] = createSignal(dimensions().width);
  const scrollAcceleration = new ScrollAcceleration();
  const [showDropdown, setShowDropdown] = createSignal(false);

  onResize((newWidth: number) => {
    setWidth(newWidth);
  });

  const useSplitView = () => width() >= 100 ? "split" : "unified";

  const renderer = useRenderer();

  useKeyboard((key) => {
    if (showDropdown()) {
      if (key.name === "escape") {
        setShowDropdown(false);
      }
      return;
    }

    if (key.name === "p" && key.ctrl) {
      setShowDropdown(true);
      return;
    }

    if (key.name === "z" && key.ctrl) {
      renderer.console.toggle();
    }
    if (key.name === "escape" || key.name === "q") {
      process.exit(0);
    }
    if (key.option) {
      if (key.eventType === "release") {
        scrollAcceleration.multiplier = 1;
      } else {
        scrollAcceleration.multiplier = 10;
      }
    }
    if (key.name === "left") {
      setCurrentFileIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.name === "right") {
      setCurrentFileIndex((prev) => Math.min(props.files.length - 1, prev + 1));
    }
  });

  // Ensure current index is valid
  const validIndex = () => Math.min(currentFileIndex(), props.files.length - 1);
  const currentFile = () => props.files[validIndex()];

  const dropdownOptions = () => props.files.map((file, idx) => ({
    title: file.fileName,
    value: String(idx),
    keywords: file.fileName.split("/"),
  }));

  const handleFileSelect = (value: string) => {
    const index = parseInt(value, 10);
    setCurrentFileIndex(index);
    setShowDropdown(false);
  };

  return (
    <Show
      when={currentFile()}
      fallback={
        <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR }}>
          <text>No files to display</text>
        </box>
      }
    >
      <Show
        when={!showDropdown()}
        fallback={
          <box
            style={{ flexDirection: "column", height: "100%", padding: 1, backgroundColor: BACKGROUND_COLOR }}
          >
            <box style={{ flexDirection: "column", justifyContent: "center", flexGrow: 1 }}>
              <Dropdown
                tooltip="Select file"
                options={dropdownOptions()}
                selectedValues={[String(validIndex())]}
                onChange={handleFileSelect}
                placeholder="Search files..."
              />
            </box>
          </box>
        }
      >
        <box
          style={{ flexDirection: "column", height: "100%", padding: 1, backgroundColor: BACKGROUND_COLOR }}
        >
          {/* Navigation header */}
          <box style={{ paddingBottom: 1, paddingLeft: 1, paddingRight: 1, flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
            <text fg="#ffffff">←</text>
            <box flexGrow={1} />
            <text onMouseDown={() => setShowDropdown(true)}>
              {currentFile()!.fileName.trim()}
            </text>
            <text fg="#00ff00"> +{currentFile()!.additions}</text>
            <text fg="#ff0000"> -{currentFile()!.deletions}</text>
            <box flexGrow={1} />
            <text fg="#ffffff">→</text>
          </box>

          <scrollbox
            scrollAcceleration={scrollAcceleration}
            style={{
              flexGrow: 1,
              rootOptions: {
                backgroundColor: "transparent",
                border: false,
              },
              scrollbarOptions: {
                showArrows: false,
                trackOptions: {
                  foregroundColor: "#4a4a4a",
                  backgroundColor: "transparent",
                },
              },
            }}
            focused
          >
            <diff
              diff={currentFile()!.diff}
              view={useSplitView()}
              filetype={detectFiletype(currentFile()!.fileName)}
              showLineNumbers={true}
              addedBg={ADDED_BG}
              removedBg={REMOVED_BG}
              addedLineNumberBg={ADDED_LINE_NUMBER_BG}
              removedLineNumberBg={REMOVED_LINE_NUMBER_BG}
              lineNumberBg={LINE_NUMBER_BG}
              lineNumberFg={LINE_NUMBER_FG}
            />
          </scrollbox>

          {/* Bottom navigation */}
          <box style={{ paddingTop: 1, paddingLeft: 1, paddingRight: 1, flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
            <text fg="#ffffff">←</text>
            <text fg="#666666"> prev file</text>
            <box flexGrow={1} />
            <text fg="#ffffff">ctrl p</text>
            <text fg="#666666"> select file </text>
            <text fg="#666666">({validIndex() + 1}/{props.files.length})</text>
            <box flexGrow={1} />
            <text fg="#666666">next file </text>
            <text fg="#ffffff">→</text>
          </box>
        </box>
      </Show>
    </Show>
  );
}

cli
  .command(
    "[ref]",
    "Show diff for a git reference (defaults to unstaged changes)",
  )
  .option("--staged", "Show staged changes")
  .option("--commit <ref>", "Show changes from a specific commit")
  .option("--watch", "Watch for file changes and refresh diff")
  .action(async (ref, options) => {
    try {
      const gitCommand = (() => {
        if (options.staged) return "git diff --cached";
        if (options.commit) return `git show ${options.commit}`;
        if (ref) return `git show ${ref}`;
        return "git add -N . && git diff";
      })();

      const shouldWatch = options.watch && !ref && !options.commit;

      function AppWithWatch(): JSX.Element {
        const [files, setFiles] = createSignal<ParsedFile[] | null>(null);

        onMount(() => {
          const fetchDiff = async () => {
            try {
              const { stdout: gitDiff } = await execAsync(gitCommand, {
                encoding: "utf-8",
              });

              if (!gitDiff.trim()) {
                setFiles([]);
                return;
              }

              const parsedFiles = parseGitDiff(gitDiff);
              setFiles(parsedFiles);
            } catch (error) {
              setFiles([]);
            }
          };

          fetchDiff();

          if (shouldWatch) {
            const cwd = process.cwd();

            const debouncedFetch = debounce(() => {
              fetchDiff();
            }, 200);

            let subscription: watcher.AsyncSubscription | undefined;

            watcher
              .subscribe(cwd, (err, events) => {
                if (err) {
                  return;
                }

                if (events.length > 0) {
                  debouncedFetch();
                }
              })
              .then((sub) => {
                subscription = sub;
              });

            onCleanup(() => {
              if (subscription) {
                subscription.unsubscribe();
              }
            });
          }
        });

        // Ensure currentFileIndex stays valid when files change
        createEffect(() => {
          const f = files();
          if (f && f.length > 0) {
            const idx = currentFileIndex();
            if (idx >= f.length) {
              setCurrentFileIndex(f.length - 1);
            }
          }
        });

        return (
          <Show
            when={files() !== null}
            fallback={
              <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR }}>
                <text>Loading...</text>
              </box>
            }
          >
            <Show
              when={files()!.length > 0}
              fallback={
                <box style={{ padding: 1, backgroundColor: BACKGROUND_COLOR }}>
                  <text>No changes to display</text>
                </box>
              }
            >
              <App files={files()!} />
            </Show>
          </Show>
        );
      }

      await render(() => <AppWithWatch />);
    } catch (error) {
      console.error("Error getting git diff:", error);
      process.exit(1);
    }
  });

cli
  .command("difftool <local> <remote>", "Git difftool integration")
  .action(async (local: string, remote: string) => {
    if (!process.stdout.isTTY) {
      execSync(`git diff --no-ext-diff "${local}" "${remote}"`, {
        stdio: "inherit",
      });
      process.exit(0);
    }

    try {
      const [localContent, remoteContent, { structuredPatch }] =
        await Promise.all([
          fs.readFileSync(local, "utf-8"),
          fs.readFileSync(remote, "utf-8"),
          import("diff"),
        ]);

      const patch = structuredPatch(
        local,
        remote,
        localContent,
        remoteContent,
        "",
        "",
      );

      if (patch.hunks.length === 0) {
        console.log("No changes to display");
        process.exit(0);
      }

      // Reconstruct a diff string from the patch
      const diffLines = [
        `diff --git a/${local} b/${remote}`,
        `--- a/${local}`,
        `+++ b/${remote}`,
      ];

      for (const hunk of patch.hunks) {
        diffLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        diffLines.push(...hunk.lines);
      }

      const diffString = diffLines.join("\n");
      const files: ParsedFile[] = [{
        fileName: remote,
        diff: diffString,
        additions: patch.hunks.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith("+")).length, 0),
        deletions: patch.hunks.reduce((acc, h) => acc + h.lines.filter(l => l.startsWith("-")).length, 0),
      }];

      await render(() => <App files={files} />);
    } catch (error) {
      console.error("Error displaying diff:", error);
      process.exit(1);
    }
  });

cli
  .command("pick <branch>", "Pick files from another branch to apply to HEAD")
  .action(async (branch: string) => {
    try {
      const { stdout: currentBranch } = await execAsync(
        "git branch --show-current",
      );
      const current = currentBranch.trim();

      if (current === branch) {
        console.error("Cannot pick from the same branch");
        process.exit(1);
      }

      const { stdout: branchExists } = await execAsync(
        `git rev-parse --verify ${branch}`,
        { encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));

      if (!branchExists.trim()) {
        console.error(`Branch "${branch}" does not exist`);
        process.exit(1);
      }

      const { stdout: diffOutput } = await execAsync(
        `git diff --name-only HEAD...${branch}`,
        { encoding: "utf-8" },
      );

      const files = diffOutput
        .trim()
        .split("\n")
        .filter((f) => f);

      if (files.length === 0) {
        console.log("No differences found between branches");
        process.exit(0);
      }

      // Simple reactive store for pick state
      const [selectedFiles, setSelectedFiles] = createSignal<Set<string>>(new Set());
      const [appliedFiles, setAppliedFiles] = createSignal<Map<string, boolean>>(new Map());
      const [message, setMessage] = createSignal("");
      const [messageType, setMessageType] = createSignal<"info" | "error" | "success" | "">("");

      interface PickAppProps {
        files: string[];
        branch: string;
      }

      function PickApp(props: PickAppProps): JSX.Element {
        const handleChange = async (value: string) => {
          const isSelected = selectedFiles().has(value);

          if (isSelected) {
            const { error } = execSyncWithError(
              `git checkout HEAD -- "${value}"`,
              { stdio: "pipe" },
            );

            if (error) {
              if (error.includes("did not match any file(s) known to git")) {
                if (fs.existsSync(value)) {
                  fs.unlinkSync(value);
                }
              } else {
                setMessage(`Failed to restore ${value}: ${error}`);
                setMessageType("error");
                return;
              }
            }

            setSelectedFiles((prev) => {
              const next = new Set(prev);
              next.delete(value);
              return next;
            });
            setAppliedFiles((prev) => {
              const next = new Map(prev);
              next.delete(value);
              return next;
            });
          } else {
            const { stdout: mergeBase } = await execAsync(
              `git merge-base HEAD ${props.branch}`,
              { encoding: "utf-8" },
            );
            const base = mergeBase.trim();

            const { stdout: patchData } = await execAsync(
              `git diff ${base} ${props.branch} -- ${value}`,
              { encoding: "utf-8" },
            );

            const patchFile = join(
              tmpdir(),
              `critique-pick-${Date.now()}.patch`,
            );
            fs.writeFileSync(patchFile, patchData);

            const result1 = execSyncWithError(
              `git apply --3way "${patchFile}"`,
              {
                stdio: "pipe",
              },
            );

            if (result1.error) {
              const result2 = execSyncWithError(`git apply "${patchFile}"`, {
                stdio: "pipe",
              });

              if (result2.error) {
                setMessage(`Failed to apply ${value}: ${result2.error}`);
                setMessageType("error");
                fs.unlinkSync(patchFile);
                return;
              }
            }

            fs.unlinkSync(patchFile);

            const { stdout: conflictCheck } = await execAsync(
              `git diff --name-only --diff-filter=U -- "${value}"`,
              { encoding: "utf-8" },
            );

            const hasConflict = conflictCheck.trim().length > 0;

            setSelectedFiles((prev) => {
              const next = new Set(prev);
              next.add(value);
              return next;
            });
            setAppliedFiles((prev) => {
              const next = new Map(prev);
              next.set(value, true);
              return next;
            });
            setMessage(hasConflict ? `Applied ${value} with conflicts` : `Applied ${value}`);
            setMessageType(hasConflict ? "error" : "");
          }
        };

        return (
          <box style={{ padding: 1, flexDirection: "column", backgroundColor: BACKGROUND_COLOR }}>
            <Dropdown
              tooltip={`Pick files from "${props.branch}"`}
              onChange={handleChange}
              selectedValues={Array.from(selectedFiles())}
              placeholder="Search files..."
              options={props.files.map((file) => ({
                value: file,
                title: "/" + file,
                keywords: file.split("/"),
              }))}
            />
            <Show when={message()}>
              <box
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 1,
                  paddingBottom: 1,
                  marginTop: 1,
                  backgroundColor: BACKGROUND_COLOR,
                }}
              >
                <text
                  fg={
                    messageType() === "error"
                      ? "#ff6b6b"
                      : messageType() === "success"
                        ? "#51cf66"
                        : "#ffffff"
                  }
                >
                  {message()}
                </text>
              </box>
            </Show>
          </box>
        );
      }

      await render(() => <PickApp files={files} branch={branch} />);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

// Worker URL for uploading HTML previews
const WORKER_URL = process.env.CRITIQUE_WORKER_URL || "https://critique.work";

cli
  .command("web [ref]", "Generate web preview of diff")
  .option("--staged", "Show staged changes")
  .option("--commit <ref>", "Show changes from a specific commit")
  .option("--patch <file>", "Use diff from a patch file instead of git")
  .option("--cols <cols>", "Number of columns for rendering (use ~100 for mobile)", { default: 240 })
  .option("--rows <rows>", "Number of rows for rendering", { default: 2000 })
  .option("--local", "Open local preview instead of uploading")
  .option("--stdout", "Output HTML to stdout instead of uploading")
  .action(async (ref, options) => {
    const pty = await import("@xmorse/bun-pty");
    const { ansiToHtmlDocument } = await import("./ansi-html.ts");

    const cols = parseInt(options.cols) || 240;
    const rows = parseInt(options.rows) || 2000;

    let gitDiff: string;
    let diffFile: string;
    let shouldCleanupDiffFile = false;

    if (options.patch) {
      // Read diff from provided patch file
      if (!fs.existsSync(options.patch)) {
        console.error(`Patch file not found: ${options.patch}`);
        process.exit(1);
      }
      gitDiff = fs.readFileSync(options.patch, "utf-8");
      diffFile = options.patch;
    } else {
      // Get diff from git
      const gitCommand = (() => {
        if (options.staged) return "git diff --cached";
        if (options.commit) return `git show ${options.commit}`;
        if (ref) return `git show ${ref}`;
        return "git add -N . && git diff";
      })();

      if (!options.stdout) {
        console.log("Capturing diff output...");
      }

      const { stdout } = await execAsync(gitCommand, { encoding: "utf-8" });
      gitDiff = stdout;

      // Write diff to temp file
      diffFile = join(tmpdir(), `critique-web-diff-${Date.now()}.patch`);
      fs.writeFileSync(diffFile, gitDiff);
      shouldCleanupDiffFile = true;
    }

    if (!gitDiff.trim()) {
      console.log("No changes to display");
      process.exit(0);
    }

    // Spawn the TUI in a PTY to capture ANSI output
    let ansiOutput = "";
    const ptyProcess = pty.spawn("bun", [
      process.argv[1]!, // path to cli.tsx
      "web-render",
      diffFile,
      "--cols", String(cols),
      "--rows", String(rows),
    ], {
      name: "xterm-256color",
      cols: cols,
      rows: rows,

      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    ptyProcess.onData((data: string) => {
      ansiOutput += data;
    });

    await new Promise<void>((resolve) => {
      ptyProcess.onExit(() => {
        resolve();
      });
    });

    // Clean up temp file if we created it
    if (shouldCleanupDiffFile) {
      fs.unlinkSync(diffFile);
    }

    if (!ansiOutput.trim()) {
      if (!options.stdout) {
        console.log("No output captured");
      }
      process.exit(1);
    }

    if (!options.stdout) {
      console.log("Converting to HTML...");
    }

    // Strip terminal cleanup sequences that clear the screen
    // The renderer outputs \x1b[H\x1b[J (cursor home + clear to end) on exit
    const clearIdx = ansiOutput.lastIndexOf("\x1b[H\x1b[J");
    if (clearIdx > 0) {
      ansiOutput = ansiOutput.slice(0, clearIdx);
    }

    // Convert ANSI to HTML document
    const html = ansiToHtmlDocument(ansiOutput, { cols, rows });

    // Output to stdout (for E2B/programmatic use)
    if (options.stdout) {
      process.stdout.write(html);
      process.exit(0);
    }

    if (options.local) {
      // Save locally and open
      const htmlFile = join(tmpdir(), `critique-${Date.now()}.html`);
      fs.writeFileSync(htmlFile, html);
      console.log(`Saved to: ${htmlFile}`);

      // Try to open in browser
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        await execAsync(`${openCmd} "${htmlFile}"`);
      } catch {
        console.log("Could not open browser automatically");
      }
      process.exit(0);
    }

    console.log("Uploading to worker...");

    try {
      const response = await fetch(`${WORKER_URL}/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ html }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Upload failed: ${error}`);
      }

      const result = await response.json() as { id: string; url: string };

      console.log(`\nPreview URL: ${result.url}`);
      console.log(`(expires in 7 days)`);

      // Try to open in browser
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        await execAsync(`${openCmd} "${result.url}"`);
      } catch {
        // Silent fail - user can copy URL
      }
    } catch (error: any) {
      console.error("Failed to upload:", error.message);

      // Fallback to local file
      const htmlFile = join(tmpdir(), `critique-${Date.now()}.html`);
      fs.writeFileSync(htmlFile, html);
      console.log(`\nFallback: Saved locally to ${htmlFile}`);
      process.exit(1);
    }
  });

// Internal command for web rendering (captures output to PTY)
cli
  .command("web-render <diffFile>", "Internal: Render diff for web capture", { allowUnknownOptions: true })
  .option("--cols <cols>", "Terminal columns", { default: 120 })
  .option("--rows <rows>", "Terminal rows", { default: 1000 })
  .action(async (diffFile: string, options) => {
    const cols = parseInt(options.cols) || 120;
    const rows = parseInt(options.rows) || 40;

    const gitDiff = fs.readFileSync(diffFile, "utf-8");
    const files = parseGitDiff(gitDiff);

    if (files.length === 0) {
      console.log("No files to display");
      process.exit(0);
    }

    // Override terminal size
    process.stdout.columns = cols;
    process.stdout.rows = rows;

    // Use unified diff for narrow viewports (mobile), split view for wider ones
    const useSplitView = cols >= 150 ? "split" : "unified";

    // Static component - renders once and exits
    function WebApp(): JSX.Element {
      onMount(() => {
        // Exit after the first render completes
        setTimeout(() => {
          process.exit(0);
        }, 100);
      });

      return (
        <box style={{ flexDirection: "column", height: "100%", padding: 1, backgroundColor: BACKGROUND_COLOR }}>
          <For each={files}>
            {(file) => (
              <box style={{ flexDirection: "column", marginBottom: 2 }}>
                <box style={{ paddingBottom: 1, paddingLeft: 1, paddingRight: 1, flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
                  <text>{file.fileName.trim()}</text>
                  <text fg="#00ff00"> +{file.additions}</text>
                  <text fg="#ff0000"> -{file.deletions}</text>
                </box>
                <diff
                  diff={file.diff}
                  view={useSplitView}
                  filetype={detectFiletype(file.fileName)}
                  showLineNumbers={true}
                  addedBg={ADDED_BG}
                  removedBg={REMOVED_BG}
                  addedLineNumberBg={ADDED_LINE_NUMBER_BG}
                  removedLineNumberBg={REMOVED_LINE_NUMBER_BG}
                  lineNumberBg={LINE_NUMBER_BG}
                  lineNumberFg={LINE_NUMBER_FG}
                />
              </box>
            )}
          </For>
        </box>
      );
    }

    await render(() => <WebApp />, {
      exitOnCtrlC: false,
      useAlternateScreen: false,
    });
  });

cli.help();
cli.version("1.0.0");
cli.parse();
