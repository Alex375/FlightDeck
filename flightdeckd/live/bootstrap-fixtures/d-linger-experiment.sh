#!/usr/bin/env bash
# Fixture D experiment: for a non-root user WITHOUT sudo, what survives the
# bootstrapping SSH session closing? Each run starts from a FRESH fixture d and
# starts its probe(s) in ONE ssh session that then closes; survival is observed
# from OUTSIDE (docker exec as root) — an ssh login as the user would open a
# new session and restart its user manager.
#
#   1. --user unit alone, no linger, default logind
#   2. setsid+nohup process alone, no linger, default logind
#   3. both together (does the nohup process keep the unit alive?)
#   4. can the user `loginctl enable-linger` THEMSELVES (no sudo, polkit present)?
#   5. --user unit alone, linger enabled by the user themselves
#   6. setsid+nohup process alone, logind KillUserProcesses=yes
#   7. reboot: self-lingered user + `systemctl --user enable`d unit, no login after boot
#
#   bootstrap-fixtures/d-linger-experiment.sh      BASE=ubuntu:24.04 … for another distro
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FX="$HERE/fixture.sh"
C=fd-fixture-d
WAIT="${WAIT:-30}"  # > logind's UserStopDelaySec (10 s) with margin

as_user() { "$FX" ssh d "$@"; }            # one fresh ssh session, closed on return
as_root() { docker exec "$C" bash -c "$1"; }
fresh()   { "$FX" up d >/dev/null 2>&1; }

start_probes() { # <unit|nohup|both> — in ONE ssh session, which then closes
  as_user "set -e; what=$1"'
    if [ "$what" != nohup ]; then
      mkdir -p ~/.config/systemd/user
      printf "[Service]\nExecStart=/bin/sh -c \"while :; do date +%%%%s > %%h/unit.alive; sleep 1; done\"\n" \
        > ~/.config/systemd/user/fd-probe.service
      systemctl --user daemon-reload
      systemctl --user start fd-probe
    fi
    if [ "$what" != unit ]; then
      setsid nohup sh -c "while :; do date +%s > \$HOME/nohup.alive; sleep 1; done" >/dev/null 2>&1 </dev/null &
    fi
    sleep 2
    echo "   in-session: unit=$(systemctl --user is-active fd-probe 2>/dev/null || true)" \
         "nohup=$(test -s ~/nohup.alive && echo running || echo none)"'
}

age() { as_root "f=/home/nosudo/$1; test -s \$f && echo \$(( \$(date +%s) - \$(cat \$f) )) || echo never"; }
verdict() { # <what> <file>
  local a; a="$(age "$2")"
  [ "$a" = never ] && return 0
  if [ "$a" -le 3 ]; then echo "   => $1: SURVIVED (last beat ${a}s ago)"
  else echo "   => $1: DIED (last beat ${a}s ago)"; fi
}
observe() {
  echo "   ... ssh session closed; waiting ${WAIT}s"
  sleep "$WAIT"
  verdict "systemctl --user unit" unit.alive
  verdict "setsid+nohup process" nohup.alive
  echo "   user@$(as_root 'id -u nosudo').service: $(as_root "systemctl is-active user@\$(id -u nosudo).service || true")," \
       "logind sessions: $(as_root 'loginctl list-sessions --no-legend | wc -l | tr -d " "')," \
       "Linger=$(as_root 'loginctl show-user nosudo -p Linger --value 2>/dev/null || echo no')"
}

fresh
echo "== fixture d: $(as_root '. /etc/os-release; echo $PRETTY_NAME'), $(as_root 'systemctl --version | head -1')," \
     "polkit: $(as_root 'command -v pkaction >/dev/null && echo installed || echo absent')," \
     "KillUserProcesses: $(as_root 'grep -h "^KillUserProcesses" /etc/systemd/logind.conf /etc/systemd/logind.conf.d/*.conf 2>/dev/null || echo "build default"')"

echo "== 1. --user unit alone, no linger";              start_probes unit;  observe
fresh; echo "== 2. setsid+nohup alone, no linger";       start_probes nohup; observe
fresh; echo "== 3. both together, no linger";            start_probes both;  observe

fresh; echo "== 4. self-service linger (no sudo)"
echo "   polkit implicit auth for set-self-linger: $(as_root 'pkaction --action-id org.freedesktop.login1.set-self-linger --verbose 2>/dev/null | grep -E "implicit (any|active)" | tr -s " " | paste -sd ";" -' || echo n/a)"
if out="$(as_user 'loginctl enable-linger 2>&1')"; then echo "   => loginctl enable-linger as nosudo: ALLOWED"
else echo "   => loginctl enable-linger as nosudo: DENIED — $out"; fi
echo "   Linger now: $(as_root 'loginctl show-user nosudo -p Linger --value 2>/dev/null || echo no')"
echo "== 5. --user unit alone, linger on";                 start_probes unit;  observe

fresh; echo "== 6. setsid+nohup alone, KillUserProcesses=yes"
as_root 'mkdir -p /etc/systemd/logind.conf.d && printf "[Login]\nKillUserProcesses=yes\n" > /etc/systemd/logind.conf.d/kill.conf && systemctl restart systemd-logind'
start_probes nohup; observe

fresh; echo "== 7. reboot with self-linger + enabled --user unit, nobody logs in"
as_user 'loginctl enable-linger
  mkdir -p ~/.config/systemd/user
  printf "[Service]\nExecStart=/bin/sh -c \"while :; do date +%%%%s > %%h/unit.alive; sleep 1; done\"\n[Install]\nWantedBy=default.target\n" \
    > ~/.config/systemd/user/fd-probe.service
  systemctl --user daemon-reload && systemctl --user enable fd-probe 2>&1 | tail -1'
docker restart "$C" >/dev/null
echo "   ... container rebooted; waiting ${WAIT}s"
sleep "$WAIT"
verdict "enabled --user unit after reboot" unit.alive
echo "   logind sessions: $(as_root 'loginctl list-sessions --no-legend | wc -l | tr -d " "'), Linger=$(as_root 'loginctl show-user nosudo -p Linger --value')"

fresh
echo "== done (fixture d left pristine)"
