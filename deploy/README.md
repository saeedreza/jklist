# Deploy

Production runs from `main` in `/opt/jklist` on the DigitalOcean droplet
`jklist`. `jklist.service` runs Node as the `jklist` user. Cloudflare Tunnel
serves https://jklist.com from the app on `127.0.0.1:6969`.

The database, uploads, and backups are in `/var/lib/jklist`. Settings are in
`/etc/jklist.env`. Keep these outside the checkout.

Run `npm test`, push a branch, and merge its pull request after CI passes.
On the server, check that the checkout is clean and record its current commit:

```
git -C /opt/jklist status --short --branch
git -C /opt/jklist rev-parse HEAD
```

Then update and restart:

```
git -C /opt/jklist switch main
git -C /opt/jklist pull --ff-only origin main
systemctl restart jklist
systemctl is-active jklist
curl --fail --silent --show-error https://jklist.com/health
```

Check the changed pages at https://jklist.com, including their plain-text or
JSON responses when relevant. Page copy loads at startup, so Markdown edits
also need a restart.

To roll back code, use the commit recorded before deploying, then restart:

```
git -C /opt/jklist switch --detach <previous-commit>
systemctl restart jklist
```

This does not restore the database. Review any data migrations before choosing
a rollback. Nightly off-site backups use `jklist-backup.timer`; `/health` also
checks their freshness.
