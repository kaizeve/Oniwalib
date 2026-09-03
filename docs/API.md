# OniWaLib — API reference

`v0.1.0` · every method on the connection returned by `openWhatsApp(...)`, the
events it emits, and the option bags. Types live in `src/` — this is the map.

Descriptions are condensed from the source doc-comments; when in doubt the
`.d.ts`-level source in `src/client.ts` (`OniConnection`, `OpenOptions`) is
authoritative.

---

## Getting started

```ts
import { openWhatsApp, fileAuthState } from "oniwalib";

const auth = fileAuthState("./auth/state.owl");         // encrypted, append-only
const conn = openWhatsApp({
  auth,
  saveCreds: () => auth.saveCreds(),
  fetch: globalThis.fetch,                               // needed for media / link preview
});

conn.events.on("connection.update", ({ qr, connection }) => {
  if (qr) console.log("scan this QR:", qr);
  if (connection === "open") console.log("online");
});

conn.events.on("messages.upsert", async ({ type, messages }) => {
  if (type !== "notify") return;
  for (const m of messages) {
    if (m.key.fromMe || !m.message) continue;
    await conn.sendText(m.key.remoteJid, "pong");
  }
});
```

A **JID** is `<number>@s.whatsapp.net` (user), `<id>@g.us` (group / community),
`<id>@newsletter` (channel), `status@broadcast` (status), or `<id>@lid` (hidden
id). `MessageKey` is `{ remoteJid, id, fromMe, participant? }`.

---

## `openWhatsApp(opts)` — `OpenOptions`

| option | type | default | what |
|---|---|---|---|
| `auth` | `AuthenticationState` | — | credential + Signal key store (`fileAuthState` / `memoryAuthState`) |
| `saveCreds` | `() => void \| Promise<void>` | — | called after pairing and every `<success>` |
| `profile` | `ClientProfile` | stock | stock vs modified client fingerprint |
| `version` | `[number,number,number]` | fetched | pin the protocol version, skip the version fetch |
| `connector` | `Connector` | bun/node WS | transport factory (mock / RTS / custom) |
| `countryCode` | `string` | — | pairing-code country hint |
| `crypto` | `Crypto` | node/bun adapter | swap the crypto backend |
| `fetch` | `FetchLike` | `globalThis.fetch` | HTTP client for media upload/download and link preview |
| `markOnlineOnConnect` | `boolean` | `true` | announce `<presence available>` on login |
| `sendReadReceipts` | `boolean` | `false` | auto blue-tick every received message |
| `historyMessages` | `boolean` | `true` | decode message bodies in history sync (costlier) |
| `autoDownloadMedia` | `boolean` | `false` | fetch+decrypt every incoming attachment, emit `messages.media` |
| `keepAliveMs` | `number` | `25000` | ping interval |
| `maxRetries` | `number` | `5` | consecutive auto-reconnects before giving up |
| `qrTimeoutMs` | `number` | `60000` / `20000` | ms before rotating the QR ref |
| `connectTimeoutMs` | `number` | `20000` | transport connect timeout |
| `channelsSource` | `string` | built-in | override the required-channels JSON URL (test only) |

Returns an **`OniConnection`**. `conn.state` is `"connecting" | "open" | "close"`.

---

## Messaging

| method | returns | what |
|---|---|---|
| `sendText(jid, text, opts?)` | `{ id }` | text message. `opts.linkPreview` fetches the first URL and attaches a title/description card |
| `sendMessage(jid, msg, opts?)` | `{ id }` | send a full `E2EMessage` (buttons, list, viewOnce, …) |
| `sendAlbum(jid, items, opts?)` | `{ albumId, ids }` | one container + N linked media (`imageMessage`/`videoMessage`) |
| `sendContact(jid, contact \| contact[], opts?)` | `{ id }` | contact card. Pass `{ name, phone }` and a vCard 3.0 (with `waid=`) is built, or pass your own `vcard` |
| `sendLocation(jid, { latitude, longitude, name?, address?, url? }, opts?)` | `{ id }` | location pin |
| `sendReaction(jid, key, emoji)` | `{ id }` | react to a message (`""` removes) |
| `editMessage(jid, key, newText)` | `{ id }` | edit a message you sent — peer gets `messages.update` |
| `deleteMessage(jid, key)` | `{ id }` | delete for everyone (revoke) |
| `sendPoll(jid, name, options, selectableCount?)` | `{ id, pollEncKey }` | create a poll — **keep `pollEncKey`** to read votes later |
| `readPollVote(evt, pollEncKey, optionNames?)` | `string[] \| Uint8Array[]` | decrypt a vote from a `poll.update` event |

