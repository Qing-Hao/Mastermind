"""Reads issues from the repositories the engineers file them in.

**A reader, not a tracker.** Every call asks the host at request time and returns
what it said; nothing is stored, nothing is written back, and every issue carries
the host's own URL because that is where an issue is read properly and answered.
See PROMPT.md amendment 7 for the argument and for the lines this must not cross.

The genre is `auth.py`, not `validation.py`: pure functions for everything that
can be decided without a network, plus one `http_client` seam so the whole thing
is testable against a stub host with no VPN and no token. The pure half is the
larger half on purpose -- URL shapes, header shapes and the normalising of three
different issue payloads into one are where the bugs live, and none of them need
a socket to be tested.

Knows nothing about roadmaps, phases or sprints, and must stay that way: it is a
client for somebody else's API that happens to be called from a planning tool.
"""

import json
import os
from urllib.parse import quote, urlsplit

import httpx

# --- environment -------------------------------------------------------------

# The feature switch, and it is environment-only rather than a settings column
# for a reason particular to it: the settings row travels in `/api/export`, so a
# column would carry the whole feature into a deployment that was never meant to
# reach the internet. It joins `MASTERMIND_SSO` and `MASTERMIND_PUBLIC` in
# describing the deployment rather than the dataset.
ENV_ISSUES = "MASTERMIND_ISSUES"

FETCH_TIMEOUT_SECONDS = 10
# Per repository, per request. A planning readout wants the top of the pile, not
# the whole backlog, and one page per repo keeps a five-repo page to five calls.
DEFAULT_LIMIT = 50
MAX_LIMIT = 100


def is_enabled():
    """True when `MASTERMIND_ISSUES` switches the Issues feature on for this process."""
    return os.environ.get(ENV_ISSUES, "").strip().lower() in ("1", "on", "true", "yes")


class IssuesError(Exception):
    """A repository that could not be read. The message is shown beside its name."""


# --- the adapter registry ----------------------------------------------------

# Three hosts, and a fourth is thirty lines here rather than a URL template in a
# settings dialog: authentication, the state vocabulary, the page-size parameter
# and the shape of a label all differ per host, so the configurable version would
# not have covered the fourth one anyway. See PROMPT.md amendment 7.

GITHUB = "github"
GITLAB = "gitlab"
FORGEJO = "forgejo"
PROVIDERS = (GITHUB, GITLAB, FORGEJO)

# What each host calls the states this app asks for. The app's vocabulary is
# GitHub's; GitLab is the one that disagrees.
STATES = {
    GITHUB: {"open": "open", "closed": "closed", "all": "all"},
    GITLAB: {"open": "opened", "closed": "closed", "all": "all"},
    FORGEJO: {"open": "open", "closed": "closed", "all": "all"},
}

# Where each host's API lives relative to the base URL somebody types in, and
# what it defaults to when they type nothing. Forgejo has no cloud default worth
# guessing at, so a base URL is required for it.
API_SUFFIX = {GITHUB: "/api/v3", GITLAB: "/api/v4", FORGEJO: "/api/v1"}
CLOUD_ROOT = {
    GITHUB: "https://api.github.com",
    GITLAB: "https://gitlab.com/api/v4",
    FORGEJO: "",
}


def api_root(provider, base_url=""):
    """The API root for a host: the cloud default, or a typed base URL plus its suffix."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return CLOUD_ROOT.get(provider, "")
    suffix = API_SUFFIX.get(provider, "")
    # Somebody who pastes the API root itself should not get it twice. Checked
    # rather than assumed, because both spellings are what people actually paste.
    if suffix and base.endswith(suffix):
        return base
    # GitHub Enterprise puts its API under /api/v3; api.github.com does not.
    if provider == GITHUB and urlsplit(base).netloc == "api.github.com":
        return base
    return base + suffix


def project_path(repo):
    """The owner/name pair as one path segment, URL-encoded where the host wants it."""
    owner = (repo.get("owner") or "").strip("/")
    name = (repo.get("repo") or "").strip("/")
    return f"{owner}/{name}"


def issues_url(repo):
    """The list-issues endpoint for one configured repository."""
    provider = repo.get("provider")
    root = api_root(provider, repo.get("base_url"))
    if not root:
        raise IssuesError("No base URL is configured for this repository.")
    if provider == GITLAB:
        # GitLab addresses a project by its full path, encoded whole -- and a
        # group can nest, so the slashes inside it are encoded too.
        return f"{root}/projects/{quote(project_path(repo), safe='')}/issues"
    return f"{root}/repos/{project_path(repo)}/issues"


def request_headers(repo):
    """Auth and accept headers for one repository. Each host spells auth differently."""
    provider = repo.get("provider")
    token = (repo.get("token") or "").strip()
    headers = {"Accept": "application/json"}
    if provider == GITHUB:
        headers["Accept"] = "application/vnd.github+json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif provider == GITLAB:
        if token:
            headers["PRIVATE-TOKEN"] = token
    elif provider == FORGEJO:
        if token:
            headers["Authorization"] = f"token {token}"
    return headers


def request_params(repo, state="open", limit=DEFAULT_LIMIT):
    """Query parameters for one repository: its host's state word and page size."""
    provider = repo.get("provider")
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    params: dict[str, str | int] = {
        "state": STATES.get(provider, STATES[GITHUB]).get(state, state)
    }
    if provider == FORGEJO:
        params["limit"] = limit
        # Forgejo's issues endpoint lists pull requests too, and unlike GitHub's
        # it can be asked not to. Cheaper and more accurate than filtering the
        # reply, and it makes the host's own total count the right number.
        params["type"] = "issues"
    else:
        params["per_page"] = limit
    return params


