#!/bin/bash
# Copies jklist's database and photos to Cloudflare R2. Runs nightly from jklist-backup.timer.
# Reads R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ENDPOINT from /etc/jklist-backup/r2.env.
set -euo pipefail

DATA=/var/lib/jklist
BUCKET=r2:jklist-backups
source /etc/jklist-backup/r2.env

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
# After an upload this rclone checks the object by version, which R2 doesn't support.
# The upload's own MD5 check already confirms it arrived intact.
export RCLONE_CONFIG_R2_NO_HEAD=true

snapshot=/var/tmp/jklist-backup-$$.db
trap 'rm -f "$snapshot"' EXIT
sqlite3 "$DATA/jklist.db" "vacuum into '$snapshot'"
rclone copyto "$snapshot" "$BUCKET/db/jklist-$(date -u +%Y-%m-%dT%H%M).db"

# A photo deleted on the site moves to removed/ instead of disappearing from the backup at once.
mkdir -p "$DATA/uploads"
rclone sync "$DATA/uploads" "$BUCKET/uploads" --backup-dir "$BUCKET/removed/$(date -u +%F)"

# Nothing is kept longer than 30 days.
rclone delete --min-age 30d "$BUCKET/db"
rclone delete --min-age 30d "$BUCKET/removed"

touch "$DATA/offsite-backup-done"
