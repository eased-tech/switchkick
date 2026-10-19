import { timingSafeEqual } from "node:crypto";
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

/**
 * Compares a presented token with the expected one in time that doesn't depend on their
 * contents: the presented bytes are copied into a buffer of the expected length before the
 * constant-time comparison, so a length mismatch doesn't return early either.
 */
function tokenMatches(presented: string, expected: Buffer): boolean {
  const bytes = Buffer.from(presented);
  const padded = Buffer.alloc(expected.length);
  bytes.copy(padded);
  return timingSafeEqual(padded, expected) && bytes.length === expected.length;
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

/** The error envelope to answer in: fixed per route, or chosen from the request. */
export type FormatOf = ApiFormat | ((c: Context) => ApiFormat);

/**
 * Checks who may call the proxy: the token when one is set, otherwise the Host header. Runs on
 * every route, before any body is read.
 */
export function access(formatOf: FormatOf, options: AccessOptions): MiddlewareHandler {
  const expected = options.token === null ? null : Buffer.from(options.token);
  return async (c, next) => {
    const format = typeof formatOf === "function" ? formatOf(c) : formatOf;
    if (expected !== null) {
      const token = presentedToken(c);
      if (token === null || !tokenMatches(token, expected)) {
        return reject(c, format, 401, "authentication", "Missing or invalid switchkick token.");
      }
    } else {
      const host = hostnameOf(c.req.header("host") ?? "");
      if (!options.allowedHosts.has(host)) {
        return reject(c, format, 403, "permission", `Host "${host}" is not allowed.`);
      }
    }
    await next();
  };
}

/**
 * Requires a JSON body on POST routes. This also means a cross-site page can't send a request
 * without a CORS preflight, which switchkick never answers.
 */
export function requireJson(format: ApiFormat): MiddlewareHandler {
  return async (c, next) => {
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
