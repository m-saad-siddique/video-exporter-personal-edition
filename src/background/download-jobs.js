/* Download state belongs to the extension, so closing the popup does not lose it. */
globalThis.downloadJobManager = (() => {
  const ACTIVE = new Set(["preparing", "downloading", "saving"]);
  const types = new Set(["START_VIDEO_DOWNLOAD", "GET_VIDEO_JOBS", "PREPARE_VIDEO_SAVE", "VIDEO_JOB_RESULT", "CONTENT_PROGRESS", "REMOVE_VIDEO_JOB", "CLEAR_VIDEO_JOBS", "SHOW_VIDEO_FILE"]);
  let writes = Promise.resolve();
  const progressTimes = new Map();

  async function list() {
    const stored = await chrome.storage.session.get("videoJobs");
    return Array.isArray(stored.videoJobs) ? stored.videoJobs : [];
  }

  function mutate(change) {
    const operation = writes.then(async () => {
      const jobs = await list();
      const result = change(jobs);
      await chrome.storage.session.set({ videoJobs: jobs.slice(-30) });
      return result;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  async function update(id, patch) {
    return mutate((jobs) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return null;
      const changes = typeof patch === "function" ? patch(job) : patch;
      if (changes) Object.assign(job, changes, { updatedAt: Date.now() });
      return job;
    });
  }

  function saveState(item) {
    if (item.state === "complete") return { status: "complete", percent: 100, message: "Saved to your downloads", error: null, ...(item.filename ? { filename: item.filename.split(/[\\/]/).pop() } : {}) };
    if (item.state === "interrupted") return { status: "error", error: `Chrome could not save the file (${item.error || "download interrupted"}).`, message: "Save interrupted" };
    return { status: "saving", message: "Saving file…" };
  }

  chrome.downloads.onCreated.addListener((item) => {
    mutate((jobs) => {
      const job = jobs.find((entry) => entry.blobUrl && [item.url, item.finalUrl].includes(entry.blobUrl));
      if (job) Object.assign(job, { downloadId: item.id, updatedAt: Date.now() }, saveState(item));
    }).catch(() => {});
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state && !delta.error && !delta.filename) return;
    mutate((jobs) => {
      const job = jobs.find((entry) => entry.downloadId === delta.id);
      if (!job) return;
      const item = { state: delta.state?.current || (delta.error?.current || job.status === "error" ? "interrupted" : job.status === "complete" ? "complete" : "in_progress"), error: delta.error?.current, filename: delta.filename?.current };
      const patch = saveState(item);
      if (!patch.filename) delete patch.filename;
      Object.assign(job, patch, { updatedAt: Date.now() });
    }).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    mutate((jobs) => {
      for (const job of jobs) if (job.tabId === tabId && ACTIVE.has(job.status)) {
        Object.assign(job, { status: "error", error: "The video tab was closed before this download finished.", updatedAt: Date.now() });
      }
    }).catch(() => {});
  });

  async function finish(id, response) {
    return update(id, (job) => {
      const metadata = {
        ...(Number.isFinite(response?.height) && response.height > 0 ? { height: response.height } : {}),
        ...(response?.diagnostics ? { diagnostics: response.diagnostics, playlists: response.playlists || [] } : {})
      };
      if (job.status === "complete") return response?.ok ? metadata : null;
      if (job.status === "error") return null;
      return response?.ok
        ? { ...metadata, status: "saving", message: "Waiting for Chrome to finish saving…" }
        : { ...metadata, status: "error", error: String(response?.error || "Download failed.").slice(0, 3000), message: "Download failed" };
    });
  }

  async function run(job, payload) {
    try {
      const response = await relayToFreshFrame(job.tabId, job.frameId, "DOWNLOAD_VIDEO", { ...payload, jobId: job.id });
      await finish(job.id, response);
    } catch (error) {
      await finish(job.id, { ok: false, error: error.message });
    }
  }

  async function handle(message, sender) {
    if (message.type === "GET_VIDEO_JOBS") {
      // Recover the disk-save state even if the worker restarted between native events.
      const jobs = await list();
      for (const job of jobs.filter((entry) => entry.status === "saving" && entry.downloadId != null)) {
        const [item] = await chrome.downloads.search({ id: job.downloadId });
        if (item) await update(job.id, saveState(item));
      }
      return { ok: true, jobs: await list() };
    }
    if (message.type === "START_VIDEO_DOWNLOAD") {
      const created = await mutate((jobs) => {
        const current = jobs.find((entry) => entry.tabId === message.tabId && ACTIVE.has(entry.status));
        if (current) return { job: current, alreadyRunning: true };
        const job = { id: globalThis.crypto?.randomUUID?.() || `job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          key: message.key, tabId: message.tabId, frameId: message.frameId, lessonUrl: message.lessonUrl,
          title: String(message.title || "Video export"), poster: message.poster || "", duration: message.duration,
          quality: message.quality, kind: message.payload?.source?.kind, status: "preparing", percent: 0, message: "Preparing video…", startedAt: Date.now(), updatedAt: Date.now() };
        jobs.push(job);
        return { job, alreadyRunning: false };
      });
      if (!created.alreadyRunning) void run(created.job, message.payload);
      return { ok: true, ...created };
    }
    if (message.type === "PREPARE_VIDEO_SAVE") {
      const job = (await list()).find((entry) => entry.id === message.jobId);
      if (!job || sender.tab?.id !== job.tabId || !/^blob:/.test(message.url || "")) throw new Error("The video save does not match its download task.");
      await update(job.id, { status: "saving", percent: 99, blobUrl: message.url, filename: message.filename, message: "Saving file…" });
      return { ok: true };
    }
    if (message.type === "VIDEO_JOB_RESULT" || message.type === "CONTENT_PROGRESS") {
      if (!message.jobId) return { ok: true };
      const job = (await list()).find((entry) => entry.id === message.jobId);
      if (!job || sender.tab?.id !== job.tabId) return { ok: false };
      if (message.type === "VIDEO_JOB_RESULT") {
        await finish(job.id, message.result);
      } else {
        const { completed, total, message: text } = message.detail || {};
        const percent = total ? Math.max(0, Math.min(99, Math.round(completed / total * 100))) : null;
        const previous = progressTimes.get(job.id);
        const stage = String(text || "").replace(/\d+/g, "#");
        if (!previous || Date.now() - previous.time > 400 || previous.stage !== stage) {
          progressTimes.set(job.id, { time: Date.now(), stage });
          await update(job.id, (current) => ACTIVE.has(current.status) && current.status !== "saving" ? { status: "downloading", percent, message: text || "Working…" } : null);
        }
      }
      return { ok: true };
    }
    if (message.type === "SHOW_VIDEO_FILE") {
      const job = (await list()).find((entry) => entry.id === message.jobId && entry.status === "complete");
      if (job?.downloadId == null) throw new Error("This file has not finished saving.");
      chrome.downloads.show(job.downloadId);
      return { ok: true };
    }
    await mutate((jobs) => {
      for (let i = jobs.length - 1; i >= 0; i -= 1) {
        if (!ACTIVE.has(jobs[i].status) && (message.type === "CLEAR_VIDEO_JOBS" || jobs[i].id === message.jobId)) jobs.splice(i, 1);
      }
    });
    return { ok: true, jobs: await list() };
  }
  return { handles: (type) => types.has(type), handle, list };
})();
