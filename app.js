(function () {
  "use strict";

  var STORAGE_KEY = "alchemy3d_human_eval_v6";
  var INSTITUTION_KEY = "alchemy3d_human_eval_institution";
  var LABELS = "ABCDEFGH";
  var DEFAULT_ORBIT = "25deg 70deg 2.1m";
  var DEFAULT_TARGET = "0m 0m 0m";
  var DEFAULT_FOV = "30deg";
  // Fit max model axis into this size (meters), then shrink a bit for margin.
  var FIT_SIZE = 0.72;
  var FIT_RADIUS = 2.9; // meters = FIT_SIZE * FIT_RADIUS after normalize
  var HARD_LABEL = "HARD";
  // Which method outputs to compare for each edit type.
  var MODEL_POLICY = {
    add: ["alchemy3d", "partflow", "3deditformer", "nano3d"],
    remove: ["alchemy3d", "partflow", "3deditformer", "nano3d"],
    replace: ["alchemy3d", "partflow", "3deditformer", "nano3d"],
    animation: ["alchemy3d", "3deditformer"],
    local_appearance: ["partflow", "alchemy3d"],
    global_appearance: ["partflow", "alchemy3d"]
  };

  var DOWNLOAD_CONCURRENCY = 2;
  var ASSET_CACHE_NAME = "alchemy3d-eval-assets-v1";

  var state = {
    manifest: null,
    session: null,
    selectedLabel: null,
    hardToSelect: false,
    optionMap: [],
    viewers: [],
    loadToken: 0,
    assetBlobs: {},
    assetUrls: {},
    downloadAbort: null,
  };

  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function remoteAssetUrl(rel) {
    var base = state.manifest.base_url.replace(/\/$/, "");
    return base + "/" + String(rel).replace(/^\//, "");
  }

  function assetUrl(rel) {
    var key = String(rel || "");
    if (state.assetUrls[key]) return state.assetUrls[key];
    return remoteAssetUrl(key);
  }

  function formatBytes(n) {
    if (!n || n < 0) return "0 MB";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function clearAssetCache() {
    Object.keys(state.assetUrls).forEach(function (key) {
      try {
        URL.revokeObjectURL(state.assetUrls[key]);
      } catch (err) {}
    });
    state.assetUrls = {};
    state.assetBlobs = {};
    if (window.caches && caches.delete) {
      return caches.delete(ASSET_CACHE_NAME).catch(function () {
        return false;
      });
    }
    return Promise.resolve(false);
  }

  function putAssetInCache(rel, blob) {
    if (!window.caches || !caches.open) return Promise.resolve();
    return caches.open(ASSET_CACHE_NAME).then(function (cache) {
      var headers = { "Content-Type": blob.type || "application/octet-stream" };
      return cache.put(remoteAssetUrl(rel), new Response(blob, { headers: headers }));
    }).catch(function (err) {
      console.warn("Cache put failed", rel, err);
    });
  }

  function deleteDownloadedAssets() {
    disposeViewers();
    var btn = $("btn-delete-assets");
    var status = $("delete-assets-status");
    if (btn) btn.disabled = true;
    if (status) status.textContent = "Deleting downloaded files... / 正在删除已下载文件...";
    return Promise.resolve(clearAssetCache()).then(function () {
      if (status) {
        status.textContent =
          "Downloaded assets deleted from this browser. / 已从本浏览器删除下载文件。";
      }
      if (btn) btn.textContent = "Deleted / 已删除";
    }).catch(function (err) {
      console.error(err);
      if (status) {
        status.textContent =
          "Could not delete all cached files. / 未能完全删除缓存文件。";
      }
      if (btn) btn.disabled = false;
    });
  }

  function materializeAssetUrls() {
    Object.keys(state.assetBlobs).forEach(function (key) {
      if (state.assetUrls[key]) {
        try {
          URL.revokeObjectURL(state.assetUrls[key]);
        } catch (err) {}
      }
      state.assetUrls[key] = URL.createObjectURL(state.assetBlobs[key]);
    });
  }

  function collectSessionAssets(session) {
    var paths = [];
    var seen = {};
    function add(rel) {
      if (!rel || seen[rel]) return;
      seen[rel] = true;
      paths.push(rel);
    }
    (session.queue || []).forEach(function (id) {
      var sample = sampleById(id);
      if (!sample) return;
      add(sample.target_image);
      add(sample.source);
      filterModelsForSample(sample).forEach(function (m) {
        add(m.glb);
      });
    });
    return paths;
  }

  function updateDownloadUi(progress) {
    var pct = progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : Math.min(100, Math.round((progress.doneFiles / Math.max(1, progress.totalFiles)) * 100));
    var fill = $("download-progress-fill");
    if (fill) fill.style.width = pct + "%";
    if ($("download-percent")) $("download-percent").textContent = pct + "%";
    if ($("download-counts")) {
      $("download-counts").textContent =
        progress.doneFiles + " / " + progress.totalFiles + " files";
    }
    if ($("download-bytes")) {
      var totalLabel = progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : "? MB";
      $("download-bytes").textContent =
        formatBytes(progress.receivedBytes) + " / " + totalLabel;
    }
    if ($("download-current")) {
      $("download-current").textContent = progress.current
        ? "Downloading " + progress.current
        : progress.phase || "";
    }
    var err = $("download-error");
    if (err) {
      if (progress.error) {
        err.hidden = false;
        err.textContent = progress.error;
      } else {
        err.hidden = true;
        err.textContent = "";
      }
    }
  }

  function fetchBlobWithProgress(url, signal, onBytes) {
    return fetch(url, { signal: signal, mode: "cors", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      var total = Number(res.headers.get("content-length") || 0);
      if (!res.body || !res.body.getReader) {
        return res.blob().then(function (blob) {
          onBytes(blob.size, total || blob.size, true);
          return blob;
        });
      }
      var reader = res.body.getReader();
      var chunks = [];
      var received = 0;
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            onBytes(received, total || received, true);
            return new Blob(chunks);
          }
          chunks.push(result.value);
          received += result.value.byteLength;
          onBytes(received, total, false);
          return pump();
        });
      }
      return pump();
    });
  }

  function downloadSessionAssets(session) {
    var paths = collectSessionAssets(session);
    var progress = {
      totalFiles: paths.length,
      doneFiles: 0,
      receivedBytes: 0,
      totalBytes: 0,
      fileBytes: {},
      current: "",
      phase: "Preparing download...",
      error: ""
    };
    updateDownloadUi(progress);

    if (!paths.length) {
      return Promise.resolve();
    }

    var controller = new AbortController();
    state.downloadAbort = controller;
    var queue = paths.slice();
    var active = 0;
    var failed = null;

    return new Promise(function (resolve, reject) {
      function refreshTotals() {
        var sumKnown = 0;
        var known = 0;
        Object.keys(progress.fileBytes).forEach(function (k) {
          var fb = progress.fileBytes[k];
          if (fb.total > 0) {
            sumKnown += fb.total;
            known += 1;
          } else {
            sumKnown += fb.received;
          }
        });
        // Estimate remaining unknown files from average of known totals.
        var remaining = progress.totalFiles - Object.keys(progress.fileBytes).length;
        var avg = known > 0 ? sumKnown / known : 0;
        progress.totalBytes = sumKnown + remaining * avg;
        var received = 0;
        Object.keys(progress.fileBytes).forEach(function (k) {
          received += progress.fileBytes[k].received;
        });
        progress.receivedBytes = received;
      }

      function pump() {
        if (failed) {
          reject(failed);
          return;
        }
        if (progress.doneFiles >= progress.totalFiles) {
          progress.current = "";
          progress.phase = "Creating local URLs...";
          updateDownloadUi(progress);
          materializeAssetUrls();
          progress.phase = "Ready";
          updateDownloadUi(progress);
          resolve();
          return;
        }
        while (active < DOWNLOAD_CONCURRENCY && queue.length) {
          (function (rel) {
            active += 1;
            progress.current = rel;
            progress.phase = "Downloading...";
            progress.fileBytes[rel] = progress.fileBytes[rel] || { received: 0, total: 0 };
            updateDownloadUi(progress);
            var remote = remoteAssetUrl(rel);
            fetchBlobWithProgress(
              remote,
              controller.signal,
              function (received, total) {
                progress.fileBytes[rel].received = received;
                if (total > 0) progress.fileBytes[rel].total = total;
                refreshTotals();
                updateDownloadUi(progress);
              }
            )
              .then(function (blob) {
                state.assetBlobs[rel] = blob;
                putAssetInCache(rel, blob);
                progress.fileBytes[rel].received = blob.size;
                if (!progress.fileBytes[rel].total) {
                  progress.fileBytes[rel].total = blob.size;
                }
                progress.doneFiles += 1;
                active -= 1;
                refreshTotals();
                updateDownloadUi(progress);
                pump();
              })
              .catch(function (err) {
                active -= 1;
                if (controller.signal.aborted) {
                  failed = new Error("Download cancelled");
                } else {
                  failed = err;
                  progress.error = "Failed: " + rel + " (" + (err && err.message ? err.message : err) + ")";
                  updateDownloadUi(progress);
                }
                reject(failed);
              });
          })(queue.shift());
        }
      }

      pump();
    }).finally(function () {
      state.downloadAbort = null;
    });
  }

  function beginSessionWithDownload(session) {
    state.session = session;
    saveSession();
    showView("download");
    var cancel = $("btn-cancel-download");
    if (cancel) {
      cancel.hidden = false;
      cancel.textContent = "Cancel download";
    }
    updateDownloadUi({
      totalFiles: 0,
      doneFiles: 0,
      receivedBytes: 0,
      totalBytes: 0,
      current: "",
      phase: "Collecting asset list...",
      error: ""
    });
    return downloadSessionAssets(session)
      .then(function () {
        if (cancel) cancel.hidden = true;
        renderTrial();
      })
      .catch(function (err) {
        console.error(err);
        var msg = err && err.message ? err.message : String(err);
        updateDownloadUi({
          totalFiles: 1,
          doneFiles: 0,
          receivedBytes: 0,
          totalBytes: 0,
          current: "",
          phase: "Download failed",
          error: msg + " — return to start and try again."
        });
        var cancel = $("btn-cancel-download");
        if (cancel) {
          cancel.hidden = false;
          cancel.textContent = "Back to start";
        }
      });
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function sampleN(items, n) {
    return shuffle(items).slice(0, Math.min(n, items.length));
  }

  function showView(name) {
    ["landing", "download", "trial", "done"].forEach(function (key) {
      var node = $("view-" + key);
      if (!node) return;
      var active = key === name;
      node.hidden = !active;
      node.classList.toggle("is-active", active);
    });
  }

  function saveSession() {
    if (!state.session) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.session));
    } catch (err) {
      console.warn("Could not persist session", err);
    }
  }

  function loadSavedSession() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.queue || !parsed.responses) return null;
      if (parsed.completedAt) return null;
      if (parsed.cursor >= parsed.queue.length) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function clearSavedSession() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {}
  }

  var SESSION_QUOTA = {
    structural: 30, // add + remove + replace
    animation: 10,
    appearance: 10
  };

  function sampleQuotaGroup(pool, editTypes, n) {
    var allow = {};
    editTypes.forEach(function (t) {
      allow[t] = true;
    });
    var subset = pool.filter(function (s) {
      return allow[String(s.edit_type || "").toLowerCase()];
    });
    return sampleN(subset, n);
  }

  function createSession() {
    var pool = (state.manifest.samples || []).filter(isSampleEligible);
    var structural = sampleQuotaGroup(
      pool,
      ["add", "remove", "replace"],
      SESSION_QUOTA.structural
    );
    var animation = sampleQuotaGroup(pool, ["animation"], SESSION_QUOTA.animation);
    var appearance = sampleQuotaGroup(
      pool,
      ["local_appearance", "global_appearance"],
      SESSION_QUOTA.appearance
    );
    var picked = shuffle(structural.concat(animation, appearance));
    var quota = {
      structural: structural.length,
      animation: animation.length,
      appearance: appearance.length
    };
    return {
      sessionId: uid(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      samplesPerSession: picked.length,
      quota: quota,
      repo: state.manifest.repo,
      userAgent: navigator.userAgent,
      queue: picked.map(function (s) {
        return s.id;
      }),
      cursor: 0,
      responses: [],
      institution: "",
    };
  }

  function readInstitutionInput() {
    var input = $("institution-input");
    return input ? String(input.value || "").trim() : "";
  }

  function persistInstitution(name) {
    try {
      localStorage.setItem(INSTITUTION_KEY, name);
    } catch (err) {}
  }

  function loadPersistedInstitution() {
    try {
      return localStorage.getItem(INSTITUTION_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function optionalInstitution() {
    var name = readInstitutionInput();
    if (name) persistInstitution(name);
    return name;
  }

  function allowedModelsForEditType(editType) {
    var key = String(editType || "").toLowerCase();
    if (MODEL_POLICY[key]) return MODEL_POLICY[key].slice();
    // Fallback: compare whatever is present.
    return null;
  }

  function filterModelsForSample(sample) {
    var models = (sample && sample.models) || [];
    var allowed = allowedModelsForEditType(sample && sample.edit_type);
    if (!allowed) return models.slice();
    var allowSet = {};
    allowed.forEach(function (id) {
      allowSet[id] = true;
    });
    // Keep policy order for stable blinding labels across reloads of same shuffle seed (shuffle still randomizes).
    var byId = {};
    models.forEach(function (m) {
      byId[m.id] = m;
    });
    var filtered = [];
    allowed.forEach(function (id) {
      if (byId[id]) filtered.push(byId[id]);
    });
    return filtered;
  }

  function isSampleEligible(sample) {
    return filterModelsForSample(sample).length >= 2;
  }

  function sampleById(id) {
    var list = state.manifest.samples;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function currentSample() {
    if (!state.session) return null;
    return sampleById(state.session.queue[state.session.cursor]);
  }

  function updateProgress() {
    var s = state.session;
    var total = s.queue.length;
    var idx = Math.min(s.cursor + 1, total);
    var pct = (s.cursor / total) * 100;
    $("progress-text").textContent = idx + " / " + total;
    $("progress-fill").style.width = pct + "%";
  }

  function disposeViewers() {
    state.viewers.forEach(function (mv) {
      try {
        mv.removeAttribute("src");
        mv.remove();
      } catch (err) {}
    });
    state.viewers = [];
  }

  function waitViewerReady(mv) {
    if (mv.updateComplete && typeof mv.updateComplete.then === "function") {
      return mv.updateComplete;
    }
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
  }

  function applyFraming(mv) {
    var radius = FIT_SIZE * FIT_RADIUS;
    var center = null;
    try {
      center = mv.getBoundingBoxCenter && mv.getBoundingBoxCenter();
    } catch (err) {}
    if (center && isFinite(center.x) && isFinite(center.y) && isFinite(center.z)) {
      mv.cameraTarget = center.x + "m " + center.y + "m " + center.z + "m";
    } else {
      mv.cameraTarget = "0m 0m 0m";
    }
    mv.fieldOfView = DEFAULT_FOV;
    mv.cameraOrbit = "25deg 70deg " + radius + "m";
    if (typeof mv.jumpCameraToGoal === "function") {
      mv.jumpCameraToGoal();
    }
  }

  function normalizeViewerFit(mv, attempt) {
    attempt = attempt || 0;
    return waitViewerReady(mv).then(function () {
      try {
        mv.scale = "1 1 1";
      } catch (err) {}
      return waitViewerReady(mv);
    }).then(function () {
      var dims = null;
      try {
        dims = mv.getDimensions && mv.getDimensions();
      } catch (err) {}
      var maxDim = dims
        ? Math.max(dims.x || 0, dims.y || 0, dims.z || 0)
        : 0;
      if (!(maxDim > 1e-6)) {
        if (attempt < 8) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              resolve(normalizeViewerFit(mv, attempt + 1));
            }, 120);
          });
        }
        applyFraming(mv);
        return;
      }
      var s = FIT_SIZE / maxDim;
      mv.scale = s + " " + s + " " + s;
      return waitViewerReady(mv).then(function () {
        applyFraming(mv);
      });
    }).catch(function (err) {
      console.warn("normalizeViewerFit failed", err);
    });
  }

  function makeViewer(src, statusEl) {
    var mv = document.createElement("model-viewer");
    mv.setAttribute("alt", "3D asset");
    mv.setAttribute("camera-controls", "");
    mv.setAttribute("touch-action", "none");
    mv.setAttribute("interaction-prompt", "none");
    mv.setAttribute("shadow-intensity", "0.55");
    mv.setAttribute("environment-image", "neutral");
    mv.setAttribute("exposure", "1");
    mv.setAttribute("camera-orbit", DEFAULT_ORBIT);
    mv.setAttribute("camera-target", "0m 0m 0m");
    mv.setAttribute("field-of-view", DEFAULT_FOV);
    mv.setAttribute("min-camera-orbit", "auto auto 0.5m");
    mv.setAttribute("max-camera-orbit", "auto auto 20m");
    mv.setAttribute("loading", "eager");
    mv.setAttribute("reveal", "auto");
    mv.style.width = "100%";
    mv.style.height = "100%";

    var onProgress = function (ev) {
      if (!statusEl) return;
      var detail = ev.detail || {};
      if (detail.totalProgress != null) {
        var pct = Math.round(detail.totalProgress * 100);
        statusEl.textContent = pct < 100 ? "Opening " + pct + "%" : "Parsing...";
        statusEl.classList.remove("is-hidden", "is-error");
      }
    };
    var onLoad = function () {
      normalizeViewerFit(mv).then(function () {
        if (statusEl) {
          statusEl.textContent = "";
          statusEl.classList.add("is-hidden");
        }
      });
      mv.removeEventListener("progress", onProgress);
    };
    var onError = function () {
      if (statusEl) {
        statusEl.textContent = "Failed to load model";
        statusEl.classList.add("is-error");
        statusEl.classList.remove("is-hidden");
      }
    };

    mv.addEventListener("progress", onProgress);
    mv.addEventListener("load", onLoad);
    mv.addEventListener("error", onError);
    mv.src = src;
    state.viewers.push(mv);
    return mv;
  }
  function setStatus(el, text, isError) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
    el.classList.toggle("is-hidden", !text);
  }

  function clearSelection() {
    state.selectedLabel = null;
    state.hardToSelect = false;
    document.querySelectorAll(".candidate").forEach(function (btn) {
      btn.classList.remove("is-selected");
      btn.setAttribute("aria-checked", "false");
    });
    $("btn-confirm").disabled = true;
    $("choice-summary").textContent = "Select one candidate to continue.";
  }

  function selectCandidate(label) {
    state.selectedLabel = label;
    state.hardToSelect = label === HARD_LABEL;
    document.querySelectorAll(".candidate").forEach(function (btn) {
      var on = btn.dataset.label === label;
      btn.classList.toggle("is-selected", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    $("btn-confirm").disabled = false;
    $("choice-summary").textContent = state.hardToSelect
      ? "Marked as hard to select."
      : "Selected option " + label + ".";
  }

  function selectHardToSelect() {
    selectCandidate(HARD_LABEL);
  }

  function renderTrial() {
    var sample = currentSample();
    if (!sample) {
      finishSession();
      return;
    }

    var token = ++state.loadToken;
    disposeViewers();
    clearSelection();
    updateProgress();
    showView("trial");

    $("instruction-text").textContent = sample.instruction || "(missing instruction)";
    $("edit-type-badge").textContent = (sample.edit_type || "").replace(/_/g, " ");

    var img = $("target-image");
    var targetStatus = $("target-status");
    setStatus(targetStatus, "Loading image...");
    img.onload = function () {
      if (token !== state.loadToken) return;
      setStatus(targetStatus, "");
    };
    img.onerror = function () {
      if (token !== state.loadToken) return;
      setStatus(targetStatus, "Failed to load image", true);
    };
    img.src = assetUrl(sample.target_image);

    var sourceFrame = $("source-frame");
    var sourceStatus = $("source-status");
    sourceFrame.querySelectorAll("model-viewer").forEach(function (n) {
      n.remove();
    });
    setStatus(sourceStatus, "Opening source...");
    var sourceMv = makeViewer(assetUrl(sample.source), sourceStatus);
    sourceFrame.appendChild(sourceMv);

    var options = shuffle(filterModelsForSample(sample));
    if (options.length < 2) {
      // Should be rare after eligibility filter; skip forward.
      recordResponse(null, true, false);
      if (state.session.cursor >= state.session.queue.length) {
        finishSession();
      } else {
        renderTrial();
      }
      return;
    }
    state.optionMap = options.map(function (m, i) {
      return { label: LABELS[i], modelId: m.id, glb: m.glb };
    });

    var grid = $("results-grid");
    grid.innerHTML = "";
    state.optionMap.forEach(function (opt) {
      var card = document.createElement("div");
      card.className = "candidate";
      card.dataset.label = opt.label;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", "false");
      card.setAttribute("tabindex", "0");
      card.setAttribute("aria-label", "Option " + opt.label);

      var head = document.createElement("div");
      head.className = "candidate-label";
      head.innerHTML =
        "<span>Option " +
        opt.label +
        '</span><span class="candidate-tag">Edited</span>';

      var frame = document.createElement("div");
      frame.className = "viewer-frame";
      var status = document.createElement("div");
      status.className = "panel-status";
      status.textContent = "Opening...";
      frame.appendChild(status);
      var mv = makeViewer(assetUrl(opt.glb), status);
      frame.appendChild(mv);

      var pick = document.createElement("button");
      pick.type = "button";
      pick.className = "btn-pick";
      pick.textContent = "Select " + opt.label;
      pick.addEventListener("click", function (ev) {
        ev.stopPropagation();
        selectCandidate(opt.label);
      });

      card.appendChild(head);
      card.appendChild(frame);
      card.appendChild(pick);
      card.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          selectCandidate(opt.label);
        }
      });

      grid.appendChild(card);
    });

    var hardCard = document.createElement("div");
    hardCard.className = "candidate candidate-hard";
    hardCard.id = "btn-hard";
    hardCard.dataset.label = HARD_LABEL;
    hardCard.setAttribute("role", "radio");
    hardCard.setAttribute("aria-checked", "false");
    hardCard.setAttribute("tabindex", "0");
    hardCard.setAttribute("aria-label", "Hard to select");

    var hardHead = document.createElement("div");
    hardHead.className = "candidate-label";
    hardHead.innerHTML =
      '<span>Hard to select</span><span class="candidate-tag">No winner</span>';

    var hardBody = document.createElement("div");
    hardBody.className = "hard-body";
    hardBody.textContent =
      "None of the edited results clearly matches the instruction better than the others.";

    var hardPick = document.createElement("button");
    hardPick.type = "button";
    hardPick.className = "btn-pick";
    hardPick.textContent = "Select this option";
    hardPick.addEventListener("click", function (ev) {
      ev.stopPropagation();
      selectHardToSelect();
    });

    hardCard.appendChild(hardHead);
    hardCard.appendChild(hardBody);
    hardCard.appendChild(hardPick);
    hardCard.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        selectHardToSelect();
      }
    });
    grid.appendChild(hardCard);
  }

  function recordResponse(choiceLabel, skipped, hardToSelect) {
    var sample = currentSample();
    if (!sample) return;
    var hard = !!hardToSelect;
    var chosen = null;
    if (!skipped && !hard) {
      for (var i = 0; i < state.optionMap.length; i++) {
        if (state.optionMap[i].label === choiceLabel) {
          chosen = state.optionMap[i];
          break;
        }
      }
    }
    state.session.responses.push({
      sampleId: sample.id,
      editType: sample.edit_type,
      instruction: sample.instruction,
      options: state.optionMap.map(function (o) {
        return { label: o.label, modelId: o.modelId };
      }),
      choiceLabel: skipped ? null : choiceLabel,
      choiceModelId: chosen ? chosen.modelId : null,
      hardToSelect: hard,
      skipped: !!skipped,
      timestamp: new Date().toISOString(),
    });
    state.session.cursor += 1;
    saveSession();
  }

  function confirmAndNext() {
    if (!state.selectedLabel) return;
    recordResponse(state.selectedLabel, false, state.hardToSelect);
    if (state.session.cursor >= state.session.queue.length) {
      finishSession();
    } else {
      renderTrial();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function skipTrial() {
    if (!window.confirm("Skip this sample without choosing a winner?")) return;
    recordResponse(null, true);
    if (state.session.cursor >= state.session.queue.length) {
      finishSession();
    } else {
      renderTrial();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function finishSession() {
    disposeViewers();
    state.session.completedAt = new Date().toISOString();
    state.session.submitted = false;
    saveSession();
    var delBtn = $("btn-delete-assets");
    var delStatus = $("delete-assets-status");
    if (delBtn) {
      delBtn.disabled = false;
      delBtn.textContent = "Delete downloaded assets / 删除已下载文件";
    }
    if (delStatus) delStatus.textContent = "";
    var retryBtn = $("btn-retry-submit");
    if (retryBtn) retryBtn.hidden = true;
    var summary = $("done-summary");
    if (summary) {
      summary.innerHTML =
        "Your evaluation is complete. Results are being submitted automatically.<br />评测已完成，结果正在自动提交。";
    }
    var submitStatus = $("submit-status");
    if (submitStatus) submitStatus.textContent = "Submitting... / 正在提交...";
    showView("done");
    submitResults();
  }

  function responseChoice(r) {
    if (r.skipped) return "skip";
    if (r.hardToSelect) return "hard_to_select";
    return r.choiceModelId || "skip";
  }

  function rateBlock(rows) {
    var counts = {};
    var n = 0;
    rows.forEach(function (r) {
      var choice = responseChoice(r);
      if (choice === "skip") return;
      n += 1;
      counts[choice] = (counts[choice] || 0) + 1;
    });
    var rates = {};
    Object.keys(counts).forEach(function (key) {
      rates[key] = n ? +(counts[key] / n).toFixed(4) : 0;
    });
    return { n: n, counts: counts, rates: rates };
  }

  function exportPayload() {
    var responses = state.session.responses || [];
    var selections = responses
      .filter(function (r) {
        return !r.skipped;
      })
      .map(function (r) {
        return {
          id: r.sampleId,
          type: r.editType,
          choice: responseChoice(r)
        };
      });
    var byType = {};
    responses.forEach(function (r) {
      if (r.skipped) return;
      var t = r.editType || "unknown";
      if (!byType[t]) byType[t] = [];
      byType[t].push(r);
    });
    var byTypeRates = {};
    Object.keys(byType).forEach(function (t) {
      byTypeRates[t] = rateBlock(byType[t]);
    });
    var overall = rateBlock(responses);
    overall.institution = (state.session && state.session.institution) || "";
    return {
      sessionId: state.session.sessionId,
      institution: (state.session && state.session.institution) || "",
      completedAt: state.session.completedAt,
      selections: selections,
      selectionRate: {
        overall: overall,
        byType: byTypeRates
      }
    };
  }

  function modelLabel(id) {
    var labels = (state.manifest && state.manifest.model_labels) || {};
    if (id === "hard_to_select") return "Hard to select";
    return labels[id] || id;
  }

  function ratesTableHtml(title, block) {
    var keys = Object.keys((block && block.rates) || {}).sort();
    var rows = keys
      .map(function (key) {
        var pct = ((block.rates[key] || 0) * 100).toFixed(1) + "%";
        var n = (block.counts && block.counts[key]) || 0;
        return (
          "<tr><td>" +
          modelLabel(key) +
          "</td><td>" +
          n +
          "</td><td>" +
          pct +
          "</td></tr>"
        );
      })
      .join("");
    return (
      "<h2>" +
      title +
      " (n=" +
      ((block && block.n) || 0) +
      ")</h2>" +
      '<table class="rates-table"><thead><tr><th>Choice</th><th>Count</th><th>Rate</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="3">No votes</td></tr>') +
      "</tbody></table>"
    );
  }

  function renderRates(payload) {
    var root = $("rates-root");
    if (!root) return;
    var html = ratesTableHtml("Overall / 总体", payload.selectionRate.overall);
    var byType = payload.selectionRate.byType || {};
    Object.keys(byType)
      .sort()
      .forEach(function (t) {
        html +=
          '<div class="rates-type">' +
          ratesTableHtml(t.replace(/_/g, " "), byType[t]) +
          "</div>";
      });
    root.innerHTML = html;
    root.hidden = false;
  }

  function submitUrl() {
    return (window.EVAL_CONFIG && window.EVAL_CONFIG.submitUrl) || "";
  }

  function setSubmitUi(stateName, message) {
    var status = $("submit-status");
    var retryBtn = $("btn-retry-submit");
    var summary = $("done-summary");
    if (status) status.textContent = message || "";
    if (retryBtn) {
      retryBtn.hidden = stateName !== "error";
      retryBtn.disabled = false;
    }
    if (summary) {
      if (stateName === "ok") {
        summary.innerHTML =
          "Thank you for contributing to this evaluation.<br />感谢您完成本次评测。";
      } else if (stateName === "error") {
        summary.innerHTML =
          "Your answers were saved locally, but cloud submit failed. Please retry.<br />答案已保存在本地，但云端提交失败，请重试。";
      } else {
        summary.innerHTML =
          "Your evaluation is complete. Results are being submitted automatically.<br />评测已完成，结果正在自动提交。";
      }
    }
  }

  function submitResults() {
    var url = submitUrl();
    var retryBtn = $("btn-retry-submit");
    if (retryBtn) {
      retryBtn.hidden = true;
      retryBtn.disabled = true;
    }
    if (!url) {
      setSubmitUi(
        "error",
        "No cloud endpoint configured. / 未配置云端接口。"
      );
      return;
    }
    setSubmitUi("pending", "Submitting... / 正在提交...");
    fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(exportPayload())
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function () {
        if (state.session) {
          state.session.submitted = true;
          saveSession();
        }
        setSubmitUi("ok", "Submitted successfully. / 已成功提交。");
      })
      .catch(function (err) {
        console.error(err);
        setSubmitUi(
          "error",
          "Submit failed. Please retry. / 提交失败，请重试。"
        );
      });
  }

  function downloadResults() {
    var payload = exportPayload();
    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      "alchemy3d_human_eval_" + state.session.sessionId.slice(0, 8) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 1000);
  }

  function startFresh() {
    var institution = optionalInstitution();
    clearSavedSession();
    clearAssetCache();
    var session = createSession();
    session.institution = institution;
    beginSessionWithDownload(session);
  }

  function resumeSession() {
    var institution = optionalInstitution();
    var saved = loadSavedSession();
    if (!saved) return;
    if (institution) saved.institution = institution;
    clearAssetCache();
    beginSessionWithDownload(saved);
  }

  function wireUi() {
    $("btn-start").addEventListener("click", startFresh);
    $("btn-resume").addEventListener("click", resumeSession);
    var cancelBtn = $("btn-cancel-download");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        if (state.downloadAbort) {
          try {
            state.downloadAbort.abort();
          } catch (err) {}
        }
        clearAssetCache();
        showView("landing");
        initLanding();
      });
    }
    $("btn-confirm").addEventListener("click", confirmAndNext);
    $("btn-skip").addEventListener("click", skipTrial);
    if ($("btn-retry-submit")) {
      $("btn-retry-submit").addEventListener("click", submitResults);
    }
    if ($("btn-delete-assets")) {
      $("btn-delete-assets").addEventListener("click", deleteDownloadedAssets);
    }
    $("btn-restart").addEventListener("click", function () {
      if (
        !window.confirm(
          "Start a new random set of 50 samples? The previous downloadable results remain only if you already saved them."
        )
      ) {
        return;
      }
      startFresh();
    });
  }

  function initLanding() {
    var n =
      SESSION_QUOTA.structural +
      SESSION_QUOTA.animation +
      SESSION_QUOTA.appearance;
    $("landing-n").textContent = String(n);
    var inst = $("institution-input");
    if (inst && !inst.value) inst.value = loadPersistedInstitution();
    var saved = loadSavedSession();
    if (saved) {
      $("btn-resume").hidden = false;
      $("btn-resume").textContent =
        "Resume (" + (saved.cursor + 1) + "/" + saved.queue.length + ")";
    }
    showView("landing");
  }

  function boot() {
    wireUi();
    fetch("manifest.json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load manifest.json");
        return res.json();
      })
      .then(function (manifest) {
        state.manifest = manifest;
        initLanding();
      })
      .catch(function (err) {
        $("landing-meta").textContent =
          "Could not load manifest.json. Serve this folder over HTTP and retry.";
        console.error(err);
        showView("landing");
      });
  }

  boot();
})();
