#!/bin/sh
# OpenSSH runs this for a password or passphrase outside Windows: Project Grid's own executable, as Node, runs
# ssh-askpass.cjs, which asks the window.
ELECTRON_RUN_AS_NODE=1 exec "$PROJECT_GRID_ASKPASS_NODE" "$PROJECT_GRID_ASKPASS_SCRIPT" "$@"
