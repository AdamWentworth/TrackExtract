import type { IncomingMessage } from "node:http";
import path from "node:path";

export function isTrustedDevRequest(request: Pick<IncomingMessage, "headers">) {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return false;
  }
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    const originUrl = new URL(origin);
    return ["http:", "https:"].includes(originUrl.protocol) && originUrl.host === request.headers.host;
  } catch {
    return false;
  }
}

export function isPathWithin(value: string, parent: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(value));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function parseByteRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || size <= 0) {
    throw new Error("Byte range is malformed.");
  }

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new Error("Byte range is not satisfiable.");
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    throw new Error("Byte range is not satisfiable.");
  }
  return { start, end };
}
