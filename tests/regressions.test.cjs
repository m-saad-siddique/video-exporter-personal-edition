const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

function content() {
  const messages = [];
  const window = { addEventListener() {}, postMessage() {}, setTimeout() {}, clearTimeout() {} };
  window.top = window;
  const context = vm.createContext({
    window, URL, URLSearchParams, Headers, Response, Request, ArrayBuffer, Uint8Array, atob, btoa, Blob,
    navigator: { userAgent: "Node regression test" },
    location: { href: 'https://media.example.test/group/lesson-a' },
    document: { referrer: '', title: 'Lesson', baseURI: 'https://media.example.test/',
      querySelector: () => null, querySelectorAll: () => [] },
    chrome: { runtime: { onMessage: event(), sendMessage: async (m) => { messages.push(m); return { ok: true }; } } },
    MutationObserver: class { observe() {} },
  });
  const source = read('src/content/content.js');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
    state, resetLesson, analyzePage, parseCaptionText, isLikelyCaptionUrl,
    cuesFromTextTracks, selectQualityTrack, selectVimeoDashTracks, downloadHls,
    assertCompleteDuration, validateVideoBlob, downloadCompleteVideo, fetchCompleteVideoBlob,
    createSafeHlsFetch, diagnosticUrl, responseFromExtensionContext,
    setToolkit: (toolkit) => { mediaToolkitPromise = Promise.resolve(toolkit); }
  }; })();`), context);
  return { context, api: context.api, messages };
}

function background(session = {}) {
  const sent = [];
  const chrome = {
    storage: { session: { get: async () => structuredClone(session), set: async (patch) => Object.assign(session, structuredClone(patch)) } },
    downloads: { onCreated: event(), onChanged: event(), search: async () => [], show: () => {} },
    webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
    webRequest: { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() },
    tabs: { onRemoved: event(), sendMessage: async (...args) => { sent.push(args); return { ok: true }; } },
    runtime: { onMessage: event() },
  };
  const context = vm.createContext({ chrome, setTimeout: (fn) => fn() });
  context.importScripts = (file) => vm.runInContext(read('src/background/' + file), context);
  vm.runInContext(read('src/background/service-worker.js'), context);
  const run = (code) => vm.runInContext(code, context);
  return { chrome, sent, run, session };
}

function element() {
  return { value: '', textContent: '', disabled: false, hidden: false, style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; }, focus() {}, select() {}, blur() {}, remove() {},
    replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); return child; } };
}

function popup() {
  const nodes = new Map();
  const sent = [];
  const context = vm.createContext({
    window: { setInterval() {} },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      createElement: element, createDocumentFragment: element, createTextNode: (text) => ({ textContent: text }) },
    chrome: { storage: { onChanged: event(), sync: { get: () => new Promise(() => {}), set: async () => {} } },
      tabs: { query: async () => [{ id: 1, url: 'https://media.example.test/group/lesson-a' }] },
      runtime: { onMessage: event(), sendMessage: async (m) => {
        sent.push(m);
        if (m.type === 'EXTRACT_TRANSCRIPT_FROM_TAB') return { ok: true, lessonTitle: 'Lesson', cues: [{ start: 1.001, end: 2, text: 'Hello' }] };
        return { ok: true };
      } } },
  });
  vm.runInContext(read('src/popup/popup.js'), context);
  const run = (code) => vm.runInContext(code, context);
  run(`activeTab = { id: 1 }; analysis = { ok: true, lessonUrl: 'https://media.example.test/group/lesson-a', lessonTitle: 'Lesson' };`);
  return { nodes, sent, run };
}

test('JSON metadata is rejected while timed JSON, VTT and bracketed transcripts survive', () => {
  const { api } = content();
  assert.equal(api.isLikelyCaptionUrl('https://example.com/settings.json'), false);
  assert.equal(api.isLikelyCaptionUrl('https://example.com/transcript/en.json'), true);
  assert.equal(api.isLikelyCaptionUrl('https://example.com/transcript.json'), true);
  for (const text of ['{"body":"Account settings saved"}', '{\n "status": "ok"\n}', '{"text":"Player settings"}']) {
    assert.equal(api.parseCaptionText(text, 'https://example.com/config.json', 'application/json').length, 0);
  }
  assert.equal(api.parseCaptionText('[{"start":0,"end":2,"text":"Hello"}]')[0].text, 'Hello');
  assert.equal(api.parseCaptionText('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello')[0].end, 2);
  assert.equal(api.parseCaptionText('[00:01] Hello\n[00:03] World')[0].end, 3);
});

test('transcript extraction preserves showing, hidden and disabled subtitle modes', () => {
  const { api } = content();
  for (const mode of ['showing', 'hidden', 'disabled']) {
    const track = { mode, cues: [{ startTime: 0, endTime: 2, text: 'Hello' }] };
    assert.equal(api.cuesFromTextTracks({ textTracks: [track] })[0].text, 'Hello');
    assert.equal(track.mode, mode);
  }
  const track = { mode: 'disabled', get cues() { throw Error('Unavailable'); } };
  assert.equal(api.cuesFromTextTracks({ textTracks: [track] }).length, 0);
  assert.equal(track.mode, 'disabled');
});

test('a lesson URL change clears content media, captions and cached analysis', () => {
  const { context, api } = content();
  for (const field of ['pageCaptionResponses', 'pageNetworkResponses', 'pageHlsResponses', 'pageDashConfigs']) {
    api.state[field].push({ url: 'old-lesson' });
  }
  api.state.lastTranscript = { cues: ['old transcript'] };
  context.location.href = 'https://media.example.test/group/lesson-b';
  api.analyzePage();
  for (const field of ['pageCaptionResponses', 'pageNetworkResponses', 'pageHlsResponses', 'pageDashConfigs']) assert.equal(api.state[field].length, 0);
  assert.equal(api.state.lastTranscript, null);
});

test('SPA navigation prevents an old HLS playlist outranking the new direct video', () => {
  const { chrome, sent, run } = background();
  run(`captureUnique(capturedMediaRequests, 1, {url: 'https://cdn.example/old.m3u8', kind: 'hls', statusCode: 200, frameId: 2});
    captureUnique(capturedCaptionRequests, 1, {url: 'https://cdn.example/old.vtt', frameId: 2});
    frameAnalyses.set(1, new Map([[2, {frameId: 2, updatedAt: now(), analysis: {}}]]));`);
  chrome.webNavigation.onHistoryStateUpdated.listeners[0]({ tabId: 1, frameId: 0, url: 'https://media.example.test/group/lesson-b' });
  assert.equal(run('pruneCaptured(1).length'), 0);
  assert.equal(run('pruneFrameAnalyses(1).length'), 0);
  run(`captureUnique(capturedMediaRequests, 1, {url: 'https://cdn.example/new.mp4', kind: 'direct', statusCode: 200, frameId: 3});`);
  assert.equal(run('bestCapturedMedia(1).url'), 'https://cdn.example/new.mp4');
  assert.equal(sent[0][1].type, 'RESET_LESSON');
});

test('iframe replacement clears only that frame, leaving sibling media intact', () => {
  const { chrome, run } = background();
  run(`captureUnique(capturedMediaRequests, 1, {url: 'old', frameId: 2});
       captureUnique(capturedMediaRequests, 1, {url: 'sibling', frameId: 3});`);
  chrome.webNavigation.onCommitted.listeners[0]({ tabId: 1, frameId: 2, url: 'https://player.example/new' });
  assert.equal(run('pruneCapturedMedia(1).length'), 1);
  assert.equal(run('pruneCapturedMedia(1)[0].url'), 'sibling');
});

test('quality selection chooses the requested ceiling and falls back to the lowest available', () => {
  const { api } = content();
  const tracks = [2160, 1080, 720, 480].map((height) => ({ height }));
  assert.equal(api.selectQualityTrack(tracks, 'best').height, 2160);
  assert.equal(api.selectQualityTrack(tracks, '1080').height, 1080);
  assert.equal(api.selectQualityTrack(tracks, '720').height, 720);
  assert.equal(api.selectQualityTrack(tracks, '360').height, 480);
});

test('popup sends the chosen quality to stream download commands', async () => {
  const { run, sent } = popup();
  run(`settings.videoQuality = '720'; analysis.video = {source: {kind: 'hls', url: 'https://cdn.example/new.m3u8'}};`);
  await run('downloadVideo()');
  assert.equal(sent[0].type, 'START_VIDEO_DOWNLOAD');
  assert.equal(sent[0].payload.quality, '720');
});

test('SRT and VTT exports have the correct extension, MIME type and timing', async () => {
  for (const ext of ['srt', 'vtt']) {
    const { run, sent } = popup();
    run(`settings.transcriptFormat = '${ext}';`);
    await run('extractTranscript()');
    const exportMessage = sent.find((m) => m.type === 'DOWNLOAD_TEXT');
    assert.ok(exportMessage);
    assert.ok(exportMessage.payload.filename.endsWith('.' + ext));
    assert.equal(exportMessage.payload.mimeType, ext === 'srt' ? 'application/x-subrip' : 'text/vtt');
    assert.ok(exportMessage.payload.text.includes(ext === 'srt' ? '00:00:01,001 --> 00:00:02,000' : '00:00:01.001 --> 00:00:02.000'));
  }
});

test('untimed transcripts remain available as TXT and cannot produce fake subtitle timing', () => {
  const { run } = popup();
  run(`transcript = {ok: true, cues: [{start: null, end: null, text: 'Hello'}]};`);
  assert.equal(run(`transcriptAs('txt')`), 'Hello');
  assert.throws(() => run(`transcriptAs('srt')`), /require timed captions/);
  assert.throws(() => run(`transcriptAs('vtt')`), /require timed captions/);
});

test('preview search filters visible rows without changing exported content', () => {
  const { run, nodes } = popup();
  run(`transcript = {ok: true, cues: [{start: 0, end: 2, text: 'Hello'}, {start: 2, end: 4, text: '<script>World</script>'}]};
    dom.transcriptSearch.value = 'world'; renderTranscriptPreview();`);
  assert.match(nodes.get('previewCount').textContent, /1 of 2 segments/);
  assert.equal(nodes.get('transcriptPreview').children[0].children.length, 1);
  assert.match(run(`transcriptAs('txt')`), /Hello/);
  assert.match(run(`transcriptAs('txt')`), /World/);
});

test('in-flight page responses from the previous lesson are ignored', async () => {
  let resolveFetch;
  const listeners = {};
  const posts = [];
  const window = { fetch: () => new Promise((resolve) => { resolveFetch = resolve; }),
    postMessage: (data) => posts.push(data), addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(read('src/content/page-hook.js'), { window, URL,
    location: { href: 'https://media.example.test/group/lesson-a', origin: 'https://media.example.test' }, document: { referrer: '' } });
  const pending = window.fetch('https://cdn.example/old.m3u8');
  listeners.message({ source: window, data: { source: 'video-transcript-exporter-content', type: 'RESET_PAGE_CONTEXT' } });
  resolveFetch(new Response('#EXTM3U\n#EXT-X-ENDLIST', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  await pending;
  assert.equal(posts.filter((p) => p.type !== 'PAGE_HOOK_READY').length, 0);
});


test('late background request completions cannot restore media from the old lesson', () => {
  const { chrome, run } = background();
  const details = { requestId: 'old-request', tabId: 1, frameId: 2, url: 'https://cdn.example/old.m3u8', statusCode: 200 };
  chrome.webRequest.onBeforeRequest.listeners[0](details);
  chrome.webNavigation.onHistoryStateUpdated.listeners[0]({ tabId: 1, frameId: 0, url: 'https://media.example.test/group/lesson-b' });
  // A redirect must not turn the invalidated request into a fresh capture.
  chrome.webRequest.onBeforeRequest.listeners[0](details);
  chrome.webRequest.onCompleted.listeners[0](details);
  assert.equal(run('pruneCapturedMedia(1).length'), 0);
  const fresh = { ...details, requestId: 'new-request', url: 'https://cdn.example/new.m3u8' };
  chrome.webRequest.onBeforeRequest.listeners[0](fresh);
  chrome.webRequest.onCompleted.listeners[0](fresh);
  assert.equal(run('bestCapturedMedia(1).url'), fresh.url);
});


test('Vimeo track selection honors the preferred resolution and keeps AAC audio', () => {
  const { api } = content();
  const config = { video: [360, 1080, 720].map((height) => ({
    height, format: 'dash', mime_type: 'video/mp4', codecs: 'avc1.64001f',
    init_segment: btoa('test initialization'), segments: [{ url: 'fragment.m4s' }]
  })), audio: [{ format: 'dash', mime_type: 'audio/mp4', codecs: 'mp4a.40.2',
    init_segment: btoa('test initialization'), segments: [{ url: 'audio.m4s' }] }] };
  assert.equal(api.selectVimeoDashTracks(config, '720').video.height, 720);
  assert.equal(api.selectVimeoDashTracks(config, 'best').video.height, 1080);
  assert.equal(api.selectVimeoDashTracks(config, '360').audio.codecs, 'mp4a.40.2');
});


test('real four-second ftyp MP4 fragment is rejected against a longer lesson', async () => {
  const { api } = content();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  const bytes = fs.readFileSync(path.join(root, 'tests/fixtures/four-seconds.mp4'));
  assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  const blob = new Blob([bytes], { type: 'video/mp4' });
  await assert.rejects(api.validateVideoBlob(blob, 120, toolkit), /Only 4.0s of the 120.0s lesson/);
});

test('real complete MP4 passes the duration check', async () => {
  const { api } = content();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  const blob = new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/twelve-seconds.mp4'))], { type: 'video/mp4' });
  assert.equal(await api.validateVideoBlob(blob, 12, toolkit), 12);
});

test('direct download does not save a playable four-second fragment as a complete lesson', async () => {
  const { api, context } = content();
  api.setToolkit(await import('../vendor/mediabunny.min.mjs'));
  context.location.origin = 'https://media.example.test';
  context.fetch = async () => new Response(fs.readFileSync(path.join(root, 'tests/fixtures/four-seconds.mp4')), {headers: {'content-type': 'video/mp4'}});
  await assert.rejects(api.downloadCompleteVideo({ source: {kind: 'direct', url: 'https://cdn.example/video.mp4'}, expectedDuration: 120 }), /Only 4.0s/);
});

test('video rows show the total, duration, quality, and one download button per video', () => {
  const { run, nodes } = popup();
  run(`analysis.videos = [{id:'2:a', title:'Lesson A', duration:125, height:720, source:{status:'downloadable'}},
    {id:'3:b', title:'Lesson B', duration:3601, height:1080, source:{status:'conditional'}}]; renderVideoList();`);
  assert.equal(nodes.get('videoCount').textContent, '2');
  const rows = nodes.get('videoList').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].children.at(-1).textContent, '2:05');
  assert.equal(rows[1].children[0].children.at(-1).textContent, '1:00:01');
  assert.equal(rows[0].children[1].children.at(-1).textContent, 'Playback 720p');
  assert.equal(rows[0].children[1].children[2].children.at(-1).textContent, 'Download');
});


test('a short direct fragment falls back to the full HLS lesson and saves all twelve seconds', async () => {
  const { api, context } = content();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  context.location.origin = 'https://media.example.test';
  const saved = [];
  context.URL = class extends URL {
    static createObjectURL(blob) { saved.push(blob); return 'blob:test'; }
    static revokeObjectURL() {}
  };
  context.document.createElement = () => ({ click() {}, remove() {} });
  context.document.documentElement = { appendChild() {} };
  context.fetch = async (url, init = {}) => {
    const name = new URL(url).pathname.split('/').pop();
    const file = name === 'fragment.mp4' ? 'four-seconds.mp4' : name;
    const data = fs.readFileSync(path.join(root, 'tests/fixtures', file));
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    const range = new Headers(init.headers).get('range')?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
      return new Response(data.subarray(start, end + 1), {status:206, headers:{'content-type':type,'content-range':`bytes ${start}-${end}/${data.length}`}});
    }
    return new Response(data, {headers:{'content-type':type,'content-length':String(data.length)}});
  };
  api.state.pageNetworkResponses.push({ kind: 'hls', status: 200, url: 'https://cdn.example/lesson.m3u8' });
  const result = await api.downloadCompleteVideo({ source: {kind:'direct',url:'https://cdn.example/fragment.mp4'}, expectedDuration:12, filenameBase:'lesson' });
  assert.equal(result.ok, true);
  assert.equal(saved.length, 1);
  const duration = await api.validateVideoBlob(saved[0], 12, toolkit);
  assert.ok(Math.abs(duration - 12) < 0.1);
});


test('large direct files are assembled from ordered ranges and short responses are rejected', async () => {
  const { api, context } = content();
  context.location.origin = 'https://media.example.test';
  const data = Buffer.alloc(8 * 1024 * 1024 + 7, 42);
  const ranges = [];
  context.fetch = async (_url, init) => {
    const match = new Headers(init.headers).get('range').match(/bytes=(\d+)-(\d+)/);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), data.length - 1);
    ranges.push([start, end]);
    return new Response(data.subarray(start, end + 1), {status:206, headers:{'content-type':'video/mp4','content-range':`bytes ${start}-${end}/${data.length}`}});
  };
  const blob = await api.fetchCompleteVideoBlob('https://cdn.example/full.mp4');
  assert.equal(blob.size, data.length);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[1][0], 8 * 1024 * 1024);
  assert.equal((await blob.arrayBuffer()).byteLength, data.length);
  context.fetch = async () => new Response(new Uint8Array(2), {status:206, headers:{'content-range':'bytes 0-9/100'}});
  await assert.rejects(api.fetchCompleteVideoBlob('https://cdn.example/short.mp4'), /cut short/);
});

function hlsFixtureContent(aliases = {}) {
  const instance = content();
  const { context } = instance;
  const saved = [];
  const fetched = [];
  context.location.origin = 'https://media.example.test';
  context.URL = class extends URL {
    static createObjectURL(blob) { saved.push(blob); return 'blob:test'; }
    static revokeObjectURL() {}
  };
  context.document.createElement = () => ({ click() {}, remove() {} });
  context.document.documentElement = { appendChild() {} };
  context.fetch = async (url, init = {}) => {
    fetched.push(url);
    const name = new URL(url).pathname.split('/').pop();
    const file = aliases[name] || name;
    const data = fs.readFileSync(path.join(root, 'tests/fixtures', file));
    const type = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    const range = new Headers(init.headers).get('range')?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
      return new Response(data.subarray(start, end + 1), {status:206, headers:{'content-type':type,'content-range':`bytes ${start}-${end}/${data.length}`}});
    }
    return new Response(data, {headers:{'content-type':type,'content-length':String(data.length)}});
  };
  return { ...instance, saved, fetched };
}

test('an audio-only initial playlist recovers through another observed video playlist', async () => {
  const { api, saved, fetched } = hlsFixtureContent({ 'captured.m3u8': 'audio.m3u8', 'alternate.m3u8': 'master.m3u8' });
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  await api.downloadHls('https://cdn.example/captured.m3u8', 'lesson', 'best', 12, ['https://cdn.example/alternate.m3u8']);
  assert.ok(fetched.some((url) => url.includes('captured.m3u8')));
  assert.ok(fetched.some((url) => url.includes('alternate.m3u8')));
  assert.equal(saved.length, 1);
  assert.ok(Math.abs(await api.validateVideoBlob(saved[0], 12, toolkit) - 12) < 0.1);
});

test('a captured master is preferred over audio and preserves video plus separate audio', async () => {
  const { api, saved, fetched } = hlsFixtureContent();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  api.state.pageHlsResponses.push({url:'https://cdn.example/master.m3u8', text:read('tests/fixtures/master.m3u8')});
  await api.downloadHls('https://cdn.example/audio.m3u8', 'lesson', 'best', 12);
  assert.equal(saved.length, 1);
  const input = new toolkit.Input({source:new toolkit.BlobSource(saved[0]), formats:toolkit.ALL_FORMATS});
  try {
    assert.equal((await input.getVideoTracks()).length, 1);
    assert.equal((await input.getAudioTracks()).length, 1);
    assert.ok(Math.abs(await api.validateVideoBlob(saved[0], 12, toolkit) - 12) < 0.1);
  } finally { input.dispose(); }
});

test('audio-only captures report missing video and save no misleading output', async () => {
  const { api, saved } = hlsFixtureContent();
  api.setToolkit(await import('../vendor/mediabunny.min.mjs'));
  await assert.rejects(api.downloadHls('https://cdn.example/audio.m3u8', 'lesson', 'best', 12), /Only audio or non-video playlists were detected/);
  assert.equal(saved.length, 0);
});

test('a complete video with just four seconds of sound fails audio coverage validation', async () => {
  const { api } = content();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  const blob = new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/short-audio.mp4'))], {type:'video/mp4'});
  await assert.rejects(api.validateVideoBlob(blob, 12, toolkit), /Audio covers only 4.0s of the 12.0s video/);
});

test('a stale four-second audio playlist is refreshed and produces full-length sound', async () => {
  const { api, saved, fetched } = hlsFixtureContent();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  api.state.pageHlsResponses.push({url:'https://cdn.example/audio.m3u8', text:read('tests/fixtures/audio-short.m3u8')});
  await api.downloadHls('https://cdn.example/master.m3u8', 'lesson', 'best', 12);
  assert.ok(fetched.some((url) => url.includes('audio.m3u8')));
  assert.equal(saved.length, 1);
  assert.ok(Math.abs(await api.validateVideoBlob(saved[0], 12, toolkit, true) - 12) < 0.1);
});

test('short source audio cannot fall back to a silent video and claim success', async () => {
  const { api, saved } = hlsFixtureContent({'audio.m3u8':'audio-short.m3u8'});
  api.setToolkit(await import('../vendor/mediabunny.min.mjs'));
  await assert.rejects(api.downloadHls('https://cdn.example/master.m3u8', 'lesson', 'best', 12, ['https://cdn.example/lesson.m3u8']), /full-length audio track could not be paired/);
  assert.equal(saved.length, 0);
});

test('required sound must survive remuxing as an actual audio track', async () => {
  const { api } = content();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  const blob = new Blob([fs.readFileSync(path.join(root, 'tests/fixtures/twelve-seconds.mp4'))], {type:'video/mp4'});
  await assert.rejects(api.validateVideoBlob(blob, 12, toolkit, true), /missing its audio track/);
});

test('HLS child links are fetched exactly as published, without parent query pollution', async () => {
  const { api, context } = content();
  context.location.origin = 'https://media.example.test';
  const requested = [];
  const child = 'https://cdn.example/course/video.m3u8?sig=child%2f%20~';
  context.fetch = async (url) => {
    requested.push(url);
    return url === child
      ? new Response(read('tests/fixtures/lesson.m3u8'), {headers:{'content-type':'application/vnd.apple.mpegurl'}})
      : new Response('', {status:404});
  };
  const fetchHls = api.createSafeHlsFetch('https://cdn.example/course/master.m3u8?parent=parent-signature');
  assert.equal((await fetchHls(child)).status, 200);
  assert.equal(requested[0], child);
  assert.equal(requested.length, 1);
});

test('query inheritance is a fallback and preserves exact child and parent encoding', async () => {
  const { api, context } = content();
  context.location.origin = 'https://media.example.test';
  const requested = [];
  const child = 'https://cdn.example/course/segment.ts?value=child%2f%20~';
  const inherited = child + '&sig=parent%2f%20~';
  context.fetch = async (url) => {
    requested.push(url);
    return url === inherited ? new Response(new Uint8Array([1,2,3])) : new Response('', {status:403});
  };
  const fetchHls = api.createSafeHlsFetch('https://cdn.example/course/master.m3u8?sig=parent%2f%20~');
  assert.equal((await fetchHls(child)).status, 200);
  assert.equal(requested[0], child);
  assert.equal(requested[requested.length - 1], inherited);
});

test('redirected master children resolve under the final CDN directory with video and audio intact', async () => {
  const { api, context, saved } = hlsFixtureContent();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  const original = context.fetch;
  const requests = [];
  context.fetch = async (url, init) => {
    requests.push(url);
    if (url === 'https://cdn.example/entry/master.m3u8') {
      const response = new Response(read('tests/fixtures/master.m3u8'), {headers:{'content-type':'application/vnd.apple.mpegurl'}});
      Object.defineProperty(response, 'url', {value:'https://cdn.example/course/streams/master.m3u8?sig=master-only'});
      return response;
    }
    if (!url.startsWith('https://cdn.example/course/streams/') || new URL(url).search) return new Response('', {status:404});
    return original(url, init);
  };
  await api.downloadHls('https://cdn.example/entry/master.m3u8', 'lesson', 'best', 12);
  assert.equal(saved.length, 1);
  assert.ok(requests.includes('https://cdn.example/course/streams/audio.m3u8'));
  assert.ok(requests.includes('https://cdn.example/course/streams/lesson.m3u8'));
  assert.ok(Math.abs(await api.validateVideoBlob(saved[0], 12, toolkit, true) - 12) < 0.1);
});

test('background fetch reconstruction preserves the final redirected response URL', async () => {
  const { api, context } = content();
  context.chrome.runtime.sendMessage = async () => ({ok:true,base64:btoa('test'),status:200,finalUrl:'https://cdn.example/real/master.m3u8'});
  const response = await api.responseFromExtensionContext('https://cdn.example/entry/master.m3u8');
  assert.equal(response.url, 'https://cdn.example/real/master.m3u8');
});

test('download diagnostics remove URL query values and long signed path segments', () => {
  const { api } = content();
  const secret = 'a-very-long-signed-path-value-that-must-not-be-shared';
  const result = api.diagnosticUrl(`https://cdn.example/${secret}/master.m3u8?token=private-token&sig=private-signature#private-fragment`);
  assert.ok(!result.includes(secret));
  assert.ok(!result.includes('private-'));
  assert.ok(result.includes('token=[redacted]'));
  assert.ok(result.includes('master.m3u8'));
});

