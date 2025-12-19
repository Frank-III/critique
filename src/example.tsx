import { createPatch } from "diff";
import {
  render,
  useKeyboard,
  onResize,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import { MacOSScrollAccel, RGBA } from "@opentui/core";
import { createSignal, type JSX } from "solid-js";
import { ErrorBoundary as SolidErrorBoundary } from "solid-js/web";

// Colors matching cli.tsx
const ADDED_BG = RGBA.fromInts(0, 60, 0, 255);
const REMOVED_BG = RGBA.fromInts(60, 0, 0, 255);
const ADDED_LINE_NUMBER_BG = RGBA.fromInts(0, 50, 0, 255);
const REMOVED_LINE_NUMBER_BG = RGBA.fromInts(60, 0, 0, 255);
const LINE_NUMBER_BG = RGBA.fromInts(30, 30, 30, 255);
const LINE_NUMBER_FG = RGBA.fromInts(100, 100, 100, 255);

function ErrorBoundary(props: { children: JSX.Element }): JSX.Element {
  return (
    <SolidErrorBoundary
      fallback={(err: Error) => (
        <box style={{ flexDirection: "column", padding: 2 }}>
          <text fg="red">Error: {err.message}</text>
        </box>
      )}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}

function App(): JSX.Element {
  const renderer = useRenderer();
  const terminalDimensions = useTerminalDimensions();
  const [width, setWidth] = createSignal(terminalDimensions().width);
  const scrollAcceleration = new MacOSScrollAccel();

  onResize((newWidth: number) => {
    setWidth(newWidth);
  });

  const useSplitView = () => (width() >= 100 ? "split" : "unified");

  useKeyboard((key) => {
    if (key.name === "z" && key.ctrl) {
      renderer.console.toggle();
    }
  });

  return (
    <box style={{ flexDirection: "column", height: "100%", padding: 1 }}>
      <text>
        {filePath} <text fg="#00ff00">+{additions}</text> <text fg="#ff0000">-{deletions}</text>
      </text>
      <box paddingTop={1} />
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
          diff={diffString}
          view={useSplitView()}
          filetype="tsx"
          showLineNumbers={true}
          addedBg={ADDED_BG}
          removedBg={REMOVED_BG}
          addedLineNumberBg={ADDED_LINE_NUMBER_BG}
          removedLineNumberBg={REMOVED_LINE_NUMBER_BG}
          lineNumberBg={LINE_NUMBER_BG}
          lineNumberFg={LINE_NUMBER_FG}
        />
      </scrollbox>
    </box>
  );
}

// Example file content before and after
const beforeContent = `import React from 'react'
import PropTypes from 'prop-types'
import { cn } from '../utils/cn'
import { useEffect, useState } from 'react'

// Button component
function Button({
  variant = "primary",
  size = "medium",
  loading = false,
  disabled = false,
  className,
  children,
  onClick,
  ...props
}) {
  const [isPressed, setIsPressed] = useState(false)

  const handleClick = (e) => {
    if (disabled || loading) return
    onClick?.(e)
  }

  return (
    <button
      className={cn("btn", className)}
      disabled={disabled || loading}
      onClick={handleClick}
      {...props}
    >
      {children}
    </button>
  )
}

export default Button`;

const afterContent = `import React from 'react'
import PropTypes from 'prop-types'
import { cn } from '../utils/cn'
import { useEffect, useState, useCallback } from 'react'
import { Loader2 } from 'lucide-react'

// Enhanced Button component
function Button({
  variant = "primary",
  size = "medium",
  loading = false,
  disabled = false,
  leftIcon = null,
  rightIcon = null,
  className,
  children,
  onClick,
  ...props
}) {
  const [isPressed, setIsPressed] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const handleClick = useCallback((e) => {
    if (disabled || loading) return
    onClick?.(e)
  }, [disabled, loading, onClick])

  return (
    <button
      className={cn(
        "btn",
        isHovered && "btn-hover",
        isPressed && "btn-pressed",
        className
      )}
      disabled={disabled || loading}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" />}
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  )
}

export default Button`;

const filePath = "/src/components/Button.tsx";

// Create a git-style diff string
const diffString = createPatch(filePath, beforeContent, afterContent, "", "", { context: 3 });

// Count additions and deletions
const additions = (diffString.match(/^\+[^+]/gm) || []).length;
const deletions = (diffString.match(/^-[^-]/gm) || []).length;

await render(() => (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
));
