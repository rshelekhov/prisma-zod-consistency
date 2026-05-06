/**
 * `DiscoveryError` — thrown by the discovery layer (entry path, multi-file
 * loader, datasource detection) when the project's shape isn't recognisable.
 *
 * Kept in its own module so that `load-schema.ts` can throw the same error
 * type without importing `discovery.ts` (which itself imports the loader).
 */

export class DiscoveryError extends Error {
  override readonly name = "DiscoveryError";
}
