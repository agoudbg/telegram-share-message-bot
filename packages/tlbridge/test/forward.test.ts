import { describe, expect, it } from 'vitest';
import { extractForwardOrigin, markNestedForwards } from '../src/forward.js';
import type { TLJsonObject } from '../src/types.js';

function fwdMsg(date: number, fromId?: TLJsonObject, extra?: Partial<TLJsonObject>): TLJsonObject {
  return {
    className: 'Message',
    id: 0,
    date,
    fwdFrom: { className: 'MessageFwdHeader', date, fromId, ...extra },
  };
}

describe('extractForwardOrigin', () => {
  it('four states: user / hidden_user / chat / channel', () => {
    expect(
      extractForwardOrigin(fwdMsg(100, { className: 'PeerUser', userId: { $long: '1' } })),
    ).toEqual({ type: 'user', date: 100, fromName: undefined, channelPost: undefined });
    expect(extractForwardOrigin(fwdMsg(100, undefined, { fromName: 'John Doe' }))).toEqual({
      type: 'hidden_user',
      date: 100,
      fromName: 'John Doe',
      channelPost: undefined,
    });
    expect(
      extractForwardOrigin(fwdMsg(100, { className: 'PeerChat', chatId: { $long: '2' } }))!.type,
    ).toBe('chat');
    const channel = extractForwardOrigin(
      fwdMsg(100, { className: 'PeerChannel', channelId: { $long: '3' } }, { channelPost: 42 }),
    );
    expect(channel).toMatchObject({ type: 'channel', channelPost: 42 });
  });

  it('structural fallback when className is absent', () => {
    expect(
      extractForwardOrigin({ className: 'Message', fwdFrom: { date: 5, fromId: { userId: 1 } } })!
        .type,
    ).toBe('user');
  });

  it('no fwdFrom → null', () => {
    expect(extractForwardOrigin({ className: 'Message', id: 1 })).toBeNull();
    expect(extractForwardOrigin({ className: 'Message', fwdFrom: null })).toBeNull();
  });
});

describe('markNestedForwards', () => {
  it('increasing timestamps → nothing marked', () => {
    const msgs = [fwdMsg(100), fwdMsg(101), fwdMsg(102)];
    expect(markNestedForwards(msgs)).toEqual([false, false, false]);
  });

  it('backwards timestamp (strictly earlier) → marked', () => {
    const msgs = [fwdMsg(100), fwdMsg(105), fwdMsg(99), fwdMsg(110)];
    expect(markNestedForwards(msgs)).toEqual([false, false, true, false]);
  });

  it('same-second neighbours are NOT marked (second precision; equality never counts)', () => {
    const msgs = [fwdMsg(100), fwdMsg(100), fwdMsg(100)];
    expect(markNestedForwards(msgs)).toEqual([false, false, false]);
  });

  it('two consecutive backwards steps are both marked (each vs the previous baseline)', () => {
    const msgs = [fwdMsg(100), fwdMsg(90), fwdMsg(80)];
    expect(markNestedForwards(msgs)).toEqual([false, true, true]);
  });

  it('messages without fwdFrom are skipped and do not reset the baseline', () => {
    const plain: TLJsonObject = { className: 'Message', id: 9, date: 1750000200 };
    const msgs = [fwdMsg(100), plain, fwdMsg(50)];
    expect(markNestedForwards(msgs)).toEqual([false, false, true]);
  });

  it('enabled:false → nothing marked', () => {
    const msgs = [fwdMsg(100), fwdMsg(50)];
    expect(markNestedForwards(msgs, { enabled: false })).toEqual([false, false]);
  });

  it('empty batch and single message', () => {
    expect(markNestedForwards([])).toEqual([]);
    expect(markNestedForwards([fwdMsg(1)])).toEqual([false]);
  });
});
