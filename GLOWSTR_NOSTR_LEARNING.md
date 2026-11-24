# Glowstr and Nostr: living notes

Keep this file current as Glowstr ships and Nostr implementations change. It records what we learned and why it matters to Glowstr, not a copy of the specs or a release log.

## How to update it

- Update it in the same change that ships a NIP feature, confirms an interoperability result, or changes a product or operating decision. Review it before each release.
- Record the date, exact build or commit, relevant NIP or implementation version, what was observed, and what should change as a result. Label claims **verified**, **decision**, or **open**. A local test is not a live deployment test.
- Keep the current rule visible. When a protocol or implementation changes, mark the old lesson superseded and point to the replacement. Use primary sources and reproducible checks; never record signing secrets, invoice tokens, or customer records.

## What we know

- **Verified — NIP-05 is an alias, not identity proof.** A client checks a profile's `nip05` field against the lower-case hex pubkey returned by the domain over HTTPS. The lookup must not redirect. Browser clients need CORS. Follow lists store public keys, not aliases; remapping a name does not migrate a user's followers. [NIP-05 specification](https://github.com/nostr-protocol/nips/blob/master/05.md).
- **Decision — one payment for `name@glowstr.net`.** No customer renewal fee while Glowstr operates the registry. This is not domain registration. Keep `glowstr.net` for public identity and `notafbihoneypotrelay.com` for the existing relay and checkout. See the [name launch checklist](docs/GLOWSTR_NET_NIP05.md) and [domain decision](docs/adr/0001-keep-relay-host-separate.md).
- **Verified in Chromium — Android 0.3.22 (`fc42069`).** With an isolated NIP-46 signer and relay, a note appears in Following after the first accepting relay response without waiting for an echo. Signer denial leaves the draft intact. This does not measure approval latency on a physical phone or with a live FROSTR quorum. See [FROSTR integration notes](docs/FROSTR.md), [NIP-01 relay messages](https://github.com/nostr-protocol/nips/blob/master/01.md), and [NIP-46 remote signing](https://github.com/nostr-protocol/nips/blob/master/46.md).

## Open checks

- **Names:** Bring up DNS and TLS, restore an off-host registry backup, then run a controlled two-confirmation purchase and resolve it in another Nostr client. Decide key-rotation policy before selling names.
- **Posting:** Measure tap → signature and signature → first accepting relay separately on Android with a real FROSTR quorum. Record the app version, signer version, network conditions, and timings.
