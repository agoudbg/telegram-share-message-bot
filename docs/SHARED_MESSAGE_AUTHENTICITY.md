# Understanding Shared Message Authenticity

The messages on a Share View page may have been excerpted, mixed, reordered,
or altered before they reached this service. The page is useful for convenient
reading, but it should not be treated as a complete or independently verified
record of a Telegram conversation.

This warning does not mean that a particular share has been manipulated. It
explains what the service can and cannot prove about any shared batch.

## Why the original meaning may change

### Messages can be selectively excerpted

The person creating a share chooses which messages to send to the bot. Earlier
questions, later corrections, replies, reactions, pinned messages, or other
surrounding context may be omitted. Every displayed message can be genuine
while the selection as a whole still suggests a meaning that the complete
conversation would not support.

### Messages from different contexts can be mixed

A batch may combine messages from different chats, senders, threads, or time
periods. Similar names and avatars do not establish that two messages came from
the same conversation. A selected ordering may also imply a sequence or a
cause-and-effect relationship that did not exist in the source chats.

### Content may already have been changed

Before content is forwarded to the bot, a person can copy and edit text,
recreate a message, modify a caption, replace media, or send a screenshot of
different content. The service receives the resulting Telegram messages; it
does not have access to every earlier version or to the private devices on
which the content was prepared.

### Telegram does not expose every forwarding detail

Telegram can hide an author's identity through privacy settings, and its APIs
may flatten a chain of repeated forwards to the earliest visible origin.
Intermediate forwarders and some source relationships therefore cannot always
be recovered. A displayed name can also be user-supplied, privacy-preserved, or
unresolvable by the bot.

### Conversation context is richer than message bodies

Meaning often depends on reply targets, deleted messages, edits, reactions,
poll state, timing, membership changes, and media that is no longer available.
Some of this information may be absent from a forwarded batch or impossible to
render later. Timestamps shown in a flattened batch may also be normalized to
keep the displayed sequence readable while source metadata remains limited.

### Share View is not cryptographic proof

The service preserves and renders the message data it receives, subject to
privacy sanitization and display adaptation. It does not receive a signed,
complete transcript that proves continuity, authorship, or the absence of
prior modification. A Share View page is not an official Telegram export and
should not be used as the sole evidence for legal, financial, safety-critical,
or reputational decisions.

## What the service does preserve

Within the data available to it, the service aims to reproduce message text,
formatting, media, visible forwarding information, replies, and timestamps as
faithfully as the Telegram Web rendering pipeline permits. Public responses
remove or replace private identifiers and media access credentials. These
protections reduce privacy and security risks, but they also mean that the page
cannot serve as a forensic copy of Telegram's internal data.

## How to verify important claims

If accuracy matters:

1. Ask for the surrounding conversation, not only the selected messages.
2. Compare the share with the original chat on the participants' devices.
3. Check reply targets, edit indicators, dates, sender identities, and media.
4. Seek confirmation from more than one participant or independent source.
5. Treat screenshots, copied text, and public share links as leads to verify,
   not as conclusive proof on their own.

The safest interpretation is simple: a Share View page shows what this service
received and rendered. It does not prove that the page contains the whole
conversation or that the selection preserves the original intent.
