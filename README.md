# dsh-octo-sts

A dsh plugin for a [dsh-yawn](https://github.com/zhming0/dsh-yawn) control plane. It keeps short-lived GitHub tokens from [octo-sts](https://github.com/octo-sts/app) up to date, so agents never need a personal access token (PAT).

The plugin exchanges the pod's projected Kubernetes service account token for a GitHub App installation token. It stores that token as a workspace secret for the sandboxes and can also write it to a file for the control plane's own `gh`. It refreshes the token on a schedule and registers missing Workspaces in dsh-yawn.

Why not a PAT:

- **Short lifetime.** An installation token lasts one hour. A leaked token stops working soon after.
- **Narrow scope.** The trust policy in GitHub decides which repositories and permissions the token gets.
- **No stored secret.** The only input is the service account token that Kubernetes mounts and rotates.

The plugin runs in the control-plane process only, never in sandboxes.

More detail:

- [docs/architecture.md](docs/architecture.md): components, token flow, scheduling and failure handling.
- [docs/configuration.md](docs/configuration.md): every configuration key and validation rule.
- [docs/trust-policies.md](docs/trust-policies.md): the octo-sts side, trust policies and the Kubernetes token.

## Requirements

- dsh `^0.2.1-alpha.2 || ^0.2.2-0` with a dsh-yawn control plane, and Node.js `^22.19.0 || >=24.0.0` (from `engines` in `package.json`).
- An octo-sts instance, reachable over https from the control plane. The default is `https://sts.h-cloud.io`; set `sts` for your own.
- The octo-sts GitHub App installed on each owner (organization or user) with access to the target repositories.
- A trust policy per owner that trusts the control plane's service account token. See [docs/trust-policies.md](docs/trust-policies.md).
- A projected service account token in the control-plane pod, with the audience your octo-sts expects. The default path is `/var/run/secrets/octo-sts/token`.
- For workspace registration: the dsh Web profile, which provides `sandboxManager.createRepositoryWorkspace`.

## Install

```sh
dsh plugin --profile <profile> add "github:lkshrk/dsh-octo-sts#<commit>"
```

pnpm builds a Git install through the `prepare` script and blocks it until allowed. Add the key pnpm prints, `dsh-octo-sts@https://codeload.github.com/lkshrk/dsh-octo-sts/tar.gz/<commit>: true`, under `allowBuilds` in the profile's `pnpm-workspace.yaml`. Then run the command again.

The bundle layer ([`cordis.patch.yml`](cordis.patch.yml)) inserts the plugin disabled. Enable and configure it in the profile's `cordis.patch.yml`.

## Configure

One owner:

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

Several owners: list one entry per owner under `owners`. Each owner gets its own token, exchanged with its own scope and identity.

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

### Configuration reference

Shared by every owner:

| Key | Default | Meaning |
| --- | --- | --- |
| `sts` | `https://sts.h-cloud.io` | octo-sts server root: https, no credentials, path, query or fragment |
| `identityTokenFile` | `/var/run/secrets/octo-sts/token` | Absolute path of the projected service account token, read fresh on every exchange |
| `refreshMinutes` | `30` | Exchange interval in whole minutes, 5 to 45 |
| `registerWorkspaces` | `true` | Register a listed Workspace in dsh-yawn when it is not registered yet |
| `secretName` | `GITHUB_TOKEN` | Name of the workspace secret, an environment variable name |
| `owners` | none | List of owners with the keys below. Leave it out to set those keys at the top level |

Per owner, either at the top level or in each `owners` entry, never both:

| Key | Default | Meaning |
| --- | --- | --- |
| `scope` | required | octo-sts scope: `<owner>` (`acme`) or `<owner>/<repository>` (`acme/widgets`) |
| `identity` | required | Trust policy name: octo-sts reads `.github/chainguard/<identity>.sts.yaml` |
| `workspaces` | `[]` | `https://github.com/<owner>/<repository>` URLs of the Workspaces that get the token as a secret |
| `tokenFile` | none | Absolute path the token is also written to |

Each owner needs at least one of `workspaces` and `tokenFile`. Every workspace has to belong to the owner of its scope. Unknown keys are refused. The full rules are in [docs/configuration.md](docs/configuration.md).

Since the `owners` form was added, the top-level form checks workspaces against the scope too.

## Token lifecycle

Each owner runs its own loop. A failing owner never delays or touches another owner's tokens.

1. **Exchange.** The first exchange runs as soon as the plugin starts, then every `refreshMinutes`. The plugin reads the identity token file and calls `GET <sts>/sts/exchange?scope=<scope>&identity=<identity>` with `Authorization: Bearer <identity token>`.
2. **Delivery.** The token file and each workspace are separate destinations. A new token goes to every destination at the same time, so a hung destination does not hold up the others. A destination that already holds the current token is not written again.
3. **Workspace registration.** dsh-yawn only stores secrets for Workspaces it has registered. The plugin sets the secret first. Only when dsh-yawn answers `workspace is not registered` does it register the Workspace through `sandboxManager.createRepositoryWorkspace`, then set the secret again. It never re-registers a Workspace that dsh-yawn already knows. Set `registerWorkspaces: false` to register Workspaces by hand instead, for example to keep dsh-yawn's Workspace list under manual control.
4. **Use in sandboxes.** The plugin stores the token under `secretName` (default `GITHUB_TOKEN`). How sandboxes receive workspace secrets is up to dsh-yawn, which passes them to sandbox commands as environment variables.
5. **Repair.** Between exchanges, a check runs about once a minute while nothing is backing off. A token file that was deleted, or a Workspace whose sandboxManager instance was replaced, gets the current token again without a new exchange, as long as that token is younger than one hour.
6. **Failure.** Nothing is ever removed. Every destination keeps its last token, which stays valid until its hour is up. A failed exchange is retried after 1, 2 and 4 minutes, then every 5 minutes. A `429` waits at least its `Retry-After`, up to `refreshMinutes`. Any other `4xx` refusal is retried after `refreshMinutes`, because the same request would be refused again.

The token's repositories and permissions come from the trust policy, not from this plugin. See [docs/architecture.md](docs/architecture.md) for the full schedule, timeouts and logs.

## The gh wrapper

The control plane's `gh` can read a token file per call. With one owner, a wrapper can be this short:

```sh
#!/bin/sh
file=/run/dsh-octo-sts/github.token
GH_TOKEN="$(cat "$file")" || exit 1
case "$GH_TOKEN" in *[![:space:]]*) ;; *) echo "gh: $file is empty" >&2; exit 1 ;; esac
export GH_TOKEN
exec gh "$@"
```

The file appears after the first successful exchange, which starts as soon as the plugin starts. A wrapper used at startup should wait for it.

With several owners, name each token file `<owner>.token` after its owner in lower case (`/run/dsh-octo-sts/acme.token`). Then let a wrapper pick the file from the target repository. [`examples/gh-owner-token.sh`](examples/gh-owner-token.sh) does that. Install it under a name other than `gh`:

```sh
#!/bin/sh
tokens="${DSH_OCTO_STS_TOKENS:-/run/dsh-octo-sts}"
[ "${GH_HOST:-github.com}" = github.com ] || { echo "gh: GH_HOST $GH_HOST is not github.com" >&2; exit 1; }
repo="${GH_REPO:-}"
previous=
for arg in "$@"; do
  case "$previous" in -R|--repo) repo="$arg" ;; esac
  case "$arg" in
    --repo=*) repo="${arg#--repo=}" ;;
    -R?*) repo="${arg#-R}" ;;
  esac
  previous="$arg"
done
[ -n "$repo" ] || repo="$(git remote get-url origin 2>/dev/null)"
case "$repo" in
  *://*) rest="${repo#*://}"; host="${rest%%/*}"; path="${rest#"$host"}"; path="${path#/}" ;;
  *@*:*) host="${repo%%:*}"; path="${repo#*:}" ;;
  */*/*) host="${repo%%/*}"; path="${repo#*/}" ;;
  *) host=github.com; path="$repo" ;;
esac
host="${host##*@}"
host="$(printf '%s\n' "${host%%:*}" | tr '[:upper:]' '[:lower:]')"
owner="$(printf '%s\n' "${path%%/*}" | tr '[:upper:]' '[:lower:]')"
[ "$host" = github.com ] || { echo "gh: $host is not github.com" >&2; exit 1; }
case "$owner" in ''|.*|*[!a-z0-9_.-]*) echo "gh: cannot tell the repository owner" >&2; exit 1 ;; esac
GH_TOKEN="$(cat "$tokens/$owner.token")" || exit 1
case "$GH_TOKEN" in *[![:space:]]*) ;; *) echo "gh: $tokens/$owner.token is empty" >&2; exit 1 ;; esac
export GH_TOKEN
exec gh "$@"
```

How it picks the repository, first match wins:

1. `-R OWNER/REPO`, `-ROWNER/REPO`, `--repo OWNER/REPO` or `--repo=OWNER/REPO`.
2. `GH_REPO`.
3. The `origin` remote of the current directory.

It accepts `OWNER/REPO`, `HOST/OWNER/REPO` and https, ssh and scp-style remote URLs. It refuses a host other than `github.com`, a `GH_HOST` other than `github.com`, and an empty or whitespace-only token file (`gh: <file> is empty`). `DSH_OCTO_STS_TOKENS` overrides the token directory.

Limits of the wrapper:

- It never parses positional arguments: `gh repo view acme/x`, `gh repo clone acme/x`, PR or issue URLs and `gh api repos/acme/x/...` paths. Set `GH_REPO` for those calls.
- It picks by owner only. Use owner-wide scopes (`scope: acme`, not `acme/widgets`) when the wrapper serves several repositories of one owner: one token per owner has to cover every repository the wrapper may be called for.

## Troubleshooting

The logs are the plugin's only health report. Each line starts with `dsh-octo-sts: <scope>/<identity>`. Token values are never logged; any that appear in an error message are replaced with `[redacted]`.

| Log text | Meaning and fix |
| --- | --- |
| `token delivered to every destination; next exchange in N min` (info) | Healthy |
| `token delivered to every destination after N failed exchange(s); next exchange in N min` (info) | Recovered after failed exchanges |
| `token delivered again to <destinations>, which had lost it` (info) | A token file was deleted or the sandboxManager instance was replaced; the plugin repaired it |
| `exchange failed: <file> is empty` or `exchange failed: ENOENT ...` | The identity token file is empty or missing. Check the projected volume and `identityTokenFile` |
| `exchange failed: octo-sts answered <4xx>: <reason>` | octo-sts refused the exchange. Check the trust policy, the trusted issuers file and that the App is installed on the owner. See [docs/trust-policies.md](docs/trust-policies.md). Retried after `refreshMinutes` and logged once until the text or level changes; `408` and `429` are retried on the backoff instead |
| `exchange failed: octo-sts answered <5xx>: <reason>` | octo-sts or GitHub is failing. Retried on the backoff |
| `exchange failed: fetch failed: <cause>` | The request failed, for example `ECONNREFUSED` or a TLS error. Check that `sts` is reachable from the pod. Retried on the backoff |
| `exchange failed: octo-sts did not answer within 30 s` | octo-sts is unreachable or slow. Retried on the backoff |
| `exchange failed: octo-sts answered without a token` | The answer had no `token` field. Check that `sts` points at octo-sts |
| `<workspace>: the sandboxManager service is not available` | dsh-yawn's sandbox manager is not available yet. Retried on the backoff; the token file still gets the token |
| `<workspace> (retried at the next exchange): workspace is not registered` | `registerWorkspaces` is off and the Workspace is not registered. Register it, or turn registration on |
| `<workspace> (retried at the next exchange): could not register the workspace: ... require the dsh Web profile` | Registration needs the dsh Web profile. Enable it, or register the Workspace by hand |
| `<workspace> (retried at the next exchange): could not register the workspace: sandboxManager has no createRepositoryWorkspace` | This dsh-yawn version lacks the registration method. Register the Workspace by hand |
| `destinations keep their last token until it expires` (warn) | Something failed, but at least one destination still holds a token younger than one hour |
| `no destination holds a valid token` (error) | Every delivered token is older than one hour, or none was ever delivered. GitHub calls fail with 401 until the next successful round |
| `refresh failed: <error>` (error) | An unexpected error in the refresh round. The plugin keeps running and retries on the backoff. Report it with the log line |

Configuration errors stop the plugin from loading. The message names the key and the rule, for example `set scope and identity, or owners`, `must be <owner> or <owner>/<repository>` or `... does not belong to acme, the owner of scope acme`.

## Limits

- **Sandboxes can read the token.** A workspace secret is meant for the Workspace's sandboxes; dsh-yawn passes it to their commands as environment variables. The gain over a PAT is the lifetime (one hour) and the scope (the policy's repositories and permissions). Keep the policy to the repositories the sandboxes work on.
- **One hour.** GitHub installation tokens last 60 minutes and cannot be extended. If octo-sts stays unreachable for longer than that, GitHub calls fail with 401 until the next successful round.
- **One token per owner.** Every workspace of an owner gets the same token, so the owner's trust policy has to cover all of them.
- **Undocumented API.** The plugin uses dsh-yawn's `sandboxManager.createRepositoryWorkspace` and `sandboxManager.setWorkspaceSecret`. They are public methods of its Cordis service but not a documented plugin API. The plugin also matches dsh-yawn's error texts `workspace is not registered` and `require the dsh Web profile`. The tests stub all of this and pin the error texts as of dsh-yawn commit `f96f495`. Check the methods and texts against the dsh-yawn version you run, and again when upgrading it.

## Development

```sh
pnpm install
pnpm check
```

| Script | Runs |
| --- | --- |
| `pnpm build` | `tsdown`: bundles `src/index.ts` into `lib/` as ESM with type declarations |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | `vitest run` over `tests/**/*.spec.ts` |
| `pnpm check` | typecheck, test and build |

Tests stub `fetch` and the secret store; they never call octo-sts. `tests/wrapper.spec.ts` runs the gh wrapper against a fake `gh`, checks that this README shows the exact script from `examples/gh-owner-token.sh`, and runs shellcheck when it is installed. Edit both together.

## License

MIT. See [LICENSE](LICENSE).
