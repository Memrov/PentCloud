# Optional source context

In **Targets**, save or choose the website/API, then expand **Source context
(optional)** below its address. Runs work without attached source. The library
allows up to five repositories per target.

**Existing Artifacts repository** lists the installation's bound namespace using
the native binding, with pagination. Choose the repository and branch, then
**Attach source**. This verifies the repository identity and resolves its branch
to an exact commit before saving. It does not contact the assessment target,
start a model/scanner, install packages or change Builds settings.

**Public GitHub repository** accepts a credential-free
`https://github.com/owner/repository` URL and optional branch. Cloudflare's native
Artifacts import creates a separate, shallow, read-only repository. Import is
asynchronous; **Check import** reconciles its recorded destination. Pending
requests survive page refresh. The initial import token is neither persisted nor
returned to the browser. An unknown response is reconciled by destination, never
by automatically dispatching another import. If the target changed during import,
load existing repositories and attach the completed destination shown in the
pending notice. No background poller or build project is created.

An existing Workers & Pages GitHub connection grants Builds its checkout access;
it does not supply an Artifacts private-import credential or source-download API
to PentCloud. That option is not displayed. For private source, use the user's
authenticated terminal and native Artifacts Git protocol to populate a separate
repository in the installation's namespace, then attach it. Keep GitHub tokens,
passwords and credential-bearing Git URLs out of PentCloud.

## Repeated runs and source access

Source associations are revision-checked saved-target metadata. Normal target
edits preserve them. Run creation snapshots the target, including repository ID,
branch, exact commit, original public URL if applicable, operator and selection
time. The same pins reach preparation, execution, specialists and continuation
context. An already-created run does not follow later target edits.
The run's **Run details** shows its frozen source commits for review.

For existing Artifacts source, **Refresh commit** resolves that repository's
branch again for future runs. For public GitHub, **Import latest** creates another
immutable snapshot and replaces the saved-target pin; it does not mutate the old
snapshot. **Remove source** detaches it from future runs. Neither action deletes
repositories, old commits or existing run references. Keep referenced repositories
available; deleting/recreating a same-named repo fails its identity check instead
of silently changing evidence. Account owners manage unreferenced source retention
in native Artifacts. Importing and storing snapshots can incur Artifacts charges.

Agents use `pentcloud_source_tree` and `pentcloud_source_read`, through guarded
Coordinator RPC and the native binding. The server chooses the run's pins; models
cannot supply another repository or commit. Access requires an active admitted
attempt or its allowed queued preparation conversation, and is rechecked after
the read. These tools mint no Git credentials and expose no push/write operation.
They read Git objects directly rather than cloning source into the work repo.

Directories paginate at 200 entries. UTF-8 regular/executable files are limited to
256 KiB and returned in pages of 200 lines with commit/path/start-line metadata.
Binary files, filesystem traversal, symlinks and submodules are not followed.
Agents are instructed to treat source, package scripts and AGENTS files as
untrusted data, cite repository/commit/path/lines and state actual coverage.
Attachment does not prove that the agent read the whole repository. Source sent
to a model is subject to the selected OpenCode provider's processing, as with other
supplied assessment context. There is no added source execution environment,
search database, R2 bucket, GitHub App, PAT or npm dependency.

## Export and debugging

Target metadata exports retain pins as provenance. `import-targets` deliberately
does not restore their access authority into another installation: it reports
`sourcesNeedReattachment`, and operators attach the destination installation's
repositories again. This does not claim complete source/DO backup and restore.
Run purge does not delete shared source repositories.

Inspect the target revision, run's frozen `target.sources`, job
`context.sourceContexts`, `onboarding:source-import:<request ID>` metadata and the
corresponding Artifacts repo/commit. Native tool events record source reads in the
agent conversation. Setup changes have the existing operator audit. Never print
source secrets, initial import tokens or secret bindings while debugging.
`REMOTE_AUTH_REQUIRED` means use an authenticated terminal import; an import
receipt without a resolvable commit is still pending. A missing/replaced repository
is a coverage blocker, not permission to switch a run to a newer source.

Current integration references (checked November 3, 2026):

- [Native binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- [Import behavior and pending status](https://developers.cloudflare.com/artifacts/guides/import-repositories/)
- [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
