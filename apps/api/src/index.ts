import { buildServer } from "./server.js";

const port = Number(process.env.API_PORT || process.env.PORT || 3000);
const host = process.env.API_HOST || process.env.HOST || "0.0.0.0";

/**
 * Next Round API server executable entrypoint.
 */
export async function main(): Promise<void> {
  const server = await buildServer();

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, "Gracefully shutting down Next Round API server...");
    try {
      await server.close();
      server.log.info("Next Round API server stopped cleanly");
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, "Error encountered while stopping API server");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await server.listen({ port, host });
    server.log.info(
      `Next Round API v1 listening on http://${host}:${port} (health: http://${host}:${port}/health/live)`
    );
  } catch (err) {
    server.log.error({ err }, "Failed to start Next Round API server");
    process.exit(1);
  }
}

void main();