test('a download error exposes a diagnostic export with URL query values removed', async () => {
  const { run, nodes, sent } = popup();
  run(`chrome.runtime.getManifest = () => ({version:'1.12.0'}); lastDownloadFrameId = 2;
    setError('Request failed: https://cdn.example/video.m3u8?sig=secret-query-value');`);
  assert.equal(nodes.get('downloadDiagnosticsButton').hidden, false);
  await run('downloadDiagnostics()');
  assert.equal(sent[0].command, 'GET_MEDIA_DIAGNOSTICS');
  assert.equal(sent[0].frameId, 2);
  const exported = sent.find((message) => message.type === 'DOWNLOAD_TEXT');
  assert.equal(exported.payload.filename, 'video-download-diagnostics.json');
  assert.ok(!exported.payload.text.includes('secret-query-value'));
  assert.equal(JSON.parse(exported.payload.text).version, '1.12.0');
});

const flushJobs = () => new Promise((resolve) => setImmediate(resolve));
function startJobMessage() {
  return {type:'START_VIDEO_DOWNLOAD',tabId:1,frameId:2,key:'1|lesson|video',title:'Lesson export',duration:12,quality:'720',lessonUrl:'https://media.example.test/group/lesson-a',payload:{source:{kind:'hls',url:'https://cdn.example/master.m3u8'},quality:'720'}};
}

