const DEFAULT_SETTINGS = {
  includeTimestamps: true,
  videoQuality: "best",
  transcriptFormat: "txt",
  filenameFormat: "{title}-{date}.{ext}"
};

const MIME_TYPES = {
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json"
};

let activeTab = null;
let analysis = null;
let transcript = null;
let settings = { ...DEFAULT_SETTINGS };
let downloadingVideoId = null;
let lastDownloadFrameId = null;
let jobs = [];
let selectedPanel = "videos";
let refreshInFlight = false;
const dismissedVideos = new Set();
const videoNames = new Map();
const videoQualities = new Map();
const ACTIVE_JOB_STATES = new Set(["preparing", "downloading", "saving"]);

const dom = {
  videosTab: document.getElementById("videosTab"),
  transcriptsTab: document.getElementById("transcriptsTab"),
  settingsTab: document.getElementById("settingsTab"),
  videosPanel: document.getElementById("videosPanel"),
  transcriptsPanel: document.getElementById("transcriptsPanel"),
  settingsPanel: document.getElementById("settingsPanel"),
  detectionStatus: document.getElementById("detectionStatus"),
  footerNote: document.getElementById("footerNote"),
  historySection: document.getElementById("historySection"),
  historyCount: document.getElementById("historyCount"),
  downloadHistory: document.getElementById("downloadHistory"),
  clearHistoryButton: document.getElementById("clearHistoryButton"),
  errorPanel: document.getElementById("errorPanel"),
  errorSummary: document.getElementById("errorSummary"),
  videoQuality: document.getElementById("videoQuality"),
  transcriptFormat: document.getElementById("transcriptFormat"),
  exportButtonLabel: document.getElementById("exportButtonLabel"),
  previewTranscriptButton: document.getElementById("previewTranscriptButton"),
  transcriptSearch: document.getElementById("transcriptSearch"),
  transcriptPreview: document.getElementById("transcriptPreview"),
  previewCount: document.getElementById("previewCount"),
  lessonTitle: document.getElementById("lessonTitle"),
  videoStatus: document.getElementById("videoStatus"),
  videoMessage: document.getElementById("videoMessage"),
  transcriptStatus: document.getElementById("transcriptStatus"),
  transcriptMessage: document.getElementById("transcriptMessage"),
  refreshButton: document.getElementById("refreshButton"),
  videoCount: document.getElementById("videoCount"),
  videoList: document.getElementById("videoList"),
  extractTranscriptButton: document.getElementById("extractTranscriptButton"),
  copyTranscriptButton: document.getElementById("copyTranscriptButton"),
  includeTimestamps: document.getElementById("includeTimestamps"),
  filenameFormat: document.getElementById("filenameFormat"),
  progress: document.getElementById("progress"),
  progressBar: document.getElementById("progressBar"),
  progressPercent: document.getElementById("progressPercent"),
  progressText: document.getElementById("progressText"),
  downloadDiagnosticsButton: document.getElementById("downloadDiagnosticsButton"),
  errorBox: document.getElementById("errorBox")
};

function setError(message) {
  dom.errorPanel.hidden = !message;
  dom.errorBox.textContent = message || "";
  dom.errorSummary.textContent = /404/.test(message || "") ? "A media file could not be found (404)." : String(message || "").length > 150 ? "The export could not finish. See the details below." : message || "";
  dom.downloadDiagnosticsButton.hidden = !message || lastDownloadFrameId === null;
}

function setProgress(message, percent = null) {
  dom.progress.hidden = !message;
  dom.progressText.textContent = message || "";
  const normalized = percent == null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  dom.progressBar.style.width = normalized == null ? "0%" : `${normalized}%`;
  dom.progressPercent.textContent = normalized == null ? "" : `${normalized}%`;
}

function sendToTab(type, payload = {}, frameId = analysis?.frameId ?? 0) {
  return sendToBackground("RELAY_TO_FRAME", {
    tabId: activeTab.id,
    frameId,
    command: type,
    payload: { quality: settings.videoQuality, ...payload }
  });
}

function sendToBackground(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function safeFilenamePart(input, fallback = "video-export") {
  return String(input || fallback)
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/\s/g, "-")
    .toLowerCase() || fallback;
}

