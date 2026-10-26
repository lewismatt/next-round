// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fastifyUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("fastify"),
).href;
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const sentinel = "LIFECYCLE_PRIVATE_SENTINEL";

// Inject failures at module boundaries, but capture the executable's real Pino
// output, process exit and Node rejection diagnostics rather than logger mocks.
async function run(stage: string) {
  const directory = await mkdtemp(join(tmpdir(), "nr-lifecycle-"));
  const errorSource = `function failure(){const err=new Error('${sentinel} message',{cause:new Error('${sentinel} cause')}); Object.assign(err,{code:'${sentinel}',detail:'${sentinel}',query:'${sentinel}'});return err;}`;
  const serverSource = `import Fastify from ${JSON.stringify(fastifyUrl)}; ${errorSource}
    export async function buildServer(){
      if(process.env.FAIL_STAGE==='construction') throw failure();
      const app=Fastify({logger:true});
      app.listen=async()=>{if(process.env.FAIL_STAGE==='listen')throw failure();console.log('FIXTURE_READY');};
      app.close=async()=>{if(process.env.FAIL_STAGE==='close')throw failure();};
      return app;
    }`;
  const authSource = `${errorSource} export async function initializeDummyPasswordHash(){if(process.env.FAIL_STAGE==='dummy')throw failure();}`;
  const preload = join(directory, "faults.mjs");
  await writeFile(
    preload,
    `import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){
      if(specifier==='./server.js' && context.parentURL?.endsWith('/src/index.ts')) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(serverSource)}`)},shortCircuit:true};
      if(specifier==='@next-round/platform/auth' && context.parentURL?.endsWith('/src/index.ts')) return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(authSource)}`)},shortCircuit:true};
      return next(specifier,context);
    }});`,
  );
  try {
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      signal: string | null;
      output: string;
    }>();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", preload, entry],
      {
        cwd: root,
        env: { ...process.env, FAIL_STAGE: stage },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let signalled = false;
    const capture = (bytes: Buffer) => {
      output += bytes.toString();
      if (
        (stage === "close" || stage === "clean") &&
        !signalled &&
        output.includes("FIXTURE_READY")
      ) {
        signalled = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    // Safety deadline for a separate executable; success waits on its exit event.
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
    return await promise;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("API executable lifecycle privacy", () => {
  it.each(["construction", "dummy", "listen", "close"])(
    "sanitizes %s failure and exits 1 without an unhandled rejection",
    async (stage) => {
      const result = await run(stage);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(1);
      expect(result.output).not.toContain(sentinel);
      expect(result.output).not.toMatch(
        /UnhandledPromiseRejection|uncaughtException|node:internal/,
      );
      expect(result.output).toContain("INTERNAL_ERROR");
      expect(result.output).toContain(
        stage === "close"
          ? "Error encountered while stopping API server"
          : "Failed to start Next Round API server",
      );
    },
    15_000,
  );
  it("retains successful shutdown exit 0", async () => {
    const result = await run("clean");
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain("Next Round API server stopped cleanly");
  }, 15_000);
});
