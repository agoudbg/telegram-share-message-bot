// Fixtures mimicking gramjs/teleproto TL class instances:
// - className may be an own property (Message) or a prototype getter (PeerUser)
// - runtime fields (_client circular reference, _entities Map) must be stripped
// - longs come in two forms: native bigint and big-integer-style instances

export class PeerUser {
  constructor(public userId: bigint) {}
  get className() {
    return 'PeerUser';
  }
}

export class MessageFwdHeader {
  className = 'MessageFwdHeader';
  date = 0;
  fromId?: PeerUser;
  fromName?: string;
}

export class Message {
  className = 'Message';
  id = 0n;
  message = '';
  date = 0;
  fwdFrom?: MessageFwdHeader;
  entities?: unknown[];
  media?: unknown;
  _client?: unknown;
  _entities?: Map<string, unknown>;
}

// Mimics a big-integer package instance: constructor name + decimal toJSON
export class SmallInteger {
  constructor(private val: string) {}
  toJSON() {
    return this.val;
  }
  toString() {
    return this.val;
  }
}

export function makeMessage(): Message {
  const msg = new Message();
  msg.id = 123n;
  msg.message = 'hello';
  msg.date = 1750000000;
  const fwd = new MessageFwdHeader();
  fwd.date = 1749999000;
  fwd.fromId = new PeerUser(777000n);
  msg.fwdFrom = fwd;
  msg.entities = [{ className: 'MessageEntityBold', offset: 0, length: 5 }];
  msg._client = { circular: null as unknown };
  (msg._client as { circular: unknown }).circular = msg._client; // circular reference
  msg._entities = new Map([['777000', {}]]);
  return msg;
}
