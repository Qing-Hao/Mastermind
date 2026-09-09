"""The issue reader: URL and header shapes, normalising, the change log.

Mirrors `app/issues.py`. Everything here is offline -- the pure half needs no
network by construction, and the reading half goes through `issues.http_client`,
the one seam, stubbed with `httpx.MockTransport`.
"""

import json

import httpx
import pytest

from app import issues


# --- URL shapes ---------------------------------------------------------------


def test_cloud_defaults_need_no_base_url():
    assert issues.api_root(issues.GITHUB) == "https://api.github.com"
    assert issues.api_root(issues.GITLAB) == "https://gitlab.com/api/v4"


def test_a_typed_host_gains_its_providers_api_suffix():
    assert issues.api_root(issues.FORGEJO, "https://git.example.com") == \
        "https://git.example.com/api/v1"
    assert issues.api_root(issues.GITLAB, "https://gitlab.example.com/") == \
        "https://gitlab.example.com/api/v4"
    # GitHub Enterprise, which is the only reason the suffix is not just /api/v1.
    assert issues.api_root(issues.GITHUB, "https://github.example.com") == \
        "https://github.example.com/api/v3"


def test_the_suffix_is_not_added_twice_to_a_pasted_api_root():
    """People paste the API root as often as the host root. Both must work."""
    assert issues.api_root(issues.FORGEJO, "https://git.example.com/api/v1") == \
        "https://git.example.com/api/v1"
    assert issues.api_root(issues.GITHUB, "https://api.github.com") == \
        "https://api.github.com"


def test_gitlab_addresses_a_project_by_its_encoded_full_path():
    repo = {"provider": issues.GITLAB, "owner": "group/sub", "repo": "planner"}
    assert issues.issues_url(repo) == \
        "https://gitlab.com/api/v4/projects/group%2Fsub%2Fplanner/issues"


def test_github_and_forgejo_address_a_repository_by_path():
    assert issues.issues_url({"provider": issues.GITHUB, "owner": "core", "repo": "mm"}) == \
        "https://api.github.com/repos/core/mm/issues"
    forgejo = {"provider": issues.FORGEJO, "base_url": "https://git.example.com",
               "owner": "core", "repo": "mm"}
    assert issues.issues_url(forgejo) == "https://git.example.com/api/v1/repos/core/mm/issues"


def test_a_forgejo_repository_without_a_host_is_refused():
    with pytest.raises(issues.IssuesError):
        issues.clean_repo({"provider": issues.FORGEJO, "owner": "core", "repo": "mm"})


# --- headers and parameters ---------------------------------------------------


def test_each_host_spells_authentication_its_own_way():
    token = "t0ken"
    github = issues.request_headers({"provider": issues.GITHUB, "token": token})
    gitlab = issues.request_headers({"provider": issues.GITLAB, "token": token})
    forgejo = issues.request_headers({"provider": issues.FORGEJO, "token": token})
    assert github["Authorization"] == "Bearer t0ken"
    assert gitlab["PRIVATE-TOKEN"] == "t0ken"
    assert forgejo["Authorization"] == "token t0ken"


def test_no_token_sends_no_authorization_header():
    """A public repository is readable unauthenticated, and should stay so."""
    headers = issues.request_headers({"provider": issues.GITHUB, "token": ""})
    assert "Authorization" not in headers


def test_gitlab_is_the_one_that_calls_an_open_issue_opened():
    assert issues.request_params({"provider": issues.GITLAB})["state"] == "opened"
    assert issues.request_params({"provider": issues.GITHUB})["state"] == "open"
    assert issues.request_params({"provider": issues.FORGEJO})["state"] == "open"


def test_the_page_size_parameter_differs_and_is_capped():
    assert issues.request_params({"provider": issues.FORGEJO}, limit=10)["limit"] == 10
    assert issues.request_params({"provider": issues.GITHUB}, limit=10)["per_page"] == 10
    assert issues.request_params({"provider": issues.GITHUB}, limit=5000)["per_page"] == \
        issues.MAX_LIMIT


# --- normalising --------------------------------------------------------------


