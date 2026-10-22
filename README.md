# Google Docs English → Spanish — v1.1.3

A Chrome Manifest V3 extension that translates an open Google Doc from English to Spanish using Chrome's built-in on-device Translator API.

Version 1.1.3 fixes translation of the configurable warning. The warning is translated explicitly with the same on-device Translator instance used for the document and is inserted only after the document translation finishes. This avoids a Google Docs API edge case where a newly created header could be omitted from the text traversal. Native Google Docs are copied normally; Office files such as `.docx` are imported into native Google Docs format first, then translated.

## What v1.1 does

- Keeps the original English Google Doc untouched.
- Creates a new native Google Doc named `Original document name - Spanish`.
- Automatically converts supported Office/Word sources (including `.docx`) to native Google Docs before translation.
- By default, Google Drive places the copy in the same discoverable parent folder as the source document.
- Translates locally with Chrome's built-in English → Spanish Translator API.
- Preserves the copied document's tables, images, lists, headings, page layout, and other non-text structure.
- Adds a configurable English translation warning to the copy's header and translates that notice to Spanish with the rest of the document.
- Stores the user's custom warning locally in the extension; **Reset default** restores the built-in notice.
- Translates text found in the body, table cells, headers, footers, footnotes, and Google Docs tabs.
- Reapplies inline styles such as bold, italic, underline, font properties, colors, and links to translated text runs.
- Retains the original plain-text side-panel preview, Copy, and Save `.txt` features from v1.0.2.

## Requirements

- Desktop Google Chrome 138 or newer.
- A Google account that can copy/edit the source document.
- For the formatted Google Doc feature: a Google Cloud project with the Google Drive API and Google Docs API enabled.

The plain-text preview does **not** require Google Cloud/OAuth setup.

## Install the extension

1. Unzip this package.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `google-docs-spanish-translator-v1.1.3` folder.
6. Open a Google Doc and click the extension icon.

This build pins a public extension key so its Chrome extension ID remains stable:

`nmeknfnkopnkomanaldgmflbmileinko`

Only the public key is included in `manifest.json`; no private signing key or OAuth client secret is included.

## One-time Google OAuth setup for formatted copies

The extension cannot create files in a user's Google Drive without explicit Google OAuth authorization. The OAuth client ID must be created in your own Google Cloud project.

### 1. Create or select a Google Cloud project

Go to Google Cloud Console and create/select a project for this extension.

For a Google Workspace school district, using an **Internal** OAuth app is generally the simplest deployment model when only users in your Workspace organization will use it.

### 2. Enable APIs

Enable both:

- Google Drive API
- Google Docs API

### 3. Configure the OAuth consent screen

Configure the project's Google Auth Platform / OAuth consent screen.

The extension requests this scope:

`https://www.googleapis.com/auth/drive`

This permission is used because v1.1 copies the existing source file and edits the resulting copy. The Google Docs API accepts the Drive scope for reading and updating Docs content.

If your Google Workspace organization uses API controls/app access controls, your Workspace administrator may also need to trust/allow the OAuth app.

### 4. Create an OAuth client

Create an OAuth 2.0 Client ID with application type **Chrome Extension**.

Use this extension ID exactly:

`nmeknfnkopnkomanaldgmflbmileinko`

Google will give you a client ID that looks similar to:

`123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com`

You do not put a client secret in this extension.

### 5. Put the client ID into manifest.json

Open `manifest.json` and find:

```json
"oauth2": {
  "client_id": "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/drive"
  ]
}
```

Replace only the placeholder client ID with the OAuth client ID from Google Cloud.

Save `manifest.json`.

### 6. Reload the extension

1. Return to `chrome://extensions`.
2. Find **Google Docs English → Spanish**.
3. Click **Reload**.
4. Reload the Google Docs browser tab as well.

The side panel should now show the formatted Google Doc feature as **Ready** instead of **Setup**.

## Create a Spanish Google Doc