test('a download starts once, persists progress, and can be restored after reopening', async () => {
  const { chrome, run, session } = background();
  let requests = 0;
  chrome.tabs.sendMessage = async () => { requests += 1; return new Promise(() => {}); };
  const manager = run('downloadJobManager');
  const [first, duplicate] = await Promise.all([manager.handle(startJobMessage(), {}), manager.handle(startJobMessage(), {})]);
  assert.equal(first.job.id, duplicate.job.id);
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(requests, 1);
  await manager.handle({type:'CONTENT_PROGRESS',jobId:first.job.id,detail:{message:'Downloading fragments…',completed:7,total:10}}, {tab:{id:1}});
  const reopened = background(session).run('downloadJobManager');
  const result = await reopened.handle({type:'GET_VIDEO_JOBS'}, {});
  assert.equal(result.jobs[0].status, 'downloading');
  assert.equal(result.jobs[0].percent, 70);
});

test('history marks a file saved only after the native download completes', async () => {
  const { chrome, run } = background();
  chrome.tabs.sendMessage = async () => new Promise(() => {});
  const manager = run('downloadJobManager');
  const {job} = await manager.handle(startJobMessage(), {});
  await manager.handle({type:'PREPARE_VIDEO_SAVE',jobId:job.id,url:'blob:https://media.example.test/test-blob',filename:'lesson.mp4'}, {tab:{id:1}});
  await manager.handle({type:'VIDEO_JOB_RESULT',jobId:job.id,result:{ok:true}}, {tab:{id:1}});
  assert.equal((await manager.list())[0].status, 'saving');
  chrome.downloads.onCreated.listeners[0]({id:42,url:'blob:https://media.example.test/test-blob',state:'in_progress',filename:'/Downloads/lesson.mp4'});
  await flushJobs();
  assert.equal((await manager.list())[0].status, 'saving');
  chrome.downloads.onChanged.listeners[0]({id:42,state:{current:'complete'}});
  await flushJobs();
  const saved = (await manager.list())[0];
  assert.equal(saved.status, 'complete');
  assert.equal(saved.downloadId, 42);
  assert.equal(saved.percent, 100);
  await manager.handle({type:'VIDEO_JOB_RESULT',jobId:job.id,result:{ok:true}}, {tab:{id:1}});
  assert.equal((await manager.list())[0].status, 'complete');
});