def test_three_payloads_normalise_to_one_shape():
    github = issues.normalise_issue(
        {"provider": issues.GITHUB, "owner": "core", "repo": "mm"},
        {"number": 7, "title": "Import drops dependencies", "state": "open",
         "html_url": "https://github.com/core/mm/issues/7",
         "labels": [{"name": "bug"}], "user": {"login": "engineer"},
         "comments": 3, "created_at": "2026-09-01T09:00:00Z",
         "updated_at": "2026-09-08T09:00:00Z"},
    )
    gitlab = issues.normalise_issue(
        {"provider": issues.GITLAB, "owner": "core", "repo": "mm"},
        {"iid": 7, "title": "Import drops dependencies", "state": "opened",
         "web_url": "https://gitlab.com/core/mm/-/issues/7",
         "labels": ["bug"], "author": {"username": "engineer"},
         "user_notes_count": 3, "created_at": "2026-09-01T09:00:00Z",
         "updated_at": "2026-09-08T09:00:00Z"},
    )
    forgejo = issues.normalise_issue(
        {"provider": issues.FORGEJO, "base_url": "https://git.example.com",
         "owner": "core", "repo": "mm"},
        {"number": 7, "title": "Import drops dependencies", "state": "open",
         "html_url": "https://git.example.com/core/mm/issues/7",
         "labels": [{"name": "bug"}], "user": {"login": "engineer"},
         "comments": 3, "created_at": "2026-09-01T09:00:00Z",
         "updated_at": "2026-09-08T09:00:00Z"},
    )
    for issue in (github, gitlab, forgejo):
        assert issue["number"] == 7
        assert issue["title"] == "Import drops dependencies"
        # GitLab says "opened"; the app's vocabulary is GitHub's.
        assert issue["state"] == "open"
        assert issue["labels"] == ["bug"]
        assert issue["author"] == "engineer"
        assert issue["comments"] == 3
    # The link out is the feature, so every issue carries its host's own URL.
    assert github["url"].startswith("https://github.com/")
    assert gitlab["url"].startswith("https://gitlab.com/")
    assert forgejo["url"].startswith("https://git.example.com/")


def test_a_pull_request_is_not_an_issue():
    """GitHub lists pull requests among issues; counting them is wrong by every branch."""
    assert issues.is_pull_request(issues.GITHUB, {"pull_request": {"url": "..."}})
    assert not issues.is_pull_request(issues.GITHUB, {"title": "real"})
    # GitLab keeps merge requests on their own endpoint, so nothing to filter.
    assert not issues.is_pull_request(issues.GITLAB, {"pull_request": {"url": "..."}})


def test_a_missing_field_normalises_rather_than_raising():
    issue = issues.normalise_issue({"provider": issues.GITHUB, "owner": "c", "repo": "m"},
                                   {"title": "bare"})
    assert issue["labels"] == [] and issue["author"] == "" and issue["comments"] == 0
    assert issue["url"] == ""


# --- the configured repositories ----------------------------------------------


def test_a_repository_is_identified_by_provider_and_path():
    repo = {"provider": "GitHub", "owner": "core", "repo": "mm"}
    assert issues.repo_ref(repo) == "github:core/mm"


def test_a_label_falls_back_to_the_path():
    assert issues.repo_label({"provider": "github", "owner": "core", "repo": "mm"}) == "core/mm"
    assert issues.repo_label({"provider": "github", "owner": "core", "repo": "mm",
                              "label": "Planner"}) == "Planner"


def test_an_unknown_provider_is_refused():
    with pytest.raises(issues.IssuesError):
        issues.clean_repo({"provider": "bitbucket", "owner": "core", "repo": "mm"})


def test_a_broken_column_reads_as_no_repositories_rather_than_an_exception():
    """The column is written by this app alone, so a broken one must not take the page down."""
    assert issues.repos_from_json("not json at all") == []
    assert issues.repos_from_json(json.dumps({"not": "a list"})) == []
    assert issues.repos_from_json("") == []


def test_one_unusable_entry_does_not_discard_the_usable_ones():
    stored = json.dumps([
        {"provider": "github", "owner": "core", "repo": "mm"},
        {"provider": "bitbucket", "owner": "core", "repo": "other"},
    ])
    repos = issues.repos_from_json(stored)
    assert [issues.repo_ref(repo) for repo in repos] == ["github:core/mm"]


def test_the_token_never_leaves_the_server():
    shown = issues.without_token({"provider": "github", "owner": "core", "repo": "mm",
                                  "token": "secret", "enabled": True})
    assert "token" not in shown
    assert shown["token_set"] is True
    # Not the tail of it either. The Sign-in page already echoes one secret.
    assert "secret" not in json.dumps(shown)


# --- the change log -----------------------------------------------------------


def test_adding_and_removing_a_repository_are_logged():
    repo = {"provider": "github", "owner": "core", "repo": "mm"}
    added = issues.audit_diff([], [repo])
    assert {"repo_ref": "github:core/mm", "field": "repository",
            "old": "", "new": "github:core/mm"} in added
    removed = issues.audit_diff([repo], [])
    assert removed[0]["new"] == ""


