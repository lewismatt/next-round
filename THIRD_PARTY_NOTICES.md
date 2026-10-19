# Third-party notices and license inventory

Next Round's project-owned code is licensed under Apache-2.0. Third-party software retains its own terms. This inventory records published package metadata and preserves upstream attribution files; it is not a legal certification or a statement that all dependencies are permissively licensed.

## Copied shadcn source

`packages/ui/src/components/button.tsx`, `packages/ui/src/lib/utils.ts` and
`packages/ui/src/styles/globals.css` derive from shadcn/ui and the selected
preset. They retain MIT SPDX identifiers and upstream attribution, separately
from Apache-2.0 project-owned code. The full upstream license and copyright
notice are preserved in [third_party/shadcn-LICENSE.txt](third_party/shadcn-LICENSE.txt).
Source: [shadcn/ui LICENSE.md](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)
(license blob SHA `fad4d887a681dd49233e5ed01ee2c7a1513089a0`; fetched from upstream main).

## Locked npm packages

[`third_party/npm-inventory.json`](third_party/npm-inventory.json) is the inventory of every package entry in every document of `pnpm-lock.yaml`. It includes runtime and development dependencies, peer-resolution snapshots, optional dependencies, and packages for operating systems, CPUs and C libraries other than the build host's. The package-manager dependency graph is included. Workspace links refer to project-owned packages and are retained in the graph rather than presented as third-party registry packages.

Each package record contains its exact name and version, the license expression from its published `package.json`, repository/homepage and registry links, download URL, locked integrity, platform constraints, and references to the original manifest and attribution files. The `graph` field preserves importers and dependency snapshots, including optional edges. Repeated peer contexts share a single name/version attribution record.

The current lockfile contains 562 distinct name/version entries across two YAML documents, including 158 platform-constrained packages. Its declarations include MPL-2.0, OFL-1.1 and Python-2.0 as well as MIT, Apache-2.0, BSD and other terms. Coverage and unresolved items are separate fields in the inventory.

The generator downloads each package archive, verifies its bytes against the lockfile integrity, and collects license, copying, copyright, authors, NOTICE, font-license and README files, including nested copies. Original bytes are stored in [`third_party/materials/`](third_party/materials/) under SHA-256 filenames. The inventory maps each original path to its material. Preserve these files with distributed source or application images. Font licenses and copyright notices remain applicable to bundled font assets.

Platform-specific esbuild and Rolldown packages share the license texts from their locked parent release, with matching versions, repositories and license declarations. Packages that declare MIT or Apache-2.0 but omit a separate license file have an explicit version-specific supplement in the generator. That supplement supplies the standard license text from SPDX license-list-data v3.28.0, records its source URL, and preserves the package's original attribution. Standard-text copyright template fields are not claims about a package's copyright owner. Embedded source license comments are retained with their archive paths and byte offsets.

Missing metadata, mismatched archives, license texts without an explicit supplement, and download failures are recorded under `unresolved` and make generation fail. Unknown licenses are never replaced with a permissive default. The inventory uses published declarations: for example, `drizzle-kit@0.31.11` declares MIT, while `drizzle-orm@0.45.4` declares Apache-2.0.

## Pinned container images

| Image | Tag | Multi-architecture index digest | Primary project terms |
| --- | --- | --- | --- |
| Node.js | `24.22.0-bookworm-slim` | `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` | [Node.js license and bundled notices](https://github.com/nodejs/node/blob/v24.22.0/LICENSE) |
| PostgreSQL | `18.6-alpine` | `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` | [PostgreSQL License and copyright](https://github.com/postgres/postgres/blob/REL_18_6/COPYRIGHT) |
| Caddy | `2.11.7-alpine` | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | [Apache-2.0](https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE), plus bundled dependencies' terms |

[`third_party/image-inventory.json`](third_party/image-inventory.json) records these exact references, primary project source archives, collected legal materials, and the installed OS package metadata for their `linux/amd64` image variants. The index digests identify the multi-architecture releases; OS package versions and notices for another architecture must be collected from that variant before redistributing it.

For the Debian Node base, collected material includes `/usr/local/LICENSE` with Node's bundled third-party notices, Debian package copyright files and common license texts, and legal files shipped with the base image's npm/Corepack tooling. The application runtime removes package-manager executables; retaining their notices is harmless. Debian source package versions and snapshot links are recorded. The application uses the same Debian-based image for API and worker and retains its base OS copyright/license material.

The Alpine images do not ship OS license texts in their filesystems. Their package databases supply exact versions, license expressions, upstream URLs, source-package origins and aports packaging commits. Follow those pinned recipes for corresponding source, patches and upstream license/copyright files. OS packages include copyleft software; the PostgreSQL or Caddy primary license does not cover the entire image. Redistribution must satisfy each component's license and any corresponding-source obligations. See the upstream [Alpine licensing information](https://wiki.alpinelinux.org/wiki/Alpine_Linux:Licensing), [Debian copyright format](https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/), and official image sources for [Node](https://github.com/nodejs/docker-node), [PostgreSQL](https://github.com/docker-library/postgres), and [Caddy](https://github.com/caddyserver/caddy-docker).

Caddy's embedded `build-info` is preserved with its exact Go module versions and checksums. Module records link to their versioned source archives and upstream license displays. Node, PostgreSQL and Caddy release archives are linked in the image inventory. These references describe upstream source availability; they do not replace an operator's redistribution obligations or promise that a remote mirror will retain files indefinitely.

## Reproducing the inventory

Use the repository's supported Node.js and pnpm versions and the unchanged lockfile. GNU `tar` and network access to the npm registry and pinned upstream license URLs are required. Image collection also needs Docker with Buildx and access to the three pinned images; it explicitly selects `linux/amd64` and does not start application services.

```sh
pnpm install --frozen-lockfile
node scripts/third-party-notices.mjs
node scripts/image-notices.mjs
```

To compare generated content without rewriting tracked artifacts:

```sh
node scripts/third-party-notices.mjs --check
node scripts/image-notices.mjs --check
```

The npm archive cache defaults to the operating system's temporary directory under `next-round-notices-cache`; set `NOTICES_CACHE` to choose another location. Archives are integrity-checked even when cached. Generated JSON has stable ordering and no generation timestamp. Review `unresolved` in both inventories and the process exit status after every update. Commit the updated inventories and referenced materials together with any dependency or image-pin change. The application image copies this document and the entire `third_party/` directory alongside the root `LICENSE` and `NOTICE`.
