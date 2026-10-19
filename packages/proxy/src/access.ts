import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { type ApiFormat, type ErrorKind, errorBody } from "./formats.js";

export interface AccessOptions {
  /**
   * When set, every request must carry it as `Authorization: Bearer <token>` or `x-api-key`.
   * Required when the server listens on a non-loopback address.
   */
  token: string | null;
  /**
   * Hostnames accepted in the `Host` header when no token is set. This blocks DNS rebinding: a
   * web page that resolves its own domain to 127.0.0.1 still sends its domain as `Host`.
   */
  allowedHosts: ReadonlySet<string>;
}

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/** Whether a listen address only accepts connections from this machine. */
export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(bare) || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/** The hostname part of a `Host` header, lowercased, without port or IPv6 brackets. */
export function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function presentedToken(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return c.req.header("x-api-key") ?? null;
}

function reject(
  c: Context,
  format: ApiFormat,
  status: 401 | 403 | 415,
  kind: ErrorKind,
  msg: string,
) {
  return c.json(errorBody(format, kind, msg), status);
}

/** Checks who may call the proxy, before any body is read. */
export function access(format: ApiFormat, options: AccessOptions): MiddlewareHandler {
  const expected = options.token === null ? null : digest(options.token);
  return async (c, next) => {
    if (expected !== null) {
      const token = presentedToken(c);
      // Compare fixed-length digests so the check takes the same time for any input.
      if (token === null || !timingSafeEqual(digest(token), expected)) {
        return reject(c, format, 401, "authentication", "Missing or invalid switchkick token.");
      }
    } else {
      const host = hostnameOf(c.req.header("host") ?? "");
      if (!options.allowedHosts.has(host)) {
        return reject(c, format, 403, "permission", `Host "${host}" is not allowed.`);
      }
    }
    // Requiring JSON also means a cross-site page can't send a request without a CORS
    // preflight, which switchkick never answers.
    const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return reject(
        c,
        format,
        415,
        "unsupported_media_type",
        "Content-Type must be application/json.",
      );
    }
    await next();
  };
}
