// Outgoing webhooks (webhooks.py). Stub: the routes call `emit` already; package 2d delivers the events.
import type { Req, User } from './http.ts';

/** Called by the routes after a change. Never throws. The demo account never sends anything out. */
export function emit(_req: Req, _user: User, _event: string, _data: Record<string, unknown>): void {}
