#!/bin/sh
# sshd for the Mac's attach path, flightdeckd (as the agent user) for
# everything else. The daemon runs in the foreground: `docker logs` shows it.
set -e
/usr/sbin/sshd
exec su -s /bin/bash agent -c '
  test -f "$HOME/.flightdeckd/config.json" || flightdeckd init --label "$(hostname)"
  exec env RUST_LOG=info flightdeckd run
'
