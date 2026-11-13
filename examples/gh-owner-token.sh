#!/bin/sh
tokens="${DSH_OCTO_STS_TOKENS:-/run/dsh-octo-sts}"
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
owner="$(printf '%s\n' "$repo" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^/]+/##; s#^[^/@:]+@[^/:]+:##; s#^[^/]+/([^/]+/[^/]+)$#\1#; s#/.*##' | tr '[:upper:]' '[:lower:]')"
case "$owner" in ''|.*|*[!a-z0-9_.-]*) echo "gh: cannot tell the repository owner" >&2; exit 1 ;; esac
GH_TOKEN="$(cat "$tokens/$owner.token")" || exit 1
export GH_TOKEN
exec gh "$@"
