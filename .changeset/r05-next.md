---
"prisma-zod-consistency": minor
---

R05 now detects bypass'ed boundaries in Next.js applications across three surfaces: App Router Route Handlers (`app/**/route.{ts,tsx,js,jsx}`), Server Actions (file-level `'use server'` exports and inline `'use server'` directives), and Pages Router API routes (`pages/api/**/*.{ts,tsx,js,jsx}`).

Route Handler detection flags `<request>.json()`, `<request>.formData()`, `<request>.blob()`, and `<request>.arrayBuffer()` calls on the first parameter of any HTTP-method export. Server Action detection flags `<formData>.get(...)` (and friends) reads on a `FormData` parameter when the function does not also call `<schema>.parse(<formData>)` or `<schema>.parse(Object.fromEntries(<formData>))`. Pages API detection flags `<req>.body` direct access on the default-export handler. Files importing known wrappers (`next-safe-action`, `zsa`, `zact`) are skipped wholesale.

`<request>.text()` and `<request>.body` stream access (`.body.getReader()`) are intentionally not flagged — webhooks legitimately read raw text for signature verification, and stream access is a streaming/SSE pattern.

The `framework` config gains `"next"`, and the default `"auto"` now picks up Next.js automatically via path detection (`app/.../route.*`, `pages/api/...`), Next imports (`next`, `next/*`), or `'use server'` directives.
