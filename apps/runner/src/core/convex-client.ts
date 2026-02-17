import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

// Re-export for convenience
export { ConvexClient } from "convex/browser";

// Runtime API reference — uses anyApi since the generated types live
// outside src/ (convex/ has its own tsconfig with Bundler resolution).
// Type safety at the schema level comes from the Convex backend files;
// the client-side calls are loosely typed via anyApi.
export const api = anyApi;

export function getConvexUrl(): string {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL environment variable is not set");
  }
  return url;
}

export function createConvexClient(url?: string): ConvexClient {
  const convexUrl = url ?? getConvexUrl();
  return new ConvexClient(convexUrl);
}
