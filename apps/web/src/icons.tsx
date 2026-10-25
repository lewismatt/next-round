// SPDX-License-Identifier: Apache-2.0
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;
function Icon({ children, ...props }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}
export function ArrowIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M4 12h15m-6-6 6 6-6 6" />
    </Icon>
  );
}
export function HomeIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3Z" />
    </Icon>
  );
}
export function GamesIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M7 7h10a4 4 0 0 1 4 4l1 7a2 2 0 0 1-3 2l-4-3H9l-4 3a2 2 0 0 1-3-2l1-7a4 4 0 0 1 4-4Z" />
      <path d="M6 11v4m-2-2h4m8-1h.01m3 3h.01" />
    </Icon>
  );
}
export function HistoryIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </Icon>
  );
}
export function AccountIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="7" r="4" />
      <path d="M3 22v-2a9 9 0 0 1 18 0v2" />
    </Icon>
  );
}
export function AdminIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </Icon>
  );
}
export function EnvelopeIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M2 4h20v16H2Zm0 0 10 9L22 4" />
    </Icon>
  );
}
export function SunIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
    </Icon>
  );
}
export function MoonIcon(props: Props) {
  return (
    <Icon {...props}>
      <path d="M21 13A9 9 0 0 1 11 3 9 9 0 1 0 21 13Z" />
    </Icon>
  );
}

/** Small, theme-aware ink illustrations, kept vector sharp at phone zoom. */
export function GameIllustration({ gameId }: { gameId: string }) {
  if (gameId === "crossword") {
    const blocks = new Set([0, 4, 6, 12, 18, 20, 24]);
    return (
      <svg
        className="game-illustration"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <rect x="7" y="7" width="86" height="86" fill="var(--paper)" />
        {Array.from({ length: 25 }, (_, i) => (
          <rect
            key={i}
            x={7 + (i % 5) * 17.2}
            y={7 + Math.floor(i / 5) * 17.2}
            width="17.2"
            height="17.2"
            fill={
              i === 17
                ? "var(--ink-accent)"
                : blocks.has(i)
                  ? "var(--foreground)"
                  : "none"
            }
            stroke="var(--foreground)"
            strokeWidth="1"
          />
        ))}
      </svg>
    );
  }
  if (gameId === "cipher")
    return (
      <svg
        className="game-illustration"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        {Array.from({ length: 9 }, (_, i) => (
          <circle
            key={i}
            cx={17 + (i % 3) * 32}
            cy={17 + Math.floor(i / 3) * 32}
            r="10.5"
            fill={
              [1, 4, 6].includes(i)
                ? "var(--ink-accent)"
                : [0, 3, 7].includes(i)
                  ? "var(--foreground)"
                  : "none"
            }
            stroke="var(--foreground)"
            strokeWidth="1.5"
          />
        ))}
      </svg>
    );
  if (gameId === "trivia")
    return (
      <svg
        className="game-illustration"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <rect
          x="11"
          y="13"
          width="51"
          height="71"
          rx="3"
          transform="rotate(-14 35 48)"
          fill="var(--paper)"
          stroke="var(--foreground)"
          strokeWidth="1.7"
        />
        <path
          d="M23 29a7 7 0 0 1 14 0c0 4-3 5-5 7v6h-5v-6c-2-2-4-3-4-7Z"
          fill="var(--ink-accent)"
        />
        <rect
          x="43"
          y="15"
          width="47"
          height="72"
          rx="3"
          transform="rotate(13 65 50)"
          fill="var(--paper)"
          stroke="var(--foreground)"
          strokeWidth="1.7"
        />
        <text
          x="66"
          y="66"
          textAnchor="middle"
          fontFamily="Georgia, serif"
          fontSize="51"
          fill="var(--foreground)"
        >
          ?
        </text>
      </svg>
    );
  return (
    <svg className="game-illustration" viewBox="0 0 100 100" aria-hidden="true">
      <rect
        x="15"
        y="15"
        width="70"
        height="70"
        rx="4"
        fill="none"
        stroke="var(--foreground)"
        strokeWidth="2"
      />
      <path
        d="M30 50h40m-20-20v40"
        stroke="var(--ink-accent)"
        strokeWidth="3"
      />
    </svg>
  );
}
