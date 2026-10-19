// SPDX-License-Identifier: Apache-2.0
import { Routes, Route, Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@next-round/ui";

function usePlatformStatus() {
  return useQuery({
    queryKey: ["platform-status"],
    queryFn: () => ({ status: "ready", version: "0.1.0" }),
  });
}

function HomePage() {
  const { data } = usePlatformStatus();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center space-y-4">
      <h1 className="text-4xl font-bold font-heading tracking-tight">Next Round</h1>
      <p className="text-muted-foreground text-sm font-mono max-w-md">
        Turn-based web game platform with deterministic rules, verifiable history, and local authoring.
      </p>
      {data && (
        <span className="inline-flex items-center rounded-md bg-secondary px-2.5 py-0.5 text-xs font-mono text-secondary-foreground">
          Platform: {data.status} (v{data.version})
        </span>
      )}
      <div className="flex gap-3 pt-2">
        <Button variant="default">Get Started</Button>
        <Button variant="outline" asChild>
          <Link to="/about">About</Link>
        </Button>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center space-y-4">
      <h1 className="text-3xl font-bold font-heading">About Next Round</h1>
      <p className="text-muted-foreground text-sm max-w-md">
        Modular platform foundation built with React 19, Vite 8, Tailwind v4, and Radix UI.
      </p>
      <Button variant="outline" asChild>
        <Link to="/">Back to Home</Link>
      </Button>
    </div>
  );
}

export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground font-mono">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/about" element={<AboutPage />} />
      </Routes>
    </main>
  );
}
