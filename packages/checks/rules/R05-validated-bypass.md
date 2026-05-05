# R05 — API boundary bypass

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | 1 (skill); CLI only when `framework` config is set |
| Surface | CLI + skill |
| Group | A (static) |
| Auto-fix | no — adding a validator middleware requires picking a Zod schema |
| Implementation | done for Hono, tRPC, Next.js; Express/Fastify/Nest deferred |

## What it checks

Detects route handlers that accept untyped client input without going through a Zod-validated boundary. The rule is framework-aware and dispatches to per-framework walkers. The intent is the same across frameworks: untyped/untrusted data should not flow from `request → service → prisma.create/update` without a Zod schema in between.

**Hono detector** finds calls of the form `<x>.req.json()`, `<x>.req.parseBody()`, or `<x>.req.formData()` — where `<x>` is the Hono context (typically `c`, `ctx`, or `context`). The wrapper-detection heuristic auto-skips files importing from `@hono/zod-validator`, since those files legitimately call `c.req.json()` inside the validator and re-expose it via `c.req.valid(...)`.

**tRPC detector** is import-gated — only files that import from `@trpc/server` (or any `@trpc/server/...` subpath) are walked. Inside such a file, every `.query(handler)` or `.mutation(handler)` call is examined. A finding is emitted when:

1. The handler accepts a parameter named `input` (or destructures `{ input }` from its first argument), AND
2. The procedure chain has no `.input(...)` call before the `.query(...)` / `.mutation(...)`.

`.input(z.void())`, `.input(z.undefined())`, and `.input(z.never())` count as explicit no-input declarations and are NOT flagged. Procedures whose handler takes no arguments at all (`.query(() => …)`) are also not flagged — there's nothing to validate.

**Next.js detector** runs three sub-walkers, gated by file path or directive:

1. **App Router Route Handlers** — files matching `**/app/**/route.{ts,tsx,js,jsx}`. For each named export whose name is an HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`), the body is searched for direct calls of `<request>.json()`, `<request>.formData()`, `<request>.blob()`, or `<request>.arrayBuffer()` on the first parameter. Both `export async function POST(...)` and `export const POST = async (...) => {...}` shapes are recognised. `<request>.text()` is intentionally NOT flagged — webhooks routinely read raw text for signature verification, and the false-positive rate would be unacceptable. `<request>.body` direct stream access (`.body.getReader()`) is also not flagged — too rare and almost always streaming/SSE.

2. **Server Actions** — any file with a `'use server'` directive, either at the top of the file (file-level) or as the first statement of an async function (inline). For file-level, every **exported** async function is treated as a Server Action; non-exported helpers in the same file are out of scope to avoid flagging routine internal functions. For inline, the directive carrier function itself is the action. The detector flags `<formData>.get(...)`, `getAll(...)`, `has(...)`, `entries(...)`, `values(...)`, `keys(...)` calls on a parameter typed as `FormData` (or named `formData`/`form`) when the function does NOT also call `<schema>.parse(<formData>)` or `<schema>.parse(Object.fromEntries(<formData>))` somewhere in its body. Files importing a known wrapper library (`next-safe-action`, `zsa`, `zact`) are skipped wholesale — those wrappers guarantee a Zod parse.

3. **Pages Router API** — files matching `**/pages/api/**/*.{ts,tsx,js,jsx}`. The default-exported handler's first parameter is identified, and any `<req>.body` PropertyAccess is flagged unless the same body calls `<schema>.parse(<req>.body)`. Both `export default function handler(...)` and `function handler(...); export default handler;` shapes are resolved.

The same file may host multiple surfaces (e.g. an `app/page.tsx` with both a Server Component and an inline Server Action) — sub-walkers are non-exclusive within a file.

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

### Bad — Hono

```typescript
import { Hono } from "hono";

const route = new Hono();

route.post("/users", async (c) => {
  const body = await c.req.json(); // ❌ untyped, untrusted
  await prisma.user.create({ data: body }); // ❌ mass-assignment
  return c.json({ ok: true });
});
```

### Good — Hono

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

### Bad — tRPC

```typescript
import { initTRPC } from "@trpc/server";

const t = initTRPC.create();
const publicProcedure = t.procedure;