**`SendOptions`** (the `opts?` above): `quoted?: { key, message? }` · `mentions?: string[]` · `ephemeralExpiration?: number` (seconds, `0` off) · `forwarded?: boolean` · `linkPreview?: boolean` (`sendText` only).

### Media

Need `fetch` in `openWhatsApp`, plus a Signal session with `jid` (1:1).

| method | what |
|---|---|
| `sendAudio(jid, data, opts?)` | `AudioOptions`: `mimetype?`, `seconds?`, `ptt?` |
| `sendImage(jid, data, opts?)` | `ImageOptions`: `mimetype?`, `caption?`, `width?`, `height?`, `jpegThumbnail?`, `viewOnce?`. `width/height` are read from the file header when omitted; a JPEG ≤ 24 KiB is embedded as its own thumbnail |
| `sendVideo(jid, data, opts?)` | `VideoOptions`: `+ seconds?`, `gifPlayback?`. Dimensions read from the MP4 `tkhd` box when omitted |
| `sendDocument(jid, data, opts?)` | `DocumentOptions`: `mimetype?`, `fileName?`, `title?`, `pageCount?`, `caption?`, `jpegThumbnail?` |
| `sendSticker(jid, data, opts?)` | `StickerOptions`: `mimetype?`, `width?`, `height?`, `isAnimated?` |
| `downloadMedia(msg)` | `DownloadedMedia` = `{ data, type, mimetype? }`. Pass `m.message` from a `messages.upsert`. Unwraps `viewOnceMessage`/`deviceSentMessage`. With `autoDownloadMedia: true` this happens automatically → `messages.media` |

Helpers (from `oniwalib` root): `hasDownloadableMedia(msg)`, `imageDimensions(bytes)`, `mp4Dimensions(bytes)`, `fetchLinkPreview(text, fetch)`, `firstUrl(text)`.

### Status (`status@broadcast`)

| method | what |
|---|---|
| `postStatus(recipients, content)` | `content` = `{ text }` or `{ media, type: "image"\|"video", caption? }`. `recipients` are the JIDs that will see it (use `knownContacts()`) |

### Sessions

| method | what |
|---|---|
| `assertSessions(jids)` | open Signal sessions (prekey fetch + X3DH) for `jids` with none. 1:1 sends call this themselves; use it to pre-warm. Returns jids still without a session |
| `assertGroupSessions(groupJid)` | pre-open sessions with **every device of every participant** (metadata → USYNC → cold-send). Run once (e.g. on join) so the next group send reaches everyone. Returns `{ opened, missing }` |

---

## Contacts, presence, receipts

| method | what |
|---|---|
| `onWhatsApp(numbers)` | which numbers have a WhatsApp account — `[{ input, exists, jid }]`, one per input |
| `getProfilePictureUrl(jid, hd?)` | profile-photo URL (`undefined` if none / private) |
| `fetchStatus(jid)` | someone's "about" text — `{ status?, setAt? }` or `undefined` |
| `getDeviceList(jids)` | USYNC device ids per number: `{ "55…@s.whatsapp.net": [0, 23] }` |
| `lidToPn(jid)` | resolve a `@lid` to its `@s.whatsapp.net` (from traffic / group metadata seen so far) |
| `noteContact(jid)` | mark a jid as a 1:1 contact (persisted, encrypted) — feeds the status audience |
| `knownContacts()` | everyone marked with `noteContact`, number/lid pairs collapsed |
| `sendPresenceUpdate(type, toJid?)` | `available`/`unavailable` (global) or `composing`/`recording`/`paused` (per chat) |
| `sendTyping(jid)` / `sendRecording(jid)` / `sendPaused(jid)` | per-chat shortcuts |
| `subscribePresence(jid)` | ask the server for `jid`'s presence updates |
| `readMessages(keys)` | blue-tick — groups `keys` by chat, one `<receipt type=read>` each |
| `sendReceipt(jid, ids, type?, participant?)` | raw receipt. `type` omitted = delivery; `"read"` = blue tick; `"read-self"` = read without telling the sender. `participant` only in groups |

