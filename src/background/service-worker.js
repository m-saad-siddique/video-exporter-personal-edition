importScripts("download-jobs.js");

const CAPTION_URL_TTL_MS = 30 * 60 * 1000;
const MAX_CAPTURED_PER_TAB = 160;
const capturedCaptionRequests = new Map();
const capturedMediaRequests = new Map();
const frameAnalyses = new Map();
const lessonUrls = new Map();
const pendingNetworkRequests = new Map();
const networkFilter = {
  urls: ["http://*/*", "https://*/*"],
  types: ["xmlhttprequest", "media", "other"]
};

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  const previous = pendingNetworkRequests.get(details.requestId);
  pendingNetworkRequests.set(details.requestId, {
    tabId: details.tabId, frameId: details.frameId, valid: previous?.valid ?? true
  });
}, networkFilter);
chrome.webRequest.onErrorOccurred.addListener((details) => pendingNetworkRequests.delete(details.requestId), networkFilter);

function resetNavigation(details, committed = false) {
  const { tabId, frameId, url } = details;
  if (!committed && frameId === 0 && lessonUrls.get(tabId) === url) return;
  // Ignore completions from requests that started before this navigation.
  for (const request of pendingNetworkRequests.values()) {
    if (request.tabId === tabId && (frameId === 0 || request.frameId === frameId)) request.valid = false;
  }
  if (frameId !== 0) {
    removeFrameAnalysis(tabId, frameId);
    for (const map of [capturedCaptionRequests, capturedMediaRequests]) {
      map.set(tabId, (map.get(tabId) || []).filter((entry) => entry.frameId !== frameId));
    }
    return;
  }
  lessonUrls.set(tabId, url);
  capturedCaptionRequests.delete(tabId);
  capturedMediaRequests.delete(tabId);
  frameAnalyses.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: "RESET_LESSON", lessonUrl: url }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener((details) => resetNavigation(details, true));
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => resetNavigation(details));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => resetNavigation(details));

function now() {
  return Date.now();
}

