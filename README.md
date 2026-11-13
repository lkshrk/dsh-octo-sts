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

For repositories under several GitHub owners, list one entry per owner under `owners` instead. Each owner gets its own token, exchanged with its own scope and identity:

```yaml
- id: dsh-octo-sts
  disabled: false
  config:
    owners:
      - scope: acme
        identity: dsh-yawn
        workspaces:
          - https://github.com/acme/widgets
          - https://github.com/acme/gadgets
        tokenFile: /run/dsh-octo-sts/acme.token
      - scope: globex
        identity: dsh-yawn
        workspaces:
          - https://github.com/globex/app
        tokenFile: /run/dsh-octo-sts/globex.token
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
Shared by every owner:

| Key | Default | Meaning |
| --- | --- | --- |
| `sts` | `https://sts.h-cloud.io` | octo-sts server root: https, no credentials, path, query or fragment. Redirects are refused |
| `identityTokenFile` | `/var/run/secrets/octo-sts/token` | The projected service account token, read fresh on every exchange |
| `refreshMinutes` | `30` | Exchange interval, 5 to 45 minutes, counted from the moment each exchange starts |
| `registerWorkspaces` | `true` | Register a listed Workspace in dsh-yawn when it is not registered yet; it then shows up in the Web UI |
| `secretName` | `GITHUB_TOKEN` | Name of the workspace secret |
| `owners` | none | List of owners, each with the keys below. Leave it out to configure a single owner with those keys at the top level |

Per owner, either at the top level or in each `owners` entry, never both:

| Key | Default | Meaning |
| --- | --- | --- |
| `scope` | required | octo-sts scope: an organization or `owner/repo` |
| `identity` | required | Trust policy name: octo-sts reads `.github/chainguard/<identity>.sts.yaml` in the scope's policy repository |
| `workspaces` | `[]` | https repository URLs, without credentials, of the dsh-yawn Workspaces that receive the token as a workspace secret |
| `tokenFile` | none | Absolute path the token is also written to: created with mode 0600 under a random temporary name, then renamed over the old file. A missing parent directory is created with mode 0700 |

Each owner needs at least one of `workspaces` and `tokenFile`. Unknown keys are refused, and so is a top-level `scope`, `identity`, `workspaces` or `tokenFile` next to `owners`. In `owners`, the configuration is also refused when:

- a workspace is not `https://github.com/<owner>/<repository>` with `<owner>` the first part of its owner's `scope`, or the repository itself when the scope is `owner/repo` (compared case-insensitively);
- two owners name the same token file, the same workspace, or the same scope and identity.

A wrapper around `gh` can read the token file per call:

```sh
#!/bin/sh
GH_TOKEN="$(cat /run/dsh-octo-sts/github.token)" || exit 1
export GH_TOKEN
exec gh "$@"
```

The file appears after the first exchange, a few seconds after dsh starts. A wrapper used at startup should wait for it.

With several owners, name each token file after its owner and let the wrapper pick it from the target repository: `--repo`/`-R`, then `GH_REPO`, then the `origin` remote of the current directory. It accepts `OWNER/REPO`, `HOST/OWNER/REPO` and https or ssh remote URLs.

```sh
#!/bin/sh
repo="${GH_REPO:-}"
previous=
for arg in "$@"; do
  case "$previous" in -R|--repo) repo="$arg" ;; esac
  case "$arg" in --repo=*) repo="${arg#--repo=}" ;; esac
  previous="$arg"
done
[ -n "$repo" ] || repo="$(git remote get-url origin 2>/dev/null)"
owner="$(printf '%s\n' "$repo" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^/]+/##; s#^[^/@:]+@[^/:]+:##; s#^[^/]+/([^/]+/[^/]+)$#\1#; s#/.*##')"
case "$owner" in ''|*[!A-Za-z0-9_.-]*) echo "gh: cannot tell the repository owner" >&2; exit 1 ;; esac
GH_TOKEN="$(cat "/run/dsh-octo-sts/$owner.token")" || exit 1
export GH_TOKEN
exec gh "$@"
```

`gh api` calls without a repository context need `GH_REPO` set.

## Behaviour

- **Owners.** Each owner runs its own loop: its own exchange, schedule, backoff, destinations and log lines (named `<scope>/<identity>`). A failing owner never delays or touches another owner's tokens.
- **Exchange.** The first exchange runs as soon as the plugin starts, then every `refreshMinutes`. Each one reads the identity token file and calls `GET <sts>/sts/exchange?scope=<scope>&identity=<identity>` with `Authorization: Bearer <identity token>`.
- **Destinations.** The token file and each workspace are separate destinations. A new token goes to every destination; a destination that already holds the current token is not written again.
- **Workspace registration.** dsh-yawn only stores secrets for Workspaces it has registered. With `registerWorkspaces` on, the list in the plugin's configuration is all that is needed, so it stays in Git: the plugin sets the secret first and only when dsh-yawn answers `workspace is not registered` does it register the Workspace through `sandboxManager.createRepositoryWorkspace`, the call the Web UI makes when a repository is opened, then set the secret again. A registered Workspace is never touched. Registration creates a Workspace that shows up in the Web UI; set `registerWorkspaces: false` to avoid that and register Workspaces by hand. One registration per Workspace runs at a time, with a 5 minute limit; a slow one is waited for, not started again. Without the dsh Web profile (`repository workspaces require the dsh Web profile`) or without that method, the Workspace gets a warning and is tried again at the next exchange; the other destinations still get the token.
- **Delivery to sandboxes.** dsh-yawn re-reads its secret store before every sandbox command, so running and new sandboxes get the new token at their next command without a restart. A single command that runs past the token's expiry keeps the old value.
- **Failures.** Nothing is ever removed: every destination keeps its last token, which stays valid until its hour is up.
  - A failed exchange is retried after 1, 2 and 4 minutes, then every 5 minutes.
  - A destination that could not be written gets the same token again on that backoff, without a new exchange. The others keep their schedule.
  - With `registerWorkspaces` off, a Workspace dsh-yawn does not know is not retried until the next exchange. The plugin recognises it by dsh-yawn's error text `workspace is not registered`, checked against dsh-yawn 2026.11.12-1090505.
- **Logs.** Successful exchanges log at info. A failure logs a warning naming the failed exchange or destinations while any destination still holds a valid token, and an error once none does. Token values are never logged; any that appear in an error message are replaced with `[redacted]`. The logs are the plugin's only health report.
- **Clock and leftovers.** Scheduling uses the monotonic clock, so a wall-clock change does not trigger or delay an exchange. On start, leftover `<tokenFile>.<random>.tmp` files from an interrupted write are removed.
- **Errors never escape.** dsh ends its process on an unhandled rejection, so every failure stays inside the loop. Disposing the plugin stops the timer, waits for a round in flight and does not deliver its token.

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
- **Undocumented API.** The plugin uses dsh-yawn's `sandboxManager.createRepositoryWorkspace` and `sandboxManager.setWorkspaceSecret`, public methods of its Cordis service but not a documented plugin API. They were checked against dsh-yawn 2026.11.12-1090505; check them again when upgrading dsh-yawn.
- **One token per owner.** Every workspace of an owner gets the same token, so the owner's trust policy has to cover all of them.

## Development

```sh
pnpm install
pnpm check
```

Tests stub `fetch` and the secret store; they never call octo-sts.
