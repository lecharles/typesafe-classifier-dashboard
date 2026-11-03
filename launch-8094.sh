#!/usr/bin/env bash
# Typesafe Classifier Dashboard — VPS test deploy (port 8094)
# Keys live in ~/secrets/classifier.env (never committed). After editing that
# file, restart: tmux kill-session -t classifier; tmux new-session -d -s classifier ~/projects/typesafe-classifier-dashboard/launch-8094.sh
set -uo pipefail
cd /home/hermes/projects/typesafe-classifier-dashboard
set -a
[ -f /home/hermes/secrets/classifier.env ] && . /home/hermes/secrets/classifier.env
set +a
exec ./node_modules/.bin/next start -p 8094
