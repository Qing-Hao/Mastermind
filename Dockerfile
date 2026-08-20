# Mastermind, served to a team.
#
# No build step to reproduce here: no ORM, no bundler, no node. One layer of pip
# and a copy of the source, which is why this is a single stage.
FROM python:3.12-slim

# Unbuffered so `docker compose logs` shows a traceback as it happens rather than
# when the buffer fills; no .pyc files on a volume nobody reads them from.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Ahead of the source, so an edit to a route does not reinstall the four
# dependencies. `requirements-ai.txt` is deliberately **not** installed: the
# sprint review is a CLI script, its dependency is heavy, and its provider key
# belongs in an environment rather than in a running server.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY templates/ ./templates/
COPY scripts/ ./scripts/

# Not root. The uid is fixed rather than dynamic so a host directory can be
# chowned to match it once -- see the note on `user:` in compose.yaml.
RUN useradd --uid 10001 --create-home mastermind \
    && mkdir -p /app/data /app/sprints \
    && chown -R mastermind:mastermind /app
USER mastermind

EXPOSE 8000

# Cheap and gate-exempt, so it stays green whether or not sign-in is armed and
# whether or not the database has anything in it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/auth/signin', timeout=4)"

# **One worker, and it is a requirement rather than a default.** The live
# connection registry -- who is here, and who is told a write landed -- is
# process memory, so a second worker would announce to half the room and draw
# presence for the other half. Do not add `--workers`.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
