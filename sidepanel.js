const docTitle = document.getElementById('docTitle');
const docMeta = document.getElementById('docMeta');
const statusText = document.getElementById('statusText');
const statusPill = document.getElementById('statusPill');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const translateButton = document.getElementById('translateButton');
const reloadButton = document.getElementById('reloadButton');
const copyButton = document.getElementById('copyButton');
const saveButton = document.getElementById('saveButton');
const translationOutput = document.getElementById('translationOutput');
const oauthPill = document.getElementById('oauthPill');
const oauthSetup = document.getElementById('oauthSetup');
const extensionId = document.getElementById('extensionId');
const copyExtensionIdButton = document.getElementById('copyExtensionIdButton');
const createDocButton = document.getElementById('createDocButton');
const openDocButton = document.getElementById('openDocButton');
const createdDocMeta = document.getElementById('createdDocMeta');
const warningTextInput = document.getElementById('warningTextInput');
const resetWarningButton = document.getElementById('resetWarningButton');
const warningSavedText = document.getElementById('warningSavedText');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const OAUTH_PLACEHOLDER_PREFIX = 'REPLACE_WITH_';
const TRANSLATION_CHUNK_LIMIT = 2800;
const API_REPLACEMENTS_PER_BATCH = 45;
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const WARNING_STORAGE_KEY = 'gdocsSpanishTranslationWarning';
const DEFAULT_TRANSLATION_WARNING = 'Translation Notice: This document was automatically translated from English to Spanish and may contain errors. Please verify important information against the original English document.';

let sourceText = '';
let sourceTitle = 'Google Doc';
let sourceDocId = '';
let translator = null;
let translating = false;
let creatingDoc = false;
let loadingDocument = false;
let createdDocUrl = '';

function setStatus(message, tone = 'ready') {
  statusText.textContent = message;
  statusPill.className = 'pill';
  if (tone === 'warning') statusPill.classList.add('warning');
  if (tone === 'error') statusPill.classList.add('error');
  statusPill.textContent = tone === 'error' ? 'Error' : tone === 'warning' ? 'Working' : 'Ready';
}

function setProgress(percent, label = '') {
  progressWrap.classList.remove('hidden');
  progressWrap.setAttribute('aria-hidden', 'false');
  progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressText.textContent = label;
}

function hideProgress() {
  progressWrap.classList.add('hidden');
  progressWrap.setAttribute('aria-hidden', 'true');
  progressBar.style.width = '0%';
  progressText.textContent = '';
}

function humanSize(text) {
  const chars = text.length.toLocaleString();
  const words = (text.trim().match(/\S+/g) || []).length.toLocaleString();
  return `${words} words • ${chars} characters`;
}

function getDocInfoFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'docs.google.com') return null;

    const match = parsed.pathname.match(/^\/document\/(?:u\/(\d+)\/)?d\/([A-Za-z0-9_-]+)/);
    if (!match) return null;

    const accountIndex = match[1] ?? parsed.searchParams.get('authuser');
    const docId = match[2];
    const accountPart = accountIndex !== null && accountIndex !== undefined
      ? `u/${encodeURIComponent(accountIndex)}/`
      : '';

    return {
      docId,
      accountIndex,
      exportUrl: `https://docs.google.com/document/${accountPart}d/${encodeURIComponent(docId)}/export?format=txt`
    };
  } catch {
    return null;
  }
}

async function getActiveDocsTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active browser tab was found.');

  const docInfo = getDocInfoFromUrl(tab.url || '');
  if (!docInfo) {
    throw new Error('Open a Google Docs document, then click Reload document.');
  }

  return { ...tab, ...docInfo };
}

function cleanDocTitle(title) {
  return (title || 'Google Doc')
    .replace(/\s*-\s*Google Docs\s*$/, '')
    .trim();
}

function validateExportResponse({ ok, status, text, contentType, finalUrl }) {
  if (!ok) {
    throw new Error(`Google Docs returned HTTP ${status} while exporting the document.`);
  }

  const looksLikeLogin =
    /accounts\.google\.com|ServiceLogin/i.test(finalUrl || '') ||
    ((contentType || '').includes('text/html') && /<html|<!doctype/i.test(text || ''));

  if (looksLikeLogin) {
    throw new Error(
      'Google redirected the export to a sign-in page. Make sure the open Doc is using the Google account that has access, then reload the document.'
    );
  }

  if (typeof text !== 'string') {
    throw new Error('Google Docs did not return readable document text.');
  }

  return text;
}

