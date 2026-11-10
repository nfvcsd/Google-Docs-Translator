# Google Docs English → Spanish Translator: Agent Guide

Read this whole file before changing the repository. It records how the code works today, the invariants that must not regress, and how to validate a change. If this file and the code disagree, trust the code, then fix this file in the same change.

## Project Overview

A Chrome Manifest V3 extension (plain JavaScript/HTML/CSS, no bundler) that translates Google Docs from English to Spanish using Chrome's built-in, on-device Translator API. It is built for North Fayette Valley CSD staff and deployed to managed Chrome as a signed, self-hosted CRX.

Two user workflows live in the side panel:

1. **Plain-text preview.** Export the open Doc as text, translate it locally, then show, copy, or save it as `.txt`. No extension OAuth is needed.
2. **Formatted Spanish copy (preferred).** Copy the source (or convert an Office file) into a new native Google Doc, translate the text in place in that copy, and add a translated warning to every tab. The source is never modified.

Current version: **1.1.4** (`manifest.json` is the source of truth).

## Repository Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest with the **development** identity (key + OAuth client). Version source of truth. |
| `sidepanel.html` / `sidepanel.css` | Side panel UI. |
| `sidepanel.js` | All extension logic: export, translation, Drive/Docs API calls, warning insertion. |
| `service-worker.js` | Only sets `openPanelOnActionClick` on install/startup. |
| `release-identity.json` | **Release** extension ID, public key, and OAuth client ID. Public values, reviewed. |
| `scripts/build.py` | Python (stdlib only) release builder: stages the 5 runtime files, injects the release identity, signs a CRX3 with Chrome, verifies it, and writes `.dist/` plus the update feed. |
| `tests/translation.test.cjs` | `node:test` suite that runs `sidepanel.js` in a `vm` sandbox with mocked Chrome/Google APIs. |
| `tests/test_release.py` | `unittest` suite for `build.py` (identity checks, version validation, update XML). |
| `.github/workflows/test.yml` | CI: syntax checks and both test suites on every push and PR. |
| `.github/workflows/release.yml` | Manually dispatched signed pilot release (see Releases). |
| `docs/RELEASE.md` | Operator guide for signing, GitHub setup, and managed deployment. |
| `README.md`, `CHANGELOG.md` | Public user/admin docs and release notes. |
| `CLAUDE.md` | Imports this file (`@AGENTS.md`). Keep the filename and the import in sync. |

Build output goes to `.dist/`, which is git-ignored. `*.pem` and `*.key` are git-ignored as well.

## Two Extension Identities

There are deliberately two identities. Do not merge them or swap them.

| | Development (unpacked) | Release (signed CRX) |
| --- | --- | --- |
| Defined in | `manifest.json` `key` + `oauth2.client_id` | `release-identity.json` |
| Extension ID | `nmeknfnkopnkomanaldgmflbmileinko` | `hhanmjkigacbhkgidgakdlpkihlgajpd` |
| OAuth client | `1019462553183-urekqshigj6dquk83ikl3d6ro0292r0k…` | `1019462553183-ujdlat1cdah4si4og249apl0i3k7l4gk…` |

- `build.py` overrides `key` and `oauth2.client_id` and adds `update_url` **only in a temporary staging copy**. The root `manifest.json` must never be rewritten by the build (a test enforces this).
- The build refuses a signing key whose derived ID or public key differs from `release-identity.json`. Never regenerate the release key for a routine release, because that changes the extension ID for every managed device.
- Users on different identities do not share locally saved warning text.
- OAuth client IDs and public keys are public configuration, not secrets. The CRX private key is a secret. It lives only in the `CRX_PRIVATE_KEY_B64` GitHub environment secret and in approved offline storage, never in the repo or in chat.
- Both OAuth clients are of type **Chrome Extension** (no client secret) in Google Cloud project `heroic-mechanic-508719-k0`, with an Internal audience and the Drive and Docs APIs enabled.
- The side panel treats a `client_id` starting with `REPLACE_WITH_` as unconfigured and shows setup instructions. Forks of the project use this placeholder path.

## Permissions and Scopes

