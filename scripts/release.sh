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
tag_commit=$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG^{}" | awk '{print $1}')
if [[ -z $tag_commit ]]; then
  tag_commit=$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | awk '{print $1}')
fi
release_commit=$(git ls-remote "$REMOTE" "refs/heads/$RELEASE_BRANCH" | awk '{print $1}')
if [[ -n $tag_commit ]]; then
  if [[ $tag_commit == "$release_commit" ]]; then
    echo "already released $TAG"
    exit 0
  fi
  echo "error: inconsistent release refs for $TAG: tag $tag_commit, $RELEASE_BRANCH ${release_commit:-missing}" >&2
  exit 1
fi

export GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-${GITHUB_ACTOR:-release.sh}}
export GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-release@local-ci}
export GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-${GITHUB_ACTOR:-release.sh}}
export GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-release@local-ci}

index_file=$(mktemp)
rm -f "$index_file"
cleanup() {
  rm -f "$index_file"
}
trap cleanup EXIT
export GIT_INDEX_FILE=$index_file
git read-tree HEAD
eval "$BUILD_CMD"
git add -f "$DIST_DIR"
TREE=$(git write-tree)
parents=()
if [[ -n $release_commit ]]; then
  parents+=("-p" "$release_commit")
fi
parents+=("-p" HEAD)
COMMIT=$(git commit-tree "$TREE" "${parents[@]}" -m "release $TAG")
unset GIT_INDEX_FILE

if ((DRY_RUN)); then
  echo "would push $COMMIT:refs/heads/$RELEASE_BRANCH and tag $TAG"
  exit 0
fi

if ! git push --atomic "$REMOTE" "$COMMIT:refs/heads/$RELEASE_BRANCH" "$COMMIT:refs/tags/$TAG"; then
  echo "error: failed to atomically publish $TAG and $RELEASE_BRANCH" >&2
  exit 1
fi
if [[ -n ${NOTES_CMD:-} ]]; then
  notes=$(eval "$NOTES_CMD")
  release_args=(gh release create "$TAG" --notes "$notes")
else
  release_args=(gh release create "$TAG" --generate-notes)
fi
if command -v gh >/dev/null 2>&1 && [[ -n ${GH_TOKEN:-} ]]; then
  if ! "${release_args[@]}"; then
    echo "error: GitHub Release $TAG was not created; run gh release create $TAG" >&2
    exit 1
  fi
else
  echo "warning: gh authentication unavailable; skipped GitHub Release $TAG" >&2
fi
