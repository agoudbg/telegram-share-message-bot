// Forward-origin extraction and the nested-forward heuristic.
// See docs/PLAN.md §2.7.
//
// Nested forwards (a forwarded message that was itself a forward) are
// flattened by the API and cannot be identified exactly. Heuristic: within a
// batch in arrival order, if a message's fwdFrom.date is **strictly earlier**
// than the previous message's fwdFrom.date, mark it as a nested forward
// (time going backwards is a reliable signal).
// No equality: TL timestamps have second precision, and adjacent messages in
// one batch very often share the same second — treating equality as nested
// would produce many false positives.

import type { TLJsonObject } from './types.js';

export type ForwardOriginType = 'user' | 'hidden_user' | 'chat' | 'channel';

export interface ForwardOriginInfo {
  type: ForwardOriginType;
  /** Original message time (Unix seconds) */
  date: number;
  /** Plain-text name for hidden_user */
  fromName?: string;
  /** Original post id for channel origins */
  channelPost?: number;
}

function asObject(value: unknown): TLJsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TLJsonObject)
    : undefined;
}

/** Extract the four forward-origin states from a TL JSON message; returns
 *  null for non-forwarded messages (no fwdFrom). */
export function extractForwardOrigin(msg: TLJsonObject): ForwardOriginInfo | null {
  const fwd = asObject(msg.fwdFrom);
  if (!fwd || typeof fwd.date !== 'number') return null;

  const info: ForwardOriginInfo = { type: 'hidden_user', date: fwd.date };
  if (typeof fwd.fromName === 'string') info.fromName = fwd.fromName;
  if (typeof fwd.channelPost === 'number') info.channelPost = fwd.channelPost;

  const fromId = asObject(fwd.fromId);
  if (fromId) {
    const cn = fromId.className;
    if (cn === 'PeerUser' || 'userId' in fromId) info.type = 'user';
    else if (cn === 'PeerChannel' || 'channelId' in fromId) info.type = 'channel';
    else if (cn === 'PeerChat' || 'chatId' in fromId) info.type = 'chat';
  }
  // No fromId but fromName → hidden_user (the default)
  return info;
}

export interface NestedForwardOptions {
  /** Heuristic switch, on by default */
  enabled?: boolean;
}

/**
 * Mark nested forwards for a batch of TL JSON messages in arrival order.
 * Returns a boolean array parallel to the input (true = suspected nested
 * forward).
 */
export function markNestedForwards(
  messages: TLJsonObject[],
  options: NestedForwardOptions = {},
): boolean[] {
  const enabled = options.enabled ?? true;
  const marks = new Array<boolean>(messages.length).fill(false);
  if (!enabled) return marks;

  let prev: ForwardOriginInfo | null = null;
  for (let i = 0; i < messages.length; i++) {
    const cur = extractForwardOrigin(messages[i]!);
    if (cur && prev && cur.date < prev.date) marks[i] = true;
    // Messages without fwdFrom take no part in comparison, but they do not
    // reset the baseline either (they are not forwards themselves; the next
    // forwarded message still compares against the most recent one that has
    // fwdFrom)
    if (cur) prev = cur;
  }
  return marks;
}