def test_a_changed_field_is_logged_with_both_values():
    before = [{"provider": "github", "owner": "core", "repo": "mm", "label": "Planner"}]
    after = [{"provider": "github", "owner": "core", "repo": "mm", "label": "Mastermind"}]
    rows = issues.audit_diff(before, after)
    assert rows == [{"repo_ref": "github:core/mm", "field": "label",
                     "old": "Planner", "new": "Mastermind"}]


def test_a_token_is_logged_as_the_fact_that_it_changed_and_never_as_a_value():
    """The change log has no `issues_` prefix protecting it. A value here is a second copy."""
    before = [{"provider": "github", "owner": "core", "repo": "mm", "token": "old-secret"}]
    after = [{"provider": "github", "owner": "core", "repo": "mm", "token": "new-secret"}]
    rows = issues.audit_diff(before, after)
    assert rows == [{"repo_ref": "github:core/mm", "field": "token",
                     "old": "", "new": issues.TOKEN_CHANGED}]
    assert "secret" not in json.dumps(rows)

    cleared = issues.audit_diff(before, [{"provider": "github", "owner": "core",
                                          "repo": "mm", "token": ""}])
    assert cleared[0]["new"] == issues.TOKEN_CLEARED
    assert issues.audit_diff([], after)[-1]["new"] == issues.TOKEN_SET


def test_an_unchanged_list_logs_nothing():
    repo = {"provider": "github", "owner": "core", "repo": "mm", "token": "same"}
    assert issues.audit_diff([repo], [dict(repo)]) == []


def test_the_change_log_records_no_person():
    """Amendment 7's bound: what changed and when, never who. Checked, not assumed."""
    rows = issues.audit_diff([], [{"provider": "github", "owner": "core", "repo": "mm"}])
    for row in rows:
        assert set(row) == {"repo_ref", "field", "old", "new"}


# --- reading a host -----------------------------------------------------------


def stub_host(monkeypatch, handler):
    """Point `issues.http_client` at a stub. The one seam every host call goes through."""
    monkeypatch.setattr(
        issues, "http_client",
        lambda timeout=None: httpx.Client(transport=httpx.MockTransport(handler)),
    )


def test_a_repository_is_read_and_pull_requests_are_dropped(monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=[
            {"number": 1, "title": "Real", "state": "open",
             "html_url": "https://github.com/core/mm/issues/1"},
            {"number": 2, "title": "A branch", "state": "open",
             "pull_request": {"url": "..."},
             "html_url": "https://github.com/core/mm/pull/2"},
        ])

    stub_host(monkeypatch, handler)
    found = issues.fetch_repo({"provider": "github", "owner": "core", "repo": "mm",
                               "token": "t0ken"})
    assert [issue["title"] for issue in found] == ["Real"]
    assert seen["url"].startswith("https://api.github.com/repos/core/mm/issues")
    assert "state=open" in seen["url"]
    assert seen["auth"] == "Bearer t0ken"


def test_a_refused_token_says_so_rather_than_reading_as_empty(monkeypatch):
    stub_host(monkeypatch, lambda request: httpx.Response(401, json={"message": "Bad"}))
    with pytest.raises(issues.IssuesError) as raised:
        issues.fetch_repo({"provider": "github", "owner": "core", "repo": "mm"})
    assert "token" in str(raised.value)


def test_a_404_names_the_private_repository_case(monkeypatch):
    """Private-and-unauthenticated looks exactly like missing on all three hosts."""
    stub_host(monkeypatch, lambda request: httpx.Response(404, json={}))
    with pytest.raises(issues.IssuesError) as raised:
        issues.fetch_repo({"provider": "github", "owner": "core", "repo": "mm"})
    assert "cannot see it" in str(raised.value)


