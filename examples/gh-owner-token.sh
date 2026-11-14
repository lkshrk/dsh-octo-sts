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
[ -n "$GH_TOKEN" ] || { echo "gh: $tokens/$owner.token is empty" >&2; exit 1; }
export GH_TOKEN
exec gh "$@"
