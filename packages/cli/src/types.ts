/**
 * Public types shared across the CLI: rule definitions, findings, and runtime context.
 *
 * Stability: pre-1.0, may break between minor versions.
 */

export type Severity = "error" | "warning" | "info";

export type RuleId =
  | "R01"
  | "R02"
  | "R03"
  | "R04"
  | "R05"
  | "R06"
  | "R07"
  | "R08"
  | "R09"
  | "R10"
  | "R11";

/** Where in the user's source a finding originates. */
export interface SourceLocation {
  /** Absolute or project-relative file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number; optional. */
  column?: number;
}

/** A single rule violation. */
export interface Finding {
  ruleId: RuleId;
  severity: Severity;
  /** Short, single-sentence description of what was found. */
  message: string;
  location: SourceLocation;
  /** Optional human-readable suggestion for how to fix. */
  suggestion?: string;
  /** Optional mechanical fix. Present only for findings that pz-fix can apply safely. */
  fix?: Fix;
  /** Optional model/field/relation context for grouping in the report. */
  scope?: {
    model?: string;
    field?: string;
    relation?: string;
  };
}

/** A safe, automatically-applicable change tied to a finding. */
export interface Fix {
  /** Human-readable description (e.g. "Add .max(255) to email"). */
  description: string;
  /** One or more atomic edits, ALL of which must apply for the fix to be valid. */
  edits: FileEdit[];
}

/** A single text-range replacement in a file. */
export interface FileEdit {
  /** Absolute file path. */
  file: string;
  /** 0-based character offset in the file (inclusive). */
  start: number;
  /** 0-based character offset in the file (exclusive). For pure insertions, set start === end. */
  end: number;
  /** Replacement text. May be empty (deletion). */
  newText: string;
}

/** What the project looks like — populated by the discovery phase. */
export interface ProjectContext {
  /** Absolute path to the project root (where `.prismazodrc` or `package.json` lives). */
  rootDir: string;
  /** Absolute path to `schema.prisma`. */
  schemaPath: string;
  /** Datasource provider as declared in `schema.prisma`. */
  provider: "postgresql" | "mysql" | "sqlite" | "sqlserver" | "mongodb" | "cockroachdb";
  /** TS/JS files we should scan. */
  sourceFiles: string[];
  /** Detected Zod-generation mode (drives R01). */
  zodMode: ZodMode;
  /** Live-DB snapshot. Populated when `--db` is passed and DATABASE_URL is set. */
  db?: import("./db/types.js").DbSnapshot;
}

export type ZodMode =
  | { kind: "hand-written" }
  | { kind: "generated"; generator: KnownZodGenerator; outputDir: string }
  | { kind: "hybrid"; generator: KnownZodGenerator; outputDir: string };

export type KnownZodGenerator = "zod-prisma-types" | "prisma-zod-generator" | "zod-prisma";

/** A rule implementation. */
export interface Rule {
  id: RuleId;
  /** Short, human-readable rule name (used in SARIF tool.driver.rules[].name). */
  name: string;
  /**
   * Single-sentence description of what the rule checks. Surfaces in SARIF
   * tool.driver.rules[].shortDescription.text.
   */
  description: string;
  /** Absolute URL to the canonical rule spec on GitHub. */
  helpUri: string;
  defaultSeverity: Severity;
  /** Run the rule against the project context. May return zero or more findings. */
  run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]>;
}

export interface RuleOptions {
  severity: Severity;
  /** Rule-specific config bag, opaque at the framework level. */
  config: Record<string, unknown>;
}