def test_an_unreachable_host_is_an_error_not_a_traceback(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("no route to host", request=request)

    stub_host(monkeypatch, handler)
    with pytest.raises(issues.IssuesError):
        issues.fetch_repo({"provider": "github", "owner": "core", "repo": "mm"})


def test_one_dead_repository_never_blanks_the_others(monkeypatch):
    """A missing repository has to read as a failure, never as a zero."""
    def handler(request):
        if "dead" in str(request.url):
            return httpx.Response(500, json={})
        return httpx.Response(200, json=[
            {"number": 1, "title": "Real", "state": "open",
             "html_url": "https://github.com/core/live/issues/1"},
        ])

    stub_host(monkeypatch, handler)
    result = issues.fetch_all([
        {"provider": "github", "owner": "core", "repo": "live"},
        {"provider": "github", "owner": "core", "repo": "dead"},
    ])
    assert [issue["title"] for issue in result["issues"]] == ["Real"]
    assert [error["repo_ref"] for error in result["errors"]] == ["github:core/dead"]
    counts = {row["repo_ref"]: row["count"] for row in result["counts"]}
    assert counts == {"github:core/live": 1, "github:core/dead": None}


def test_a_disabled_repository_is_not_asked(monkeypatch):
    def handler(request):
        raise AssertionError("a disabled repository was read")

    stub_host(monkeypatch, handler)
    result = issues.fetch_all([{"provider": "github", "owner": "core", "repo": "mm",
                                "enabled": False}])
    assert result == {"issues": [], "counts": [], "errors": []}


# --- how many there are -------------------------------------------------------


def test_github_counts_through_search_because_its_list_counts_branches():
    repo = {"provider": issues.GITHUB, "owner": "core", "repo": "mm"}
    assert issues.total_url(repo) == "https://api.github.com/search/issues"
    params = issues.total_params(repo, "open")
    assert params["q"] == "repo:core/mm is:issue state:open"
    # `all` drops the state term rather than sending "state:all", which the
    # search syntax has no word for.
    assert issues.total_params(repo, "all")["q"] == "repo:core/mm is:issue"
    assert issues.total_from(repo, {}, {"total_count": 42}) == 42


def test_the_other_two_count_from_a_header_on_a_one_row_page():
    gitlab = {"provider": issues.GITLAB, "owner": "core", "repo": "mm"}
    forgejo = {"provider": issues.FORGEJO, "base_url": "https://git.example.com",
               "owner": "core", "repo": "mm"}
    assert issues.total_url(gitlab).endswith("/issues")
    assert issues.total_params(gitlab, "open")["per_page"] == 1
    assert issues.total_from(gitlab, {"X-Total": "17"}, []) == 17
    assert issues.total_from(forgejo, {"X-Total-Count": "9"}, []) == 9


def test_forgejo_asks_the_host_to_leave_pull_requests_out():
    """Unlike GitHub's, Forgejo's endpoint can be told -- so its total is right too."""
    assert issues.request_params({"provider": issues.FORGEJO})["type"] == "issues"
    assert "type" not in issues.request_params({"provider": issues.GITHUB})


def test_a_host_that_gives_no_count_reads_as_unknown_not_zero():
    gitlab = {"provider": issues.GITLAB, "owner": "core", "repo": "mm"}
    assert issues.total_from(gitlab, {}, []) is None
    assert issues.total_from(gitlab, {"X-Total": "not a number"}, []) is None


def test_totals_are_summed_across_repositories_and_say_when_partial(monkeypatch):
    def handler(request):
        if "quiet" in str(request.url):
            # A host that answers without the header: it contributes nothing, and
            # the readout has to admit the total is incomplete.
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[], headers={"X-Total": "5"})

    stub_host(monkeypatch, handler)
    answer = issues.fetch_totals(
        [{"provider": "gitlab", "owner": "core", "repo": "loud"},
         {"provider": "gitlab", "owner": "core", "repo": "quiet"}],
        states=("open",))
    assert answer["totals"]["open"] == 5
    assert answer["partial"] is True


def test_a_totals_read_never_raises(monkeypatch):
    """A count is a nicety beside the list; a host being down must not cost the page."""
    def handler(request):
        raise httpx.ConnectError("no route to host", request=request)

    stub_host(monkeypatch, handler)
    answer = issues.fetch_totals([{"provider": "gitlab", "owner": "c", "repo": "m"}],
                                 states=("open",))
    assert answer == {"totals": {"open": None}, "partial": True}


# --- testing a connection before it is saved ----------------------------------


def test_a_connection_test_asks_for_one_issue(monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json=[
            {"number": 1, "title": "Real", "state": "open",
             "html_url": "https://github.com/core/mm/issues/1"},
        ])

    stub_host(monkeypatch, handler)
    answer = issues.test_repo({"provider": "github", "owner": "core", "repo": "mm",
                               "token": "t0ken"})
    assert answer == {"ok": True, "open": 1, "repo_ref": "github:core/mm"}
    assert "per_page=1" in seen["url"]


def test_a_bad_token_fails_the_test_by_name(monkeypatch):
    stub_host(monkeypatch, lambda request: httpx.Response(403, json={}))
    with pytest.raises(issues.IssuesError) as raised:
        issues.test_repo({"provider": "github", "owner": "core", "repo": "mm",
                          "token": "wrong"})
    assert "token" in str(raised.value)


# --- the flag -----------------------------------------------------------------


def test_the_feature_is_off_unless_the_environment_says_otherwise(monkeypatch):
    monkeypatch.delenv(issues.ENV_ISSUES, raising=False)
    assert not issues.is_enabled()
    for word in ("on", "1", "true", "YES"):
        monkeypatch.setenv(issues.ENV_ISSUES, word)
        assert issues.is_enabled()
    monkeypatch.setenv(issues.ENV_ISSUES, "off")
    assert not issues.is_enabled()
