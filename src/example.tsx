import { structuredPatch } from "diff";
import {
  createRoot,
  useKeyboard,
  useOnResize,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import { createCliRenderer, MacOSScrollAccel } from "@opentui/core";
import { createSignal, type JSX } from "solid-js";
import {
  ErrorBoundary,
  FileEditPreviewTitle,
  FileEditPreview,
} from "./diff.tsx";

function App(): JSX.Element {
  const renderer = useRenderer();
  const { width: initialWidth } = useTerminalDimensions();
  const [width, setWidth] = createSignal(initialWidth);
  const scrollAcceleration = new MacOSScrollAccel();

  useOnResize((newWidth: number) => {
    setWidth(newWidth);
  });

  const useSplitView = () => width() >= 100;

  useKeyboard((key) => {
    if (key.name === "z" && key.ctrl) {
      renderer.console.toggle();
    }
  });

  return (
    <box style={{ flexDirection: "column", height: "100%", padding: 1 }}>
      <FileEditPreviewTitle filePath={filePath} hunks={hunks} />
      <box paddingTop={3} />
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
        <FileEditPreview hunks={hunks} paddingLeft={0} filePath={filePath} />
      </scrollbox>
    </box>
  );
}

// Example file content before and after - Extended version for scrolling demo
export const beforeContent = `import React from 'react'
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

export const afterContent = `import React from 'react'
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
const hunks = structuredPatch(
  filePath,
  filePath,
  beforeContent,
  afterContent,
  undefined,
  undefined,
  { context: 3, ignoreWhitespace: true, stripTrailingCr: true },
).hunks;

const renderer = await createCliRenderer();
createRoot(renderer).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
