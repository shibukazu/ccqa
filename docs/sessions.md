# Saved sessions (`session:`)

This is the detail page for the `session:` restore feature used by [live specs](./live.md).

By default each `ccqa run` of a live spec starts signed-out and logs in through its own steps. That's fine for plain form logins, but some providers gate every fresh browser with a device-trust check (an "unrecognized device" e-mail code, an MFA prompt) that a human has to clear by hand — impractical to repeat on every run, impossible in CI.

For those, save the signed-in browser state once and let the spec **restore** it. ccqa does not manage authentication — `session` is purely an optional restore of cookies + localStorage. Specs that can just log in normally don't use it.

```yaml
title: Admin can open the settings page
mode: live
session: admin            # restore the saved "admin" session before step 1
steps:
  - ...                   # no login steps — the spec starts signed-in
```

A spec can also restore several sessions at once (e.g. one provider in each), and ccqa merges them:

```yaml
session:
  - admin                 # one provider, signed in as admin
  - admin-chat            # another provider, same person
```

## Create a session — `ccqa session bootstrap`

```bash
# Opens a headed browser. Log in by hand (clear any device-trust gate),
# then press Enter and ccqa uploads the session to the hub.
ccqa session bootstrap admin --url https://app.example.com/login --hub-url <url> --hub-token <token>

# List sessions stored on the hub (names + last-updated times; no secret values shown).
ccqa hub session ls
```

`bootstrap` requires a hub connection (`--hub-url`/`--hub-token`, or `CCQA_HUB_URL`/`CCQA_HUB_TOKEN`) — it uploads the saved cookies + localStorage straight to the hub (encrypted at rest) and never writes them to disk locally. The `--profile` you pass (default `default`) is the same one `--profile` selects for environment variables, so one flag picks both the environment and its sessions bucket. At run time, a spec's `session:` restore fetches the named session(s) from the hub for the resolved project/profile — see [Hub](./hub.md) for how the project is resolved.

When a spec names a session that hasn't been created yet, the run stops and tells you which `ccqa session bootstrap` to run, rather than starting unauthenticated.

Notes:

- **Expiry.** The provider's "remember this device" window eventually lapses and the saved cookies stop working. Re-run `ccqa session bootstrap` and it overwrites the hub copy.
- **Treat sessions as credentials.** They hold live auth cookies. The hub encrypts them at rest; anyone holding `CCQA_HUB_TOKEN` can still read them back (see [Security](./hub.md#security)).
- **Deterministic specs ignore `session:`.** It only affects `mode: live`; vitest-replayed specs always run isolated.
