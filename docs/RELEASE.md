# Signed releases and GitHub hosting

This release setup follows nfvcsd/eaglercraft-blocker: manually dispatch an Actions workflow, sign a CRX3, publish an immutable GitHub Release, verify anonymous download, then deploy updates.xml to GitHub Pages. Source changes alone never publish a release.

## New identity and OAuth

The old private key is unavailable. `release-identity.json` contains the new release ID, public key, and registered OAuth client ID. Keep the corresponding private key outside this repository and back it up in approved secret storage. Never regenerate it for a routine release. The build rejects keys that do not match this file.

The root manifest retains the existing unpacked extension's key and OAuth client so local development remains usable. The release build overrides both values in a temporary staging folder. Consequently, the installed release has a DIFFERENT extension ID from the current unpacked extension. Existing installations will not update into it; deploy the new ID and remove the old installation when appropriate. Locally saved warnings will not migrate automatically.

The **Docs Translator — GitHub Release** Chrome Extension OAuth client is registered in project `heroic-mechanic-508719-k0` for extension ID `hhanmjkigacbhkgidgakdlpkihlgajpd`. Drive and Docs APIs are enabled, the audience is Internal, and the consent configuration declares `https://www.googleapis.com/auth/drive`.

The public client ID is `1019462553183-ujdlat1cdah4si4og249apl0i3k7l4gk.apps.googleusercontent.com`. Builds use this value from `release-identity.json` by default. An optional GitHub environment variable `OAUTH_CLIENT_ID` or local `--oauth-client-id` argument overrides it for a separately registered client. No client secret is used. Only a live sign-in can confirm district authorization works; Google Admin API controls may still require approval.

## One-time GitHub setup

Repository: [`nfvcsd/Google-Docs-Translator`](https://github.com/nfvcsd/Google-Docs-Translator).

1. Publish the reviewed source to a public distribution repository with default branch `main`. Release assets and the feed must be anonymously accessible. Never add the signing PEM to Git.
2. Create the `pilot-release` environment, restrict it to `main`, and configure reviewers as appropriate for district operations.
3. Add environment secret `CRX_PRIVATE_KEY_B64` containing the base64-encoded new private key. Transfer it directly using a secret-management UI or CLI, never through chat. The public OAuth client is already configured; `OAUTH_CLIENT_ID` is an optional override.
4. Set Pages source to **GitHub Actions** and allow deployments from `pilot-release`.
5. Run **Signed pilot release** from `main`. This requires Chrome, Python, OpenSSL and gh on the Ubuntu runner. Pin Actions to reviewed commit SHAs before broader production deployment.

The configured GitHub Pages update feed is:

`https://nfvcsd.github.io/Google-Docs-Translator/updates.xml`

The build derives URLs from the actual GitHub repository, so a different repository name is supported without editing scripts. It packages only the five extension runtime files. Keys, tests and repository documentation are excluded.

## Managed deployment and subsequent releases

Use your existing managed Chrome/Jamf deployment process with the new extension ID and feed URL. With Chrome `ExtensionSettings`, use an entry keyed by the new ID containing `installation_mode: force_installed`, `update_url: <feed URL>`, and `override_update_url: true`. Confirm the policy is applied in `chrome://policy`. Self-hosted distribution is intended for supported managed devices; a public CRX download is not a general consumer install mechanism on Windows/macOS.

Before expanding deployment, test fresh installation and a same-ID upgrade on the district network, including GitHub's redirected asset download hosts. Test OAuth consent and formatted copies under a normal staff account. Hosting availability is not proof that enterprise installation or OAuth works.

For each release, increase the root manifest's numeric version, review changes, push to `main`, and dispatch the workflow. The workflow refuses to overwrite an existing release tag. If Release upload succeeds but Pages fails, restore the completed Pages artifact or publish a higher version; rerunning the entire workflow will stop at the existing release. Roll back behavior by publishing the older code with a higher version.

## Local validation

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -v
node --check sidepanel.js
node --check service-worker.js
python3 scripts/build.py --key /secure/path/signing.pem --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --repository nfvcsd/Google-Docs-Translator --expected-id hhanmjkigacbhkgidgakdlpkihlgajpd
```

Build outputs go into ignored `.dist/`. An OAuth-looking test value can validate packaging, but cannot validate sign-in; never publish that package. The source manifest is not modified by packaging.

References: [reference workflow](https://github.com/nfvcsd/eaglercraft-blocker/blob/main/.github/workflows/release.yml), [Chrome enterprise policies](https://support.google.com/chrome/a/answer/7532015), [self-hosted packaging and update format](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux).
