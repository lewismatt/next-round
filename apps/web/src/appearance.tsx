// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { Button } from "@next-round/ui";
import { MoonIcon, SunIcon } from "./icons.js";

const KEY = "next-round:appearance:v1";
type Theme = "light" | "dark";

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle() {
  const explicit = useRef<Theme | null>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(KEY);
      } catch {
        /* Use system appearance. */
      }
      const next =
        saved === "light" || saved === "dark"
          ? saved
          : (explicit.current ?? (media.matches ? "dark" : "light"));
      apply(next);
      setTheme(next);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) {
        explicit.current = null;
        sync();
      }
    };
    media.addEventListener("change", sync);
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", storage);
    };
  }, []);
  const dark = theme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      type="button"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const next = dark ? "light" : "dark";
        explicit.current = next;
        apply(next);
        setTheme(next);
        try {
          localStorage.setItem(KEY, next);
        } catch {
          /* Still applies for this page. */
        }
      }}
    >
      {dark ? (
        <SunIcon data-icon="inline-start" />
      ) : (
        <MoonIcon data-icon="inline-start" />
      )}
    </Button>
  );
}
