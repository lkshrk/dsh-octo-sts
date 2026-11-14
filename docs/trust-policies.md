# Trust policies

The plugin only asks octo-sts for a token. octo-sts decides whether to issue one and what it can do. That decision comes from a trust policy in GitHub. This page covers what an operator sets up outside the plugin.

The octo-sts behaviour described here comes from the [octo-sts README](https://github.com/octo-sts/app#readme). Check it for the full policy format.

## How the pieces fit

For each owner, the plugin sends `scope` and `identity` with the pod's service account token. octo-sts then:

1. Reads the trust policy `.github/chainguard/<identity>.sts.yaml`.
   - Scope `acme/widgets`: the file in the `acme/widgets` repository.
   - Scope `acme`: the file in the owner's `.github` repository, an org-level policy.
2. Checks the token's issuer, subject and audience against the policy.
3. Creates an installation token with the policy's permissions, limited to the policy's repositories.

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

## Repository-level policy

For `scope: acme/widgets`, put the same file in the `acme/widgets` repository and leave out `repositories`. The token then covers only that repository.

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

The plugin logs `exchange failed: octo-sts answered <status>: <reason>` with the reason octo-sts gives. Check, in order:

1. The App is installed on the owner and can read the policy repository.
2. The policy file exists at `.github/chainguard/<identity>.sts.yaml` in the right repository for the scope.
3. `issuer`, `subject` and `audience` match the token's claims exactly.
4. The issuer is listed in `trusted-token-issuers.yaml` if that file exists.
5. octo-sts can reach the issuer's discovery document and JWKS anonymously.
6. Every repository in `repositories` exists.