test('native save interruption is not overwritten by a late successful remux result', async () => {
  const { chrome, run } = background();
  chrome.tabs.sendMessage = async () => new Promise(() => {});
  const manager = run('downloadJobManager');
  const {job} = await manager.handle(startJobMessage(), {});
  await manager.handle({type:'PREPARE_VIDEO_SAVE',jobId:job.id,url:'blob:test',filename:'lesson.mp4'}, {tab:{id:1}});
  chrome.downloads.onCreated.listeners[0]({id:99,url:'blob:test',state:'in_progress'});
  await flushJobs();
  chrome.downloads.onChanged.listeners[0]({id:99,state:{current:'interrupted'},error:{current:'FILE_FAILED'}});
  await flushJobs();
  await manager.handle({type:'VIDEO_JOB_RESULT',jobId:job.id,result:{ok:true}}, {tab:{id:1}});
  assert.equal((await manager.list())[0].status, 'error');
});

test('clearing history preserves active tasks and does not erase native files', async () => {
  const session = {videoJobs:[{id:'busy',status:'downloading'},{id:'done',status:'complete',downloadId:42}]};
  const manager = background(session).run('downloadJobManager');
  const response = await manager.handle({type:'CLEAR_VIDEO_JOBS'}, {});
  assert.equal(response.jobs.length, 1);
  assert.equal(response.jobs[0].id, 'busy');
});

