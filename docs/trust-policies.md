# Trust policies

The plugin only asks octo-sts for a token. octo-sts decides whether to issue one and what it can do. That decision comes from a trust policy in GitHub. This page covers what an operator sets up outside the plugin.

The octo-sts behaviour described here comes from the [octo-sts README](https://github.com/octo-sts/app#readme), [`pkg/octosts/octosts.go`](https://github.com/octo-sts/app/blob/main/pkg/octosts/octosts.go) and [`pkg/octosts/trust_policy.go`](https://github.com/octo-sts/app/blob/main/pkg/octosts/trust_policy.go). Check them for the full policy format.

## How the pieces fit

For each owner, the plugin sends `scope` and `identity` with the pod's service account token. octo-sts then, in this order:

1. Checks the token's issuer against the operator's issuer allowlist, if the octo-sts instance has one.
2. Fetches the issuer's OIDC discovery document and keys, and verifies the token's signature.
3. Checks the issuer against the owner's `trusted-token-issuers.yaml`, if that file exists.
4. Reads and parses the trust policy `.github/chainguard/<identity>.sts.yaml`.
   - Scope `acme/widgets`: the file in the `acme/widgets` repository.
   - Scope `acme`: the file in the owner's policy repository (`.github` by default), an org-level policy.
5. Checks the token's issuer, subject, audience and any `claim_pattern` against the policy.
6. Creates an installation token with the policy's permissions, limited to the policy's repositories.

So `identity` in the plugin's configuration names the policy file, and `scope` picks where octo-sts looks for it.

## Prerequisites

- The octo-sts GitHub App is installed on the owner, with access to the target repositories and to the repository that holds the policy.
- octo-sts can fetch the issuer's OIDC discovery document and JWKS anonymously over https, and trusts the issuer's TLS certificate.
- When the owner's policy repository has `.github/chainguard/trusted-token-issuers.yaml`, the Kubernetes issuer must be listed in it. Without that file, octo-sts accepts any issuer.

## The Kubernetes token

A projected service account token carries these claims:

| Claim | Value |
| --- | --- |
| `iss` | The API server's service account issuer (`--service-account-issuer`) |
| `sub` | `system:serviceaccount:<namespace>:<service account>` |
| `aud` | The `audience` set in the projected volume |

Mount it in the control-plane pod. The plugin's default path is `/var/run/secrets/octo-sts/token`:

```yaml
spec:
  serviceAccountName: <control-plane service account>
  containers:
    - name: control-plane
      volumeMounts:
        - name: octo-sts-token
          mountPath: /var/run/secrets/octo-sts
          readOnly: true
  volumes:
    - name: octo-sts-token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              audience: sts.example.com
              expirationSeconds: 3600
```

Use the audience your octo-sts instance expects, usually its domain. The kubelet rotates the file before it expires; the plugin reads it on every exchange.

octo-sts has to read the issuer's discovery document and keys without credentials. On Kubernetes, the API server serves them, and anonymous access needs a binding like this:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: service-account-issuer-discovery-unauthenticated
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:service-account-issuer-discovery
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: system:unauthenticated
```

## Org-level policy

For `scope: acme` and `identity: dsh-yawn`, put `.github/chainguard/dsh-yawn.sts.yaml` in the `acme/.github` repository:

```yaml
issuer: https://<kubernetes API server issuer>
subject: system:serviceaccount:<namespace>:<control-plane service account>
audience: sts.example.com
permissions:
  contents: write
  pull_requests: write
  issues: write
  checks: read
  statuses: read
  actions: read
repositories:
  - widgets
  - gadgets
```

`repositories` limits the token to those repositories. List every repository in the owner's `workspaces` and every repository the gh wrapper may be called for: the plugin delivers one token per owner to all of them.

Without `repositories` (or `repository_ids`), an org-level policy covers every repository the octo-sts App can see in that owner. Do not leave it out in a policy with write permissions: the sandboxes could then write to every repository of the owner.

### Policy fields

- `issuer` or `issuer_pattern`: exactly one is required.
- `subject` or `subject_pattern`: exactly one is required.
- `audience` or `audience_pattern`: optional. Without either, the token's audience must contain the octo-sts instance's domain.
- `claim_pattern`: optional map of claim names to patterns.

The plain fields match exactly. The `_pattern` fields are regular expressions matched against the whole value; do not add `^` or `$`.

## Repository-level policy

For `scope: acme/widgets`, put the same file in the `acme/widgets` repository, without `repositories`. The token then covers only that repository.

A repository-level policy must not contain `repositories`, `repository_ids` or `caller_repository`. Those are org-level fields, and octo-sts parses a repository-level policy strictly as the plain policy type. An unknown field fails the parse, and octo-sts answers as if the policy did not exist (`unable to find trust policy`).

The plugin refuses workspaces outside a repository scope. A repository scope fits a single-repository owner. It does not fit the multi-owner gh wrapper, which picks a token by owner and needs one token that covers every repository of that owner.

## Choosing permissions

The permissions above suit an agent that pushes branches, opens pull requests and reads CI results. Grant fewer when the agents do less. Sandboxes can read the token, so every permission in the policy is available to every command in the Workspace's sandboxes.

## Several owners

Each entry in `owners` needs its own policy in its own owner. The `identity` may be the same name in each owner, as long as each owner has that policy file:

```yaml
owners:
  - scope: acme
    identity: dsh-yawn
    tokenFile: /run/dsh-octo-sts/acme.token
  - scope: globex
    identity: dsh-yawn
    tokenFile: /run/dsh-octo-sts/globex.token
```

This needs `acme/.github/.github/chainguard/dsh-yawn.sts.yaml` and `globex/.github/.github/chainguard/dsh-yawn.sts.yaml`, both trusting the same service account.

## When the exchange fails

The plugin logs `exchange failed: octo-sts answered <status>: <reason>` with the reason octo-sts gives. octo-sts keeps the detailed reason for a policy mismatch in its own logs, not in the answer, so check those too.

The plugin retries a `4xx` refusal (other than `408` and `429`) only after `refreshMinutes`, and logs it once until the text changes. After fixing a policy, expect the next exchange up to `refreshMinutes` later, or restart the plugin to exchange at once.

Then check:

1. The App is installed on the owner and can read the policy repository.
2. The policy file exists at `.github/chainguard/<identity>.sts.yaml` in the right repository for the scope, and parses. A parse error looks like a missing policy.
3. The issuer is allowed by the operator's issuer allowlist, if the instance has one.
4. octo-sts can reach the issuer's discovery document and JWKS anonymously.
5. The issuer is listed in `trusted-token-issuers.yaml` if that file exists.
6. `issuer`, `subject` and `audience` (or their patterns) match the token's claims.
7. The GitHub App's own permissions cover every permission in the policy. GitHub refuses to create a token with more than the App has.
8. Every repository in `repositories` exists.
