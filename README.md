# dsh-octo-sts

A dsh plugin for a [dsh-yawn](https://github.com/zhming0/dsh-yawn) control plane that keeps a short-lived GitHub token from [octo-sts](https://github.com/octo-sts/app) up to date. It exchanges the pod's projected Kubernetes service account token for a GitHub App installation token, stores that token as a workspace secret for the sandboxes, and writes it to a file the control plane's own `gh` can read. No long-lived GitHub credential is needed anywhere.

## Install

```sh
dsh plugin --profile <profile> add "github:lkshrk/dsh-octo-sts#<commit>"
```

pnpm builds a Git install through the `prepare` script and blocks it until allowed: add the key pnpm prints, `dsh-octo-sts@https://codeload.github.com/lkshrk/dsh-octo-sts/tar.gz/<commit>: true`, under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then run the command again.

The bundle inserts the plugin disabled. Enable and configure it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-octo-sts
  disabled: false
  config:
    scope: acme
    identity: dsh-yawn
    workspaces:
      - https://github.com/acme/widgets
    tokenFile: /run/dsh-octo-sts/github.token
```

It runs in the control-plane process only, never in sandboxes.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `sts` | `https://sts.h-cloud.io` | Base URL of the octo-sts instance (https only) |
| `scope` | required | octo-sts scope: an organization or `owner/repo` |
| `identity` | required | Trust policy name: octo-sts reads `.github/chainguard/<identity>.sts.yaml` in the scope's policy repository |
| `identityTokenFile` | `/var/run/secrets/octo-sts/token` | The projected service account token, read fresh on every exchange |
| `refreshMinutes` | `30` | Exchange interval, 5 to 55 minutes |
| `workspaces` | `[]` | Repository URLs of registered dsh-yawn Workspaces that receive the token as a workspace secret |
| `secretName` | `GITHUB_TOKEN` | Name of that workspace secret |
| `tokenFile` | none | Absolute path the token is also written to, mode 0600, replaced atomically |

At least one of `workspaces` and `tokenFile` must be set. Unknown keys are refused.

A wrapper around `gh` can read the token file per call:

```sh
#!/bin/sh
GH_TOKEN="$(cat /run/dsh-octo-sts/github.token)" || exit 1
export GH_TOKEN
exec gh "$@"
```

The file appears after the first exchange, a few seconds after dsh starts. A wrapper used at startup should wait for it.

## Behaviour

- **Rounds.** The first exchange runs as soon as the plugin starts, then every `refreshMinutes`. Each round reads the identity token file, calls `GET <sts>/sts/exchange?scope=<scope>&identity=<identity>` with `Authorization: Bearer <identity token>`, writes the token file and then sets the secret on each workspace.
- **Delivery to sandboxes.** dsh-yawn re-reads its secret store before every sandbox command, so running and new sandboxes get the new token at their next command without a restart. A single command that runs past the token's expiry keeps the old value.
- **Failures.** A failed round keeps the previous token where it is; it stays valid until its hour is up. The plugin retries after 1, 2 and 4 minutes, then every 5 minutes, until a round succeeds. A round that wrote the file but could not set a workspace secret counts as failed and is retried as a whole.
- **Logs.** One line per round: info on success, a warning while the previous token is still valid, an error once it has expired. Token values are never logged; any that appear in an error message are replaced with `[redacted]`.
- **Errors never escape.** dsh ends its process on an unhandled rejection, so every failure stays inside the loop. Disposing the plugin stops the timer and waits for a round in flight.

## Trust policy

The token's permissions and repositories come from the trust policy in the scope's organization, `.github/chainguard/<identity>.sts.yaml` in its `.github` repository. The issuer has to be listed in that organization's `.github/chainguard/trusted-token-issuers.yaml`. For a Kubernetes service account token:

```yaml
issuer: https://<kubernetes API server issuer>
subject: system:serviceaccount:<namespace>:<control-plane service account>
audience: <the projected token's audience, usually the octo-sts domain>
permissions:
  contents: write
  pull_requests: write
  issues: write
  checks: read
  statuses: read
  actions: read
repositories:
  - widgets
```

octo-sts must be able to fetch the issuer's discovery document and JWKS anonymously over https, and trust its certificate. The control-plane pod mounts the token as a projected volume with that audience:

```yaml
volumes:
  - name: octo-sts-token
    projected:
      sources:
        - serviceAccountToken:
            path: token
            audience: sts.example.com
            expirationSeconds: 3600
```

The kubelet rotates the token file before it expires; the plugin reads it on every round.

## Limits

- **Sandboxes can read the token.** dsh-yawn hands workspace secrets to every command in that Workspace's sandboxes as environment variables. The gain over a personal access token is the lifetime (one hour) and the scope (the policy's repositories and permissions). Keep the policy to the repositories the sandboxes work on.
- **One hour.** GitHub installation tokens last 60 minutes and cannot be extended. If octo-sts stays unreachable for longer than that, GitHub calls fail with 401 until the next successful round.
- **Undocumented write API.** The secret is set through dsh-yawn's `sandboxManager.setWorkspaceSecret`, a public method of its Cordis service but not a documented plugin API. It was checked against dsh-yawn 2026.11.12-1090505; check it again when upgrading dsh-yawn. The Workspace has to be registered, or the round fails with `workspace is not registered`.
- **One scope and identity.** The plugin requests one token; every listed workspace gets the same one.

## Development

```sh
pnpm install
pnpm check
```

Tests stub `fetch` and the secret store; they never call octo-sts.
