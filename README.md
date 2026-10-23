# Google Docs Translator

Translate Google Docs from English to Spanish using Chrome’s built-in, on-device Translator API. Preview the translated text in a side panel, or create a separate Spanish Google Doc that retains the source document’s structure and formatting where supported.

The original document is left unchanged.

[Download releases](https://github.com/nfvcsd/Google-Docs-Translator/releases) · [Changelog](CHANGELOG.md) · [Deployment guide](docs/RELEASE.md) · [Report an issue](https://github.com/nfvcsd/Google-Docs-Translator/issues)

## Features

- **Local translation:** English-to-Spanish translation runs on your device through Chrome.
- **Text preview:** Read the translation in a side panel, copy it, or save it as a `.txt` file.
- **Formatted copies:** Create a Spanish Google Doc while retaining tables, images, lists, headings, and supported text styles.
- **Word document support:** Convert supported Office files opened in Google Docs into native Google Docs before translating them.
- **Translation notices:** Customize an English notice that is translated and added to every document tab, including nested tabs. Pageless tabs receive the notice at the top of the body.
- **Concurrent-edit protection:** Stop updates if the copied document changes during translation, rather than applying outdated text ranges.

## Requirements

- Desktop Google Chrome 138 or newer with the Translator API available.
- Access to the source document in Google Docs.
- For formatted copies, an authorized Google account with permission to copy the source and edit the resulting document.

Chrome may need to download the English–Spanish language model on first use. Internet access is required to read Google Docs and create or update files in Google Drive.

**The bundled OAuth configuration is for North Fayette Valley Community School District users.** Users outside the district can use the local preview when document export is available, but need their own Google Cloud OAuth configuration to create formatted copies. See [Using this project in another organization](#using-this-project-in-another-organization).

## Installation

### Managed deployment

Signed `.crx` packages are available on the [releases page](https://github.com/nfvcsd/Google-Docs-Translator/releases). These packages are intended for supported, managed Chrome installations through an administrator’s deployment policy. Downloading a CRX is not a general-purpose installation method on Windows or macOS.

| Setting | Value |
| --- | --- |
| Signed extension ID | `hhanmjkigacbhkgidgakdlpkihlgajpd` |
| Update feed | `https://nfvcsd.github.io/Google-Docs-Translator/updates.xml` |

See the [deployment guide](docs/RELEASE.md) for signing, GitHub Actions, GitHub Pages, and Chrome policy configuration. Validate installation and automatic updates with a small pilot group before wider deployment.

### Local development and evaluation

1. Clone this repository or download and extract its source ZIP.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** and select **Load unpacked**.
4. Select the repository folder containing `manifest.json`.
5. Open a Google Doc and click the extension’s toolbar icon. You may need to pin it from Chrome’s Extensions menu.

The source manifest retains a separate development identity from the signed release. Loading the repository directly does not install the signed release identity or enable its automatic updates. See [OAuth setup](#using-this-project-in-another-organization) before testing formatted copies with your own account.

## Usage

### Preview a translation

1. Open an English document in Google Docs and open the extension’s side panel.
2. Select **Reload** if you have switched documents.
3. Select **Translate preview to Spanish**.
4. Use **Copy** or **Save .txt** to export the result.

The preview does not require the extension’s Google OAuth authorization. It uses your existing access to the open document. If text export fails, the authenticated formatted-copy option may still be available.

### Create a formatted Spanish copy

1. Open the source document and the extension’s side panel.
2. Review or customize the **Translation warning**.
3. Select **Create Spanish Google Doc** and complete Google authorization when prompted.
4. Keep the side panel open while translation runs, and avoid editing the new copy until it finishes.
5. Select **Open created Spanish Doc** to review the result.

The copy is named `Original document name - Spanish`. Supported Word files are converted to native Google Docs as part of this process. Review the translation before sharing it, especially where wording or formatting is important.

## Privacy and permissions

Translation is performed locally using Chrome’s Translator API. The extension does not send document text to a third-party translation service.

Creating a formatted copy communicates with Google Drive and Google Docs APIs using the Google account you authorize. This workflow requests the `https://www.googleapis.com/auth/drive` scope, which grants broad access to view, edit, create, and delete Drive files. The implemented workflow reads the source, creates a copy, and edits that copy; it does not modify the original or automatically delete files.

Your custom translation notice is stored locally in the browser profile. OAuth client IDs and public extension keys included in the repository are public configuration, not secrets. Private signing keys must remain outside the repository.

## Limitations

- Only English-to-Spanish translation is currently supported.
- Machine translations can contain errors and should be reviewed by a person.
- Mixed-format sentences are translated in smaller text runs to retain styling, which can reduce translation quality.
- Text embedded in images, comments, and suggestion discussions is not translated. Some smart chips and generated content may remain unchanged.
- Formatting preservation depends on the source document and Google’s conversion behavior; translated text may change pagination and layout.
- Office conversion is limited to formats supported by Google Drive.
- Large documents can take time. Closing the side panel interrupts the workflow; automatic resume is not supported.
- If an operation fails after a copy has been created, that file remains in Drive and may be partially translated. Review or delete it manually before trying again.

## Using this project in another organization

Formatted copies require an OAuth client registered to the extension ID you deploy. The district’s bundled client is not available to accounts outside its organization.

1. Create or select your own Google Cloud project and enable the **Google Drive API** and **Google Docs API**.
2. Configure the OAuth consent screen, audience, and Drive scope for your intended users.
3. Create an OAuth client with application type **Chrome Extension**, using your extension’s ID as the Item ID.
4. For unpacked development, replace `oauth2.client_id` in `manifest.json` with your client ID and reload the extension. Confirm the registered ID matches the ID displayed in `chrome://extensions`.
5. For signed distribution, use your own signing key and update `release-identity.json` with its derived extension ID, public key, and matching OAuth client ID. Follow the [deployment guide](docs/RELEASE.md) to configure your repository and update feed.

The release builder injects the release identity and OAuth client into the packaged manifest without changing the development manifest. Changing only the development manifest does not change the release OAuth client. No OAuth client secret is needed for this Chrome extension.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Translator API is unavailable | Use a supported desktop Chrome version and confirm that local translation is available in your browser environment. |
| Preview cannot read the document | Confirm access in the active Google account, select **Reload**, or try the formatted-copy option. |
| OAuth client configuration is invalid | Confirm the client type is **Chrome Extension** and that its registered ID matches the installed extension. |
| Google blocks authorization | Check whether your account belongs to the configured audience. Workspace administrators may need to approve the client in Google Admin API controls. |
| Drive or Docs API is disabled | Enable both APIs in the Cloud project that owns the OAuth client. |
| Translation stops because the document changed | Leave the incomplete copy for review and start a new translation from the source. Avoid editing the copy during processing. |

When [reporting an issue](https://github.com/nfvcsd/Google-Docs-Translator/issues), include the extension version, Chrome version, operating system, document type, and steps to reproduce. Use a sanitized example rather than sharing confidential documents or access tokens.

## Development

The extension uses Manifest V3 and plain JavaScript, HTML, and CSS. No bundler is required to load the source.

Run the automated checks with Node.js 22 and Python 3:

```sh
node --check sidepanel.js
node --check service-worker.js
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -v
```

GitHub Actions runs these checks on pushes and pull requests. The manual release workflow also validates the signing identity, publishes the signed package and checksum, verifies an anonymous download, and then deploys the update feed.

Automated checks cover translation control flow, document update requests, and release packaging. Live Google authorization, document rendering, managed installation, and automatic upgrades also require browser and device testing.
