# Sharing models across machines

Plan for letting LocalPilot use other people's computers, on the same home network or in a group across the
internet, with no setup beyond installing the app and entering a code. Nothing here is built yet.

## Roles

- **Host:** the machine you chat on.
- **Helper:** any machine running LocalPilot with *Share this computer* on. It offers a whole model, memory for a
  pooled model, or both.
- **Browser:** a phone or laptop using the Host's interface from a web page (last phase).

One app plays every role. Model servers (`llama-server`, `rpc-server`) only ever listen on `127.0.0.1`; everything
between machines goes through LocalPilot's own encrypted connection between paired devices.

## Two ways to share

**Remote engines (the main way).** A helper runs a complete model and LocalPilot sends it whole requests. Only text
crosses the network, so it runs at the helper's full speed anywhere. A group of five is five machines that can each
serve a request at the same time.

- *Routing:* a group appears in the model picker as "<group> · best available". Each request goes to a machine that
  has the model, is free, and is closest.
- *A chat stays on one machine* while it's available, because that machine holds the chat's processed prompt.
  If it leaves mid-chat, the chat moves and the prompt is processed again once.
- *Owners first:* a helper stops taking group work while its owner is using it.
- *Background jobs* (journal summaries, source checks, model comparisons) can run on idle group machines.
- *Big models where they fit:* whoever has the most memory hosts the big model; Auto effort can step up to it.

**Pooled models (one model split across machines, llama.cpp RPC).** For models too big for any one machine.

- *On a home network* (about 1 ms per link) this is fast and is the normal case.
- *Over the internet* it works at roughly reading speed at best: every token passes through each machine in turn,
  about 170 ms per token across five machines with direct links, more through the relay. Long prompts are worse:
  each link carries roughly 20 KB per prompt token for a 27B model, so a 10,000-token prompt is about 200 MB per link
  on home upload speeds. One machine dropping out stops the model for everyone.
- So the app allows it, but:
  - measures the links before loading and shows an estimate ("about 5 tok/s, first reply after long prompts about
    1 minute");
  - picks the fewest machines that can hold the model;
  - starts internet-pooled models on Low effort (no thinking);
  - lists them next to the single-machine options with their speeds.
- A home pool can be shared with a group as a single remote engine, so the slow links stay inside one house.

Before building internet pooling, measure it: split a small model between this Mac and the droplet (CPU
`rpc-server` through an SSH tunnel) and record time per token and time to first reply.

## Connecting

**Same network.** Machines announce themselves with Bonjour (`_localpilot._tcp`). Pairing uses a 6-digit code shown
on the helper for 5 minutes; after that they reconnect on their own. *Add by address* covers networks that block
discovery. Paired machines on the same network always talk directly, even if they also share a group.

**Remote groups, through the droplet relay.**

1. On first launch the app makes a key pair (stored with Electron `safeStorage`, i.e. the Keychain). The public key
   is the device's identity; there are no accounts or passwords. The name comes from the computer's name.
2. While in a group, the app keeps one outgoing WebSocket to `wss://relay.<domain>` on port 443, reconnecting after
   sleep or network changes. No port forwarding or router changes.
3. *Invite* creates a single-use code (`LP-7Q4K-92`, 24 hours). The other person enters it under *Join a group* and
   an existing member approves.
4. To reach a machine, the app asks the relay; the relay checks both are in the same group and pipes the two
   connections together. The apps encrypt end to end with their own keys inside that pipe, so the relay only
   forwards bytes it can't read.
5. Later: direct connections across the internet (WebRTC, with the droplet helping the two sides find each other),
   keeping the relay as fallback.

**The relay on the droplet** (one-time setup by the group owner, not users):

- A subdomain pointing at the droplet, and a small Node service (WebSocket + SQLite) in its own container behind
  the reverse proxy that already serves the site on 443, with a Let's Encrypt certificate.
- It stores only group membership: member public keys and device names.
- Per-device limits on connections and bandwidth; rate limits on invites and joins.
- The relay address is built into the app.
- If the relay is down, same-network connections keep working and the app says the group can't be reached.

## Interface

- **Sidebar:** a *Connect* button next to *Memory & skills*, with the number of machines online.
- **Connect panel:**
  - *Share this computer:* on/off; what to share (models, memory for pooled models); a memory limit; only when idle;
    the pairing code while sharing is on.
  - *On this network:* discovered machines with what they offer and their latency; *Pair*; *Add by address*.
  - *Remote group:* members with status, model and latency; *Invite*, *Join a group*, *Leave*.
  - A one-line note that prompts go to the machine running the model.
- **Model picker:** grouped by where models run: *This Mac*, *On this network*, each group, *Pooled*. Pooled and
  remote entries show expected speed.
- **Top bar:** "Running on <machine>" whenever prompts go to someone else's machine.

## Phases

| Phase | Delivers | Size |
|---|---|---|
| 0 | Installable app: bundled llama.cpp (one pinned version, RPC on, Ventura patch), built-in model downloads for helpers, signed installers and auto-update, an engine list in place of `API`/`ENGINE_API` | L |
| 1 | Gateway, device keys, pairing, Bonjour; Connect panel with the *Share* and *On this network* sections | M |
| 2 | Remote engines on the home network: routing, chats staying on one machine, failover, owners first, background jobs on idle machines | M |
| 3 | Relay on the droplet and remote groups: invites, approvals, end-to-end encryption | L |
| 4 | Pooled models: home network first, then internet pooling with link measurement and estimates (after the droplet test) | M–L |
| 5 | Browser access to the interface over WebSocket, with pairing, Manual mode by default and a log of commands run from the web | L |

Code that changes first:

- `main.js:14`, `main.js:20`, `main.js:410`: `API` / `ENGINE_API` and the choice between them become a list of
  engines `{ id, kind: lmstudio | llamacpp | remote, baseUrl, headers, supportsSlots }`.
- `main.js:18`: `LLAMA_SERVER` points at the bundled build, falling back to `~/llama.cpp` in development.
- `main.js:271` (`startEngine`): `--rpc` and `-ts` for pooled models.
- `main.js:493`: slot save/restore only for the local engine.
- `main.js:159` (`send`) and the `ipcMain.handle` calls: shared with the WebSocket in phase 5.

## Security

- Model servers never listen beyond `127.0.0.1`; `rpc-server` in particular has no authentication.
- Only paired devices or group members can connect, and any device can be revoked.
- Whoever runs a remote engine sees the prompt (messages, files read, web results) and controls the text that
  drives tool calls. Connect only machines you trust; the top bar always says where a chat is running.
- Every machine runs the same signed build and llama.cpp version; connections with a different version are refused.

## Open decisions

1. The relay's subdomain, and which reverse proxy serves the droplet's site on 443.
2. Helper platforms: Macs only at first, or Windows and Linux too (each adds a llama.cpp build).
3. An Apple Developer account for signing and notarization; without it, first launch shows a blocking warning.
