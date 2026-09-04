# Changelog

All notable changes to `oniwalib`. Dates are UTC. The public surface is
`openWhatsApp(...)` → `OniConnection` (see [`docs/API.md`](docs/API.md)) plus the
named exports from `oniwalib`.

Versioning: while `0.x`, minor-version bumps may carry breaking changes; they'll
be called out here and announced on the
[official channel](https://whatsapp.com/channel/0029Vb93Ug3LI8YRuoroJd44).

## [Unreleased]

### Added
- **Live connection on bun / node** — `openWhatsApp` pairs (QR + code), logs in,
  survives `515` restart, keeps alive, and drives the full message / presence /
  notification / call pipeline. A reference bot runs against a live account.
- **Messaging** — `sendText` / `sendMessage` / `sendAlbum`, `editMessage`,
  `deleteMessage` (for everyone), `sendReaction`, `sendPoll` + `readPollVote`,
  `sendContact`, `sendLocation`; `SendOptions` (`quoted`, `mentions`,
  `ephemeralExpiration`, `forwarded`, `linkPreview`).
- **Media** — send audio / image / video / document / sticker with auto
  width/height + embedded thumbnail; `downloadMedia`; `autoDownloadMedia`
  option → `messages.media` event.
- **Status** — `postStatus` (`status@broadcast` sender-key fan-out) and receive.
- **Groups & communities** — `groupMetadata` / `groupParticipants` plus full
  management (create, leave, subject, description, participants add/remove/
  promote/demote, settings, ephemeral, join-approval mode, member-add mode,
  invite code / revoke / accept / info, join-request list / approve / reject);
  `communitySubGroups` / `communityLinkSubgroups` / `communityUnlinkSubgroup`.
- **App-state (LT-hash) sync** — `updateProfileName`, `chatModify` (mute / pin /
  archive / mark read), `addChatLabel` / `removeChatLabel`, `resyncAppState`,
  `appStateReady`; auto key-capture off `messages.upsert` and resync on
  `server_sync`. LT-hash and key expansion cross-checked byte-for-byte against
  `whatsapp-rust-bridge`.
- **History sync** — `messaging-history.set` (chats, pushnames, LID↔PN map, and
  message bodies with `historyMessages: true`).
- **Channels (`@newsletter`)** — `newsletterMetadata`, follow / unfollow, mute /
  unmute, create, delete, `newsletterReactMessage`, `newsletterFetchMessages`,
  `subscribeNewsletterUpdates`; text + media send.
- **Contacts / presence** — `onWhatsApp`, `getProfilePictureUrl`, `fetchStatus`,
  `getDeviceList`, `lidToPn`, `noteContact` / `knownContacts`, presence send +
  subscribe, `readMessages` / `sendReceipt`, `markOnlineOnConnect` /
  `sendReadReceipts` options.
- **Privacy** — `fetchPrivacySettings` / `updatePrivacySetting`.
- **Blocklist** — `fetchBlocklist`, `updateBlockStatus`; `blocklist.update`.
- **Calls** — incoming `call` event + `rejectCall` (no WebRTC).
- **Business (read)** — `getBusinessProfile`, `getCatalog`, `getCollections`,
  `getOrderDetails`.
- **`makeInMemoryStore`** — binds to the event surface, keeps chats / contacts /
  messages / presence / group metadata / labels / poll votes; `toJSON` /
  `fromJSON`.
- **Events** — `messages.upsert` / `.media` / `.receipt` / `.reaction` /
  `.delete` / `.update`, `presence.update`, `contacts.update` / `.upsert`,
  `chats.update` / `.delete`, `labels.edit` / `.association`, `groups.update`,
  `group-participants.update`, `poll.update`, `call`, `blocklist.update`,
  `messaging-history.set`, `node.recv` / `node.send`.
- **RTS** — `crypto` closed on the engine (XEdDSA, X25519, `inflate`);
  `RTS_GAPS` empty. Three engine bugs found while porting, filed, and **fixed
  upstream**: `#2611` (module-graph AOT), `#2612` (regex `[`), `#2617`
  (const-arrow-over-param miscompile). `rts compile src/index.ts` now produces a
  native ELF binary that runs the crypto / codec / Signal / store paths. Left:
  the RTS TLS/WS transport connector for a binary that connects live, and
  `node_modules` bare-specifier resolution (`#2625`) for `import "oniwalib"`.

### Packaging
- Cross-runtime `exports`: **bun** and **RTS** resolve `import "oniwalib"` to
  `src/index.ts` (TypeScript, no build); **node** resolves to `dist/index.js` — a
  single bundled ESM file (`bun run build`, run automatically on `prepack`) with
  `node:*` external and everything else (incl. `curve25519-js`) inlined.
- `files` whitelist — the tarball is `src` + `dist` + `docs` + metadata (~260 KiB,
  was ~1.7 MB); tests / examples / scripts / the banner no longer ship.
- `npm run smoke` — packs the library and imports it by package name from a clean
  consumer under node and bun; the deploy gate.

### Fixed
- Pre-key upload loop that walked `nextPreKeyId` into the thousands and froze the
  bot — now a `<count>` check + low-watermark + rate limit.
- App-state `SyncActionValue` field numbers for archive / delete-message-for-me /
  mark-read / delete-chat (were `14/15/17/19`, corrected to `17/18/20/22`;
  `14/15` are label edit / association).

## [0.1.0] — 2026-09

- Foundation: transport, Noise XX handshake, WABinary codec, own protobuf codec,
  auth state (memory + encrypted file), MD pairing (QR + code), protocol-version
  resolver (`oni-version.json`), Signal 1:1 + group cipher, pre-keys. Suite green
  on bun and (bar the live socket) on RTS.
