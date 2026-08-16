// Logging and the unknown-constructor alert hook (docs/PLAN.md §2.2).
//
// teleproto logs `Type <id> not found` (MTProtoSender) when the TL layer
// falls behind Telegram. Those lines are the "time to upgrade teleproto"
// detector, so they are forwarded to a dedicated alert sink in addition to
// the regular log output.

import { Logger } from 'teleproto';

export type AlertSink = (line: string) => void;

const UNKNOWN_CONSTRUCTOR_PATTERN = /Type \S+ not found|Unknown constructor/i;

/** A teleproto baseLogger that mirrors records to `log` and forwards
 *  unknown-constructor lines to `onAlert`. */
export function createBotLogger(log: (line: string) => void, onAlert: AlertSink): Logger {
  // Default level is INFO
  const logger = new Logger();
  logger.handler = (record) => {
    const line = `[teleproto:${record.level}] ${record.message}`;
    log(line);
    if (UNKNOWN_CONSTRUCTOR_PATTERN.test(record.message)) {
      onAlert(record.message);
    }
  };
  return logger;
}