| Permission | Why it is needed |
| --- | --- |
| `sidePanel` | The UI. |
| `scripting` | Runs the text export `fetch` in the Docs tab's MAIN world so it carries the page's session and account. |
| `clipboardWrite` | Copy the preview and the extension ID. |
| `identity` | `chrome.identity.getAuthToken` for Drive/Docs. |
| Host: `docs.google.com`, `*.googleusercontent.com` | Text export and its redirect host. |
| Host: `www.googleapis.com`, `docs.googleapis.com` | Drive v3 and Docs v1 APIs. |

The OAuth scope is the full `https://www.googleapis.com/auth/drive`. `drive.file` is not enough, because the extension must read, copy, and download source files the app did not create. This is a known, documented tradeoff (see README "Privacy and permissions"). Do not broaden permissions, and do not change the scope without explaining the reason and the Google Admin and consent impact. `minimum_chrome_version` is `138`, the first version with the Translator API.

## How the Code Works

### Finding the document (`getDocInfoFromUrl`, `getActiveDocsTab`)

- Matches `docs.google.com/document/[u/<n>/]d/<id>` and also accepts `?authuser=`.
- **Preserve the `/u/<n>/` account selector** when building export URLs. Earlier versions broke multi-account users by dropping it.

### Plain-text preview (`loadDocument`, `extractOpenDoc`, `translateDocument`)

1. Fetch `…/export?format=txt` from inside the Docs page (`chrome.scripting.executeScript`, `world: 'MAIN'`, `credentials: 'include'`), then fall back to an extension-context fetch.
2. `validateExportResponse` rejects non-OK responses and sign-in redirects (HTML or `accounts.google.com`).
3. Text is split by `splitText` (default 3,200 chars) and translated chunk by chunk.
4. If the export fails but the doc ID is known, `sourceDocId` is kept so the formatted copy can still run. A test covers this. Do not regress it.

The only DOM dependency is reading the title from `input.docs-title-input`, with `document.title` as a fallback. Do not add DOM scraping of document content, because the Docs editor is canvas-based and its class names change.

### Formatted copy (`createSpanishGoogleDoc`), in order

1. **`getTranslator()` runs first, directly from the click handler**, before any OAuth or network `await`. `Translator.create` may need the user activation to download the language pack, and an availability probe or earlier await can use up that activation. If model preparation fails, no OAuth prompt is shown and no Drive file is created. Tests enforce this order.
2. `getGoogleAccessToken(true)`, the OAuth step. A 401 clears the cached token and retries once (`googleFetch`).
3. `createEditableGoogleDocCopy`:
   - Native Doc (`application/vnd.google-apps.document`): Drive `files.copy` named `<title> - Spanish`.
   - Anything else: checks Drive `about.importFormats`. If it can convert to a Google Doc, the code downloads the bytes and uploads them via multipart with the Docs MIME type into the source's first parent folder, then verifies the result is native. Never call Docs `batchUpdate` on an Office file.
   - All Drive calls pass `supportsAllDrives=true` (shared drives).
4. `getGoogleDocStructure` uses `includeTabsContent=true`. `createRevisionWriter` starts from the returned `revisionId`.
5. `collectTranslationOperations` walks every tab (including nested `childTabs`), the body, headers, footers, footnotes, table cells, and tables of contents. Header segments are skipped when the **Translate document headers** checkbox (`translateHeadersInput`, default on) is cleared. The value is read once when the run starts, and the checkbox is disabled until the run ends. Per paragraph:
   - All text runs with identical filtered style → one operation for the whole paragraph (better sentence context).
   - Mixed styles or non-text elements → one operation per run, so each run's style can be restored.
   - Leading and trailing whitespace stays outside the replaced range (`splitCoreRange`). Ranges with no letters are skipped.
6. The **warning is translated** with the same translator instance but not inserted yet.
7. `translateOperations` handles each op, chunking above `TRANSLATION_CHUNK_LIMIT` (2,800).
8. `applyTranslationsToGoogleDoc` does the following:
   - Sorts by `(tabId, segmentId)`, then **descending `startIndex`**, so earlier indexes stay valid.
   - Builds `deleteContentRange` → `insertText` → `updateTextStyle` (the style whitelist is in `filterTextStyle`) for each op.
   - Sends batches of `API_REPLACEMENTS_PER_BATCH` (45) ops through the revision writer.