test('a different tab cannot update another lesson download or attach its file', async () => {
  const { chrome, run } = background();
  chrome.tabs.sendMessage = async () => new Promise(() => {});
  const manager = run('downloadJobManager');
  const {job} = await manager.handle(startJobMessage(), {});
  const response = await manager.handle({type:'CONTENT_PROGRESS',jobId:job.id,detail:{completed:100,total:100}}, {tab:{id:999}});
  assert.equal(response.ok, false);
  await assert.rejects(manager.handle({type:'PREPARE_VIDEO_SAVE',jobId:job.id,url:'blob:other'}, {tab:{id:999}}), /does not match/);
});

test('popup tabs separate transcript tools and settings from the video list', () => {
  const { run, nodes } = popup();
  run(`selectPanel('transcripts')`);
  assert.equal(nodes.get('videosPanel').hidden, true);
  assert.equal(nodes.get('transcriptsPanel').hidden, false);
  assert.equal(nodes.get('transcriptsTab').getAttribute('aria-selected'), 'true');
  run(`selectPanel('settings')`);
  assert.equal(nodes.get('transcriptsPanel').hidden, true);
  assert.equal(nodes.get('settingsPanel').hidden, false);
});

test('the pinned official remuxer matches its published bundle digest', () => {
  const provenance = JSON.parse(read('vendor/mediabunny-PROVENANCE.json'));
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'vendor',provenance.bundle))).digest('hex');
  assert.equal(digest, provenance.sha256);
  assert.equal(provenance.version, '1.65.2');
});

