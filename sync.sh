#!/usr/bin/env bash
# dsh-plugin — pull the repo and make the profile see it.
#
# Every plugin package is symlinked into the profile's node_modules, so a pull is
# the whole update: there is nothing to copy. This script exists to make that a
# one-liner and to fail loudly when the links are missing, which is the one thing
# that silently makes a profile run stale code.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `DSH_PROFILE` may hold either a profile name (`web`) or a path; the harness
# sets it to the bare name, so resolve that against DSH_HOME rather than
# treating it as a relative directory.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
case "$PROFILE" in
  /*) ;;
  *) PROFILE="$DSH_HOME/profiles/$PROFILE" ;;
esac
MODULES="$PROFILE/node_modules"

echo "==> pulling $REPO"
git -C "$REPO" pull --ff-only

echo "==> checking profile links in $MODULES"
missing=0
for pkg in "$REPO"/packages/*/; do
  # `basename` on a trailing-slash path returns the last component, but the
  # symlink target must keep the trailing slash off to stay a directory link.
  pkg="${pkg%/}"
  name="$(basename "$pkg")"
  target="$MODULES/$name"
  if [ -L "$target" ]; then
    echo "  ok    $name"
  elif [ -e "$target" ]; then
    # A copied directory shadows the repo: edits land in the repo and never reach
    # the profile. Replace it rather than leaving the trap in place.
    echo "  copy  $name — replacing with a symlink"
    rm -rf "$target"
    ln -s "$pkg" "$target"
  else
    echo "  link  $name"
    ln -s "$pkg" "$target"
  fi
done

echo "==> done; restart DSH to pick up host-side changes"
