#!/usr/bin/env bash
# apt-get install with a deadline and retries: runner mirrors fail to resolve or hang at times.
#   scripts/ci/apt-install.sh PACKAGE...
set -u
# Rebuilding man-db's index after every install takes minutes on the runners, and nothing here reads man pages.
sudo rm -f /var/lib/man-db/auto-update
for attempt in 1 2 3; do
  timeout 300 sudo apt-get update -o Acquire::Retries=3 &&
    timeout 900 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Acquire::Retries=3 "$@" && exit 0
  echo "apt attempt $attempt failed; retrying" >&2
  sleep $((attempt * 20))
done
exit 1
