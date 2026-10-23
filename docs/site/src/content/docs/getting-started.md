---
title: Getting started
description: Install switchkick, run setup, and check it with doctor.
---

switchkick needs Node.js 22.18 or newer, or one of the [standalone builds](/switchkick/install/),
and an [OpenRouter](https://openrouter.ai) API key with some credit on the account.

```sh
npm install -g switchkick
switchkick setup
switchkick doctor --live
```

`npx switchkick setup` works too: the service it installs then runs this exact version through
npx.

## What setup does

`setup` asks for your OpenRouter key and shows what it will change before doing it:

1. **Key.** Stored in the macOS Keychain or, on Linux, the Secret Service (libsecret), under
   service `switchkick`, account `openrouter`. Where neither works (a server, a container), it goes
   in `~/.config/switchkick/env`, readable only by you. The key is passed on stdin, never as a
   command-line argument. A key that's already stored is kept.
2. **Config.** `~/.config/switchkick/config.yaml` in [local mode](/switchkick/routing/local/), with
   the `claude-only` preset when Claude Code is a client and `multi-provider` otherwise (see
   [presets](/switchkick/routing/static/#presets)). An existing config is left as it is.
3. **Service.** A launchd agent on macOS (`~/Library/LaunchAgents/io.github.eased-tech.switchkick.plist`,
   logging to `~/.local/state/switchkick/service.log`) or a systemd user unit on Linux
   (`~/.config/systemd/user/switchkick.service`, logging to the journal). It starts at login and
   restarts switchkick if it stops. Without a service manager, run `switchkick serve` yourself.
   systemd stops user services at logout unless you run `loginctl enable-linger`.
4. **Clients.** Each client found on the machine (or named with `--client codex,claude,openai`)
   is pointed at switchkick. See [clients](/switchkick/clients/) for exactly what changes.

`setup --yes` asks nothing, and takes the key from `OPENROUTER_API_KEY` if none is stored.

## Check it with doctor

`switchkick doctor` checks the config, the key (it says where it found it, never what it is),
that every configured model is on OpenRouter, the service, the client settings, and that the
proxy answers. It exits 1 if anything is wrong.

`--live` also asks Jev one question and sends a tiny request through the proxy at the frontier
tier for each client setup wired, with the output cap that client asks for. That's where a 402
from OpenRouter (credit, or the key's limit, too low for a request's worst case) shows up,
rather than in the middle of a session. Claude Code asks for up to
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Codex sets no cap, so OpenRouter prices each Codex request at the
model's full output limit, and a key with little credit left refuses them all. The checks cost a
fraction of a cent.

## Undo it

Before changing a client's file, setup saves its exact bytes. `switchkick uninstall` stops and
removes the service and puts every file back byte for byte, or deletes it if setup created it. If
you edited a file after setup, your version is kept next to it as `<file>.switchkick-uninstall`.
The config, the decision log and the stored key stay; `uninstall --purge` deletes them too.

## Run it by hand

Without setup, give switchkick the key and pick a tier:

```sh
OPENROUTER_API_KEY=sk-or-... switchkick serve --tier balanced
```

Instead of setting `OPENROUTER_API_KEY` each time, you can store the key once in the OS
credential store, which switchkick checks next:

```sh
security add-generic-password -s switchkick -a openrouter -w          # macOS Keychain
secret-tool store --label=switchkick service switchkick account openrouter   # Linux
```

Where neither exists, put `OPENROUTER_API_KEY=...` in `~/.config/switchkick/env` and
`chmod 600` it; switchkick refuses to read the file if other users can. At startup switchkick
says which source it used, never the key.

Then point a client at `http://127.0.0.1:8787`, as described in [clients](/switchkick/clients/).
