#!/usr/bin/env bash
# Builds the public hackathon copy of this repo in ../Fr33World-public, locally. It publishes
# nothing: pushing it and making it public is the owner's call (see the hackathon's rules).
#
#   scripts/public-copy.sh
#
# A clean snapshot of the game at tag `pre-hackathon`, then each NEAR commit replayed on top, so
# judges can read the diff. Left out: Mixamo-derived animations (their terms forbid sharing the
# files on their own), internal notes, and CI (the schedules belong to the private repo).
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
out="$repo/../Fr33World-public"
name=$(git -C "$repo" config user.name)
email=$(git -C "$repo" config user.email)

rm -rf "$out"
mkdir -p "$out"
git -C "$out" init -q -b main
git -C "$out" config user.name "$name"
git -C "$out" config user.email "$email"

load() {
  find "$out" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  git -C "$repo" archive "$1" | tar -x -C "$out"
  rm -rf "$out/apps/client/public/assets/animations" "$out/.github" "$out/track.md" \
    "$out/docs/security-review.md" "$out/docs/support.md" "$out/load-runs"
  cp "$repo/scripts/public-license.txt" "$out/LICENSE" 2>/dev/null || true
}

commit() {
  git -C "$out" add -A
  GIT_AUTHOR_DATE="$2" GIT_COMMITTER_DATE="$2" git -C "$out" commit -q --allow-empty -m "$1"
}

load pre-hackathon
commit "The game before the hackathon (snapshot)" "$(git -C "$repo" log -1 --format=%aI pre-hackathon)"
git -C "$out" tag pre-hackathon

for c in $(git -C "$repo" rev-list --reverse pre-hackathon..HEAD); do
  load "$c"
  commit "$(git -C "$repo" log -1 --format=%s "$c")" "$(git -C "$repo" log -1 --format=%aI "$c")"
done
git -C "$out" tag hackathon-submission

echo "Built $out: $(git -C "$out" rev-list --count HEAD) commits, $(du -sh "$out" | cut -f1)"
echo 'Scanning every commit for secrets…'
if git -C "$out" log -p --all | grep -E -i \
  '(NEAR_ROOT_KEY|NEAR_OPERATOR_KEY|PRIVY_APP_SECRET|WORLD_TICKET_SECRET|ADMIN_TOKEN|LIVEKIT_API_SECRET)=[A-Za-z0-9:_-]{12,}|ed25519:[1-9A-HJ-NP-Za-km-z]{70,}|-----BEGIN [A-Z ]*PRIVATE KEY'; then
  echo 'SECRETS FOUND: do not publish.'
  exit 1
fi
echo 'No secrets found.'