# --- how many there are, which is not how many were fetched -------------------

# One page per repository is what a planning readout wants; "42 open" is what
# tells you whether the page is the whole story. No host gives both in one call,
# and each gives the count a different way:
#
# * GitHub's issues endpoint sends no total at all, and its `Link` header counts
#   pull requests among the issues. Its search endpoint answers exactly, excludes
#   pull requests with `is:issue`, and costs one small request.
# * GitLab sends `X-Total` on the list itself, so a one-row page carries it.
# * Forgejo sends `X-Total-Count`, and `type=issues` keeps pull requests out of
#   it.
TOTAL_HEADERS = {GITLAB: "X-Total", FORGEJO: "X-Total-Count"}


def total_url(repo):
    """Where a count comes from. GitHub asks its search endpoint; the others count a page."""
    if repo.get("provider") == GITHUB:
        return f"{api_root(GITHUB, repo.get('base_url'))}/search/issues"
    return issues_url(repo)


def total_params(repo, state="open"):
    """A count asks for as little as the host will send: one row, or none at all."""
    provider = repo.get("provider")
    if provider == GITHUB:
        # `is:issue` is what excludes pull requests, and it is the reason this
        # endpoint is used rather than the cheaper `Link`-header trick.
        query = [f"repo:{project_path(repo)}", "is:issue"]
        if state in ("open", "closed"):
            query.append(f"state:{state}")
        return {"q": " ".join(query), "per_page": 1}
    return {**request_params(repo, state, 1)}


def total_from(repo, headers, payload):
    """The count out of one host's answer, or None when it did not give one."""
    provider = repo.get("provider")
    if provider == GITHUB:
        return payload.get("total_count") if isinstance(payload, dict) else None
    raw = (headers or {}).get(TOTAL_HEADERS.get(provider, ""), "")
    try:
        return int(raw)
    except (TypeError, ValueError):
        # A GitLab or Forgejo old enough not to send the header. The page is
        # still drawn; the total simply reads as unknown rather than as zero.
        return None


def is_pull_request(provider, raw):
    """True for a merge/pull request, which GitHub and Forgejo list among issues."""
    # GitHub's issues endpoint returns pull requests as issues, distinguished
    # only by this key. A planning readout that counts them is wrong by however
    # many branches are open, which on a busy repo is most of the number.
    return provider in (GITHUB, FORGEJO) and bool(raw.get("pull_request"))


def _labels(provider, raw):
    labels = raw.get("labels") or []
    if provider == GITLAB:
        return [str(label) for label in labels if label]
    return [label.get("name", "") for label in labels if isinstance(label, dict)]


def _author(provider, raw):
    person = raw.get("author") if provider == GITLAB else raw.get("user")
    if not isinstance(person, dict):
        return ""
    return person.get("username") or person.get("login") or ""


def normalise_issue(repo, raw):
    """One host's issue payload as the shape the page draws. Never stored anywhere."""
    provider = repo.get("provider")
    url = raw.get("web_url") if provider == GITLAB else raw.get("html_url")
    number = raw.get("iid") if provider == GITLAB else raw.get("number")
    comments = raw.get("user_notes_count") if provider == GITLAB else raw.get("comments")
    state = (raw.get("state") or "").lower()
    return {
        "repo_ref": repo_ref(repo),
        "repo_label": repo_label(repo),
        "number": number,
        "title": raw.get("title") or "",
        # GitLab says "opened"; the app's vocabulary is GitHub's throughout.
        "state": "open" if state in ("open", "opened") else state,
        "url": url or "",
        "labels": _labels(provider, raw),
        "author": _author(provider, raw),
        "comments": comments or 0,
        "created_at": raw.get("created_at") or "",
        "updated_at": raw.get("updated_at") or "",
    }