9. Re-reads the structure, then `addTranslationWarningToGoogleDoc` runs for **every tab**:
   - Paged tab: uses the default header, creating one with `createHeader` if it is missing, plus every existing header ID (first-page, even, and so on). Inserts `"<warning>\n"` at index 0 in bold.
   - Pageless tab (`documentMode === 'PAGELESS'`): inserts `"<warning>\n\n"` at body index 1 in bold.
   - Fails if the snapshot's `revisionId` differs from the writer's last revision.

### Revision-guarded writes (`createRevisionWriter`)

Every `batchUpdate` sends `writeControl.requiredRevisionId` and adopts the revision Google returns. On any error, the writer **stops permanently**: no retries, and it never adopts a fresh revision for stale index ranges. A revision mismatch produces a "document changed during translation" error. This protects the copy from concurrent edits and index corruption. Keep it fail-closed.

### Translation warning

- Default text is `DEFAULT_TRANSLATION_WARNING` in `sidepanel.js`. Users edit it in English.
- Stored in the side panel's `localStorage` under `gdocsSpanishTranslationWarning`, saved on `change`/`blur`. Saving an empty value or the default text removes the key. **Reset default** restores it.
- Always translated before insertion and inserted after the body pass (see steps 6 and 9). It is still added to headers when header translation is off.

### Header translation option

- `translateHeadersInput` in the formatted-copy card is checked by default.
- Only an opt-out is stored: `localStorage` key `gdocsSpanishTranslateHeaders` = `'false'`. Re-checking the box removes the key, so a missing value always means "translate headers".
- It affects only `documentTab.headers` text. Footers, footnotes, the body, and warning placement are unchanged.

### Errors and partial copies

- `googleJson` maps 403s to "API not enabled" or "permission/scope denied" messages and otherwise includes the status and Google's message.
- OAuth errors distinguish an invalid client from other authorization failures.
- If anything fails after the copy exists, the status says a possibly partial Doc remains in Drive. The extension never deletes files automatically. If you add cleanup, it must target only the file this run created, and it must be explicit to the user.

## Invariants (Do Not Regress)

1. The source document is never modified. All writes target the created copy's ID.
2. Translation stays on-device via Chrome's Translator API. Never send document text to a third-party service, and never silently fall back to one.
3. The translator is prepared before OAuth or Drive calls.
4. Office sources are converted to native Docs before any Docs API edit.
5. The `/u/<n>/` account selector is preserved.
6. Replacements are applied in descending index order per tab and segment, and translated length is never assumed to equal source length.
7. All Docs writes go through the revision writer and fail closed.
8. The warning is configurable, translated, and added to every tab (header for paged tabs, top of body for pageless tabs), whether or not header text is translated.
9. Preview export failure does not block the formatted copy.
10. No telemetry or analytics. Do not log document contents or OAuth tokens. Opt-in telemetry is possible only if explicitly requested, and it must never include content.
11. No hard-coded document IDs, user accounts, or tokens. No secrets in git.
12. Treat all document content as potentially containing student information (FERPA). Use sanitized sample docs in tests, issues, and screenshots.

## Code Conventions

- `sidepanel.js` is a classic script with top-level functions and `let` state. The test harness evaluates it in a `vm` context, calls those globals by name, overrides them with mocks, and strips the trailing `loadDocument();` line. Therefore:
  - Keep functions at the top level and named, or update the harness at the same time.
  - Keep `loadDocument();` as the file's final statement.
  - Do not convert to ES modules or add a bundler without a plan for the tests.
- Keep UI state in sync: every workflow sets the `translating`, `creatingDoc`, or `loadingDocument` flag, disables conflicting buttons, and re-enables them in `finally` via `refreshOAuthUi()`.
- User-facing errors should say what failed (OAuth, Drive, Docs, translator, conversion, permissions, partial copy) and what to do next.
- Tooling and scripts are Python 3, standard library only (`build.py` has no dependencies). Prefer Python for new automation, keep it readable, and add `unittest` coverage.
- Prefer small, targeted changes over rewrites.

## Validation