function filenameFor(ext, title = analysis?.lessonTitle || "video-export") {
  const date = new Date().toISOString().slice(0, 10);
  const format = settings.filenameFormat || DEFAULT_SETTINGS.filenameFormat;
  const withExt = format.includes("{ext}") ? format : `${format}.{ext}`;
  return withExt
    .replace(/\{title\}/g, safeFilenamePart(title))
    .replace(/\{date\}/g, date)
    .replace(/\{ext\}/g, ext)
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/-+/g, "-");
}

function renderAnalysis() {
  const videoState = (analysis?.videoStatus || "missing").toLowerCase();
  const transcriptState = (transcript?.ok ? "available" : analysis?.transcriptStatus || "missing").toLowerCase();
  const videoLabels = {
    downloadable: "Ready",
    conditional: "Ready to combine",
    unsupported: "Unsupported",
    missing: "Not found",
    unknown: "Unknown"
  };
  const transcriptLabels = {
    available: "Available",
    missing: "Not found",
    unknown: "Unknown"
  };

  dom.lessonTitle.textContent = analysis?.lessonTitle || "No video page detected";
  dom.videoStatus.textContent = videoLabels[videoState] || analysis?.videoStatus || "Not found";
  dom.videoMessage.textContent = `${analysis?.videoMessage || ""}${analysis?.frameCount ? ` Checked ${analysis.frameCount} frame(s).` : ""}`;
  dom.transcriptStatus.textContent = transcript?.ok ? "Extracted" : transcriptLabels[transcriptState] || "Not found";
  dom.transcriptMessage.textContent = transcript?.message || analysis?.transcriptMessage || "";
  dom.videoStatus.dataset.state = videoState;
  dom.transcriptStatus.dataset.state = transcriptState;

  renderVideoList();
  dom.extractTranscriptButton.disabled = !analysis;
  dom.copyTranscriptButton.disabled = !analysis;
  dom.previewTranscriptButton.disabled = !analysis;
  dom.exportButtonLabel.textContent = `Export ${settings.transcriptFormat.toUpperCase()}`;
}

function displayDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Duration unknown";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function detectedVideos() {
  return analysis?.videos || (analysis?.video ? [{ ...analysis.video, id: "active", frameId: analysis.frameId, title: analysis.lessonTitle }] : []);
}

function videoKey(video) {
  return `${activeTab?.id}|${analysis?.lessonUrl || analysis?.pageUrl || ""}|${video.elementId || video.id || "active"}`;
}

