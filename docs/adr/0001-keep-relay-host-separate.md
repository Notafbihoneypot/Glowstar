# 0001. Keep the relay hostname separate from the Glowstr site

Status: Accepted  
Date: 2026-11-24  
Context: Public site, NIP-05 identity, paid relay, Monero checkout

## Decision

Use `glowstr.net` for the project site and NIP-05 lookups. Keep the existing paid relay and commerce API on `notafbihoneypotrelay.com`. This decision does not enable name sales or decide whether to host a browser client.

## Why

NIP-05 resolves aliases at the exact domain in the alias. NIP-42 authentication binds to the relay URL, and released Android clients already point to the existing relay and checkout host. Adding the identity domain independently avoids making existing users change relay URLs or re-authenticate during launch.

## Alternatives considered

Moving relay and checkout under `glowstr.net` would unify branding but would require a client release and a migration for existing members. There is no launch requirement that needs that move.

## Consequences

- Security: The hostnames are separate, but sharing the same VPS does not isolate them from host failure or compromise.
- Speed: The relay and checkout request paths stay unchanged. NIP-05 uses its own apex HTTPS endpoint.
- Simplicity: Two hostnames need DNS and TLS upkeep; the existing relay and commerce configuration remain canonical for clients.

## Revisit when

The existing relay hostname must be retired, or there is a documented need to move it with tested compatibility and rollback for existing clients and members.
