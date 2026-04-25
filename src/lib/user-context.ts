/**
 * Request-scoped user context backed by AsyncLocalStorage. Server handlers
 * wrap their work in `withUserContext(user, fn)`; downstream code calls
 * `getCurrentUser()` (or `currentUserPaths()` from user-paths.ts) to learn
 * which user owns the in-flight request without threading the id through
 * every signature.
 *
 * Why ALS: the call graph already sprawls across negotiate-email,
 * negotiate-agent, offer-agent, voice/simulator, etc. Each of those
 * persists per-user state (threads/, offers/, calls/, settings) and
 * adding a `userId` parameter to every function — and then to every
 * helper THOSE call — was the bigger refactor. ALS lets us isolate the
 * change to the request boundary.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "./auth.ts";

const als = new AsyncLocalStorage<{ user: User }>();

export function withUserContext<T>(user: User, fn: () => T): T {
  return als.run({ user }, fn);
}

export function getCurrentUser(): User {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      "No user context — every per-user filesystem call must be inside withUserContext.",
    );
  }
  return ctx.user;
}

/** Returns null when called outside of a request — useful for paths that
 *  can run with or without a user (rare). Prefer `getCurrentUser()`. */
export function maybeCurrentUser(): User | null {
  return als.getStore()?.user ?? null;
}