export const router = t.router({
  // ❌ no `.input(...)` — `input` is unknown/untyped client data.
  createUser: publicProcedure.mutation(({ input }) => {
    return prisma.user.create({ data: input as never }); // ❌ mass-assignment
  }),
});
```

### Good — tRPC

```typescript
import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const router = t.router({
  // Canonical: explicit Zod input.
  createUser: t.procedure
    .input(z.object({ name: z.string().min(1).max(100), email: z.string().email() }))
    .mutation(({ input }) => prisma.user.create({ data: input })),

  // Explicit no-input — also accepted.
  ping: t.procedure.input(z.void()).query(() => "pong"),

  // No `input` parameter at all — nothing to validate, nothing to flag.
  listUsers: t.procedure.query(() => prisma.user.findMany()),
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

For the webhook case: confirm the endpoint is signature-verified (or otherwise authenticated by a different mechanism), then add it to `R05.excludeFiles` or suppress with a `// pz-disable-next-line R05` comment (see [Suppression](#suppression) below).

### Bad — Next.js App Router Route Handler

```typescript
// app/api/users/route.ts
export async function POST(request: Request) {
  const body = await request.json(); // ❌ untyped, untrusted
  await prisma.user.create({ data: body }); // ❌ mass-assignment
  return Response.json({ ok: true });
}
```

### Good — Next.js App Router Route Handler

```typescript
// app/api/users/route.ts
import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function POST(request: Request) {
  // pz-disable-next-line R05 -- parsed below
  const raw = await request.json();
  const body = createUserSchema.parse(raw);
  await prisma.user.create({ data: body });
  return Response.json({ ok: true });
}
```

R05 doesn't track the dataflow `request.json() → schema.parse(...)` (that path is fragile across refactors). The canonical fix on Route Handlers is therefore an explicit `// pz-disable-next-line R05` over the bypass call, paired with a Zod parse on the next line. Alternatively, wrap the handler with a library like `next-safe-action`.

### Bad — Next.js Server Action (file-level `'use server'`)

```typescript
// app/actions/create-user.ts
"use server";

export async function createUser(formData: FormData) {
  const name = formData.get("name"); // ❌ untyped FormData read
  const email = formData.get("email");
  await prisma.user.create({ data: { name: name as string, email: email as string } });
}
```

### Good — Next.js Server Action

```typescript
// app/actions/create-user.ts
"use server";

import { z } from "zod";

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export async function createUser(formData: FormData) {
  const data = createUserSchema.parse(Object.fromEntries(formData));
  await prisma.user.create({ data });
}
```

The `schema.parse(Object.fromEntries(formData))` shape is auto-skipped — no suppression comment needed.

### Bad — Next.js Server Action (inline `'use server'`)

```typescript
// app/page.tsx
export default function Page() {
  async function deletePost(formData: FormData) {
    "use server";
    const id = formData.get("id"); // ❌ untyped FormData read
    await prisma.post.delete({ where: { id: id as string } });
  }
  return <form action={deletePost}>{/* … */}</form>;
}
```

### Bad — Next.js Pages Router API

```typescript
// pages/api/login.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body; // ❌ untyped client data
  await prisma.session.create({ data: body });
  res.status(200).json({ ok: true });
}
```

### Good — Next.js Pages Router API

```typescript
// pages/api/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const body = loginSchema.parse(req.body);
  // ...
  res.status(200).json({ ok: true, email: body.email });
}
```

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
    "framework": "auto",                 // hono | trpc | next | auto | off
    "excludeFiles": ["**/webhooks/**"],   // glob patterns (planned)
    "validatedReaderNames": ["valid"]     // method names that count as validated reads (Hono)
  }
}
```

`framework: "auto"` (the default) probes the project for each detector's signal:

- **Hono** — any source file importing `hono`.
- **tRPC** — any source file importing `@trpc/server` (or a `@trpc/server/...` subpath).
- **Next.js** — any source file at a Next-conventional path (`**/app/**/route.{ts,tsx,js,jsx}` or `**/pages/api/**/*.{ts,tsx,js,jsx}`), any source file importing `next` / `next/*`, or any source file beginning with a `'use server'` directive.

A project that uses both Hono and Next gets both walkers. `"hono"` / `"trpc"` / `"next"` force-enable a single detector regardless of the signal; `"off"` disables the rule entirely.

> **Layout note.** The default `include` glob is `src/**/*.{ts,tsx}`. Next.js projects using `app/` and `pages/` at the project root (without a `src/` directory) need to extend `include` in their config — e.g. `["src/**/*.ts", "src/**/*.tsx", "app/**/*.{ts,tsx}", "pages/**/*.{ts,tsx}"]` — for the Next sub-walkers to see those files.

## Suppression

R05 findings can be silenced inline with comment directives. The canonical use case is signature-verified webhooks where reading `c.req.json()` directly is correct:

```typescript
// pz-disable-next-line R05
const event = await c.req.json(); // signature already verified above
```

Block form, useful for whole-file webhook handlers:

```typescript
// pz-disable R05
// ... handler that legitimately bypasses Zod validation ...
// pz-enable R05
```

Wildcards, multi-rule lists, and trailing reasons in `-- ` style are also supported — see [packages/cli/README.md](../../cli/README.md#suppression-comments) for the full grammar.

For excluding entire directories (e.g. `webhooks/`) without per-line comments, prefer `R05.excludeFiles` in your config — that's a coarser knob with the same outcome and avoids comment-noise across many handlers.

To hard-gate R05 (no suppression honoured, every finding always reported), set in your config:

```jsonc
{ "R05": { "suppressionsEnabled": false } }
```

## Common false positives

- **Webhooks with signature verification** (see ambiguous example).
- **Files that compute their own Zod parse manually.** A file might do `const body = await c.req.json(); const parsed = mySchema.parse(body);` — semantically validated, but R05 doesn't see `c.req.valid(...)` so it flags. Suppress per-file or restructure to use the standard validator middleware.
- **Tests, fixtures, and sample servers.** Test files that call `c.req.json()` to assert framework behavior aren't real bypass cases. Excluded by the default `exclude` config (`**/*.test.ts`).

## Implementation notes

- **Hono, tRPC, and Next.js are implemented.** Other frameworks (Express, Fastify, NestJS) need their own detectors keyed off `framework: "express" | "fastify" | "nest"`. They use different bypass shapes (Express: `req.body` direct usage; NestJS: a controller method with no DTO + ValidationPipe; etc.). Each is one focused walker.
- **tRPC detection is import-gated.** Files that don't import from `@trpc/server` are skipped entirely. This rules out coincidental `.query(...)` / `.mutation(...)` chains from MongoDB drivers, Prisma `findMany()` chains, and other libraries that happen to expose those method names. Known limitation: a file that re-exports `procedure` through a barrel without itself importing `@trpc/server` (e.g. via a `t.ts` helper) would not be walked. Mitigation: use the standard pattern of importing `initTRPC` / `procedure` directly in router files, or set `R05.framework = "trpc"` to force-enable the detector across every TS/TSX file regardless of imports.
- **tRPC walker is permissive about identifier names.** Any chain ending in `.query(handler)` or `.mutation(handler)` is treated as a procedure candidate — not just `procedure` / `publicProcedure` / `protectedProcedure`. The import gate already filters out non-tRPC code, so identifier matching is unnecessary and would produce false negatives for projects with custom names.
- **Next.js detection has three sub-walkers** (App Router Route Handlers, Server Actions, Pages Router API), each independently gated. Route Handlers and Pages API are path-gated (`app/**/route.*` and `pages/api/**`); Server Actions are directive-gated (`'use server'`, file-level or inline). The same file may carry multiple surfaces (e.g. an `app/page.tsx` Server Component that defines an inline action). Files importing known wrappers (`next-safe-action`, `zsa`, `zact`) are skipped wholesale.
- **Next.js Server Actions: file-level vs inline scoping.** In a `'use server'` file, only **exported** async functions are flagged — non-exported async helpers are out of scope to avoid false positives on routine internal code. For inline directives (`'use server'` as the first statement of an async function), only the directive carrier is treated as an Action.
- **Next.js Route Handlers: hand-rolled parse is not auto-skipped.** A file that does `const raw = await request.json(); const parsed = mySchema.parse(raw);` will still get an R05 finding on the `.json()` call. Tracking the dataflow `request → parse` across statements is too fragile; the documented fix is `// pz-disable-next-line R05` on the bypass line plus a real Zod parse below it. For Server Actions and Pages API, by contrast, the parse target is fixed (`<formDataParam>` or `<reqParam>.body`), and the walker DOES auto-skip when that exact shape is detected.
- **Next.js `<request>.text()` and `<request>.body` stream access are not flagged.** `text()` is the canonical webhook / signature-verification path; `body.getReader()` is for streaming/SSE. Both have FP rates too high to flag in MVP. Documented limitations.
- **Hono wrapper detection is heuristic.** "Imports from `@hono/zod-validator`" catches the standard wrapper pattern but a project that hand-rolls validation without importing zod-validator wouldn't be auto-skipped. Add to `excludeFiles` or refactor to use the standard import.
- **Source location is exact** — the rule walks the TS AST via `ts-morph` and gets the actual line of the bypass call directly from the source position.

## See also

- R01 — Field type drift (related: even with R05 enforced, the schemas validated must themselves be consistent with Prisma)
