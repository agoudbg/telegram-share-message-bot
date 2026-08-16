// Share access gate shared by every share-scoped route (docs/PLAN.md §2.8):
// pending shares must not be distinguishable from unknown ones.

import type { StorageDatabase } from '../storage/database.js';
import { getShare } from '../storage/repository.js';
import type { ShareRow } from '../storage/repository.js';

export function checkShareAccess(
  db: StorageDatabase,
  shareId: string,
): ShareRow | 'not_found' | 'revoked' {
  const share = getShare(db, shareId);
  if (share === null || share.status === 'pending') return 'not_found';
  if (share.status === 'revoked') return 'revoked';
  return share;
}