### Privacy

| method | what |
|---|---|
| `fetchPrivacySettings()` | `{ readreceipts, last, online, profile, status, groupadd, calladd }` |
| `updatePrivacySetting(category, value)` | change one category, returns the new settings |

---

## Groups & communities

| method | returns | what |
|---|---|---|
| `groupMetadata(jid)` | `GroupMetadata` | subject, owner, participants + admin, `announce`/`restrict`, `isCommunity`/`linkedParent` |
| `groupParticipants(jid)` | `GroupParticipant[]` | just the participant list |
| `groupCreate(subject, participants)` | `GroupMetadata` | create a group |
| `groupLeave(jid)` | — | leave |
| `groupUpdateSubject(jid, subject)` | — | rename |
| `groupUpdateDescription(jid, description?)` | — | set/clear description |
| `groupParticipantsUpdate(jid, participants, action)` | `ParticipantUpdateResult[]` | `action`: `"add"\|"remove"\|"promote"\|"demote"` — one result per jid (`"200"` ok, `"403"` no permission, `"408"` not on WA, …) |
| `groupSettingUpdate(jid, setting)` | — | `"announcement"`/`"not_announcement"`, `"locked"`/`"unlocked"` |
| `groupToggleEphemeral(jid, seconds)` | — | disappearing messages (`0` off, else `86400`/`604800`/`7776000`) |
| `groupJoinApprovalMode(jid, "on"\|"off")` | — | require admin approval to join |
| `groupMemberAddMode(jid, "all_member_add"\|"admin_add")` | — | who can add members |
| `groupInviteCode(jid)` | `string?` | current `chat.whatsapp.com/<code>` |
| `groupRevokeInvite(jid)` | `string?` | revoke + return the new code |
| `groupAcceptInvite(code)` | `string?` | join by code, returns the group jid |
| `groupGetInviteInfo(code)` | `GroupMetadata` | preview a group by code without joining |
| `groupRequestParticipantsList(jid)` | `Record<string,string>[]` | pending join requests |
| `groupRequestParticipantsUpdate(jid, participants, "approve"\|"reject")` | `ParticipantUpdateResult[]` | act on join requests |
| `communitySubGroups(communityJid)` | `{ jid, subject? }[]` | a community's subgroups |
| `communityLinkSubgroups(communityJid, groupJids)` | `ParticipantUpdateResult[]` | link existing groups into a community |
| `communityUnlinkSubgroup(communityJid, groupJid)` | — | unlink a subgroup |

---

## Channels (`@newsletter`)

| method | what |
|---|---|
| `newsletterMetadata("invite"\|"jid", key)` | channel metadata by invite code or jid |
| `followNewsletter(jid)` / `unfollowNewsletter(jid)` | follow / unfollow |
| `muteNewsletter(jid)` / `unmuteNewsletter(jid)` | mute / unmute |
| `createNewsletter(name, description?)` | create a channel |
| `deleteNewsletter(jid)` | delete (owner only) |
| `newsletterReactMessage(jid, serverId, code)` | react to a channel post by `server_id` (`code` `""` removes) |
| `newsletterFetchMessages(jid, count, { since?, after? })` | older posts — `[{ serverId?, message? }]` |
| `subscribeNewsletterUpdates(jid)` | live updates; returns `{ duration? }` |
| `ensureChannels()` | force the required-channel check now (normally runs once on connect) |

---

## Account & app-state (LT-hash sync)

Needs the primary device to have shared the app-state sync keys — check
`appStateReady()`.

