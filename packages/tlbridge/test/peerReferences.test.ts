import { describe, expect, it } from 'vitest';

import { collectReferencedPeers } from '../src/peerReferences.js';

describe('collectReferencedPeers', () => {
  it('collects wrapped and bare special-message references', () => {
    expect(collectReferencedPeers({
      className: 'Message',
      peerId: { className: 'PeerUser', userId: { $long: '1' } },
      fromId: { className: 'PeerUser', userId: { $long: '1' } },
      fwdFrom: {
        className: 'MessageFwdHeader',
        fromId: { className: 'PeerChannel', channelId: { $long: '10' } },
      },
      media: {
        className: 'MessageMediaGiveawayResults',
        channelId: { $long: '20' },
        winners: [{ $long: '30' }, { $long: '31' }],
      },
    })).toEqual([
      { peerId: '10', kind: 'channel' },
      { peerId: '20', kind: 'channel' },
      { peerId: '30', kind: 'user' },
      { peerId: '31', kind: 'user' },
    ]);
  });

  it('deduplicates references and never collects the forwarding account envelope', () => {
    expect(collectReferencedPeers({
      className: 'MessageService',
      peerId: { className: 'PeerUser', userId: { $long: '1' } },
      fromId: { className: 'PeerUser', userId: { $long: '1' } },
      action: {
        className: 'MessageActionChatAddUser',
        users: [{ $long: '2' }, { $long: '2' }],
      },
    })).toEqual([{ peerId: '2', kind: 'user' }]);
  });
});