async function exportFromPage(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [tab.exportUrl],
    func: async (exportUrl) => {
      try {
        const response = await fetch(exportUrl, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow'
        });

        const text = await response.text();
        const titleInput = document.querySelector('input.docs-title-input');

        return {
          ok: response.ok,
          status: response.status,
          text,
          contentType: response.headers.get('content-type') || '',
          finalUrl: response.url || exportUrl,
          title: titleInput?.value || document.title || 'Google Doc'
        };
      } catch (error) {
        return {
          pageFetchFailed: true,
          error: error?.message || String(error),
          title: document.querySelector('input.docs-title-input')?.value || document.title || 'Google Doc'
        };
      }
    }
  });

  return results?.[0]?.result || null;
}

async function exportFromExtension(tab) {
  const response = await fetch(tab.exportUrl, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow'
  });

  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get('content-type') || '',
    finalUrl: response.url || tab.exportUrl,
    title: tab.title || 'Google Doc'
  };
}

async function extractOpenDoc(tab = null) {
  tab = tab || await getActiveDocsTab();
  let pageResult = null;

  try {
    pageResult = await exportFromPage(tab);

    if (pageResult && !pageResult.pageFetchFailed) {
      const text = validateExportResponse(pageResult);
      return {
        ok: true,
        docId: tab.docId,
        title: cleanDocTitle(pageResult.title),
        text
      };
    }
  } catch (pageError) {
    pageResult = {
      ...(pageResult || {}),
      pageFetchFailed: true,
      error: pageError?.message || String(pageError)
    };
  }

  try {
    const extensionResult = await exportFromExtension(tab);
    const text = validateExportResponse(extensionResult);

    return {
      ok: true,
      docId: tab.docId,
      title: cleanDocTitle(pageResult?.title || tab.title),
      text
    };
  } catch (fallbackError) {
    const firstError = pageResult?.error;
    const secondError = fallbackError?.message || String(fallbackError);
    const accountHint = tab.accountIndex !== null && tab.accountIndex !== undefined
      ? ` Google account slot /u/${tab.accountIndex}/ was preserved.`
      : '';

    throw new Error(
      `The document could not be read. Page export: ${firstError || 'failed'}. ` +
      `Extension export: ${secondError}.${accountHint}`
    );
  }
}

function oauthClientConfigured() {
  const clientId = chrome.runtime.getManifest()?.oauth2?.client_id || '';
  return Boolean(clientId) && !clientId.startsWith(OAUTH_PLACEHOLDER_PREFIX);
}

function refreshOAuthUi() {
  extensionId.textContent = chrome.runtime.id;
  const configured = oauthClientConfigured();
  oauthSetup.classList.toggle('hidden', configured);
  oauthPill.textContent = configured ? 'Ready' : 'Setup';
  oauthPill.className = 'pill';
  if (!configured) oauthPill.classList.add('warning');
  createDocButton.disabled = !configured || !sourceDocId || creatingDoc || translating || loadingDocument;
}

function normalizeWarningText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function loadWarningSetting() {
  const saved = normalizeWarningText(localStorage.getItem(WARNING_STORAGE_KEY));
  warningTextInput.value = saved || DEFAULT_TRANSLATION_WARNING;
  warningSavedText.textContent = saved ? 'Custom warning saved for this browser.' : 'Using the default warning.';
}

function saveWarningSetting() {
  const value = normalizeWarningText(warningTextInput.value);
  if (!value || value === DEFAULT_TRANSLATION_WARNING) {
    localStorage.removeItem(WARNING_STORAGE_KEY);
    if (!value) warningTextInput.value = DEFAULT_TRANSLATION_WARNING;
    warningSavedText.textContent = 'Using the default warning.';
    return;
  }

  localStorage.setItem(WARNING_STORAGE_KEY, value);
  warningSavedText.textContent = 'Custom warning saved for this browser.';
}

function resetWarningSetting() {
  localStorage.removeItem(WARNING_STORAGE_KEY);
  warningTextInput.value = DEFAULT_TRANSLATION_WARNING;
  warningSavedText.textContent = 'Using the default warning.';
}

function getConfiguredWarningText() {
  const value = normalizeWarningText(warningTextInput.value);
  return value || DEFAULT_TRANSLATION_WARNING;
}

