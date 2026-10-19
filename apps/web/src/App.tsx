// SPDX-License-Identifier: Apache-2.0
import { Routes, Route, Link } from "react-router";
import { Button } from "@next-round/ui";

function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center gap-4">
      <h1 className="text-4xl font-bold font-heading tracking-tight">Next Round</h1>
      <p className="text-muted-foreground text-sm font-mono max-w-md">
        A place to play turn-based games together.
      </p>
      <p className="text-muted-foreground text-sm max-w-md">
        Development preview. Sign-in and games are not available yet.
      </p>
      <div className="flex gap-3 pt-2">
        <Button variant="outline" asChild>
          <Link to="/about">About</Link>
        </Button>
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center gap-4">
      <h1 className="text-3xl font-bold font-heading">About Next Round</h1>
      <p className="text-muted-foreground text-sm max-w-md">
        Next Round is a self-hosted platform for turn-based games. This early
        preview includes these information pages; accounts and playable games
        are still in development.
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