function jobForVideo(video) {
  return [...jobs].reverse().find((job) => job.key === videoKey(video));
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function progressElement(job) {
  const container = el("div", "card-progress");
  const label = el("div", "progress-label");
  label.appendChild(el("span", "", job.message || "Preparing…"));
  label.appendChild(el("strong", "", job.percent == null ? "" : `${job.percent}%`));
  const bar = el("div", `progress-bar${job.percent == null ? " indeterminate" : ""}`);
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", job.message || "Download progress");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (job.percent != null) bar.setAttribute("aria-valuenow", String(job.percent));
  const fill = el("span");
  fill.style.width = `${job.percent ?? 32}%`;
  bar.appendChild(fill);
  container.appendChild(label);
  container.appendChild(bar);
  return container;
}

function selectPanel(name) {
  selectedPanel = name;
  for (const panel of ["videos", "transcripts", "settings"]) {
    dom[`${panel}Panel`].hidden = panel !== name;
    dom[`${panel}Tab`].setAttribute("aria-selected", String(panel === name));
    dom[`${panel}Tab`].tabIndex = panel === name ? 0 : -1;
  }
}

function renderVideoList() {
  const videos = detectedVideos().filter((video) => !dismissedVideos.has(videoKey(video)));
  dom.videoCount.textContent = String(videos.length);
  dom.videoCount.setAttribute("aria-label", `${videos.length} videos detected on this page`);
  dom.videoList.replaceChildren();
  dom.refreshButton.disabled = refreshInFlight;
  const activeJob = jobs.find((job) => job.tabId === activeTab?.id && ACTIVE_JOB_STATES.has(job.status));
  if (!videos.length) {
    const empty = el("div", "empty-list");
    empty.appendChild(el("strong", "", dismissedVideos.size ? "No videos in this list" : "No videos detected yet"));
    empty.appendChild(el("p", "", "Play a video. The list updates automatically."));
    if (dismissedVideos.size) {
      const restore = el("button", "text-button", "Restore hidden videos");
      restore.addEventListener("click", () => { dismissedVideos.clear(); renderVideoList(); });
      empty.appendChild(restore);
    }
    dom.videoList.appendChild(empty);
  }
  for (const [index, video] of videos.entries()) {
    const key = videoKey(video);
    const job = jobForVideo(video);
    const busy = ACTIVE_JOB_STATES.has(job?.status);
    const row = el("article", "video-card");
    const thumbnail = el("div", "thumbnail");
    thumbnail.appendChild(el("span", "icon icon-video"));
    if (/^https?:\/\//i.test(video.poster || "")) {
      const image = el("img");
      image.src = video.poster;
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      thumbnail.appendChild(image);
    }
    thumbnail.appendChild(el("span", "duration", displayDuration(video.duration)));
    row.appendChild(thumbnail);
    const info = el("div", "video-info");
    const heading = el("div", "video-title-row");
    const kind = video.source?.kind;
    heading.appendChild(el("span", "source-badge", ({hls:"HLS", "vimeo-dash":"DASH", direct:"HTTP", blob:"VIDEO"})[kind] || "VIDEO"));
    const originalName = video.title || analysis.lessonTitle || `Video ${index + 1}`;
    const title = el("h3", "video-title", videoNames.get(key) || job?.title || originalName);
    title.title = title.textContent;
    heading.appendChild(title);
    info.appendChild(heading);
    const renameInput = el("input", "rename-input");
    renameInput.type = "text";
    renameInput.value = title.textContent;
    renameInput.hidden = true;
    renameInput.setAttribute("aria-label", "Video filename title");
    info.appendChild(renameInput);
    const controls = el("div", "card-controls");
    const rename = el("button", "rename-button");
    rename.type = "button";
    rename.title = "Rename export";
    rename.setAttribute("aria-label", "Rename export");
    rename.appendChild(el("span", "icon icon-rename"));
    rename.disabled = busy;
    rename.addEventListener("click", () => { renameInput.hidden = false; heading.hidden = true; renameInput.focus(); renameInput.select(); });
    const commitName = () => {
      videoNames.set(key, renameInput.value.trim() || originalName);
      renderVideoList();
    };
    renameInput.addEventListener("blur", commitName);
    renameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") renameInput.blur();
      if (event.key === "Escape") { renameInput.value = videoNames.get(key) || job?.title || originalName; renameInput.blur(); }
    });
    controls.appendChild(rename);
    const format = kind === "direct" ? video.source.url?.match(/\.(mp4|webm|mov|m4v|ogv)(?=[?#]|$)/i)?.[1]?.toUpperCase() || "VIDEO" : "MP4";
    controls.appendChild(el("span", "format-label", format));
    const quality = el("select", "quality-select");
    quality.setAttribute("aria-label", `Download quality for ${title.textContent}`);
    const stream = ["hls", "vimeo-dash"].includes(kind);
    const choices = stream ? [["best", "Best available"], ...(video.availableQualities?.length ? video.availableQualities.map((height) => [String(height), `${height}p`]) : [["1080", "Up to 1080p"], ["720", "Up to 720p"], ["360", "Up to 360p"]])] : [["original", "Original quality"]];
    const selected = videoQualities.get(key) || job?.quality || settings.videoQuality;
    if (stream && !choices.some(([value]) => value === selected)) choices.push([selected, `Up to ${selected}p`]);
    for (const [value, text] of choices) { const option = el("option", "", text); option.value = value; quality.appendChild(option); }
    quality.value = stream ? selected : "original";
    quality.disabled = !stream || busy;
    quality.title = video.availableQualities?.length ? "Resolutions detected in the stream" : stream ? "Resolution limits; exact options appear when the player exposes its master playlist" : "Direct files keep their original quality";
    quality.addEventListener("change", () => videoQualities.set(key, quality.value));
    controls.appendChild(quality);
    const ready = ["downloadable", "conditional"].includes(video.source?.status);
    const button = el("button", "primary-action", busy ? "Working…" : job?.status === "error" ? "Retry" : job?.status === "complete" ? "Download again" : "Download");
    button.type = "button";
    button.disabled = !ready || Boolean(activeJob) || downloadingVideoId !== null;
    button.addEventListener("click", () => downloadVideo(video.id));
    controls.appendChild(button);
    info.appendChild(controls);
    info.appendChild(el("p", "card-caption", video.height ? `Playback ${video.height}p${job?.status === "complete" ? " · Saved" : ""}` : job?.status === "complete" ? "Saved to your downloads" : "Playback quality unavailable"));
    if (!ready) info.appendChild(el("p", "video-note", kind === "segment" ? "Waiting for the full stream…" : "Full source not available yet"));
    row.appendChild(info);
    const dismiss = el("button", "dismiss-button", "×");
    dismiss.type = "button";
    dismiss.title = "Hide this video";
    dismiss.setAttribute("aria-label", `Hide ${title.textContent}`);
    dismiss.disabled = busy;
    dismiss.addEventListener("click", () => { dismissedVideos.add(key); renderVideoList(); });
    row.appendChild(dismiss);
    if (busy) row.appendChild(progressElement(job));
    dom.videoList.appendChild(row);
  }
  renderHistory();
}

function renderHistory() {
  const visibleKeys = new Set(detectedVideos().filter((video) => !dismissedVideos.has(videoKey(video))).map(videoKey));
  const history = jobs.filter((job) => !ACTIVE_JOB_STATES.has(job.status) || !visibleKeys.has(job.key));
  dom.historySection.hidden = !history.length;
  dom.historyCount.textContent = history.length ? `(${history.length})` : "";
  dom.clearHistoryButton.disabled = !jobs.some((job) => !ACTIVE_JOB_STATES.has(job.status));
  dom.downloadHistory.replaceChildren();
  const active = jobs.some((job) => ACTIVE_JOB_STATES.has(job.status));
  dom.footerNote.textContent = active ? "You can close this popup. Keep the video tab open while downloading." : "Only videos detected on this page are listed.";
  for (const job of [...history].reverse()) {
    const card = el("article", "history-card");
    const top = el("div", "history-top");
    const title = el("span", "history-title", job.filename || job.title);
    title.title = title.textContent;
    top.appendChild(title);
    const labels = {complete:"Saved", error:"Failed", preparing:"Preparing", downloading:"Downloading", saving:"Saving"};
    top.appendChild(el("span", `status ${job.status}`, labels[job.status] || job.status));
    card.appendChild(top);
    const bottom = el("div", "history-bottom");
    bottom.appendChild(el("span", "history-meta", `${displayDuration(job.duration)} · ${job.height ? `${job.height}p` : job.quality === "best" ? "Best available" : job.quality === "original" ? "Original" : `${job.quality || "Original"}${Number(job.quality) ? "p limit" : ""}`}`));
    const actions = el("div", "history-actions");
    if (job.status === "complete" && job.downloadId != null) {
      const show = el("button", "", "Show file");
      show.title = "Show saved video in its folder";
      show.addEventListener("click", () => jobAction("SHOW_VIDEO_FILE", job.id));
      actions.appendChild(show);
    }
    if (job.status === "error") {
      const video = detectedVideos().find((entry) => videoKey(entry) === job.key);
      if (video) {
        const retry = el("button", "", "Retry");
        retry.disabled = jobs.some((entry) => entry.tabId === activeTab?.id && ACTIVE_JOB_STATES.has(entry.status));
        retry.addEventListener("click", () => downloadVideo(video.id));
        actions.appendChild(retry);
      }
      const saveDetails = el("button", "", "Save details");
      saveDetails.addEventListener("click", () => downloadDiagnostics(job.id));
      actions.appendChild(saveDetails);
      const details = el("details");
      details.appendChild(el("summary", "", "Error details"));
      details.appendChild(el("pre", "", job.error || "Download failed"));
      card.appendChild(details);
    }
    if (!ACTIVE_JOB_STATES.has(job.status)) {
      const remove = el("button", "", "×");
      remove.setAttribute("aria-label", `Remove ${job.title} from download history`);
      remove.title = "Remove from history";
      remove.addEventListener("click", () => jobAction("REMOVE_VIDEO_JOB", job.id));
      actions.appendChild(remove);
    }
    bottom.appendChild(actions);
    card.appendChild(bottom);
    if (ACTIVE_JOB_STATES.has(job.status)) card.appendChild(progressElement(job));
    dom.downloadHistory.appendChild(card);
  }
}

async function jobAction(type, jobId) {
  try {
    const response = await sendToBackground(type, { jobId });
    if (!response?.ok) throw new Error(response?.error || "Could not update this download.");
    if (response.jobs) jobs = response.jobs;
    renderVideoList();
  } catch (error) { setError(error.message); }
}

async function loadJobs() {
  const response = await sendToBackground("GET_VIDEO_JOBS");
  if (response?.ok && Array.isArray(response.jobs)) { jobs = response.jobs; renderVideoList(); }
}

function renderTranscriptPreview() {
  const query = dom.transcriptSearch.value.trim().toLowerCase();
  const cues = transcript?.cues || [];
  const matches = cues.filter((cue) => cue.text.toLowerCase().includes(query));
  dom.transcriptSearch.disabled = !transcript?.ok;
  dom.transcriptPreview.hidden = !transcript?.ok;
  dom.transcriptPreview.replaceChildren();
  dom.previewCount.textContent = transcript?.ok
    ? `${matches.length} of ${cues.length} segments${query ? " match" : ""}. Search filters the preview; exports include the full transcript.`
    : "Load a preview to check the transcript before exporting.";
  const fragment = document.createDocumentFragment();
  for (const cue of matches) {
    const row = document.createElement("p");
    if (cue.start != null) {
      const time = document.createElement("time");
      time.textContent = timestamp(cue.start, false);
      row.appendChild(time);
    }
    row.appendChild(document.createTextNode(cue.text));
    fragment.appendChild(row);
  }
  dom.transcriptPreview.appendChild(fragment);
}

async function previewTranscript() {
  setError("");
  setProgress("Loading transcript preview...", 20);
  try {
    await ensureCurrentLesson();
    if (!transcript?.ok) await loadTranscript();
    renderTranscriptPreview();
    setProgress("");
  } catch (error) {
    setProgress("");
    setError(error.message || String(error));
  }
}

async function ensureCurrentLesson() {
  const tab = await getActiveTab();
  if (tab?.id !== activeTab?.id || tab?.url !== (analysis?.lessonUrl || analysis?.pageUrl)) {
    await refresh();
    if (!analysis?.ok) throw new Error("The page changed. Play the new video and refresh before exporting.");
  }
}

function formatTxt(cues, includeTimestamps) {
  return cues
    .map((cue) => {
      if (includeTimestamps && cue.start != null) {
        return `[${timestamp(cue.start, false)}] ${cue.text}`;
      }
      return cue.text;
    })
    .join("\n");
}

function timestamp(seconds, srt) {
  const value = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const secs = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${srt ? "," : "."}${String(millis).padStart(3, "0")}`;
}

function formatSrt(cues) {
  return cues
    .map((cue, index) => {
      const start = timestamp(cue.start ?? 0, true);
      const end = timestamp(cue.end ?? (cue.start ?? 0) + 2, true);
      return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
}

function formatVtt(cues) {
  const body = cues
    .map((cue) => {
      const start = timestamp(cue.start ?? 0, false);
      const end = timestamp(cue.end ?? (cue.start ?? 0) + 2, false);
      return `${start} --> ${end}\n${cue.text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function transcriptAs(ext) {
  const cues = transcript?.cues || [];
  if (ext === "txt") return formatTxt(cues, settings.includeTimestamps);
  if (ext === "srt" || ext === "vtt") {
    if (!cues.length || cues.some((cue) => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start)) {
      throw new Error("SRT and VTT exports require timed captions. Use TXT for a transcript without timestamps.");
    }
    return ext === "srt" ? formatSrt(cues) : formatVtt(cues);
  }
  return JSON.stringify(
    {
      lessonTitle: transcript.lessonTitle,
      pageUrl: analysis?.pageUrl,
      cueCount: cues.length,
      cues
    },
    null,
    2
  );
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = {
    includeTimestamps: Boolean(stored.includeTimestamps),
    videoQuality: ["best", "1080", "720", "360"].includes(stored.videoQuality) ? stored.videoQuality : "best",
    transcriptFormat: ["txt", "srt", "vtt"].includes(stored.transcriptFormat) ? stored.transcriptFormat : "txt",
    filenameFormat: stored.filenameFormat || DEFAULT_SETTINGS.filenameFormat
  };
  dom.videoQuality.value = settings.videoQuality;
  dom.transcriptFormat.value = settings.transcriptFormat;
  dom.includeTimestamps.checked = settings.includeTimestamps;
  dom.filenameFormat.value = settings.filenameFormat;
}

async function saveSettings() {
  settings = {
    includeTimestamps: dom.includeTimestamps.checked,
    videoQuality: dom.videoQuality.value,
    transcriptFormat: dom.transcriptFormat.value,
    filenameFormat: dom.filenameFormat.value.trim() || DEFAULT_SETTINGS.filenameFormat
  };
  renderAnalysis();
  await chrome.storage.sync.set(settings);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function videoFingerprint(videos) {
  return JSON.stringify(videos?.map((video) => ({id: video.id, title: video.title, duration: video.duration, height: video.height,
    poster: video.poster, availableQualities: video.availableQualities, source: video.source})));
}

async function refresh(options = {}) {
  const silent = options.silent === true;
  if (refreshInFlight) return;
  refreshInFlight = true;
  dom.refreshButton.disabled = true;
  if (!silent) { setError(""); dom.detectionStatus.textContent = "Checking…"; }
  try {
    const tab = await getActiveTab();
    const changed = activeTab?.id !== tab?.id || (analysis?.lessonUrl && analysis.lessonUrl !== tab?.url);
    activeTab = tab;
    if (changed) {
      transcript = null;
      dom.transcriptSearch.value = "";
      renderTranscriptPreview();
    }
    if (!activeTab?.id || !/^https?:\/\//i.test(activeTab.url || "")) {
      analysis = null;
      dom.detectionStatus.textContent = "Open a video page";
      if (!silent) setError("Open a website with a video to find its media.");
    } else {
      const response = await sendToBackground("GET_TAB_ANALYSIS", { tabId: activeTab.id });
      if (!response?.ok) throw new Error(response?.error || "Could not inspect this page.");
      const previous = videoFingerprint(analysis?.videos);
      const next = response.analysis;
      analysis = next;
      dom.detectionStatus.textContent = "Auto-detecting";
      // Do not replace a control while the user is editing or choosing a quality.
      const editing = document.activeElement?.matches?.("input, select");
      if (silent && !changed && (previous === videoFingerprint(next?.videos) || editing)) return;
    }
    renderAnalysis();
  } catch (error) {
    dom.detectionStatus.textContent = "Detection unavailable";
    if (!silent) setError(error.message || "Could not inspect this page.");
  } finally { refreshInFlight = false; dom.refreshButton.disabled = false; }
}

async function downloadVideo(videoId = null) {
  if (downloadingVideoId !== null) return;
  downloadingVideoId = videoId || "active";
  setError("");
  renderVideoList();
  try {
    await ensureCurrentLesson();
    const video = videoId ? detectedVideos().find((entry) => entry.id === videoId) : detectedVideos()[0];
    if (!video?.source) throw new Error("This video changed. Refresh the list and try again.");
    const key = videoKey(video);
    const previous = jobForVideo(video);
    const title = videoNames.get(key) || previous?.title || video.title || analysis.lessonTitle;
    const quality = ["hls", "vimeo-dash"].includes(video.source.kind) ? videoQualities.get(key) || previous?.quality || settings.videoQuality : "original";
    lastDownloadFrameId = video.source.frameId ?? video.frameId ?? analysis.frameId ?? 0;
    const response = await sendToBackground("START_VIDEO_DOWNLOAD", {
      tabId: activeTab.id, frameId: lastDownloadFrameId, key, title, poster: video.poster,
      lessonUrl: analysis.lessonUrl || activeTab.url, duration: video.duration, quality,
      payload: { elementId: video.elementId, source: video.source, expectedDuration: video.duration, quality,
        hlsUrls: (analysis.hlsPlaylists || []).filter((entry) => entry.frameId === lastDownloadFrameId).map((entry) => entry.url),
        filenameBase: filenameFor("", title).replace(/[.\s-]+$/, "") }
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start the video download.");
    if (response.job) jobs = [...jobs.filter((job) => job.id !== response.job.id), response.job];
  } catch (error) { setError(error.message || String(error)); }
  finally { downloadingVideoId = null; renderVideoList(); }
}

async function downloadDiagnostics(jobId = null) {
  try {
    const job = typeof jobId === "string" ? jobs.find((entry) => entry.id === jobId) : null;
    const detail = job ? { ok: true, diagnostics: job.diagnostics || [], playlists: job.playlists || [], jobStatus: job.status }
      : await sendToTab("GET_MEDIA_DIAGNOSTICS", {}, lastDownloadFrameId ?? analysis?.frameId ?? 0);
    if (!detail?.ok) throw new Error(detail?.error || "Could not collect download details.");
    const report = {
      version: chrome.runtime.getManifest().version,
      error: (job?.error || dom.errorBox.textContent).replace(/https?:\/\/\S+/g, "[URL]"),
      videoCount: detectedVideos().length,
      videos: detectedVideos().map((video) => ({ duration: video.duration, height: video.height, kind: video.source?.kind })),
      ...detail
    };
    const result = await sendToBackground("DOWNLOAD_TEXT", {payload: {
      filename: "video-download-diagnostics.json", text: JSON.stringify(report, null, 2), mimeType: "application/json"
    }});
    if (!result?.ok) throw new Error(result?.error || "Could not save download details.");
  } catch (error) { setError(error.message || String(error)); }
}

async function loadTranscript() {
  const captured = await sendToBackground("GET_CAPTURED_CAPTIONS", { tabId: activeTab.id });
  const result = await sendToBackground("EXTRACT_TRANSCRIPT_FROM_TAB", {
    tabId: activeTab.id,
    capturedUrls: captured?.captions || []
  });
  if (!result?.ok) {
    throw new Error(result?.message || "No transcript could be extracted.");
  }
  transcript = result;
  renderTranscriptPreview();
  renderAnalysis();
  return result;
}

async function extractTranscript() {
  setError("");
  setProgress("Extracting transcript and preparing export...", 20);

  try {
    await ensureCurrentLesson();
    if (!transcript?.ok) await loadTranscript();
    const ext = settings.transcriptFormat;
    const response = await sendToBackground("DOWNLOAD_TEXT", {
      payload: {
        filename: filenameFor(ext, transcript.lessonTitle),
        text: transcriptAs(ext),
        mimeType: MIME_TYPES[ext]
      }
    });
    if (!response?.ok) throw new Error(response?.error || "Transcript export failed.");
    setProgress(`${ext.toUpperCase()} transcript export started.`, 100);
  } catch (error) {
    transcript = null;
    renderTranscriptPreview();
    setProgress("");
    setError(error.message || String(error));
  }

  renderAnalysis();
}

async function copyTranscript() {
  setError("");
  setProgress(transcript?.ok ? "Copying transcript..." : "Extracting transcript to copy...", 20);
  try {
    await ensureCurrentLesson();
    if (!transcript?.ok) await loadTranscript();
    await navigator.clipboard.writeText(transcriptAs("txt"));
    setProgress("Transcript copied to clipboard.", 100);
  } catch (error) {
    transcript = null;
    renderTranscriptPreview();
    setProgress("");
    setError(error.message || String(error));
    renderAnalysis();
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "CONTENT_PROGRESS" || message.jobId || sender?.tab?.id !== activeTab?.id) return;
  const { message: text, completed, total } = message.detail || {};
  setProgress(text || "Working…", total ? Math.round(completed / total * 100) : null);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.videoJobs) return;
  jobs = changes.videoJobs.newValue || [];
  renderVideoList();
  const previous = new Map((changes.videoJobs.oldValue || []).map((job) => [job.id, job.status]));
  const failed = [...jobs].reverse().find((job) => job.status === "error" && previous.get(job.id) !== "error" && job.tabId === activeTab?.id);
  if (failed) {
    lastDownloadFrameId = failed.frameId;
    setError(failed.error);
  }
});

for (const [index, name] of ["videos", "transcripts", "settings"].entries()) {
  dom[`${name}Tab`].addEventListener("click", () => selectPanel(name));
  dom[`${name}Tab`].addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const next = ["videos", "transcripts", "settings"][(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
    selectPanel(next);
    dom[`${next}Tab`].focus();
  });
}
dom.clearHistoryButton.addEventListener("click", () => jobAction("CLEAR_VIDEO_JOBS"));

dom.downloadDiagnosticsButton.addEventListener("click", downloadDiagnostics);
dom.videoQuality.addEventListener("change", saveSettings);
dom.transcriptFormat.addEventListener("change", saveSettings);
dom.previewTranscriptButton.addEventListener("click", previewTranscript);
dom.transcriptSearch.addEventListener("input", renderTranscriptPreview);
dom.refreshButton.addEventListener("click", refresh);
dom.extractTranscriptButton.addEventListener("click", extractTranscript);
dom.copyTranscriptButton.addEventListener("click", copyTranscript);
dom.includeTimestamps.addEventListener("change", saveSettings);
dom.filenameFormat.addEventListener("change", saveSettings);

loadSettings().then(async () => { await loadJobs().catch(() => {}); await refresh(); }).catch((error) => {
  setError(error.message || String(error));
});

// Poll only while this popup exists; downloads themselves are owned by the extension.
window.setInterval(() => { refresh({ silent: true }); }, 2500);