async function loadDocument() {
  if (translating || creatingDoc || loadingDocument) return;
  loadingDocument = true;
  reloadButton.disabled = true;
  sourceDocId = '';
  sourceText = '';
  translateButton.disabled = true;
  createDocButton.disabled = true;
  copyButton.disabled = true;
  saveButton.disabled = true;
  translationOutput.value = '';
  createdDocMeta.textContent = '';
  createdDocUrl = '';
  openDocButton.classList.add('hidden');
  docTitle.textContent = 'Loading…';
  docMeta.textContent = '';
  setStatus('Reading the current Google Doc…', 'warning');
  setProgress(10, 'Exporting document text…');

  try {
    const tab = await getActiveDocsTab();
    sourceDocId = tab.docId;
    sourceTitle = cleanDocTitle(tab.title);
    docTitle.textContent = sourceTitle;
    const doc = await extractOpenDoc(tab);
    sourceText = doc.text;
    sourceTitle = doc.title || 'Google Doc';
    sourceDocId = doc.docId || '';
    docTitle.textContent = sourceTitle;
    docMeta.textContent = humanSize(sourceText);

    if (!sourceText.trim()) {
      setStatus('This document does not contain any translatable text.', 'error');
      hideProgress();
      refreshOAuthUi();
      return;
    }

    setProgress(100, 'Document loaded.');
    setTimeout(hideProgress, 450);
    setStatus('Document loaded. Choose a preview or formatted copy.');
    translateButton.disabled = false;
    refreshOAuthUi();
  } catch (error) {
    console.error(error);
    sourceText = '';
    docTitle.textContent = sourceDocId ? sourceTitle : 'No document loaded';
    const message = error?.message || 'Unable to read the Google Doc.';
    setStatus(sourceDocId
      ? `Preview unavailable: ${message} You can still try creating a formatted copy.`
      : message, 'error');
    hideProgress();
    refreshOAuthUi();
  } finally {
    loadingDocument = false;
    reloadButton.disabled = false;
    refreshOAuthUi();
  }
}

function splitText(text, maxChars = 3200) {
  const paragraphs = text.split(/(\n+)/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const part of paragraphs) {
    if (!part) continue;

    if (part.length <= maxChars) {
      if (current.length + part.length > maxChars) flush();
      current += part;
      continue;
    }

    flush();
    let remaining = part;
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) current = remaining;
  }

  flush();
  return chunks;
}

async function getTranslator() {
  if (!('Translator' in self)) {
    throw new Error('Chrome\'s Translator API is unavailable. Use desktop Chrome 138 or newer.');
  }

  // Call create directly from the click handler, before OAuth or network waits.
  // An availability probe here can consume the activation needed for a download.
  if (!translator) {
    translator = await Translator.create({
      sourceLanguage: 'en',
      targetLanguage: 'es',
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          const pct = Math.round(event.loaded * 100);
          setProgress(pct, `Downloading the English → Spanish language pack… ${pct}%`);
          setStatus('Preparing Chrome translation model…', 'warning');
        });
      }
    });
  }

  return translator;
}

async function translateTextWithChunking(text, activeTranslator) {
  if (!text || !/\p{L}/u.test(text)) return text;
  if (text.length <= TRANSLATION_CHUNK_LIMIT) {
    return activeTranslator.translate(text);
  }

  const chunks = splitText(text, TRANSLATION_CHUNK_LIMIT);
  const result = [];
  for (const chunk of chunks) {
    if (!chunk.trim() || !/\p{L}/u.test(chunk)) result.push(chunk);
    else result.push(await activeTranslator.translate(chunk));
  }
  return result.join('');
}

async function translateDocument() {
  if (translating || creatingDoc || !sourceText.trim()) return;

  translating = true;
  translateButton.disabled = true;
  reloadButton.disabled = true;
  createDocButton.disabled = true;
  copyButton.disabled = true;
  saveButton.disabled = true;
  translationOutput.value = '';
  setStatus('Preparing translation…', 'warning');
  setProgress(1, 'Checking Chrome translation support…');

  try {
    const activeTranslator = await getTranslator();
    const chunks = splitText(sourceText);
    const translatedChunks = [];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const pct = Math.round((i / Math.max(1, chunks.length)) * 100);
      setProgress(pct, `Translating preview section ${i + 1} of ${chunks.length}…`);
      setStatus(`Translating preview ${i + 1} / ${chunks.length}…`, 'warning');

      if (!chunk.trim()) translatedChunks.push(chunk);
      else translatedChunks.push(await activeTranslator.translate(chunk));

      translationOutput.value = translatedChunks.join('');
    }

    setProgress(100, 'Translation complete.');
    setStatus('Spanish preview complete.');
    copyButton.disabled = false;
    saveButton.disabled = false;
    setTimeout(hideProgress, 650);
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'Translation failed.', 'error');
    hideProgress();
  } finally {
    translating = false;
    reloadButton.disabled = false;
    translateButton.disabled = !sourceText.trim();
    refreshOAuthUi();
  }
}

