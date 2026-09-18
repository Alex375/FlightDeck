#!/bin/sh
# SSH_ASKPASS helper: answers ssh's password prompt with $FIXTURE_PASSWORD
# (no sshpass needed; OpenSSH >= 8.4 with SSH_ASKPASS_REQUIRE=force).
printf '%s\n' "$FIXTURE_PASSWORD"
