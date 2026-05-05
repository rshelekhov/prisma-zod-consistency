/**
 * Generated Zod-schema registry.
 *
 * Scans the configured Zod-generator `outputDir`, extracts every top-level
 * Zod schema declaration via the shared discovery walker, and produces a
 * `ModelName -> ZodSchemaInfo` map keyed by the conventional model schema
 * name for the detected generator (e.g. `XSchema` for `zod-prisma-types`).
 *
 * Supported generators:
 *   - `zod-prisma-types` — full match for `<Model>Schema` exports.
 *   - `prisma-zod-generator`, `zod-prisma` — best-effort, see `MODEL_SCHEMA_NAMES`.
 *
 * The registry is consumed by R01b (sanity-check generated against Prisma)
 * and indirectly by R01c — derived schemas resolve back to entries in the
 * shared ts-morph Project, but R01c only needs origin-file/exportName, not
 * the full `ZodSchemaInfo`.
 */

import { glob } from "tinyglobby";
import type { KnownZodGenerator, ZodMode } from "../types.js";
import { type ZodSchemaInfo, discoverZodSchemas } from "./discover.js";

export interface GeneratedRegistry {
  /** Generator that produced this output, as detected in schema.prisma. */
  generator: KnownZodGenerator;
  /** Absolute path to the generator's outputDir. */
  outputDir: string;
  /** All TS/TSX files inside outputDir — useful as resolution context for downstream discovery. */
  files: string[];
  /** Every top-level schema declaration found inside outputDir. */
  schemas: ZodSchemaInfo[];
  /**
   * Convenience map: Prisma model name → the generator-emitted "model schema"
   * (the one that mirrors the model's full field shape — `XSchema` for
   * zod-prisma-types). Schemas that don't correspond to a model (input
   * variants, where filters, etc.) are not in this map.
   */
  modelSchemas: Map<string, ZodSchemaInfo>;
}

/**
 * Per-generator naming convention for "the schema that represents a model
 * exactly as it lives in the database, with all fields." This is the one
 * R01b compares against Prisma; everything else (CreateInput, UpdateInput,
 * WhereInput, …) is intentionally lossy.
 */
const MODEL_SCHEMA_NAMES: Record<KnownZodGenerator, (model: string) => string[]> = {
  // zod-prisma-types canonical export: `<Model>Schema`.
  "zod-prisma-types": (model) => [`${model}Schema`],
  // prisma-zod-generator emits both `<Model>Model` and `<Model>Schema` depending
  // on config; accept either.
  "prisma-zod-generator": (model) => [`${model}Schema`, `${model}Model`],
  // zod-prisma (legacy) uses `<model>Model` (camelCase).
  "zod-prisma": (model) => [
    `${model}Model`,
    `${model.charAt(0).toLowerCase() + model.slice(1)}Model`,
  ],
};

export async function loadGeneratedRegistry(
  zodMode: ZodMode,
  outputDirAbs: string,
  knownModelNames: Iterable<string>,
): Promise<GeneratedRegistry | undefined> {
  if (zodMode.kind !== "generated" && zodMode.kind !== "hybrid") return undefined;

  const files = await glob(["**/*.ts", "**/*.tsx"], {
    cwd: outputDirAbs,
    absolute: true,
    ignore: ["**/*.d.ts", "**/node_modules/**"],
    dot: false,
  });

  if (files.length === 0) {
    return {
      generator: zodMode.generator,
      outputDir: outputDirAbs,
      files,
      schemas: [],
      modelSchemas: new Map(),
    };
  }

  // Pull every Zod schema in outputDir. We pass outputDir here too: in
  // theory generated files could re-export from each other; if a schema
  // is itself derived (`SomeBase.partial()`) we still want the chain
  // resolved against this same dir.
  const schemas = await discoverZodSchemas({ files, outputDir: outputDirAbs });

  const namesForModel = MODEL_SCHEMA_NAMES[zodMode.generator];
  const modelSchemas = new Map<string, ZodSchemaInfo>();
  const byName = new Map(schemas.map((s) => [s.name, s]));

  for (const modelName of knownModelNames) {
    const candidates = namesForModel(modelName);
    for (const candidate of candidates) {
      const found = byName.get(candidate);
      if (found && found.shape.kind === "object") {
        modelSchemas.set(modelName, found);
        break;
      }
    }
  }

  return {
    generator: zodMode.generator,
    outputDir: outputDirAbs,
    files,
    schemas,
    modelSchemas,
  };
}
