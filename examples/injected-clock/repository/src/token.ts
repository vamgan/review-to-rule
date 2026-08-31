export function legacyExpiresAt(ttl: number) {
  return Date.now() + ttl;
}

export interface Clock {
  now(): number;
}

export function expiresAt(ttl: number, clock: Clock) {
  return clock.now() + ttl;
}