function isLikelyCaptionUrl(url) {
  const lower = url.toLowerCase();
  return (
    /\.(vtt|srt)(\?|#|$)/.test(lower) ||
    /(^|[./?&=_-])(caption|captions|subtitle|subtitles|transcript|texttrack|text-track)([./?&=_-]|$)/.test(lower)
  );
}

function isLikelyMediaUrl(url, contentType = "") {
  const lower = String(url || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  return (
    /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd|m4s|ts)(\?|#|$)/.test(lower) ||
    /application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/.test(type) ||
    /^video\//.test(type) ||
    /(^|[/?&=_-])(hls|m3u8|playlist|master|manifest|video|media)([/?&=_-]|$)/.test(lower)
  );
}

function headerValue(details, name) {
  const target = name.toLowerCase();
  return (details.responseHeaders || []).find((header) => header.name.toLowerCase() === target)?.value || "";
}

function pruneCapturedMap(map, tabId) {
  const entries = map.get(tabId) || [];
  const fresh = entries.filter((entry) => now() - entry.timestamp < CAPTION_URL_TTL_MS);
  map.set(tabId, fresh.slice(-MAX_CAPTURED_PER_TAB));
  return map.get(tabId);
}

function pruneCaptured(tabId) {
  return pruneCapturedMap(capturedCaptionRequests, tabId);
}

function pruneCapturedMedia(tabId) {
  return pruneCapturedMap(capturedMediaRequests, tabId);
}

function mediaKindFromUrl(url, contentType = "") {
  const lower = String(url || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  if (/\.m3u8(\?|#|$)/.test(lower) || /mpegurl/.test(type)) return "hls";
  if (/\.mpd(\?|#|$)/.test(lower) || /dash\+xml/.test(type)) return "dash";
  if (isLikelyMediaFragment(url)) return "segment";
  if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/.test(lower) || /^video\//.test(type)) return "direct";
  return "unknown";
}

function isLikelyMediaFragment(url) {
  const lower = String(url || "").toLowerCase();
  return (
    /\.(m4s|cmfv|cmfa|ts)(\?|#|$)/.test(lower) ||
    /(^|[/?&=_-])(seg|segment|fragment|frag|chunk|part|init)(\d*|[/?&=_-]|$)/.test(lower) ||
    /(^|[/?&=_-])(moof|m4s|fmp4)([/?&=_-]|$)/.test(lower)
  );
}

function captureUnique(map, tabId, entry) {
  const entries = pruneCapturedMap(map, tabId);
  const existing = entries.find((item) => item.url === entry.url);
  if (existing) {
    Object.assign(existing, entry, { timestamp: now() });
  } else {
    entries.push({ ...entry, timestamp: now() });
  }
  map.set(tabId, entries.slice(-MAX_CAPTURED_PER_TAB));
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const request = pendingNetworkRequests.get(details.requestId);
    pendingNetworkRequests.delete(details.requestId);
    if (request?.valid === false || details.tabId < 0 || !details.url) return;
    const contentType = headerValue(details, "content-type");

    if (isLikelyCaptionUrl(details.url)) {
      captureUnique(capturedCaptionRequests, details.tabId, {
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        contentType,
        frameId: details.frameId,
        type: "caption",
        timestamp: now()
      });
    }

    if (isLikelyMediaUrl(details.url, contentType)) {
      captureUnique(capturedMediaRequests, details.tabId, {
        url: details.url,
        method: details.method,
        statusCode: details.statusCode,
        contentType,
        frameId: details.frameId,
        kind: mediaKindFromUrl(details.url, contentType),
        timestamp: now()
      });
    }
  },
  networkFilter,
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  capturedCaptionRequests.delete(tabId);
  capturedMediaRequests.delete(tabId);
  frameAnalyses.delete(tabId);
  lessonUrls.delete(tabId);
  for (const [requestId, request] of pendingNetworkRequests) {
    if (request.tabId === tabId) pendingNetworkRequests.delete(requestId);
  }
});

function pruneFrameAnalyses(tabId) {
  const frames = frameAnalyses.get(tabId);
  if (!frames) return [];
  const fresh = Array.from(frames.values()).filter((entry) => now() - entry.updatedAt < 2 * 60 * 1000);
  frameAnalyses.set(
    tabId,
    new Map(fresh.map((entry) => [entry.frameId, entry]))
  );
  return fresh;
}

function scoreAnalysis(entry) {
  const videoPriority = {
    downloadable: 80,
    conditional: 70,
    unknown: 35,
    unsupported: 25,
    missing: 0
  };
  const source = entry.analysis?.video?.source;
  const transcriptPoints = entry.analysis?.transcriptStatus === "available" ? 15 : 0;
  const visibleVideoPoints = entry.analysis?.detectedVideoCount ? 10 : 0;
  return (videoPriority[source?.status || "missing"] || 0) + transcriptPoints + visibleVideoPoints;
}

function aggregateTabAnalysis(tabId) {
  const frames = pruneFrameAnalyses(tabId);
  const capturedMedia = bestCapturedMedia(tabId);
  if (!frames.length) {
    return {
      ok: false,
      lessonTitle: "No video page detected",
      videoStatus: "missing",
      videoMessage: "No extension content script has reported from this tab yet. Reload the page and try again.",
      transcriptStatus: "missing",
      transcriptMessage: "No transcript data found.",
      capturedMedia,
      frames: []
    };
  }

  const sorted = [...frames].sort((a, b) => scoreAnalysis(b) - scoreAnalysis(a));
  const best = sorted[0];
  const topFrame = frames.find((entry) => entry.frameId === 0);
  const topTitle = topFrame?.analysis?.lessonTitle;

  const analysis = {
    ...best.analysis,
    lessonUrl: lessonUrls.get(tabId) || topFrame?.analysis?.pageUrl || best.analysis.pageUrl,
    lessonTitle: topTitle && topTitle !== "Video page" ? topTitle : best.analysis.lessonTitle,
    frameId: best.frameId,
    frameUrl: best.url,
    frameCount: frames.length,
    capturedMedia,
    hlsPlaylists: pruneCapturedMedia(tabId).filter((entry) => entry.kind === "hls" && entry.statusCode >= 200 && entry.statusCode < 400).map((entry) => ({ url: entry.url, frameId: entry.frameId })),
    frames: frames.map((entry) => ({
      frameId: entry.frameId,
      url: entry.url,
      score: scoreAnalysis(entry),
      videoStatus: entry.analysis?.videoStatus,
      videoKind: entry.analysis?.video?.source?.kind,
      transcriptStatus: entry.analysis?.transcriptStatus,
      detectedVideoCount: entry.analysis?.detectedVideoCount || 0
    }))
  };

  const source = analysis.video?.source;
  if (
    capturedMedia &&
    (best.analysis.videos?.length || best.analysis.detectedVideoCount || 0) <= 1 &&
    (!source ||
      ["blob", "unknown", "missing", "segment"].includes(source.kind) ||
      ["missing", "unknown"].includes(source.status))
  ) {
    const capturedSource = sourceFromCapturedMedia(capturedMedia, source);
    analysis.video = {
      ...(analysis.video || {}),
      source: capturedSource
    };
    analysis.videoStatus = capturedSource.status;
    analysis.videoMessage = capturedSource.message;
  }

  const videos = frames.flatMap((frame) => (frame.analysis.videos || (frame.analysis.video ? [frame.analysis.video] : [])).map((video) => ({
    ...video,
    id: `${frame.frameId}:${video.elementId || video.index || 0}`,
    frameId: frame.frameId,
    title: frame.frameId === best.frameId ? analysis.lessonTitle : video.title || frame.analysis.lessonTitle,
    source: frame.frameId === best.frameId && video.elementId === analysis.video?.elementId ? analysis.video.source : video.source
  })));
  if (!videos.length && analysis.video?.source) {
    videos.push({ ...analysis.video, id: `captured:${analysis.video.source.url}`, title: analysis.lessonTitle,
      frameId: analysis.video.source.frameId ?? best.frameId });
  }
  analysis.videos = videos;
  analysis.detectedVideoCount = videos.length;
  return analysis;
}

function bestCapturedMedia(tabId) {
  const entries = pruneCapturedMedia(tabId).filter((entry) => entry.statusCode >= 200 && entry.statusCode < 400);
  const priority = { hls: 100, direct: 75, dash: 25, segment: 5, unknown: 1 };
  const score = (entry) => {
    const lower = String(entry.url || "").toLowerCase();
    let value = priority[entry.kind] || 0;
    if (entry.kind === "hls" && /(^|[/?&=_-])(master|manifest|playlist)([/?&=_-]|$)/.test(lower)) value += 8;
    if (entry.kind === "hls" && /(^|[/?&=_-])audio([/?&=_-]|$)/.test(lower)) value -= 15;
    return value;
  };
  return entries.sort((a, b) => score(b) - score(a) || b.timestamp - a.timestamp)[0] || null;
}

function sourceFromCapturedMedia(entry, originalSource) {
  if (entry.kind === "direct") {
    return {
      status: "downloadable",
      kind: "direct",
      url: entry.url,
      frameId: entry.frameId,
      contentType: entry.contentType,
      message: "The player uses a blob URL, but a directly accessible media request was captured from the authorized browser tab."
    };
  }

  if (entry.kind === "hls") {
    return {
      status: "conditional",
      kind: "hls",
      url: entry.url,
      frameId: entry.frameId,
      contentType: entry.contentType,
      message:
        "An HLS lesson playlist was captured. The extension can combine its directly accessible, unencrypted video and audio tracks into MP4."
    };
  }

  if (entry.kind === "dash") {
    return {
      status: "unsupported",
      kind: "dash",
      url: entry.url,
      frameId: entry.frameId,
      contentType: entry.contentType,
      message: "A DASH media manifest was captured. DASH/protected packaged streams are unsupported by this extension."
    };
  }

  if (entry.kind === "segment") {
    return {
      ...(originalSource || {}),
      status: "unsupported",
      kind: "segment",
      url: entry.url,
      frameId: entry.frameId,
      contentType: entry.contentType,
      message:
        "Only a fragmented media segment was captured, not the stream metadata needed to combine the video and audio. Reload the lesson, play from the beginning for 5-10 seconds, then refresh."
    };
  }

  return {
    ...(originalSource || {}),
    status: originalSource?.status || "unknown",
    kind: originalSource?.kind || "unknown",
    url: originalSource?.url || "",
    message: originalSource?.message || "A media request was captured, but it is not a safe downloadable file or supported unencrypted HLS playlist."
  };
}

async function requestFrameRefresh(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ANALYZE_PAGE_BROADCAST" });
  } catch {
    // This can fail before content scripts have loaded. The popup reports the missing registry state.
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function removeFrameAnalysis(tabId, frameId) {
  const frames = frameAnalyses.get(tabId);
  if (!frames) return;
  frames.delete(frameId);
  if (frames.size) {
    frameAnalyses.set(tabId, frames);
  } else {
    frameAnalyses.delete(tabId);
  }
}

function commandFrameScore(entry, command) {
  const kind = entry.analysis?.video?.source?.kind;
  const preferredKind = {
    DOWNLOAD_VIMEO_DASH: "vimeo-dash",
    DOWNLOAD_HLS: "hls",
    DOWNLOAD_BLOB: "blob"
  }[command];
  const transcriptBonus =
    command === "EXTRACT_TRANSCRIPT" && entry.analysis?.transcriptStatus === "available" ? 500 : 0;
  return scoreAnalysis(entry) + transcriptBonus + (preferredKind && kind === preferredKind ? 1000 : 0);
}

function commandFrameCandidates(tabId, command) {
  return pruneFrameAnalyses(tabId).sort(
    (a, b) => commandFrameScore(b, command) - commandFrameScore(a, command) || b.updatedAt - a.updatedAt
  );
}

async function relayToFreshFrame(tabId, requestedFrameId, command, payload = {}) {
  const relayMessage = { type: command, ...payload };
  try {
    return await chrome.tabs.sendMessage(tabId, relayMessage, { frameId: requestedFrameId });
  } catch (initialError) {
    // Sites can replace their player iframe without reloading the tab, invalidating a recently reported frame id.
    removeFrameAnalysis(tabId, requestedFrameId);
    await requestFrameRefresh(tabId);

    let lastError = initialError;
    let lastResponse = null;
    for (const frame of commandFrameCandidates(tabId, command)) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, relayMessage, { frameId: frame.frameId });
        lastResponse = response;
        if (response?.ok !== false) {
          return { ...response, recoveredFrameId: frame.frameId };
        }
      } catch (error) {
        lastError = error;
        removeFrameAnalysis(tabId, frame.frameId);
      }
    }

    if (lastResponse) return lastResponse;
    throw new Error(
      `The video player changed before the command started. Refresh the popup and try again. (${
        lastError?.message || "No active player frame responded."
      })`
    );
  }
}

function safeFilename(input, fallback = "video-export") {
  const base = String(input || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return base || fallback;
}

function dataUrlForText(text, mimeType) {
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(text)}`;
}

async function downloadText({ filename, text, mimeType }) {
  return chrome.downloads.download({
    url: dataUrlForText(text, mimeType || "text/plain"),
    filename: safeFilename(filename),
    saveAs: true,
    conflictAction: "uniquify"
  });
}

async function downloadUrl({ url, filename }) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) media URLs can be downloaded by the background service.");
  }

  return chrome.downloads.download({
    url,
    filename: safeFilename(filename),
    saveAs: true,
    conflictAction: "uniquify"
  });
}

function assertHttpUrl(url) {
  if (!/^https?:\/\//i.test(url || "")) {
    throw new Error("Only http(s) URLs can be fetched.");
  }
}

async function fetchTextUrl(url) {
  assertHttpUrl(url);
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}). The server did not return this media resource.`);
  }
  return response.text();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchBinaryBase64(url, range = "") {
  assertHttpUrl(url);
  const headers = {};
  if (/^bytes=\d*-\d*$/i.test(range)) headers.Range = range;
  const response = await fetch(url, {
    credentials: "omit",
    cache: /\.m3u8(?:[?#]|$)/i.test(url) ? "no-store" : "default",
    headers
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}). The server did not return this media resource.`);
  }
  const buffer = await response.arrayBuffer();
  return {
    base64: arrayBufferToBase64(buffer),
    finalUrl: response.url || url,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    contentRange: response.headers.get("content-range") || "",
    acceptRanges: response.headers.get("accept-ranges") || "",
    byteLength: buffer.byteLength
  };
}

async function probeMediaUrl(url) {
  assertHttpUrl(url);
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Range: "bytes=0-63"
    }
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Media check failed (${response.status}). Reload the lesson and play it again to refresh the media link.`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    return { ok: true, kind: "unknown", message: "Could not inspect media bytes." };
  }

  const result = await reader.read();
  await reader.cancel().catch(() => {});
  const bytes = result.value || new Uint8Array();
  const ascii = Array.from(bytes.slice(0, 16))
    .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."))
    .join("");
  const box = Array.from(bytes.slice(4, 8))
    .map((byte) => String.fromCharCode(byte))
    .join("");

  if (box === "moof" || box === "mdat" || ascii.includes("moof")) {
    return {
      ok: true,
      kind: "segment",
      message: "This URL starts with an fMP4 media fragment, not a complete MP4 file."
    };
  }

  if (box === "ftyp" || bytes[0] === 0x1a || ascii.includes("WEBM")) {
    return {
      ok: true,
      kind: "file",
      message: "This URL appears to start with a normal media file header."
    };
  }

  return {
    ok: true,
    kind: "unknown",
    message: "The media header was not recognized."
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (downloadJobManager.handles(message?.type)) {
      sendResponse(await downloadJobManager.handle(message, sender));
      return;
    }
    if (message?.type === "FRAME_ANALYSIS") {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId ?? 0;
      if (tabId == null) {
        sendResponse({ ok: false, error: "Missing sender tab." });
        return;
      }
      if (message.lessonUrl && lessonUrls.has(tabId) && message.lessonUrl !== lessonUrls.get(tabId)) {
        sendResponse({ ok: false, error: "This report belongs to a previous lesson." });
        return;
      }
      const frames = frameAnalyses.get(tabId) || new Map();
      frames.set(frameId, {
        frameId,
        tabId,
        url: sender.url || message.analysis?.pageUrl || "",
        analysis: message.analysis,
        updatedAt: now()
      });
      frameAnalyses.set(tabId, frames);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "GET_TAB_ANALYSIS") {
      const tabId = message.tabId ?? sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "Missing tab id." });
        return;
      }
      await requestFrameRefresh(tabId);
      sendResponse({ ok: true, analysis: aggregateTabAnalysis(tabId) });
      return;
    }

    if (message?.type === "RELAY_TO_FRAME") {
      const { tabId, frameId, command, payload } = message;
      const response = await relayToFreshFrame(tabId, frameId, command, payload);
      sendResponse(response);
      return;
    }

    if (message?.type === "GET_CAPTURED_CAPTIONS") {
      const tabId = message.tabId ?? sender.tab?.id;
      sendResponse({ ok: true, captions: tabId == null ? [] : pruneCaptured(tabId) });
      return;
    }

    if (message?.type === "GET_CAPTURED_MEDIA") {
      const tabId = message.tabId ?? sender.tab?.id;
      sendResponse({ ok: true, media: tabId == null ? [] : pruneCapturedMedia(tabId) });
      return;
    }

    if (message?.type === "EXTRACT_TRANSCRIPT_FROM_TAB") {
      const tabId = message.tabId ?? sender.tab?.id;
      const capturedUrls = message.capturedUrls || [];
      const frames = pruneFrameAnalyses(tabId);
      const results = await Promise.allSettled(
        frames.map((frame) =>
          chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TRANSCRIPT", capturedUrls }, { frameId: frame.frameId })
        )
      );
      const cues = [];
      const errors = [];
      let title = aggregateTabAnalysis(tabId).lessonTitle;
      for (const result of results) {
        if (result.status !== "fulfilled") {
          errors.push(result.reason?.message || String(result.reason));
          continue;
        }
        if (result.value?.lessonTitle && result.value.lessonTitle !== "Video page") title = result.value.lessonTitle;
        if (Array.isArray(result.value?.cues)) cues.push(...result.value.cues);
        if (Array.isArray(result.value?.errors)) errors.push(...result.value.errors);
      }
      cues.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
      const seen = new Set();
      const deduped = cues.filter((cue) => {
        const key = `${cue.start ?? ""}|${cue.end ?? ""}|${cue.text}`;
        if (!cue.text || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      sendResponse({
        ok: deduped.length > 0,
        lessonTitle: title,
        cues: deduped,
        errors,
        message: deduped.length
          ? `Extracted ${deduped.length} transcript segment(s) from ${frames.length} frame(s).`
          : "No transcript data could be extracted from tracks, captured caption responses, caption requests, or rendered page text."
      });
      return;
    }

    if (message?.type === "DOWNLOAD_URL") {
      const downloadId = await downloadUrl(message.payload || {});
      sendResponse({ ok: true, downloadId });
      return;
    }

    if (message?.type === "DOWNLOAD_TEXT") {
      const downloadId = await downloadText(message.payload || {});
      sendResponse({ ok: true, downloadId });
      return;
    }

    if (message?.type === "FETCH_TEXT_URL") {
      const text = await fetchTextUrl(message.url);
      sendResponse({ ok: true, text });
      return;
    }

    if (message?.type === "FETCH_BINARY_BASE64") {
      const payload = await fetchBinaryBase64(message.url, message.range || "");
      sendResponse({ ok: true, ...payload });
      return;
    }

    if (message?.type === "PROBE_MEDIA_URL") {
      const payload = await probeMediaUrl(message.url);
      sendResponse(payload);
      return;
    }

    sendResponse({ ok: false, error: "Unknown background command." });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });

  return true;
});