| method | what |
|---|---|
| `resyncAppState(names?)` | pull collection state from the server (`critical_block` = push name, `regular*` = mute/pin/archive/contacts), emit `creds.update`/`chats.update`/`contacts.upsert`. Runs on connect and on `server_sync` notifications |
| `updateProfileName(name)` | change the push name (a `critical_block` mutation) |
| `chatModify(mod, jid)` | mute / pin / archive a chat, or mark (un)read — `ChatModification` |
| `addChatLabel(jid, labelId)` / `removeChatLabel(jid, labelId)` | (un)assign a label (1..20) |
| `appStateReady()` | `true` once the sync keys arrived |
| `setProfilePicture(jpeg)` / `removeProfilePicture()` | your profile photo (JPEG, ~640px square) |
| `setBio(text)` | your "about" |

---

## Blocklist, calls, business

| method | what |
|---|---|
| `fetchBlocklist()` | blocked jids (also emits `blocklist.update`) |
| `updateBlockStatus(jid, "block"\|"unblock")` | (un)block |
| `rejectCall(callId, callFrom)` | reject an incoming call (from a `call` event: `rejectCall(c.id, c.chatId)`) |
| `getBusinessProfile(jid)` | `BusinessProfile` of a Business number |
| `getCatalog({ jid?, limit?, cursor? })` | product catalog |
| `getCollections(jid?, limit?)` | product collections |
| `getOrderDetails(orderId, tokenBase64)` | order details (from an `orderMessage`) |

---

## Connection

| member | what |
|---|---|
| `events` | the `Emitter` (see below) |
| `sendNode(node)` | send a raw `BinaryNode` on the live connection (throws if not open) |
| `state` | `"connecting" \| "open" \| "close"` |
| `end(err?)` | close and do not reconnect |

---

## Events — `conn.events.on(name, cb)`

| event | payload |
|---|---|
| `connection.update` | `{ connection?, lastDisconnect?, qr?, pairingCode?, isNewLogin? }` |
| `creds.update` | `Record<string, unknown>` — persist with `saveCreds` |
| `messages.upsert` | `{ type: "notify" \| "append", messages: [{ key, message?, messageTimestamp?, pushName?, newsletterServerId? }] }` |
| `messages.media` | `{ key, message, media?: { data, type, mimetype? }, error? }` — only with `autoDownloadMedia: true` |
| `messages.receipt` | `{ key, receipt: "delivery" \| "read" \| "played" }` |
| `messages.reaction` | `{ key, reaction: { text?, senderTimestampMs?, key } }` |
| `messages.delete` | `{ keys: MessageKey[] }` |
| `messages.update` | `[{ key, update: { message?, editedTimestamp?, starred? } }]` (edits, stars) |
| `presence.update` | `{ id, presences: Record<jid, PresenceData> }` |
| `contacts.update` | `ContactUpdate[]` — pfp / about / name changed |
| `contacts.upsert` | `[{ id, name?, notify? }]` — new/renamed from app-state |
| `chats.update` | `[{ id, …mute/pin/archive/unreadCount }]` |
| `chats.delete` | `string[]` |
| `labels.edit` | `{ id, name?, color?, deleted?, predefinedId? }` |
| `labels.association` | `{ type: "add" \| "remove", labelId, chatId?, messageId? }` |
| `groups.update` | `[{ id, …subject/desc/announce/restrict }]` |
| `group-participants.update` | `{ id, author, participants, action }` |
| `poll.update` | `{ key, pollUpdateMessageKey, vote, senderTimestampMs }` — decrypt with `readPollVote` |
| `call` | `WACall[]` |
| `blocklist.update` | `{ blocklist, action?: "add" \| "remove" }` |
| `node.recv` / `node.send` | raw `BinaryNode` — every stanza in / out |

---

## Auth state

| factory | what |
|---|---|
| `fileAuthState(path, opts?)` | encrypted append-only log on disk (`node:fs`). Compacts itself. Key file sits next to `path` (`.owl.key`) |
| `memoryAuthState()` | in-memory — for tests or ephemeral bots |

Both expose `{ creds, keys, saveCreds }` shaped as `AuthenticationState`.