# --- the configured repositories ---------------------------------------------

# Stored as one `issues_repos` JSON column rather than a table: a handful of
# connection settings edited on one page, never joined against anything, and a
# table keyed by an external system would have to answer to export and import.

REPO_FIELDS = ("provider", "base_url", "owner", "repo", "label", "enabled")


def repo_ref(repo):
    """A repository's identity for the page and the change log: `provider:owner/name`."""
    return f"{(repo.get('provider') or '').lower()}:{project_path(repo)}"


def repo_label(repo):
    """What to call it on screen: whatever was typed, else `owner/name`."""
    return (repo.get("label") or "").strip() or project_path(repo)


def clean_repo(raw):
    """One repository entry, with junk dropped and defaults filled. Raises on nonsense."""
    if not isinstance(raw, dict):
        raise IssuesError("A repository entry must be an object.")
    provider = (raw.get("provider") or "").strip().lower()
    if provider not in PROVIDERS:
        raise IssuesError(f"`{provider or '(none)'}` is not a known provider.")
    repo = {
        "provider": provider,
        "base_url": (raw.get("base_url") or "").strip().rstrip("/"),
        "owner": (raw.get("owner") or "").strip().strip("/"),
        "repo": (raw.get("repo") or "").strip().strip("/"),
        "label": (raw.get("label") or "").strip(),
        "token": (raw.get("token") or "").strip(),
        "enabled": bool(raw.get("enabled", True)),
    }
    if not repo["owner"] or not repo["repo"]:
        raise IssuesError("A repository needs both an owner and a name.")
    if provider == FORGEJO and not repo["base_url"]:
        raise IssuesError("Forgejo needs the base URL of its host.")
    return repo


def repos_from_json(raw):
    """Parse the `issues_repos` column. A malformed column reads as no repositories."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        # The column is written by this app alone, so a broken one is a bug
        # somewhere else -- but it must not take the whole page down with it.
        return []
    if not isinstance(parsed, list):
        return []
    repos = []
    for entry in parsed:
        try:
            repos.append(clean_repo(entry))
        except IssuesError:
            continue
    return repos


def repos_to_json(repos):
    """Serialise cleaned repositories back into the column."""
    return json.dumps([clean_repo(repo) for repo in repos])


def without_token(repo):
    """One repository as the frontend may see it: every field except the token.

    `token_set` rather than the token, or its tail. The Sign-in page prints the
    tail of the OIDC secret and that is already one echo of a secret too many.
    """
    shown = {field: repo.get(field) for field in REPO_FIELDS}
    shown["ref"] = repo_ref(repo)
    shown["token_set"] = bool((repo.get("token") or "").strip())
    return shown


# --- the change log ----------------------------------------------------------

# `issues_audit` is the audit log **Non-goals** refuses, allowed for external
# connection settings only and bounded three ways: it records no person, it
# records no token value, and it never sees planning data. PROMPT.md amendment 7
# carries the argument; do not generalise it.

TOKEN_SET = "set"
TOKEN_CLEARED = "cleared"
TOKEN_CHANGED = "changed"
ADDED = "added"
REMOVED = "removed"


def _token_state(before, after):
    before, after = (before or "").strip(), (after or "").strip()
    if before == after:
        return None
    if not after:
        return ("", TOKEN_CLEARED)
    if not before:
        return ("", TOKEN_SET)
    return ("", TOKEN_CHANGED)


def audit_diff(before, after):
    """What changed between two repository lists, as change-log rows. No token values.

    Keyed by `repo_ref`, so editing the owner or the name of a repository reads as
    one removed and one added rather than as a rename -- which is what it is to
    the host as well.
    """
    old = {repo_ref(repo): repo for repo in before}
    new = {repo_ref(repo): repo for repo in after}
    rows = []
    for ref in old.keys() - new.keys():
        rows.append({"repo_ref": ref, "field": "repository", "old": ref, "new": ""})
    for ref in new.keys() - old.keys():
        rows.append({"repo_ref": ref, "field": "repository", "old": "", "new": ref})
        # A repository arriving with a token already set is worth a line of its
        # own: "added" says nothing about whether it can authenticate.
        if (new[ref].get("token") or "").strip():
            rows.append({"repo_ref": ref, "field": "token", "old": "", "new": TOKEN_SET})
    for ref in old.keys() & new.keys():
        for field in REPO_FIELDS:
            was, now = old[ref].get(field), new[ref].get(field)
            if was != now:
                rows.append({
                    "repo_ref": ref,
                    "field": field,
                    "old": "" if was is None else str(was),
                    "new": "" if now is None else str(now),
                })
        moved = _token_state(old[ref].get("token"), new[ref].get("token"))
        if moved:
            rows.append({"repo_ref": ref, "field": "token", "old": moved[0], "new": moved[1]})
    return sorted(rows, key=lambda row: (row["repo_ref"], row["field"]))


# --- reading a host ----------------------------------------------------------


def http_client(timeout=FETCH_TIMEOUT_SECONDS):
    """The client every host call goes through. One seam, so a test can stub the host."""
    return httpx.Client(timeout=timeout)


def fetch_repo(repo, state="open", limit=DEFAULT_LIMIT, timeout=FETCH_TIMEOUT_SECONDS):
    """Read one repository's issues. Raises `IssuesError` naming what the host said."""
    url = issues_url(repo)
    try:
        with http_client(timeout) as client:
            response = client.get(url, headers=request_headers(repo),
                                  params=request_params(repo, state, limit))
    except httpx.HTTPError as error:
        raise IssuesError(f"Could not reach {url} -- {error}.") from error

    if response.status_code == 401 or response.status_code == 403:
        raise IssuesError(
            f"The host refused the token ({response.status_code}). Check that it is "
            "current and that it can read issues on this repository."
        )
    if response.status_code == 404:
        # Private-and-unauthenticated looks exactly like missing on all three
        # hosts, and saying so saves the obvious wrong guess.
        raise IssuesError(
            "The host has no such repository, or the token cannot see it (404)."
        )
    if response.status_code != 200:
        raise IssuesError(f"The host answered {response.status_code} for {url}.")
    try:
        payload = response.json()
    except ValueError as error:
        raise IssuesError(f"{url} did not answer with JSON.") from error
    if not isinstance(payload, list):
        raise IssuesError(f"{url} answered with something other than a list of issues.")

    provider = repo.get("provider")
    return [normalise_issue(repo, raw) for raw in payload
            if isinstance(raw, dict) and not is_pull_request(provider, raw)]


