const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', disabled: false, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, addEventListener() {}
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    chrome: { runtime: { id: 'extension-id', getManifest: () => ({ oauth2: { client_id: 'configured' } }) } },
    console: { error() {}, warn() {} },
    URL, setTimeout() {},
    localStorage: { getItem() { return null; } }
  });
  context.self = context;
  // Skip only the initial automatic load; all production handlers run unchanged.
  vm.runInContext(source.replace(/loadDocument\(\);\s*$/, ''), context);
  return { context, element, run: code => vm.runInContext(code, context) };
}
const docTab = (id, mode = 'PAGES', children = []) => ({
  tabProperties: { tabId: id }, childTabs: children,
  documentTab: { documentStyle: { documentFormat: { documentMode: mode } }, headers: {} }
});

test('translator creation is invoked synchronously before any availability/network wait', async () => {
  const h = harness();
  let created = 0;
  h.context.Translator = { create() { created++; return Promise.resolve({ translate() {} }); } };
  const pending = h.run('getTranslator()');
  assert.equal(created, 1);
  await pending;
  await h.run('getTranslator()');
  assert.equal(created, 1, 'reuse the prepared translator');
});

test('failed model preparation never requests OAuth or creates a Drive copy', async () => {
  const h = harness();
  const calls = [];
  h.context.Translator = { create() { calls.push('model'); return Promise.reject(new Error('download failed')); } };
  h.context.getGoogleAccessToken = async () => { calls.push('oauth'); };
  h.context.createEditableGoogleDocCopy = async () => { calls.push('copy'); };
  h.run("sourceDocId = 'source';");
  await h.run('createSpanishGoogleDoc()');
  assert.deepEqual(calls, ['model']);
  assert.match(h.element('statusText').textContent, /download failed/);
  assert.equal(h.element('createDocButton').disabled, false);
});

test('formatted workflow waits for model readiness before OAuth', async () => {
  const h = harness();
  const calls = [];
  let ready;
  h.context.Translator = { create() { calls.push('model'); return new Promise(resolve => { ready = resolve; }); } };
  h.context.getGoogleAccessToken = async () => { calls.push('oauth'); throw new Error('test stop'); };
  h.run("sourceDocId = 'source';");
  const pending = h.run('createSpanishGoogleDoc()');
  assert.deepEqual(calls, ['model']);
  ready({ translate() {} });
  await pending;
  assert.deepEqual(calls, ['model', 'oauth']);
});

test('preview export failure retains the current document for formatted copying', async () => {
  const h = harness();
  const tab = { docId: 'office-file', title: 'Lesson - Google Docs' };
  let queries = 0;
  h.context.getActiveDocsTab = async () => { queries++; return tab; };
  h.context.exportFromPage = async received => { assert.equal(received, tab); throw new Error('export unavailable'); };
  h.context.exportFromExtension = async received => { assert.equal(received, tab); throw new Error('export unavailable'); };
  await h.run('loadDocument()');
  assert.equal(queries, 1);
  assert.equal(h.run('sourceDocId'), 'office-file');
  assert.equal(h.element('createDocButton').disabled, false);
  assert.equal(h.element('translateButton').disabled, true);
  assert.match(h.element('statusText').textContent, /still try creating a formatted copy/);
  assert.equal(h.element('reloadButton').disabled, false);
});

test('invalid active tab clears the previous source and blocks copying', async () => {
  const h = harness();
  h.run("sourceDocId = 'old'; sourceText = 'old text';");
  h.context.getActiveDocsTab = async () => { throw new Error('Open a Google Doc'); };
  await h.run('loadDocument()');
  assert.equal(h.run('sourceDocId'), '');
  assert.equal(h.element('createDocButton').disabled, true);
});

test('reload is serialized and formatted copying is disabled while loading', async () => {
  const h = harness();
  let finish;
  let queries = 0;
  h.context.getActiveDocsTab = () => { queries++; return new Promise(resolve => { finish = resolve; }); };
  h.context.extractOpenDoc = async () => ({ docId: 'new', text: 'Hello', title: 'New' });
  const pending = h.run('loadDocument()');
  await h.run('loadDocument()');
  assert.equal(queries, 1);
  assert.equal(h.element('createDocButton').disabled, true);
  finish({ docId: 'new', title: 'New' });
  await pending;
  assert.equal(h.element('createDocButton').disabled, false);
});

test('warnings cover every tab, including nested pageless tabs and distinct headers', async () => {
  const h = harness();
  const first = docTab('first', 'PAGES', [docTab('child', 'PAGELESS')]);
  first.documentTab.documentStyle.defaultHeaderId = 'default';
  first.documentTab.headers = { default: {}, firstPage: {} };
  h.context.snapshot = { revisionId: 'r0', tabs: [first, docTab('second')] };
  const bodies = [];
  h.context.googleJson = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.writeControl.requiredRevisionId, `r${bodies.length}`);
    bodies.push(body);
    return { writeControl: { requiredRevisionId: `r${bodies.length}` }, replies: [{ createHeader: { headerId: 'new-header' } }] };
  };
  const result = await h.run("addTranslationWarningToGoogleDoc(snapshot, 'Aviso', createRevisionWriter('copy', 'r0'))");
  assert.deepEqual(Array.from(result, p => [p.tabId, p.placement]), [['first', 'header'], ['child', 'body'], ['second', 'header']]);
  const inserts = bodies.flatMap(b => b.requests).filter(r => r.insertText).map(r => r.insertText);
  assert.deepEqual(inserts.map(i => [i.location.tabId, i.location.segmentId || '', i.location.index]), [
    ['first', 'default', 0], ['first', 'firstPage', 0], ['child', '', 1], ['second', 'new-header', 0]
  ]);
});

