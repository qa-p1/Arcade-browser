#!/usr/bin/env bash
# Installs Debian packages for CI with a download cache and a parallel prefetch, as Arcade-Link's desktop jobs do:
# apt fetches one package at a time, and the runners' Ubuntu mirror has taken ~3 s per request (an install of the
# Box libraries took 15 minutes). What isn't in the cache yet is fetched 16 at a time first, a stalled file from two
# other Ubuntu mirrors; apt then checks every file's hash and fetches whatever is missing or wrong itself.
#   DEBS=DIR scripts/ci/apt-install.sh PACKAGE...
set -u
debs="${DEBS:?set DEBS to the package cache folder}"
mkdir -p "$debs"
# Rebuilding man-db's index after every install takes minutes on the runners, and nothing here reads man pages.
sudo rm -f /var/lib/man-db/auto-update

fetch1='path=${0#*/ubuntu/}
  for url in "$0" "http://azure.archive.ubuntu.com/ubuntu/$path" "http://archive.ubuntu.com/ubuntu/$path"; do
    curl -fsS --retry 2 --connect-timeout 10 --speed-limit 50000 --speed-time 20 --max-time 300 -o "$1/$2" "$url" && exit 0
  done
  rm -f "$1/$2"; echo "not prefetched: $2" >&2'

prefetch() {
  local mirror
  mirror=$(grep -m1 -v '^#' /etc/apt/apt-mirrors.txt 2>/dev/null | awk '{print $1}' || true)
  apt-get install -y --no-install-recommends --print-uris -o Dir::Cache::Archives="$debs" "$@" \
    | sed -n "s/^'\([^']*\)' \([^ ]*\) .*/\1 \2/p" | sed "s|^mirror+file:/etc/apt/apt-mirrors.txt/*|${mirror%/}/|" \
    | while read -r url name; do printf '%s %s %s\n' "$url" "$debs" "$name"; done \
    | xargs -r -P 16 -n 3 sh -c "$fetch1" || true
  echo "$(ls "$debs" | grep -c '\.deb$') packages in the cache"
}

ok=
for attempt in 1 2 3; do
  if timeout 300 sudo apt-get update -o Acquire::Retries=3 && prefetch "$@" && sudo mkdir -p "$debs/partial" &&
    timeout 900 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      -o Dir::Cache::Archives="$debs" -o APT::Keep-Downloaded-Packages=true "$@"; then
    ok=1
    break
  fi
  echo "apt attempt $attempt failed; retrying" >&2
  sleep $((attempt * 20))
done
# apt leaves its lock and partial/ (root's); the cache is saved as the runner user.
sudo rm -rf "$debs/partial" "$debs/lock"
sudo chown -R "$(id -u):$(id -g)" "$debs"
[ -n "$ok" ]