Run these before proposing any change (CI runs the same on Node 22 and Ubuntu's Python 3):

```sh
node --check sidepanel.js && node --check service-worker.js
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -v
```

Add or update tests when you change the control flow, request building, revision handling, warning placement, or the build. The automated tests cannot prove live OAuth, rendering, or managed install. For those, use the manual checklist below.

### Manual checklist (before a release)

- **Native Doc:** OAuth succeeds; the copy is created and the original is unchanged; body, tables, headers, footers, and footnotes are translated; formatting and images are intact; the warning appears in Spanish.
- **DOCX opened in Docs:** detected and converted; the Spanish native Doc is created in the source folder; the original file is unchanged.
- **Header option:** with the box checked, header text is translated. With it cleared, header text stays English but the Spanish warning is still added. The setting persists after reopening the panel.
- **Multiple tabs:** nested tabs are translated, and every tab gets the warning.
- **Pageless doc:** the warning is visible at the top of the body.
- **Multi-account:** `/u/1/` URL works against the correct account.
- **Errors:** OAuth denied, translator unavailable, insufficient permissions, API disabled, invalid client, failed conversion, editing the copy mid-run (must stop with the "changed" message).
- **Managed install:** fresh install and same-ID upgrade from the update feed on a district device, with policy visible in `chrome://policy`.

## Releases and Deployment

The current deployment model is a self-hosted signed CRX, not the Chrome Web Store:

1. Bump `version` in `manifest.json`. Use 1–4 dot-separated integers ≤ 65535 with no leading zeros, not all zeros, and no pre-release suffix (`build.py` enforces this). Patch = fix, minor = feature, major = architecture or behavior change.
2. Add a `CHANGELOG.md` entry. Update README version references if needed.
3. Merge to `main`, then manually dispatch **Signed pilot release** (`release.yml`, `pilot-release` environment, `main` only). The workflow does the following:
   - Re-runs all checks.
   - Builds and signs the CRX with `CRX_PRIVATE_KEY_B64`. The `OAUTH_CLIENT_ID` environment variable is an optional override.
   - Creates the immutable GitHub Release `v<version>` (it refuses to overwrite an existing tag).
   - Verifies an anonymous download is byte-identical.
   - Deploys `updates.xml` to GitHub Pages.
4. Managed Chrome (Google Admin / Jamf) force-installs ID `hhanmjkigacbhkgidgakdlpkihlgajpd` from `https://nfvcsd.github.io/Google-Docs-Translator/updates.xml` with `override_update_url: true`. Pilot with a small OU or group first.

The package contains exactly the five runtime files (`manifest.json`, `service-worker.js`, `sidepanel.{js,html,css}`). The build verifies this. If you add a runtime file (for example icons), add it to `FILES` in `build.py`. Never package keys, tests, or docs.

To roll back, publish the older code under a higher version. If the Release succeeded but Pages failed, see `docs/RELEASE.md`. Rerunning the whole workflow stops at the existing tag.

Before broader production rollout, pin GitHub Actions to reviewed commit SHAs (this is still to do).

A Chrome Web Store private listing remains an option for later. If you pursue it, the store assigns its own ID and key, so a new OAuth client is needed, and installs would not upgrade across the change.

## Known Limitations

- English → Spanish only.
- Mixed-format paragraphs translate run by run, which can reduce translation quality.
- Text in images, comments, suggestions, and some smart chips or generated content is not translated.
- Closing the side panel interrupts the run, and there is no resume.
- No automatic cleanup of partial copies.

## Possible Future Work (Do Not Implement Unless Asked)

- Additional target languages.
- Admin-managed warning text and settings via `chrome.storage.managed`, including an organization-enforced warning.
- Translating selected sections only.
- Better progress reporting and resilience for very large documents.
- Broader automated coverage for footnotes, complex tables, and smart chips.
- Pinning Actions to SHAs. Chrome Web Store assets and privacy disclosures if that route is chosen.

## Guidance for AI Coding Agents

- Inspect the existing implementation and tests before changing architecture.
- Run the validation commands and report their results.
- Explain any new permission, host, or OAuth scope before adding it, including the Google Admin consent impact.
- Do not introduce a third-party translation service, a network dependency, or a build step without explicit approval.
- Treat Docs API indexes, tabs, and segment IDs carefully. Test assumptions against real API shapes rather than guessing.
- If a change can leave orphaned or partial Drive files, surface that clearly to the user.
- Keep this file, `README.md`, `docs/RELEASE.md`, and `CHANGELOG.md` consistent with the code.
