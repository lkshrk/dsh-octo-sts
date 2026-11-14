# Configuration

The plugin's configuration is the `config` block of its row in the profile's `cordis.patch.yml`. [`src/config.ts`](../src/config.ts) defines it as a zod schema, exported as `Config`, which Cordis validates on load. An invalid configuration stops the plugin from loading; the error names the key and the rule.

Leading and trailing whitespace is trimmed from `scope`, `identity`, `identityTokenFile` and `tokenFile` (zod `.trim()`), and from `sts` and each workspace (zod 4.4.3's `z.url()` trims its input). `secretName` is not trimmed: a value with surrounding whitespace is refused.

## Two forms

**Single owner.** Set `scope`, `identity`, `workspaces` and `tokenFile` at the top level.

**Several owners.** Set `owners` to a list with at least one entry. Each entry holds `scope`, `identity`, `workspaces` and `tokenFile`. The top-level keys `scope`, `identity`, `workspaces` and `tokenFile` are then refused (`set <key> inside owners, not next to it`).

Both forms produce the same thing internally: one owner per entry, each combined with the shared keys (`ownerSettings` in `src/config.ts`). Each owner runs its own refresh loop.

## Shared keys

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `sts` | string | `https://sts.h-cloud.io` | octo-sts server root. The exchange goes to `<sts>/sts/exchange` |
| `identityTokenFile` | string | `/var/run/secrets/octo-sts/token` | The service account token sent as the bearer token |
| `refreshMinutes` | integer | `30` | Time between exchanges |
| `registerWorkspaces` | boolean | `true` | Register an unregistered Workspace before setting its secret |
| `secretName` | string | `GITHUB_TOKEN` | Name of the workspace secret in dsh-yawn |
| `owners` | list | none | Owners for the multi-owner form |

Rules:

- `sts` must be an `https` URL without a username or password, and must be the server root: no path other than `/`, no query, no fragment. The exchange refuses redirects.
- `identityTokenFile` must be an absolute path. It is read on every exchange, so the kubelet's rotation is picked up. Surrounding whitespace in the file is trimmed. An empty file fails the exchange without calling octo-sts.
- `refreshMinutes` must be a whole number from 5 to 45. The interval is counted from the moment an exchange starts, so a slow answer does not push the next exchange back.
- `secretName` must match `^[A-Za-z_][A-Za-z0-9_]*$`, an environment variable name.

## Per-owner keys

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `scope` | string | required | octo-sts scope of the exchange |
| `identity` | string | required | octo-sts trust policy name |
| `workspaces` | list of strings | `[]` | Workspaces that get the token as a workspace secret |
| `tokenFile` | string | none | File that also gets the token |

Rules:

- `scope` must be non-empty. Use an owner (`acme`) or a repository (`acme/widgets`). The plugin does not check that the owner or repository exists; octo-sts does.
- `identity` must be a single path segment: non-empty, without `/`, whitespace or control characters, and not `.` or `..`. octo-sts reads `.github/chainguard/<identity>.sts.yaml`.
- Each workspace must be an `https` URL without credentials, of the form `https://github.com/<owner>/<repository>`. A trailing `/` or `.git` is accepted. A port, query or fragment is refused.
- Each workspace must belong to the scope: `<owner>` must equal the scope's owner part. When the scope is `owner/repo`, `<repository>` must equal that repository too. Both comparisons ignore case. The error is `<url> does not belong to <owner>, the owner of scope <scope>` or `<url> is outside scope <scope>`.
- `tokenFile` must be an absolute path.
- An owner needs at least one destination: a non-empty `workspaces`, a `tokenFile`, or both (`set workspaces, tokenFile or both`).
- In the single-owner form, `scope` and `identity` are required unless `owners` is set (`set scope and identity, or owners`).

## Rules across owners

Only in the `owners` form:

- Two owners may not have the same scope (case-insensitive) with the same identity (case-sensitive, because it names a file).
- Two owners may not name the same `tokenFile`. Paths are compared after normalising, so `/run/a/../x.token` equals `/run/x.token`.
- Two owners may not list the same workspace. Workspaces are compared by owner and repository, case-insensitively, so `https://github.com/Acme/Widgets.git` equals `https://github.com/acme/widgets`.

The same workspace listed twice in one owner is accepted. Exact duplicates are delivered once.

## Token file

When `tokenFile` is set, each new token is written like this:

1. A missing parent directory is created with mode `0700`.
2. The token goes to `<tokenFile>.<16 hex characters>.tmp`, created exclusively with mode `0600`.
3. The temporary file is renamed over `tokenFile`. A symlink at `tokenFile` is replaced, not written through.

When the plugin starts, it removes leftover `<tokenFile>.<16 hex characters>.tmp` files from an interrupted write. It touches no other files in the directory.

The file holds the bare token without a trailing newline. A memory-backed volume (an `emptyDir` with `medium: Memory`) keeps it off disk.

The file has mode `0600`, so only the user dsh runs as can read it. Run `gh` and the gh wrapper as that same user. A directory the plugin creates gets `0700`; an existing directory, such as a volume mount, keeps its mode.

Do not set `tokenFile` to the same path as `identityTokenFile`. The configuration does not refuse it, but the plugin would overwrite the service account token with the GitHub token. On a projected volume the write fails instead, because Kubernetes mounts projected volumes read-only.

## Examples

Single owner, workspace secret only:

```yaml
- id: dsh-octo-sts
  disabled: false
  config:
    scope: acme
    identity: dsh-yawn
    workspaces:
      - https://github.com/acme/widgets
```

Single owner, file only, with a self-hosted octo-sts and a shorter interval:

```yaml
- id: dsh-octo-sts
  disabled: false
  config:
    sts: https://sts.example.com
    refreshMinutes: 15
    scope: acme/widgets
    identity: control-plane
    tokenFile: /run/dsh-octo-sts/github.token
```

Several owners, Workspaces registered by hand:

```yaml
- id: dsh-octo-sts
  disabled: false
  config:
    registerWorkspaces: false
    owners:
      - scope: acme
        identity: dsh-yawn
        workspaces:
          - https://github.com/acme/widgets
        tokenFile: /run/dsh-octo-sts/acme.token
      - scope: globex
        identity: dsh-yawn
        workspaces:
          - https://github.com/globex/app
        tokenFile: /run/dsh-octo-sts/globex.token
```

Name token files `<owner>.token` in lower case when you use [`examples/gh-owner-token.sh`](../examples/gh-owner-token.sh); the wrapper builds the file name from the repository owner.
