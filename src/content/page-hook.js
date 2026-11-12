(() => {
  if (window.__videoExporterPageHookInstalled) return;

  function urlFromInput(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isWebUrl(value) {
    try { return ["http:", "https:"].includes(new URL(value).protocol); }
    catch { return false; }
  }

  if (!isWebUrl(location.href) && !isWebUrl(document.referrer || "")) return;

  window.__videoExporterPageHookInstalled = true;

  const MAX_TEXT_CAPTURE = 3 * 1024 * 1024;
  let generation = 0;
  const allowedMediaOrigins = new Set([location.origin]);

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return "";
    }
  }

  function lowerUrl(url) {
    return absoluteUrl(url).toLowerCase();
  }

  function isLikelyCaptionUrl(url) {
    const lower = lowerUrl(url);
    return (
      /\.(vtt|srt)(\?|#|$)/.test(lower) ||
      /(^|[./?&=_-])(caption|captions|subtitle|subtitles|transcript|texttrack|text-track)([./?&=_-]|$)/.test(lower)
    );
  }

  function isLikelyHls(url, contentType = "") {
    return /\.m3u8(\?|#|$)/i.test(url || "") || /mpegurl/i.test(contentType || "");
  }

  function isLikelyMediaUrl(url) {
    const lower = lowerUrl(url);
    return (
      /\.(mp4|webm|mov|m4v|ogv|m3u8|mpd|m4s|cmfv|cmfa|ts)(\?|#|$)/.test(lower) ||
      /(^|[/?&=_-])(hls|m3u8|playlist|master|manifest|video|media|seg|segment|fragment|frag|chunk|part|init)([/?&=_-]|$)/.test(lower)
    );
  }

  function isVimeoDashTrack(track) {
    return Boolean(
      track &&
        typeof track === "object" &&
        track.format === "dash" &&
        typeof track.init_segment === "string" &&
        Array.isArray(track.segments) &&
        track.segments.length &&
        track.segments.every((segment) => typeof segment?.url === "string")
    );
  }

  function findVimeoDashConfig(root) {
    const seen = new Set();
    let visited = 0;

    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 8 || seen.has(node) || visited++ > 1500) return null;
      seen.add(node);

      if (
        typeof node.base_url === "string" &&
        Array.isArray(node.video) &&
        Array.isArray(node.audio) &&
        node.video.some(isVimeoDashTrack) &&
        node.audio.some(isVimeoDashTrack)
      ) {
        return node;
      }

      for (const value of Object.values(node)) {
        const match = visit(value, depth + 1);
        if (match) return match;
      }
      return null;
    }

    return visit(root, 0);
  }

  function parseVimeoDashConfig(text) {
    const candidates = Array.from(
      new Set([text, ...String(text || "").split(/\r?\n/).filter((line) => line.includes('"base_url"'))])
    );
    for (const candidate of candidates) {
      try {
        const match = findVimeoDashConfig(JSON.parse(candidate));
        if (match) return match;
      } catch {
        // Some player diagnostics contain multiple JSON documents separated by newlines.
      }
    }
    return null;
  }

  function captureVimeoDashText(url, requestedUrl, contentType, text) {
    if (!text || text.length > MAX_TEXT_CAPTURE || !text.includes('"init_segment"')) return;
    const config = parseVimeoDashConfig(text);
    if (!config) return;

    try {
      const baseUrl = new URL(config.base_url, url).href;
      rememberMediaOrigin(baseUrl);
      for (const track of [...config.video, ...config.audio]) {
        const trackBase = track.base_url ? new URL(track.base_url, baseUrl) : baseUrl;
        if (track.segments?.[0]?.url) rememberMediaOrigin(new URL(track.segments[0].url, trackBase).href);
      }
    } catch {
      return;
    }

    post("VIMEO_DASH_CONFIG_RESPONSE", {
      url,
      requestedUrl,
      contentType: contentType || "",
      config,
      timestamp: Date.now()
    });
  }

  function maybeCaptureVimeoDashText(url, requestedUrl, response, contentType = "") {
    const type = String(contentType || response?.headers?.get?.("content-type") || "").toLowerCase();
    const lower = lowerUrl(url);
    if (!/json/i.test(type) && !/(vimeo|config|master|playlist|options)/i.test(lower)) return;

    const capturedGeneration = generation;
    response
      .clone()
      .text()
      .then((text) => {
        if (capturedGeneration === generation) captureVimeoDashText(response.url || url, requestedUrl || url, type, text);
      })
      .catch(() => {});
  }

  function rememberMediaOrigin(url) {
    try {
      allowedMediaOrigins.add(new URL(url, location.href).origin);
    } catch {
      // Ignore malformed URLs.
    }
  }

  function post(type, payload, transfer = []) {
    window.postMessage(
      {
        source: "video-transcript-exporter",
        type,
        payload
      },
      "*",
      transfer
    );
  }

  function maybeCaptureCaptionText(url, response, contentType = "") {
    if (!isLikelyCaptionUrl(url)) return;
    const type = String(contentType || response?.headers?.get?.("content-type") || "").toLowerCase();
    if (type && !/(text|json|vtt|srt|caption|subtitle|transcript)/i.test(type)) return;

    const capturedGeneration = generation;
    response
      .clone()
      .text()
      .then((text) => {
        if (capturedGeneration !== generation) return;
        if (!text || text.length > MAX_TEXT_CAPTURE) return;
        post("CAPTION_RESPONSE", {
          url: response.url || url,
          contentType: type,
          text,
          timestamp: Date.now()
        });
      })
      .catch(() => {});
  }

  function maybeCaptureHlsText(url, response, contentType = "") {
    const type = String(contentType || response?.headers?.get?.("content-type") || "").toLowerCase();
    if (!isLikelyHls(url, type)) return;

    const capturedGeneration = generation;
    response
      .clone()
      .text()
      .then((text) => {
        if (capturedGeneration !== generation) return;
        if (!text || text.length > MAX_TEXT_CAPTURE || !/^#EXTM3U/m.test(text)) return;
        post("HLS_PLAYLIST_RESPONSE", {
          url: response.url || url,
          requestedUrl: url,
          contentType: type,
          text,
          timestamp: Date.now()
        });
      })
      .catch(() => {});
  }

  function reportNetworkResponse(url, status, contentType) {
    const resolved = absoluteUrl(url);
    if (!resolved || (!isLikelyMediaUrl(resolved) && !isLikelyCaptionUrl(resolved) && !isLikelyHls(resolved, contentType))) {
      return;
    }
    if (isLikelyMediaUrl(resolved) || isLikelyHls(resolved, contentType)) rememberMediaOrigin(resolved);
    post("NETWORK_RESPONSE", {
      url: resolved,
      status,
      contentType: contentType || "",
      timestamp: Date.now()
    });
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function videoExporterFetch(input) {
      const requestedUrl = absoluteUrl(urlFromInput(input));
      const capturedGeneration = generation;
      const response = await originalFetch.apply(this, arguments);
      if (capturedGeneration !== generation) return response;
      const finalUrl = response.url || requestedUrl;
      const contentType = response.headers?.get?.("content-type") || "";
      reportNetworkResponse(finalUrl, response.status, contentType);
      maybeCaptureCaptionText(finalUrl, response, contentType);
      maybeCaptureHlsText(finalUrl, response, contentType);
      maybeCaptureVimeoDashText(finalUrl, requestedUrl, response, contentType);
      return response;
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === "function") {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function videoExporterOpen(method, url) {
      this.__videoExporterUrl = absoluteUrl(urlFromInput(url));
      this.__videoExporterGeneration = generation;
      return originalOpen.apply(this, arguments);
    };

    OriginalXhr.prototype.send = function videoExporterSend() {
      this.addEventListener("load", () => {
        if (this.__videoExporterGeneration !== generation) return;
        const url = this.responseURL || this.__videoExporterUrl;
        if (!url) return;

        const contentType = this.getResponseHeader?.("content-type") || "";
        reportNetworkResponse(url, this.status, contentType);

        let responseText = "";
        try {
          responseText = typeof this.responseText === "string" ? this.responseText : "";
        } catch {
          // XHR throws when responseType is "json"; serialize the already parsed response below.
        }
        if (!responseText && this.responseType === "json" && this.response && typeof this.response === "object") {
          try {
            responseText = JSON.stringify(this.response);
          } catch {
            responseText = "";
          }
        }
        if (!responseText || responseText.length > MAX_TEXT_CAPTURE) return;

        if (isLikelyCaptionUrl(url) && /(text|json|vtt|srt|caption|subtitle|transcript)/i.test(contentType)) {
          post("CAPTION_RESPONSE", {
            url,
            contentType,
            text: responseText,
            timestamp: Date.now()
          });
        }

        if (isLikelyHls(url, contentType) && /^#EXTM3U/m.test(responseText)) {
          post("HLS_PLAYLIST_RESPONSE", {
            url,
            requestedUrl: this.__videoExporterUrl || url,
            contentType,
            text: responseText,
            timestamp: Date.now()
          });
        }

        captureVimeoDashText(url, this.__videoExporterUrl || url, contentType, responseText);
      });

      return originalSend.apply(this, arguments);
    };
  }

  function bridgeRequestAllowed(url) {
    try {
      const parsed = new URL(url);
      return (
        ["https:", "http:"].includes(parsed.protocol) &&
        (parsed.origin === location.origin ||
          allowedMediaOrigins.has(parsed.origin) ||
          isLikelyMediaUrl(parsed.href) ||
          isLikelyCaptionUrl(parsed.href))
      );
    } catch {
      return false;
    }
  }

  async function handleResourceRequest(payload) {
    const requestId = String(payload?.requestId || "");
    const url = absoluteUrl(payload?.url);
    if (!requestId || !url || !bridgeRequestAllowed(url)) {
      post("RESOURCE_RESPONSE", {
        requestId,
        ok: false,
        error: "The requested resource is outside the active lesson media context."
      });
      return;
    }

    const headers = {};
    if (/^bytes=\d*-\d*$/i.test(payload?.range || "")) {
      headers.Range = payload.range;
    }

    try {
      rememberMediaOrigin(url);
      const credentials = new URL(url).origin === location.origin ? "same-origin" : "omit";
      const response = await originalFetch.call(window, url, {
        credentials,
        cache: isLikelyHls(url) ? "no-store" : "default",
        headers
      });
      const contentType = response.headers.get("content-type") || "";
      const common = {
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        finalUrl: response.url || url,
        contentType,
        contentLength: response.headers.get("content-length") || "",
        contentRange: response.headers.get("content-range") || "",
        acceptRanges: response.headers.get("accept-ranges") || ""
      };

      if (!response.ok) {
        post("RESOURCE_RESPONSE", {
          ...common,
          error: `Media request failed (${response.status}).`
        });
        return;
      }

      if (payload?.responseType === "text") {
        const text = await response.text();
        post("RESOURCE_RESPONSE", { ...common, text });
        return;
      }

      const buffer = await response.arrayBuffer();
      post("RESOURCE_RESPONSE", { ...common, buffer }, [buffer]);
    } catch (error) {
      post("RESOURCE_RESPONSE", {
        requestId,
        ok: false,
        error: error?.message || "The page could not fetch this media resource."
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "video-transcript-exporter-content") return;
    if (event.data.type === "RESET_PAGE_CONTEXT") {
      generation += 1;
      allowedMediaOrigins.clear();
      allowedMediaOrigins.add(location.origin);
      return;
    }
    if (event.data.type === "BRIDGE_PING") {
      post("PAGE_HOOK_READY", { timestamp: Date.now() });
      return;
    }
    if (event.data.type === "RESOURCE_REQUEST") {
      handleResourceRequest(event.data.payload);
    }
  });

  post("PAGE_HOOK_READY", { timestamp: Date.now() });
})();
