# R05 — API boundary bypass

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | 1 (skill); CLI only when `framework` config is set |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | no — adding a validator middleware requires picking a Zod schema |
| Implementation | done for Hono; tRPC/Next/Express/Fastify deferred |

## What it checks

Detects route handlers that read body data directly from the framework context instead of going through a Zod-validated middleware. Currently the rule has one detector — Hono. The intent is the same across frameworks: untyped/untrusted data should not flow from `request → service → prisma.create/update` without a Zod schema in between.

**Hono detector** finds calls of the form `<x>.req.json()`, `<x>.req.parseBody()`, or `<x>.req.formData()` — where `<x>` is the Hono context (typically `c`, `ctx`, or `context`). The wrapper-detection heuristic auto-skips files importing from `@hono/zod-validator`, since those files legitimately call `c.req.json()` inside the validator and re-expose it via `c.req.valid(...)`.

## Why it matters

The Zod boundary is the project's contract: at this point, the data is shaped, sized, and constrained the way the rest of the code expects. Bypassing it means:

- Untyped data flows into the service layer (TypeScript thinks it's `any` or `unknown`, runtime takes whatever the client sent).
- Constraint violations — string longer than `@db.VarChar(N)`, missing required fields, wrong-type values — surface as 500s deep in the stack instead of clean 400s at the boundary.
- Field renames in `schema.prisma` that aren't reflected in API contracts are silently shipped (the validator would have caught them).
- Security exposure: mass-assignment vulnerabilities (passing the entire body straight to `prisma.X.create({ data: body })`) become possible.

## How to fix

Add a validator middleware to the route. With `@hono/zod-validator`:

```typescript
import { zValidator } from "@hono/zod-validator";

usersRoute.post("/", zValidator("json", createUserSchema), async (c) => {
  const body = c.req.valid("json"); // typed and constrained
  // ...
});
```

Or with a project-local wrapper (e.g. `validated()`):

```typescript
usersRoute.post("/", validated("json", createUserSchema), async (c) => {
  const body = c.req.valid("json");
});
```

No auto-fix — the right schema to plug in depends on what this endpoint expects.

## Examples

### Bad

```typescript
import { Hono } from "hono";

const route = new Hono();

route.post("/users", async (c) => {
  const body = await c.req.json(); // ❌ untyped, untrusted
  await prisma.user.create({ data: body }); // ❌ mass-assignment
  return c.json({ ok: true });
});
```

### Good

```typescript
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

const route = new Hono();

route.post("/users", zValidator("json", createUserSchema), async (c) => {
  const body = c.req.valid("json"); // shaped + constrained
  await prisma.user.create({ data: body });
  return c.json({ ok: true });
});
```

### Ambiguous — flagged but often intentional

```typescript
// Webhook from a third-party service. Body shape is dictated by them and
// authenticity is verified via signature, not Zod. Reading c.req.json()
// directly is the correct pattern here.
webhookRoute.post("/square", async (c) => {
  const rawBody = await c.req.text();
  verifySquareSignature(rawBody, c.req.header("x-square-signature"));
  const event = JSON.parse(rawBody);
  await processSquareEvent(event);
  return c.json({ ok: true });
});
```

For the webhook case: confirm the endpoint is signature-verified (or otherwise authenticated by a different mechanism), then add it to `R05.excludeFiles` or suppress with a `// pz-disable-next-line R05` comment (planned syntax).

### Validator wrapper file (auto-skipped)

```typescript
// src/lib/validation.ts — file that imports @hono/zod-validator is auto-skipped.
import { zValidator } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

export function validated<S extends ZodSchema>(
  target: "json" | "form" | "query" | "param",
  schema: S,
) {
  return zValidator(target, schema);
}
```

The presence of `from "@hono/zod-validator"` in the file's imports tells R05 this is wrapper code, not application code. No findings emitted from this file.

## Configuration

```jsonc
{
  "R05": {
    "severity": "warning",
    "framework": "auto",                 // hono | auto | off
    "excludeFiles": ["**/webhooks/**"],   // glob patterns (planned)
    "validatedReaderNames": ["valid"]     // method names that count as validated reads
  }
}
```

`framework: "auto"` checks for `import ... from "hono"` in any source file before activating the Hono detector. Set to `"hono"` to force-on, or `"off"` to disable the rule entirely.

## Common false positives

- **Webhooks with signature verification** (see ambiguous example).
- **Files that compute their own Zod parse manually.** A file might do `const body = await c.req.json(); const parsed = mySchema.parse(body);` — semantically validated, but R05 doesn't see `c.req.valid(...)` so it flags. Suppress per-file or restructure to use the standard validator middleware.
- **Tests, fixtures, and sample servers.** Test files that call `c.req.json()` to assert framework behavior aren't real bypass cases. Excluded by the default `exclude` config (`**/*.test.ts`).

## Implementation notes

- **Hono only.** Other frameworks (tRPC, Next.js Route Handlers, Express, Fastify, NestJS) need their own detectors keyed off `framework: "trpc" | "next" | "express" | "fastify" | "nest"`. They use different bypass shapes (e.g. tRPC: a procedure with no `.input(...)` accepting an untyped body; Express: `req.body` direct usage; NestJS: a controller method with no DTO + ValidationPipe). Each is one focused walker.
- **Wrapper detection is heuristic.** "Imports from `@hono/zod-validator`" catches the standard wrapper pattern but a project that hand-rolls validation without importing zod-validator wouldn't be auto-skipped. Add to `excludeFiles` or refactor to use the standard import.
- **Source location is exact** — the rule walks the TS AST via `ts-morph` and gets the actual line of the bypass call directly from the source position.

## See also

- R01 — Field type drift (related: even with R05 enforced, the schemas validated must themselves be consistent with Prisma)