async function copyTranslation() {
  if (!translationOutput.value) return;
  try {
    await navigator.clipboard.writeText(translationOutput.value);
    setStatus('Spanish translation copied to the clipboard.');
  } catch (error) {
    console.error(error);
    setStatus('Unable to copy the translation to the clipboard.', 'error');
  }
}

function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Google Doc';
}

function saveTranslation() {
  if (!translationOutput.value) return;
  const blob = new Blob([translationOutput.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilename(sourceTitle)} - Spanish.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Spanish text file saved.');
}

async function copyExtensionId() {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    setStatus('Extension ID copied.');
  } catch (error) {
    console.error(error);
    setStatus('Unable to copy the extension ID.', 'error');
  }
}

async function getGoogleAccessToken(interactive = true) {
  if (!oauthClientConfigured()) {
    throw new Error('Google OAuth is not configured yet. Complete the setup shown in the extension panel first.');
  }

  try {
    const result = await chrome.identity.getAuthToken({
      interactive,
      scopes: [DRIVE_SCOPE]
    });
    const token = typeof result === 'string' ? result : result?.token;
    if (!token) throw new Error('Google did not return an OAuth access token.');
    return token;
  } catch (error) {
    const message = error?.message || String(error);
    if (/bad client id|oauth2|client id|invalid_client/i.test(message)) {
      throw new Error('Google OAuth client configuration is invalid. Verify the Chrome Extension OAuth client ID in manifest.json and reload the extension.');
    }
    throw new Error(`Google authorization failed: ${message}`);
  }
}

async function removeCachedToken(token) {
  if (!token) return;
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch (error) {
    console.warn('Unable to clear cached Google token:', error);
  }
}

async function googleFetch(url, options = {}, allowTokenRetry = true) {
  let token = await getGoogleAccessToken(true);
  let response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });

  if (response.status === 401 && allowTokenRetry) {
    await removeCachedToken(token);
    token = await getGoogleAccessToken(true);
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });
  }

  return response;
}

async function googleJson(url, options = {}) {
  const response = await googleFetch(url, options);
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const apiMessage = data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
    if (response.status === 403 && /accessNotConfigured|has not been used|disabled/i.test(apiMessage)) {
      throw new Error(`Google API access is not enabled for this OAuth project: ${apiMessage}`);
    }
    if (response.status === 403 && /insufficient|scope|permission/i.test(apiMessage)) {
      throw new Error(`Google denied the requested Drive permission: ${apiMessage}`);
    }
    throw new Error(`Google API error ${response.status}: ${apiMessage}`);
  }

  return data;
}

async function getDriveFileMetadata(fileId) {
  const fields = 'id,name,mimeType,parents,webViewLink,size';
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  return googleJson(url, { method: 'GET' });
}

async function getDriveImportFormats() {
  const url = 'https://www.googleapis.com/drive/v3/about?fields=importFormats';
  const data = await googleJson(url, { method: 'GET' });
  return data?.importFormats || {};
}

