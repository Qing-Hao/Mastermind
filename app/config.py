"""Reads `.env` into the process environment at startup.

`.env` was a Docker Compose file: `compose.yaml` interpolates `${...}` from it,
and nothing else ever opened it. So `MASTERMIND_SSO=off` worked in a container
and did nothing at all under `uvicorn` on the host, which is a confusing way for
a recovery hatch to behave.

Environment wins over file (`override=False`). A variable already set in the
shell is never replaced, matching Compose's own precedence and keeping
`$env:MASTERMIND_SSO = "off"` an override rather than a coin toss.
"""

import os
import sys

ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")


def load_env(path=ENV_FILE):
    """Apply `.env` to `os.environ` without overwriting anything already set."""
    # The real `.env` carries the client secret and, when someone is debugging,
    # `MASTERMIND_SSO=off`. Tests set the sign-in environment themselves and
    # several assume the gate is armed, so a developer's file must not reach
    # them -- it would disarm the gate in the suite that exists to check it.
    if "pytest" in sys.modules:
        return False
    from dotenv import load_dotenv

    return load_dotenv(path, override=False)