test('replacement batches use descending indexes and chain required revisions', async () => {
  const h = harness();
  h.context.operations = Array.from({ length: 46 }, (_, i) => ({
    startIndex: i * 10 + 1, endIndex: i * 10 + 5, tabId: 't', style: {}, translatedText: 'Hola'
  }));
  const bodies = [];
  h.context.googleJson = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return { writeControl: { requiredRevisionId: `r${bodies.length}` } };
  };
  await h.run("applyTranslationsToGoogleDoc(operations, createRevisionWriter('copy', 'r0'))");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map(b => b.writeControl.requiredRevisionId), ['r0', 'r1']);
  const indexes = bodies.flatMap(b => b.requests).filter(r => r.deleteContentRange).map(r => r.deleteContentRange.range.startIndex);
  assert.deepEqual(indexes, Array.from({ length: 46 }, (_, i) => (45 - i) * 10 + 1));
});

test('revision conflict stops later batches without retrying', async () => {
  const h = harness();
  let calls = 0;
  h.context.operations = Array.from({ length: 100 }, (_, i) => ({ startIndex: i + 1, endIndex: i + 2, tabId: 't', style: {}, translatedText: 'a' }));
  h.context.googleJson = async () => {
    calls++;
    if (calls === 2) throw new Error('Google API error 400: required revision does not match latest revision');
    return { writeControl: { requiredRevisionId: 'r1' } };
  };
  await assert.rejects(h.run("applyTranslationsToGoogleDoc(operations, createRevisionWriter('copy', 'r0'))"), /changed during translation/);
  assert.equal(calls, 2);
});

test('missing revisions and changed warning snapshots fail closed', async () => {
  const h = harness();
  let calls = 0;
  h.context.googleJson = async () => { calls++; return {}; };
  assert.throws(() => h.run("createRevisionWriter('copy', '')"), /did not return a revision/);
  h.run("writer = createRevisionWriter('copy', 'r0')");
  await assert.rejects(h.run('writer.write([])'), /did not confirm/);
  await assert.rejects(h.run('writer.write([])'), /updates have stopped/);
  assert.equal(calls, 1);
  h.context.snapshot = { revisionId: 'external-edit', tabs: [docTab('t')] };
  await assert.rejects(h.run("addTranslationWarningToGoogleDoc(snapshot, 'Aviso', createRevisionWriter('copy', 'r0'))"), /changed before the warning/);
  assert.equal(calls, 1);
});

test('complete formatted workflow writes only the copy and adds notices after translated text', async () => {
  const h = harness();
  const tabs = [docTab('first', 'PAGELESS'), docTab('second', 'PAGELESS')];
  for (const tab of tabs) tab.documentTab.body = { content: [{ paragraph: { elements: [
    { startIndex: 1, endIndex: 7, textRun: { content: 'Hello\n', textStyle: {} } }
  ] } }] };
  let revision = 0;
  const requests = [];
  const reads = [];
  h.context.Translator = { create: async () => ({ translate: async text => `ES:${text}` }) };
  h.context.getGoogleAccessToken = async () => 'token';
  h.context.createEditableGoogleDocCopy = async id => {
    assert.equal(id, 'original');
    return { document: { id: 'copy', name: 'Lesson - Spanish' } };
  };
  h.context.getGoogleDocStructure = async id => {
    reads.push(id);
    return { revisionId: `r${revision}`, tabs };
  };
  h.context.googleJson = async (url, options) => {
    assert.match(url, /\/copy:batchUpdate$/);
    const body = JSON.parse(options.body);
    assert.equal(body.writeControl.requiredRevisionId, `r${revision}`);
    revision++;
    requests.push(body.requests);
    return { writeControl: { requiredRevisionId: `r${revision}` } };
  };
  h.run("sourceDocId = 'original'; sourceTitle = 'Lesson'; warningTextInput.value = 'Notice';");
  await h.run('createSpanishGoogleDoc()');
  assert.deepEqual(reads, ['copy', 'copy']);
  assert.equal(requests.length, 3);
  assert.equal(requests[0][1].insertText.text, 'ES:Hello');
  assert.equal(requests[1][0].insertText.text, 'ES:Notice\n\n');
  assert.equal(requests[2][0].insertText.location.tabId, 'second');
  assert.match(h.element('statusText').textContent, /created successfully/);
  assert.match(h.element('createdDocMeta').textContent, /all 2 document tabs/);
});