async function copyNativeGoogleDoc(docId, name) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/copy?supportsAllDrives=true&fields=id,name,parents,webViewLink,mimeType`;
  return googleJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
}

async function readGoogleApiError(response) {
  const raw = await response.text();
  try {
    const data = raw ? JSON.parse(raw) : {};
    return data?.error?.message || data?.message || raw || `HTTP ${response.status}`;
  } catch {
    return raw || `HTTP ${response.status}`;
  }
}

async function downloadDriveFile(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const response = await googleFetch(url, { method: 'GET' });
  if (!response.ok) {
    const message = await readGoogleApiError(response);
    throw new Error(`Google Drive could not download the Office source file: ${message}`);
  }
  return response.arrayBuffer();
}

async function importAsNativeGoogleDoc(sourceMeta, name) {
  const importFormats = await getDriveImportFormats();
  const targets = importFormats?.[sourceMeta.mimeType] || [];
  if (!targets.includes(GOOGLE_DOC_MIME)) {
    throw new Error(
      `This file is ${sourceMeta.mimeType || 'an unknown file type'}, and Google Drive does not currently list it as convertible to a native Google Doc.`
    );
  }

  const bytes = await downloadDriveFile(sourceMeta.id);
  const boundary = `gdocs-spanish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const metadata = {
    name,
    mimeType: GOOGLE_DOC_MIME
  };
  if (Array.isArray(sourceMeta.parents) && sourceMeta.parents.length) {
    metadata.parents = [sourceMeta.parents[0]];
  }

  const prefix = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${sourceMeta.mimeType || 'application/octet-stream'}`,
    '',
    ''
  ].join('\r\n');
  const suffix = `\r\n--${boundary}--`;
  const body = new Blob([prefix, new Uint8Array(bytes), suffix], {
    type: `multipart/related; boundary=${boundary}`
  });

  const fields = 'id,name,parents,webViewLink,mimeType';
  const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
  const created = await googleJson(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });

  if (created?.mimeType !== GOOGLE_DOC_MIME) {
    throw new Error('Google Drive uploaded the file, but it was not converted to native Google Docs format.');
  }
  return created;
}

async function createEditableGoogleDocCopy(sourceId, name) {
  const sourceMeta = await getDriveFileMetadata(sourceId);
  if (!sourceMeta?.id) throw new Error('Google Drive did not return metadata for the source document.');

  if (sourceMeta.mimeType === GOOGLE_DOC_MIME) {
    return {
      document: await copyNativeGoogleDoc(sourceMeta.id, name),
      sourceWasOffice: false,
      sourceMimeType: sourceMeta.mimeType
    };
  }

  return {
    document: await importAsNativeGoogleDoc(sourceMeta, name),
    sourceWasOffice: true,
    sourceMimeType: sourceMeta.mimeType
  };
}

async function getGoogleDocStructure(docId) {
  const url = `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?includeTabsContent=true`;
  return googleJson(url, { method: 'GET' });
}

function documentTabs(documentResource) {
  const result = [];
  const visit = tab => {
    if (tab?.documentTab && tab?.tabProperties?.tabId) result.push(tab);
    for (const child of tab?.childTabs || []) visit(child);
  };
  for (const tab of documentResource?.tabs || []) visit(tab);
  return result;
}

function createRevisionWriter(docId, initialRevisionId) {
  if (!initialRevisionId) throw new Error('Google Docs did not return a revision. No text was changed.');
  let revisionId = initialRevisionId;
  let stopped = false;
  return {
    get revisionId() { return revisionId; },
    async write(requests) {
      if (stopped) throw new Error('Document updates have stopped. Start a new translation.');
      try {
        const result = await googleJson(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } })
        });
        const nextRevision = result?.writeControl?.requiredRevisionId;
        if (!nextRevision) throw new Error('Google Docs did not confirm the new revision. Updates stopped to protect the document.');
        revisionId = nextRevision;
        return result;
      } catch (error) {
        // Never retry index-changing writes or adopt a fresh revision for stale ranges.
        stopped = true;
        if (/revision/i.test(error?.message || '') && /400|match|latest|conflict/i.test(error.message)) {
          throw new Error('The copied document changed during translation. Updates stopped to avoid overwriting edits. Start a new translation from the source.');
        }
        throw error;
      }
    }
  };
}

async function addTranslationWarningToGoogleDoc(documentResource, warningText, writer) {
  const message = normalizeWarningText(warningText);
  if (!message) throw new Error('Enter a translation warning before creating the Spanish Google Doc.');
  const tabs = documentTabs(documentResource);
  if (!tabs.length) throw new Error('Google Docs did not return a writable document tab for the translation warning.');
  // The snapshot must be the revision reached by our last text replacement.
  if (documentResource.revisionId !== writer.revisionId) {
    throw new Error('The copied document changed before the warning could be added. Start a new translation from the source.');
  }
  const placements = [];
  for (const tab of tabs) {
    const tabId = tab.tabProperties.tabId;
    const documentTab = tab.documentTab;
    const docStyle = documentTab.documentStyle || {};
    if (docStyle.documentFormat?.documentMode === 'PAGELESS') {
      await writer.write([
        { insertText: { location: { index: 1, tabId }, text: `${message}\n\n` } },
        { updateTextStyle: { range: { startIndex: 1, endIndex: 1 + message.length, tabId }, textStyle: { bold: true }, fields: 'bold' } }
      ]);
      placements.push({ tabId, placement: 'body' });
      continue;
    }
    let defaultHeaderId = docStyle.defaultHeaderId;
    if (!defaultHeaderId) {
      const created = await writer.write([
        { createHeader: { type: 'DEFAULT', sectionBreakLocation: { index: 0, tabId } } }
      ]);
      defaultHeaderId = created?.replies?.[0]?.createHeader?.headerId;
      if (!defaultHeaderId) throw new Error('Google Docs did not return the newly created header ID.');
    }
    const headerIds = [...new Set([...Object.keys(documentTab.headers || {}), defaultHeaderId])];
    const requests = headerIds.flatMap(segmentId => [
      { insertText: { location: { segmentId, index: 0, tabId }, text: `${message}\n` } },
      { updateTextStyle: { range: { segmentId, startIndex: 0, endIndex: message.length, tabId }, textStyle: { bold: true }, fields: 'bold' } }
    ]);
    await writer.write(requests);
    placements.push({ tabId, placement: 'header' });
  }
  return placements;
}

function filterTextStyle(style = {}) {
  const allowed = [
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'smallCaps',
    'backgroundColor',
    'foregroundColor',
    'fontSize',
    'weightedFontFamily',
    'baselineOffset',
    'link'
  ];
  const filtered = {};
  for (const key of allowed) {
    if (style[key] !== undefined && style[key] !== null) filtered[key] = style[key];
  }
  return filtered;
}

function textStyleFields(style) {
  return Object.keys(style || {}).join(',');
}

function stylesEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}

function splitCoreRange(content, startIndex, endIndex) {
  if (!content || typeof startIndex !== 'number' || typeof endIndex !== 'number') return null;
  const leading = content.match(/^\s*/u)?.[0] || '';
  const trailing = content.match(/\s*$/u)?.[0] || '';
  const core = content.slice(leading.length, content.length - trailing.length);
  if (!core || !/\p{L}/u.test(core)) return null;

  return {
    text: core,
    startIndex: startIndex + leading.length,
    endIndex: endIndex - trailing.length
  };
}

function collectParagraphOperations(paragraph, tabId, segmentId, operations) {
  const elements = paragraph?.elements || [];
  const textElements = elements.filter(el => el?.textRun?.content);
  if (!textElements.length) return;

  // If the paragraph is entirely text and all text runs use the same inline
  // style, translate the paragraph as one unit for better sentence context.
  const onlyTextRuns = elements.every(el => Boolean(el?.textRun));
  const styles = textElements.map(el => filterTextStyle(el.textRun.textStyle || {}));
  const sameStyle = styles.every(style => stylesEqual(style, styles[0]));

  if (onlyTextRuns && sameStyle) {
    const combined = textElements.map(el => el.textRun.content || '').join('');
    const firstStart = textElements[0].startIndex;
    const lastEnd = textElements[textElements.length - 1].endIndex;
    const core = splitCoreRange(combined, firstStart, lastEnd);
    if (core) {
      operations.push({
        ...core,
        tabId,
        segmentId,
        style: styles[0]
      });
    }
    return;
  }

  // Mixed inline formatting is translated run-by-run so links, bold, italic,
  // font changes, etc. can be restored on the translated text.
  for (const element of textElements) {
    const core = splitCoreRange(
      element.textRun.content,
      element.startIndex,
      element.endIndex
    );
    if (!core) continue;
    operations.push({
      ...core,
      tabId,
      segmentId,
      style: filterTextStyle(element.textRun.textStyle || {})
    });
  }
}

function collectStructuralOperations(content, tabId, segmentId, operations) {
  for (const element of content || []) {
    if (element?.paragraph) {
      collectParagraphOperations(element.paragraph, tabId, segmentId, operations);
    }

    if (element?.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells || []) {
          collectStructuralOperations(cell.content || [], tabId, segmentId, operations);
        }
      }
    }

    if (element?.tableOfContents?.content) {
      collectStructuralOperations(element.tableOfContents.content, tabId, segmentId, operations);
    }
  }
}

function collectFromDocumentTab(tab, operations) {
  const tabId = tab?.tabProperties?.tabId;
  const documentTab = tab?.documentTab;
  if (!tabId || !documentTab) return;

  collectStructuralOperations(documentTab.body?.content || [], tabId, '', operations);

  for (const [headerId, header] of Object.entries(documentTab.headers || {})) {
    collectStructuralOperations(header?.content || [], tabId, headerId, operations);
  }
  for (const [footerId, footer] of Object.entries(documentTab.footers || {})) {
    collectStructuralOperations(footer?.content || [], tabId, footerId, operations);
  }
  for (const [footnoteId, footnote] of Object.entries(documentTab.footnotes || {})) {
    collectStructuralOperations(footnote?.content || [], tabId, footnoteId, operations);
  }

  for (const child of tab.childTabs || []) {
    collectFromDocumentTab(child, operations);
  }
}

function collectTranslationOperations(documentResource) {
  const operations = [];
  for (const tab of documentResource.tabs || []) {
    collectFromDocumentTab(tab, operations);
  }
  return operations;
}

function operationKey(op) {
  return `${op.tabId || ''}\u0000${op.segmentId || ''}`;
}

function sortOperationsForReplacement(operations) {
  return [...operations].sort((a, b) => {
    const aKey = operationKey(a);
    const bKey = operationKey(b);
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    return b.startIndex - a.startIndex;
  });
}

async function translateOperations(operations, activeTranslator) {
  const translated = [];
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    const pct = 18 + Math.round(((i + 1) / Math.max(1, operations.length)) * 57);
    setProgress(pct, `Translating formatted text ${i + 1} of ${operations.length}…`);
    setStatus(`Translating formatted copy ${i + 1} / ${operations.length}…`, 'warning');

    translated.push({
      ...op,
      translatedText: await translateTextWithChunking(op.text, activeTranslator)
    });
  }
  return translated;
}

function buildReplacementRequests(op) {
  const range = {
    startIndex: op.startIndex,
    endIndex: op.endIndex,
    tabId: op.tabId
  };
  const location = {
    index: op.startIndex,
    tabId: op.tabId
  };
  if (op.segmentId) {
    range.segmentId = op.segmentId;
    location.segmentId = op.segmentId;
  }

  const requests = [
    { deleteContentRange: { range } },
    { insertText: { location, text: op.translatedText } }
  ];

  const fields = textStyleFields(op.style);
  if (fields && op.translatedText.length > 0) {
    const styleRange = {
      startIndex: op.startIndex,
      endIndex: op.startIndex + op.translatedText.length,
      tabId: op.tabId
    };
    if (op.segmentId) styleRange.segmentId = op.segmentId;

    requests.push({
      updateTextStyle: {
        range: styleRange,
        textStyle: op.style,
        fields
      }
    });
  }

  return requests;
}

async function applyTranslationsToGoogleDoc(operations, writer) {
  const sorted = sortOperationsForReplacement(operations);
  const totalBatches = Math.ceil(sorted.length / API_REPLACEMENTS_PER_BATCH);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * API_REPLACEMENTS_PER_BATCH;
    const batchOps = sorted.slice(start, start + API_REPLACEMENTS_PER_BATCH);
    const requests = batchOps.flatMap(buildReplacementRequests);
    const pct = 76 + Math.round(((batchIndex + 1) / Math.max(1, totalBatches)) * 22);
    setProgress(pct, `Writing Spanish text to Google Doc ${batchIndex + 1} of ${totalBatches}…`);
    setStatus(`Updating formatted copy ${batchIndex + 1} / ${totalBatches}…`, 'warning');

    await writer.write(requests);
  }
}

async function createSpanishGoogleDoc() {
  if (creatingDoc || translating || loadingDocument || !sourceDocId) return;
  if (!oauthClientConfigured()) {
    refreshOAuthUi();
    setStatus('Complete the Google OAuth setup shown below first.', 'error');
    return;
  }

  creatingDoc = true;
  createdDocUrl = '';
  createdDocMeta.textContent = '';
  openDocButton.classList.add('hidden');
  reloadButton.disabled = true;
  translateButton.disabled = true;
  createDocButton.disabled = true;
  copyButton.disabled = true;
  saveButton.disabled = true;
  setStatus('Preparing translation…', 'warning');
  setProgress(1, 'Preparing the English → Spanish translator…');

  let createdDoc = null;

  try {
    const activeTranslator = await getTranslator();
    setStatus('Connecting to Google Drive…', 'warning');
    setProgress(2, 'Requesting Google authorization…');
    await getGoogleAccessToken(true);

    setProgress(5, 'Checking the source file type…');
    setStatus('Checking whether the source is a native Google Doc or an Office file…', 'warning');
    const result = await createEditableGoogleDocCopy(sourceDocId, `${sourceTitle} - Spanish`);
    createdDoc = result.document;
    if (!createdDoc?.id) throw new Error('Google Drive created a document but did not return its document ID.');

    createdDocUrl = createdDoc.webViewLink || `https://docs.google.com/document/d/${createdDoc.id}/edit`;
    createdDocMeta.textContent = result.sourceWasOffice
      ? `Created native Google Doc from Office source: ${createdDoc.name || `${sourceTitle} - Spanish`}`
      : `Created: ${createdDoc.name || `${sourceTitle} - Spanish`}`;

    setProgress(10, result.sourceWasOffice
      ? 'Office file converted to native Google Docs. Reading document structure…'
      : 'Reading the copied document structure…');
    setStatus('Reading formatting and document structure…', 'warning');
    const structuredDoc = await getGoogleDocStructure(createdDoc.id);
    const writer = createRevisionWriter(createdDoc.id, structuredDoc.revisionId);
    const operations = collectTranslationOperations(structuredDoc);

    if (!operations.length) {
      throw new Error('The copied Google Doc did not contain any text runs that could be translated.');
    }

    setProgress(14, `Found ${operations.length.toLocaleString()} formatted text sections.`);
    // Translate the warning explicitly with the same Translator instance used
    // for the document, but do not insert it yet. Newly created header segments
    // are not always returned consistently enough to depend on them being picked
    // up by the main traversal. Inserting the warning after the body translation
    // also prevents it from shifting any indexes used by the replacement pass.
    setProgress(16, 'Translating the document warning…');
    setStatus('Translating the warning to Spanish…', 'warning');
    const translatedWarning = await translateTextWithChunking(
      getConfiguredWarningText(),
      activeTranslator
    );

    const translatedOps = await translateOperations(operations, activeTranslator);

    await applyTranslationsToGoogleDoc(translatedOps, writer);

    setProgress(99, 'Adding the translated warning…');
    setStatus('Adding the Spanish warning to the translated copy…', 'warning');
    const postTranslationDoc = await getGoogleDocStructure(createdDoc.id);
    const placements = await addTranslationWarningToGoogleDoc(
      postTranslationDoc, translatedWarning, writer
    );

    const bodyCount = placements.filter(item => item.placement === 'body').length;
    createdDocMeta.textContent += ` • Translated warning added to all ${placements.length} document tabs.`;
    if (bodyCount) createdDocMeta.textContent += ` Placed at the top of ${bodyCount} pageless tabs.`;

    setProgress(100, 'Spanish Google Doc created.');
    setStatus('Formatted Spanish Google Doc created successfully.');
    openDocButton.classList.remove('hidden');
    oauthPill.textContent = 'Ready';
    oauthPill.className = 'pill';
    setTimeout(hideProgress, 900);
  } catch (error) {
    console.error(error);
    const partial = createdDoc?.id
      ? ' A native Google Doc was already created in Drive; it may be partially translated and can be deleted manually if you do not want to keep it.'
      : '';
    setStatus(`${error?.message || 'Unable to create the Spanish Google Doc.'}${partial}`, 'error');
    hideProgress();
    if (createdDocUrl) openDocButton.classList.remove('hidden');
  } finally {
    creatingDoc = false;
    reloadButton.disabled = false;
    translateButton.disabled = !sourceText.trim();
    copyButton.disabled = !translationOutput.value;
    saveButton.disabled = !translationOutput.value;
    refreshOAuthUi();
  }
}

async function openCreatedDoc() {
  if (!createdDocUrl) return;
  await chrome.tabs.create({ url: createdDocUrl });
}

translateButton.addEventListener('click', translateDocument);
reloadButton.addEventListener('click', loadDocument);
copyButton.addEventListener('click', copyTranslation);
saveButton.addEventListener('click', saveTranslation);
copyExtensionIdButton.addEventListener('click', copyExtensionId);
createDocButton.addEventListener('click', createSpanishGoogleDoc);
openDocButton.addEventListener('click', openCreatedDoc);
warningTextInput.addEventListener('change', saveWarningSetting);
warningTextInput.addEventListener('blur', saveWarningSetting);
resetWarningButton.addEventListener('click', resetWarningSetting);

loadWarningSetting();
refreshOAuthUi();
loadDocument();