test('a real overlapping-GOP fixture remuxes past the old fatal timestamp boundary', async () => {
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  const input = new toolkit.Input({source:new toolkit.BlobSource(new Blob([fs.readFileSync(path.join(root,'tests/fixtures/overlapping-gop.mp4'))])), formats:toolkit.ALL_FORMATS});
  try {
    const video = await input.getPrimaryVideoTrack();
    let max = -Infinity, beforeGop = -Infinity, overlap = false;
    for await (const packet of new toolkit.EncodedPacketSink(video).packets(undefined,undefined,{metadataOnly:true})) {
      if (packet.type === 'key') beforeGop = max;
      if (packet.timestamp < beforeGop) overlap = true;
      max = Math.max(max,packet.timestamp);
    }
    assert.equal(overlap, true, 'Fixture must reproduce the previous muxer rule violation');
    const target = new toolkit.BufferTarget();
    const output = new toolkit.Output({format:new toolkit.Mp4OutputFormat(),target});
    const conversion = await toolkit.Conversion.init({input,output});
    await conversion.execute();
    const { api } = content();
    assert.equal(await api.validateVideoBlob(new Blob([target.buffer]),12,toolkit),12);
  } finally { input.dispose(); }
});

test('HLS with an overlapping GOP still exports the full timeline and full audio', async () => {
  const { api, saved } = hlsFixtureContent();
  const toolkit = await import('../vendor/mediabunny.min.mjs');
  api.setToolkit(toolkit);
  await api.downloadHls('https://cdn.example/gop-master.m3u8','lesson','best',12);
  assert.equal(saved.length,1);
  assert.equal(await api.validateVideoBlob(saved[0],12,toolkit,true),12);
});

