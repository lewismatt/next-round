import {
  SDK_IDENTIFIER,
  validateGameManifest,
  type GameManifest,
  type ManifestValidationResult,
} from "@next-round/contracts";
import type { GameServer } from "@next-round/game-sdk";

export { SDK_IDENTIFIER, type GameManifest };

/**
 * Representation of an installed version of a game module.
 */
export interface RegisteredGameVersion {
  manifest: GameManifest;
  server?: GameServer<any, any>;
  serverHash?: string;
  clientHash?: string;
}

/**
 * Representation of a registered game module with its installed versions.
 */
export interface RegisteredGameModule {
  id: string;
  defaultVersion: string;
  versions: Map<string, RegisteredGameVersion>;
}

/**
 * In-memory registry for installed game modules, manifests, and server hooks.
 * Validates manifests against SDK contract `next-round-game/0.1` and Master Spec §2 rules.
 */
export class GameRegistry {
  private readonly modules = new Map<string, RegisteredGameModule>();

  /**
   * Validates a game manifest object against Master Spec requirements and SDK contract.
   * Throws an Error with detailed validation messages if invalid.
   */
  public validate(manifest: unknown): GameManifest {
    const result: ManifestValidationResult = validateGameManifest(manifest);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed for SDK contract ${SDK_IDENTIFIER}:\n${result.errors.join("\n")}`
      );
    }
    if (result.value.sdk !== SDK_IDENTIFIER) {
      throw new Error(
        `Unsupported SDK contract "${result.value.sdk}". Expected exact contract "${SDK_IDENTIFIER}".`
      );
    }
    return result.value;
  }

  /**
   * Registers a game module version into the registry after validation.
   */
  public register(
    manifestInput: unknown,
    server?: GameServer<any, any>,
    options?: { serverHash?: string; clientHash?: string; isDefault?: boolean }
  ): GameManifest {
    const manifest = this.validate(manifestInput);
    let mod = this.modules.get(manifest.id);

    if (!mod) {
      mod = {
        id: manifest.id,
        defaultVersion: manifest.version,
        versions: new Map(),
      };
      this.modules.set(manifest.id, mod);
    }

    if (options?.isDefault || !mod.versions.has(mod.defaultVersion)) {
      mod.defaultVersion = manifest.version;
    }

    mod.versions.set(manifest.version, {
      manifest,
      server,
      serverHash: options?.serverHash,
      clientHash: options?.clientHash,
    });

    return manifest;
  }

  /**
   * Retrieves a registered module by its module ID.
   */
  public get(id: string): RegisteredGameModule | undefined {
    return this.modules.get(id);
  }

  /**
   * Retrieves a specific version of a game module.
   */
  public getVersion(
    id: string,
    version?: string
  ): RegisteredGameVersion | undefined {
    const mod = this.modules.get(id);
    if (!mod) {
      return undefined;
    }
    const targetVersion = version ?? mod.defaultVersion;
    return mod.versions.get(targetVersion);
  }

  /**
   * Retrieves the server hook implementation for a module version.
   */
  public getServer(
    id: string,
    version?: string
  ): GameServer<any, any> | undefined {
    return this.getVersion(id, version)?.server;
  }

  /**
   * Returns manifests for all installed modules (default versions).
   */
  public list(): GameManifest[] {
    const list: GameManifest[] = [];
    for (const mod of this.modules.values()) {
      const ver = mod.versions.get(mod.defaultVersion);
      if (ver) {
        list.push(ver.manifest);
      }
    }
    return list;
  }

  /**
   * Returns all registered versions for a given module ID.
   */
  public listVersions(id: string): GameManifest[] {
    const mod = this.modules.get(id);
    if (!mod) {
      return [];
    }
    return Array.from(mod.versions.values()).map((v) => v.manifest);
  }

  /**
   * Checks whether a module (and optional specific version) is registered.
   */
  public has(id: string, version?: string): boolean {
    const mod = this.modules.get(id);
    if (!mod) {
      return false;
    }
    if (version) {
      return mod.versions.has(version);
    }
    return true;
  }
}

/**
 * Default shared singleton registry instance.
 */
export const defaultGameRegistry = new GameRegistry();
