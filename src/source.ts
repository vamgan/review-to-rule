import { z } from "zod";
import { ConfigurationError } from "./domain/errors.js";
import { canonicalReviewIdentity, parseReviewUrl } from "./github/url.js";

export const reviewSystemSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);

export function normalizeReviewSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("Review source URL is invalid.");
  }
  if (!new Set(["https:", "http:"]).has(url.protocol))
    throw new ConfigurationError("Review source URL must use HTTP or HTTPS.");
  if (url.username || url.password)
    throw new ConfigurationError(
      "Review source URL must not contain embedded credentials.",
    );
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function canonicalReviewSourceIdentity(value: string): string {
  const normalized = normalizeReviewSourceUrl(value);
  try {
    return canonicalReviewIdentity(parseReviewUrl(normalized));
  } catch {
    return `review-url:${normalized}`;
  }
}