test('the popup inspects an ordinary HTTPS website on general websites', async () => {
  const { run, sent, nodes } = popup();
  run(`chrome.tabs.query = async () => [{id:9,url:'https://videos.example.test/watch/1'}];
    const originalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (message) => {
      if (message.type === 'GET_TAB_ANALYSIS') { await originalSend(message); return {ok:true,analysis:{ok:true,lessonTitle:'Example video',lessonUrl:'https://videos.example.test/watch/1',videos:[]}}; }
      return originalSend(message);
    };`);
  await run('refresh()');
  assert.ok(sent.some((message) => message.type === 'GET_TAB_ANALYSIS' && message.tabId === 9));
  assert.equal(nodes.get('lessonTitle').textContent,'Example video');
  assert.equal(nodes.get('errorPanel').hidden,true);
});

test('the popup also inspects ordinary HTTP pages and rejects browser internal pages', async () => {
  const { run, sent, nodes } = popup();
  run(`chrome.tabs.query = async () => [{id:9,url:'http://videos.example.test/watch/1'}]`);
  await run('refresh()');
  assert.ok(sent.some((message) => message.type === 'GET_TAB_ANALYSIS'));
  const previous = sent.length;
  run(`chrome.tabs.query = async () => [{id:10,url:'chrome://extensions/'}]`);
  await run('refresh()');
  assert.equal(sent.length,previous);
  assert.equal(nodes.get('detectionStatus').textContent,'Open a video page');
});

test('page hooks install without a provider-specific URL or referrer on HTTP and HTTPS sites', async () => {
  for (const protocol of ['http:','https:']) {
    const posts = [];
    const url = `${protocol}//player.example.test/watch`;
    const originalFetch = async () => new Response('ok');
    const window = {fetch:originalFetch,postMessage:(message)=>posts.push(message),addEventListener(){}};
    vm.runInNewContext(read('src/content/page-hook.js'),{window,URL,location:{href:url,origin:new URL(url).origin},document:{referrer:''}});
    assert.notEqual(window.fetch,originalFetch);
    assert.ok(posts.some((message) => message.type === 'PAGE_HOOK_READY'));
  }
});
