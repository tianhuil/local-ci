#!/usr/bin/env bash
set -euo pipefail

BUILD_CMD=${BUILD_CMD:-"bun run build"}
DIST_DIR=${DIST_DIR:-dist}
RELEASE_BRANCH=${RELEASE_BRANCH:-release}
TAG_PREFIX=${TAG_PREFIX:-v}
REMOTE=${REMOTE:-origin}
DRY_RUN=0
if [[ ${1:-} == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if (($#)); then
  echo "error: unexpected argument: $1" >&2
  exit 2
fi

if [[ -n $(git status --porcelain) ]]; then
  echo "error: working tree is not clean" >&2
  exit 1
fi
VERSION=$(bun -e 'const p = await Bun.file("package.json").json(); console.log(p.version)')
TAG="${TAG_PREFIX}${VERSION}"
if [[ -n $(git ls-remote --tags "$REMOTE" "refs/tags/$TAG") ]]; then
  echo "already released $TAG"
  exit 0
fi

eval "$BUILD_CMD"
git add -f "$DIST_DIR"
TREE=$(git write-tree)
parents=()
if parent=$(git rev-parse "$REMOTE/$RELEASE_BRANCH" 2>/dev/null); then
  parents+=("-p" "$parent")
fi
parents+=("-p" HEAD)
COMMIT=$(git commit-tree "$TREE" "${parents[@]}" -m "release $TAG")
git reset --quiet

if ((DRY_RUN)); then
  echo "would push $COMMIT:refs/heads/$RELEASE_BRANCH and tag $TAG"
  exit 0
fi

git push "$REMOTE" "$COMMIT:refs/heads/$RELEASE_BRANCH"
git push "$REMOTE" "$COMMIT:refs/tags/$TAG"
if [[ -n ${NOTES_CMD:-} ]]; then
  notes=$(eval "$NOTES_CMD")
  release_args=(gh release create "$TAG" --notes "$notes")
else
  release_args=(gh release create "$TAG" --generate-notes)
fi
if command -v gh >/dev/null 2>&1 && [[ -n ${GH_TOKEN:-} ]]; then
  "${release_args[@]}"
else
  echo "warning: gh authentication unavailable; skipped GitHub Release $TAG" >&2
fi
