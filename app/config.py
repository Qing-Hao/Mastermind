"""Reads `.env` into the process environment at startup.

`.env` was a Docker Compose file: `compose.yaml` interpolates `${...}` from it,
and nothing else ever opened it. So `MASTERMIND_SSO=off` worked in a container
and did nothing at all under `uvicorn` on the host, which is a confusing way for
a recovery hatch to behave. This closes that gap without a parsing dependency --
the file is four keys and comments.

Environment wins over file. A variable already set in the shell is never
overwritten, matching Compose's own precedence and keeping
`$env:MASTERMIND_SSO = "off"` an override rather than a coin toss.
"""

import os
import sys

ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")

QUOTES = ("'", '"')


def parse_env(text):
    """Parse `.env` text into a dict. Later keys win; malformed lines skipped."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        name, separator, value = line.partition("=")
        if not separator:
            continue
        name = name.strip()
        if not name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in QUOTES:
            value = value[1:-1]
        values[name] = value
    return values


def load_env(path=ENV_FILE):
    """Apply `.env` to `os.environ` without overwriting anything already set."""
    # The real `.env` carries the client secret and, when someone is debugging,
    # `MASTERMIND_SSO=off`. Tests set the sign-in environment themselves and
    # several assume the gate is armed, so a developer's file must not reach
    # them -- it would disarm the gate in the suite that exists to check it.
    if "pytest" in sys.modules:
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        return {}
    applied = {}
    for name, value in parse_env(text).items():
        if name not in os.environ:
            os.environ[name] = value
            applied[name] = value
    return applied
