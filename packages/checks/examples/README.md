# Examples

Test fixtures organized by rule. Each rule has a `good/` and `bad/` directory under `examples/<RNN>/`.

The CLI uses these as integration test fixtures: every fixture in `bad/` must produce at least one finding for that rule, and every fixture in `good/` must produce zero findings for that rule.

The skills reference these as concrete examples in their decision-making.

## Layout

```
examples/
├── R01/
│   ├── bad/
│   │   ├── missing-max-length.prisma
│   │   ├── missing-max-length.ts
│   │   └── ...
│   └── good/
├── R02/
│   ├── bad/
│   └── good/
├── R05/
│   ├── bad/         # Hono fixture
│   ├── good/        # Hono fixture
│   ├── trpc/
│   │   ├── bad/
│   │   └── good/
│   └── next/
│       ├── bad/    # Route Handler + Server Action (file + inline) + Pages API
│       └── good/   # all surfaces with proper Zod parse / suppression
└── ...
```

Multi-detector rules (currently only R05, which has separate Hono / tRPC / Next.js walkers) keep one fixture per detector under a framework-named subfolder.

Each fixture is a minimal, self-contained slice — schema + Zod + (optional) TS usage — small enough to read in one screen.