1. Open the English Google Doc.
2. Open the extension side panel.
3. Review or customize the **Translation warning** text. The default is:

   > Translation Notice: This document was automatically translated from English to Spanish and may contain errors. Please verify important information against the original English document.

4. Click **Create Spanish Google Doc**.
5. On the first use, approve the Google authorization prompt.
6. The extension will:
   - detect whether the source is a native Google Doc or an Office file;
   - copy native Docs directly, or import supported Office sources as a native Google Doc;
   - read the copy's Docs structure and translate its English text locally in Chrome;
   - translate the configured English warning with the same local Translator instance;
   - replace text from the end of each Docs segment toward the beginning so changing sentence lengths do not corrupt later indexes;
   - preserve/reapply inline text styles;
   - add the already-translated warning to the copy's default header (or the top of the body for a pageless Doc, because pageless Docs do not display headers);
   - provide an **Open created Spanish Doc** button when complete.

## Why this preserves formatting better

Rather than exporting the source as plain text and rebuilding it manually, v1.1.3 uses Google Drive conversion/copying. Native Google Docs are copied directly. Supported Office files are downloaded and immediately re-imported as native Google Docs, allowing Google to preserve the Office document structure during conversion. The extension then edits only translatable text ranges in the resulting native Doc.

For paragraphs where all text has the same inline style, the extension translates the paragraph as a larger unit for better context. If a paragraph contains mixed formatting—such as a bold word inside a normal sentence—the extension translates the individual formatted runs so their styles can be retained. That tradeoff can occasionally produce a slightly less natural translation in heavily formatted sentences.

## Privacy

The actual English → Spanish translation is performed by Chrome's on-device Translator API. Document text is not sent to a third-party translation provider by this extension.

When you use **Create Spanish Google Doc**, the extension necessarily communicates with Google Drive and Google Docs APIs to copy and edit files in the Google account you authorize.

## Known limitations

- The configurable warning is stored locally in the extension/browser profile. It is not added to the original English document.
- Pageless Google Docs do not display page headers; for those documents, the warning is inserted at the top of the translated copy instead.
- Mixed-format sentences may translate slightly differently from the plain-text preview because inline runs are translated separately to preserve formatting.
- Comments and suggestion discussions are not translated. The copy workflow does not intentionally copy open comments.
- Text embedded inside an image is not translated.
- Drawings/images themselves are preserved because the source document is copied, but any English words baked into those images remain English.
- Some advanced smart-chip or generated/autotext content may remain unchanged.
- If translation fails after the native Google Doc has already been created, the extension leaves it in Drive and tells you that it may be partially translated; it does not automatically delete user files.
- Office conversion depends on the source MIME type appearing in Google Drive's current `importFormats` list. Unsupported formats produce a clear error instead of attempting a Docs API edit.
- Very large documents require many local translation calls and Google Docs update batches.

## Troubleshooting

### "Google OAuth client configuration is invalid"

Verify that:

- the OAuth client type is **Chrome Extension**;
- its extension ID is `nmeknfnkopnkomanaldgmflbmileinko`;
- the client ID was copied into `manifest.json` exactly;
- the extension was reloaded after editing the manifest.

### Google says the app is blocked

For a Google Workspace district, check Google Admin Console API controls / app access controls. An administrator may need to mark the internally created OAuth app as trusted or allowed.

### API has not been used / is disabled

Enable both Google Drive API and Google Docs API in the same Google Cloud project that owns the OAuth client.

### The original document is unchanged

That is intentional. The formatted workflow always works on a newly created copy.

## Files

- `manifest.json` — Manifest V3 configuration, permissions, fixed public extension key, OAuth placeholder.
- `service-worker.js` — Opens the side panel when the extension icon is clicked.
- `sidepanel.html` — Side-panel UI.
- `sidepanel.css` — UI styling.
- `sidepanel.js` — Google Docs export, local translation, OAuth, Drive copy, Docs structure parsing, and formatted text replacement.
