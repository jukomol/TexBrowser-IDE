#!/usr/bin/env bash
# Download a Debian package robustly: apt's own mirror first, then other Ubuntu
# mirrors. A stalled transfer (under 200 KB/s for 60 s) is aborted and retried
# instead of hanging the job, and the file is checked against apt's checksum.
#
#   scripts/ci/download-deb.sh <package> <output.deb>
set -euo pipefail
pkg=$1
out=$2

# 'URL' filename size SHA512:hex   (hash type depends on the archive)
read -r uri _ size hash < <(apt-get download --print-uris "$pkg" | head -n1)
uri=${uri//\'/}
algo=$(echo "${hash%%:*}" | tr '[:upper:]' '[:lower:]')
algo=${algo%sum}   # MD5Sum → md5
expected=${hash#*:}
path="pool/${uri#*/pool/}"

mirrors=()
if [[ "$uri" == mirror+file:* ]]; then
  # GitHub runners: "mirror+file:/etc/apt/apt-mirrors.txt/pool/…" — the file lists
  # the real mirrors, one per line ("<url>[<tab>priority:N]").
  list=${uri#mirror+file:}
  list=${list%%/pool/*}
  while read -r base _; do
    [[ "$base" == http* ]] && mirrors+=("${base%/}/$path")
  done < <(grep -v '^#' "$list" || true)
elif [[ "$uri" == http* ]]; then
  mirrors+=("$uri")
fi
mirrors+=(
  "http://archive.ubuntu.com/ubuntu/$path"
  "http://us.archive.ubuntu.com/ubuntu/$path"
  "https://mirrors.edge.kernel.org/ubuntu/$path"
  "https://mirror.math.princeton.edu/pub/ubuntu/$path"
)

for url in "${mirrors[@]}"; do
  for attempt in 1 2; do
    echo "↓ $pkg ($((size / 1048576)) MB) from $url (attempt $attempt)"
    if curl --fail --location --silent --show-error \
         --connect-timeout 20 --speed-limit 204800 --speed-time 60 \
         --output "$out.part" "$url"; then
      actual=$("${algo}sum" "$out.part" | cut -d' ' -f1)
      if [[ "$actual" == "$expected" ]]; then
        mv "$out.part" "$out"
        echo "✔ $pkg downloaded and verified (${algo})"
        exit 0
      fi
      echo "✖ checksum mismatch from $url"
    fi
    rm -f "$out.part"
  done
done
echo "✖ could not download $pkg from any mirror" >&2
exit 1