def fetch_total(repo, state="open", timeout=FETCH_TIMEOUT_SECONDS):
    """How many issues one repository has in that state, or None if the host will not say."""
    url = total_url(repo)
    try:
        with http_client(timeout) as client:
            response = client.get(url, headers=request_headers(repo),
                                  params=total_params(repo, state))
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return total_from(repo, response.headers, payload)


def fetch_totals(repos, states=("open", "closed", "all"),
                 timeout=FETCH_TIMEOUT_SECONDS):
    """Totals per state across every enabled repository. A readout, and best-effort.

    A host that will not give a count contributes nothing rather than a zero, and
    `partial` says so -- "0 closed" and "nobody would tell me" must not read the
    same way. Called once when the tab opens, not on every filter change: it is
    one small request per repository per state.
    """
    totals = {}
    partial = False
    for state in states:
        running = 0
        counted = False
        for repo in repos:
            if not repo.get("enabled", True):
                continue
            found = fetch_total(repo, state, timeout)
            if found is None:
                partial = True
                continue
            running += found
            counted = True
        totals[state] = running if counted else None
    return {"totals": totals, "partial": partial}


def test_repo(repo, timeout=FETCH_TIMEOUT_SECONDS):
    """Ask a repository for one issue, to prove the URL and the token before a save.

    The one place a token that is not yet stored is used: the page sends what was
    just typed, this tries it, and nothing about the attempt is written down.
    """
    found = fetch_repo(repo, "open", 1, timeout)
    return {"ok": True, "open": len(found), "repo_ref": repo_ref(repo)}


def fetch_all(repos, state="open", limit=DEFAULT_LIMIT, timeout=FETCH_TIMEOUT_SECONDS):
    """Read every enabled repository. One host being down never blanks the page.

    Returns the issues, a per-repository count, and the failures beside them --
    a missing repository has to be visible as a failure rather than as a zero,
    or the panel quietly under-reports the thing it exists to surface.
    """
    issues, counts, errors = [], [], []
    for repo in repos:
        if not repo.get("enabled", True):
            continue
        ref, label = repo_ref(repo), repo_label(repo)
        try:
            found = fetch_repo(repo, state, limit, timeout)
        except IssuesError as error:
            errors.append({"repo_ref": ref, "repo_label": label, "message": str(error)})
            counts.append({"repo_ref": ref, "repo_label": label, "count": None})
            continue
        issues.extend(found)
        counts.append({"repo_ref": ref, "repo_label": label, "count": len(found)})
    return {"issues": issues, "counts": counts, "errors": errors}
