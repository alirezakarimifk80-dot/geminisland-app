import { createMeadowWorldEngine } from "./voxel/meadow_engine.js";
import { createCharacterBuilderController } from "./character_builder.js";
import { createMultiplayerClient } from "./multiplayer_client.js";

const urlParams = new URLSearchParams(location.search);
const isOgCapture = urlParams.get("og") === "1";
if (isOgCapture) {
  document.body.dataset.ogCapture = "1";
}

const worldCanvas = document.getElementById("world-canvas");

const addBtn = document.getElementById("add-btn");
const pickSpotPill = document.getElementById("pick-spot-pill");
const cancelPickBtn = document.getElementById("cancel-pick-btn");

const bottomBuilder = document.getElementById("bottom-builder");
const moveSpotBtn = document.getElementById("move-spot-btn");
const closeBuilderBtn = document.getElementById("close-builder-btn");

const dropZone = document.getElementById("drop-zone");
const imageInput = document.getElementById("image-input");
const dropEmpty = document.getElementById("drop-empty");
const dropPreviewWrap = document.getElementById("drop-preview-wrap");
const dropPreviewImg = document.getElementById("drop-preview-img");
const clearImageBtn = document.getElementById("clear-image-btn");
const promptInput = document.getElementById("prompt-input");
const sculptBtn = document.getElementById("sculpt-btn");
const formError = document.getElementById("form-error");

const buildingPill = document.getElementById("building-pill");
const buildingPillLabel = document.getElementById("building-pill-label");
const buildingPillSub = document.getElementById("building-pill-sub");
const readyGotoBtn = document.getElementById("ready-goto-btn");
const readyGotoLabel = document.getElementById("ready-goto-label");
const locateMineBtn = document.getElementById("locate-mine-btn");
const locateMineLabel = document.getElementById("locate-mine-label");

const hoverCard = document.getElementById("hover-card");
const hoverName = document.getElementById("hover-name");
const hoverFeed = document.getElementById("hover-feed");
const hoverStatus = document.getElementById("hover-status");
const weaveToast = document.getElementById("weave-toast");

const camPanBtn = document.getElementById("cam-pan-btn");
const camOrbitBtn = document.getElementById("cam-orbit-btn");
const camWalkBtn = document.getElementById("cam-walk-btn");
const recenterBtn = document.getElementById("recenter-btn");
const recenterCompass = document.getElementById("recenter-compass");
const avatarBtn = document.getElementById("avatar-btn");
const avatarSwatchDot = document.getElementById("avatar-swatch-dot");
const onlinePill = document.getElementById("online-pill");
const onlineCountEl = document.getElementById("online-count");
const interactPromptBtn = document.getElementById("interact-prompt");
const interactKeyEl = document.getElementById("interact-key");
const interactLabelEl = document.getElementById("interact-label");
const walkEscHintBtn = document.getElementById("walk-esc-hint");
const avatarDialog = document.getElementById("avatar-dialog");

const walkJoystick = document.getElementById("walk-joystick");
const walkJoystickKnob = document.getElementById("walk-joystick-knob");
const walkJoyUp = document.getElementById("walk-joy-up");
const walkJoyDown = document.getElementById("walk-joy-down");
const walkJoyLeft = document.getElementById("walk-joy-left");
const walkJoyRight = document.getElementById("walk-joy-right");

// UI states: "idle" | "picking" | "composing" | "building" | "ready" | "placed"
let uiState = "idle";
let myCreationId = null;
let readyCreation = null;
let worldData = null;
let selectedImageDataUrl = null;
let chosenSpot = null;
let toastTimer = null;

// Live multi-user build queue state
let activeJob = null;
let jobPollInterval = null;
let jobPollInFlight = false;

const VISITOR_STORAGE_KEY = "geminisland_visitor_token_v1";
let cachedVisitorToken = (() => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(VISITOR_STORAGE_KEY) : null;
  } catch {
    return null;
  }
})();

const CLIENT_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();

function storeVisitorToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return;
  cachedVisitorToken = token;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VISITOR_STORAGE_KEY, token);
    }
  } catch {
    // Sandboxed iframes without storage access fall back to in-memory cachedVisitorToken
  }
}

function buildVisitorHeaders(extra = {}) {
  const headers = { ...extra };
  if (cachedVisitorToken) {
    headers["x-meadow-visitor"] = cachedVisitorToken;
  }
  if (CLIENT_TIMEZONE) {
    headers["x-meadow-tz"] = CLIENT_TIMEZONE;
  }
  return headers;
}
window.__geminIslandVisitorHeaders = buildVisitorHeaders;

function showToast(text, durationMs = 4200) {
  if (!text || isOgCapture) return;
  weaveToast.textContent = text;
  weaveToast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    weaveToast.hidden = true;
  }, durationMs);
}

function renderActiveJobLabel() {
  if (buildingPillSub) {
    buildingPillSub.textContent = "Being built with Gemini 4 Hydrogen";
  }
  if (!activeJob) {
    buildingPillLabel.textContent = "Approving query…";
    return;
  }
  if (activeJob.status === "queued" && activeJob.position >= 1) {
    buildingPillLabel.textContent =
      activeJob.position === 1 ? "Next in queue…" : `Waiting in queue (#${activeJob.position})…`;
  } else if (activeJob.phase === "approving") {
    buildingPillLabel.textContent = "Approving query…";
  } else if (activeJob.phase === "reviewing") {
    buildingPillLabel.textContent = "Reviewing 3D model…";
  } else if (activeJob.phase === "refining") {
    buildingPillLabel.textContent = "Polishing details…";
  } else if (activeJob.phase === "placing") {
    buildingPillLabel.textContent = "Placing on island…";
  } else {
    buildingPillLabel.textContent = "Sculpting voxels…";
  }
}

function stopJobTracking() {
  activeJob = null;
  if (jobPollInterval) {
    clearInterval(jobPollInterval);
    jobPollInterval = null;
  }
}

let engine = null;
let characterBuilder = null;
let mpClient = null;
let activeInteractionPrompt = null;
let lastAvatarDialogCloseMs = -1000;
let currentCamMode = "pan";
let sawTouchInput = false;
let joyPointerId = null;

function syncAvatarSwatchDot(app) {
  if (!avatarSwatchDot || !app || typeof app !== "object") return;
  const swatchColor =
    (typeof app.topColor === "string" && app.topColor) ||
    (typeof app.hatColor === "string" && app.hatColor) ||
    "#4c82d4";
  avatarSwatchDot.style.backgroundColor = swatchColor;
}

function updateOnlinePill(count) {
  if (!onlinePill) return;
  if (isOgCapture || typeof count !== "number" || !Number.isFinite(count) || count < 1) {
    onlinePill.hidden = true;
    return;
  }
  const clean = Math.max(1, Math.trunc(count));
  if (onlineCountEl) {
    onlineCountEl.textContent = String(clean);
  }
  onlinePill.hidden = false;
}

function isMobileWalkViewport() {
  if (sawTouchInput) return true;
  if (window.matchMedia?.("(pointer: coarse)")?.matches) return true;
  return window.innerWidth <= 768;
}

function resetWalkJoystick() {
  joyPointerId = null;
  walkJoystick?.classList.remove("is-active");
  walkJoystickKnob?.setAttribute("transform", "translate(0 0)");
  walkJoyUp?.classList.remove("is-lit");
  walkJoyDown?.classList.remove("is-lit");
  walkJoyLeft?.classList.remove("is-lit");
  walkJoyRight?.classList.remove("is-lit");
  engine?.setJoystickInput(0, 0);
}

function syncWalkJoystickVisibility() {
  const show = !isOgCapture && currentCamMode === "walk" && isMobileWalkViewport();
  if (walkJoystick) {
    walkJoystick.hidden = !show;
  }
  if (show) {
    document.body.dataset.walkMobile = "1";
  } else {
    delete document.body.dataset.walkMobile;
    resetWalkJoystick();
  }
}

function syncCameraModeUI(mode) {
  currentCamMode = mode;
  const isPan = mode === "pan";
  const isOrbit = mode === "orbit";
  const isWalk = mode === "walk";
  if (camPanBtn) {
    camPanBtn.classList.toggle("is-active", isPan);
    camPanBtn.setAttribute("aria-pressed", isPan ? "true" : "false");
  }
  if (camOrbitBtn) {
    camOrbitBtn.classList.toggle("is-active", isOrbit);
    camOrbitBtn.setAttribute("aria-pressed", isOrbit ? "true" : "false");
  }
  if (camWalkBtn) {
    camWalkBtn.classList.toggle("is-active", isWalk);
    camWalkBtn.setAttribute("aria-pressed", isWalk ? "true" : "false");
  }
  syncWalkJoystickVisibility();
  if (walkEscHintBtn) {
    walkEscHintBtn.hidden = isOgCapture || !isWalk || isMobileWalkViewport();
  }
}

const demoClickTimers = new WeakMap();

function triggerCameraButtonClickFX(mode) {
  syncCameraModeUI(mode);
  const btn = mode === "walk" ? camWalkBtn : mode === "orbit" ? camOrbitBtn : camPanBtn;
  if (!btn || isOgCapture) return;
  const prevTimer = demoClickTimers.get(btn);
  if (prevTimer) clearTimeout(prevTimer);
  btn.classList.remove("is-demo-click");
  void btn.offsetWidth;
  btn.classList.add("is-demo-click");
  demoClickTimers.set(
    btn,
    setTimeout(() => {
      btn.classList.remove("is-demo-click");
    }, 740),
  );
}

const lastIncidentSentByVehicle = new Map();

async function reportTrafficIncidentToObserver(incident) {
  if (isOgCapture || !incident || typeof incident.vehicleId !== "string") return;
  const nowMs = Date.now();
  const prevMs = lastIncidentSentByVehicle.get(incident.vehicleId) || 0;
  if (nowMs - prevMs < 25_000) return;
  lastIncidentSentByVehicle.set(incident.vehicleId, nowMs);
  try {
    await fetch("/api/traffic-incident", {
      method: "POST",
      headers: buildVisitorHeaders({
        "content-type": "application/json",
        "x-meadow-client": "1",
      }),
      body: JSON.stringify({
        vehicleId: incident.vehicleId,
        peerVehicleId: incident.peerVehicleId || null,
        x: incident.x,
        z: incident.z,
        reason: incident.reason || "self_restored",
      }),
    });
  } catch {
    // Ignore transient network errors during background telemetry
  }
}

engine = createMeadowWorldEngine(
  worldCanvas,
  {
    onHoverCreation(creation, clientX, clientY, reading) {
      if (
        !creation ||
        uiState === "picking" ||
        isOgCapture ||
        (activeInteractionPrompt && engine?.isFirstPerson?.())
      ) {
        hoverCard.hidden = true;
        return;
      }
      hoverName.textContent = creation.name;
      if (reading?.summary) {
        hoverFeed.textContent = reading.summary;
        hoverFeed.hidden = false;
      } else {
        hoverFeed.hidden = true;
      }
      hoverStatus.textContent = creation.description || creation.behavior?.statusLine || "";
      hoverCard.style.left = `${clientX}px`;
      hoverCard.style.top = `${clientY}px`;
      hoverCard.hidden = false;
    },
    onSelectCreation(creation, reading) {
      if (!creation || isOgCapture) return;
      const baseDesc = creation.description || creation.behavior?.statusLine || "";
      const detail = reading?.summary
        ? baseDesc
          ? `${reading.summary} · ${baseDesc}`
          : reading.summary
        : baseDesc;
      showToast(detail ? `${creation.name} — ${detail}` : creation.name);
    },
    onInteractiveEvent(_creation, message) {
      if (!message || isOgCapture) return;
      showToast(message);
    },
    onPickGroundSpot(x, z) {
      chosenSpot = { x, z };
      uiState = "composing";
      syncDockUI();
      if (window.innerWidth > 640) {
        promptInput.focus({ preventScroll: true });
      }
    },
    onAutoNudgeSpot(x, z) {
      if (chosenSpot) {
        chosenSpot = { x, z };
      }
    },
    onDragModeChange(mode) {
      syncCameraModeUI(mode);
    },
    onIntroDemoStep(mode) {
      triggerCameraButtonClickFX(mode);
    },
    onCameraChange(camState) {
      if (recenterCompass && typeof camState?.azDeltaFromHome === "number") {
        const deg = ((camState.azDeltaFromHome * 180) / Math.PI).toFixed(1);
        recenterCompass.setAttribute("transform", `rotate(${deg} 12 12)`);
      }
    },
    onInteractionPromptChange(promptInfo) {
      activeInteractionPrompt = promptInfo || null;
      if (!interactPromptBtn) return;
      if (!promptInfo || isOgCapture) {
        interactPromptBtn.hidden = true;
        return;
      }
      if (interactKeyEl) {
        interactKeyEl.textContent = promptInfo.keyHint || "E";
      }
      if (interactLabelEl) {
        interactLabelEl.textContent = promptInfo.label || "Interact";
      }
      interactPromptBtn.hidden = false;
      if (engine?.isFirstPerson?.()) {
        hoverCard.hidden = true;
      }
    },
    onLocalEmote(kind) {
      mpClient?.sendEmote(kind);
    },
    onInteriorChange(roomInfo) {
      if (roomInfo) {
        document.body.dataset.inInterior = "1";
        if (uiState === "picking" || uiState === "composing") {
          hideError();
          chosenSpot = null;
          uiState = "idle";
          syncDockUI();
        }
      } else {
        delete document.body.dataset.inInterior;
      }
      hoverCard.hidden = true;
      mpClient?.forcePoseSync();
    },
    onTrafficIncident(incident) {
      void reportTrafficIncidentToObserver(incident);
    },
  },
  { ogMode: isOgCapture },
);

window.__geminIslandCam = () => engine.getCameraState();
window.__geminIslandEngine = engine;

interactPromptBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  engine?.triggerActiveInteraction?.();
  interactPromptBtn.blur();
});

characterBuilder = createCharacterBuilderController({
  dialogEl: avatarDialog,
  onChange(app) {
    engine?.setLocalAppearance?.(app);
    syncAvatarSwatchDot(app);
  },
  onSave(app) {
    engine?.setLocalAppearance?.(app);
    syncAvatarSwatchDot(app);
    mpClient?.sendProfile(app);
  },
});

avatarDialog?.addEventListener("close", () => {
  lastAvatarDialogCloseMs = performance.now();
  avatarBtn?.blur();
  queueMicrotask(() => avatarBtn?.blur());
});

avatarDialog?.querySelector('[data-cb-action="wave"]')?.addEventListener("click", () => {
  engine?.triggerLocalWave?.();
  mpClient?.sendEmote("wave");
});

syncAvatarSwatchDot(engine?.getLocalAppearance?.() || characterBuilder?.getAppearance?.());

avatarBtn?.addEventListener("click", () => {
  if (isOgCapture) return;
  avatarBtn?.blur();
  hoverCard.hidden = true;
  resetWalkJoystick();
  engine?.releaseWalkPointerLock?.();
  characterBuilder?.open(engine?.getLocalAppearance?.());
});

walkEscHintBtn?.addEventListener("click", () => {
  hoverCard.hidden = true;
  engine?.setDragMode("pan");
  walkEscHintBtn.blur();
});

window.__geminIslandCharacterBuilder = characterBuilder;

camPanBtn?.addEventListener("click", () => {
  engine.setDragMode("pan");
});

camOrbitBtn?.addEventListener("click", () => {
  engine.setDragMode("orbit");
});

camWalkBtn?.addEventListener("click", () => {
  hoverCard.hidden = true;
  if (engine.isFirstPerson()) {
    engine.setDragMode("pan");
    return;
  }
  if (uiState === "picking" || uiState === "composing") {
    hideError();
    chosenSpot = null;
    uiState = "idle";
    syncDockUI();
  }
  engine.setDragMode("walk");
  camWalkBtn.blur();
});

recenterBtn?.addEventListener("click", () => {
  engine.recenterCamera();
  engine.setDragMode("pan");
});

window.addEventListener(
  "pointerdown",
  (e) => {
    if (e.pointerType === "touch" && !sawTouchInput) {
      sawTouchInput = true;
      syncWalkJoystickVisibility();
    }
  },
  { passive: true },
);

window.addEventListener("resize", () => {
  syncWalkJoystickVisibility();
  if (walkEscHintBtn) {
    walkEscHintBtn.hidden = isOgCapture || currentCamMode !== "walk" || isMobileWalkViewport();
  }
});

window.addEventListener("blur", () => {
  if (joyPointerId !== null) resetWalkJoystick();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" && joyPointerId !== null) {
    resetWalkJoystick();
  }
});

function updateWalkJoystickFromPoint(clientX, clientY) {
  if (!walkJoystick) return;
  const rect = walkJoystick.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  const maxPx = Math.max(24, rect.width * 0.31);
  const dx = clientX - cx;
  const dy = clientY - cy;
  const dist = Math.hypot(dx, dy);
  const clampedPx = Math.min(maxPx, dist);
  const ux = dist > 1e-4 ? dx / dist : 0;
  const uy = dist > 1e-4 ? dy / dist : 0;

  const maxSvg = 34;
  const svgX = ux * (clampedPx / maxPx) * maxSvg;
  const svgY = uy * (clampedPx / maxPx) * maxSvg;
  walkJoystickKnob?.setAttribute("transform", `translate(${svgX.toFixed(1)} ${svgY.toFixed(1)})`);

  const rawMag = clampedPx / maxPx;
  const deadzone = 0.08;
  const eff = rawMag <= deadzone ? 0 : (rawMag - deadzone) / (1 - deadzone);
  const moveRight = ux * eff;
  const moveFwd = -uy * eff;

  walkJoyUp?.classList.toggle("is-lit", moveFwd > 0.28);
  walkJoyDown?.classList.toggle("is-lit", moveFwd < -0.28);
  walkJoyLeft?.classList.toggle("is-lit", moveRight < -0.28);
  walkJoyRight?.classList.toggle("is-lit", moveRight > 0.28);

  engine?.setJoystickInput(moveRight, moveFwd);
}

if (walkJoystick) {
  walkJoystick.addEventListener("contextmenu", (e) => e.preventDefault());

  walkJoystick.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (joyPointerId !== null) return;
    joyPointerId = e.pointerId;
    walkJoystick.classList.add("is-active");
    hoverCard.hidden = true;
    try {
      walkJoystick.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointer events in tests may omit active capture handles
    }
    updateWalkJoystickFromPoint(e.clientX, e.clientY);
  });

  walkJoystick.addEventListener("pointermove", (e) => {
    if (joyPointerId !== e.pointerId) return;
    e.stopPropagation();
    e.preventDefault();
    updateWalkJoystickFromPoint(e.clientX, e.clientY);
  });

  const endJoystickGesture = (e) => {
    if (joyPointerId !== e.pointerId) return;
    e.stopPropagation();
    resetWalkJoystick();
  };

  walkJoystick.addEventListener("pointerup", endJoystickGesture);
  walkJoystick.addEventListener("pointercancel", endJoystickGesture);
  walkJoystick.addEventListener("lostpointercapture", endJoystickGesture);
}

function syncDockUI() {
  if (isOgCapture) return;

  addBtn.hidden = true;
  pickSpotPill.hidden = true;
  bottomBuilder.hidden = true;
  buildingPill.hidden = true;
  readyGotoBtn.hidden = true;
  locateMineBtn.hidden = true;

  if (myCreationId && uiState !== "ready") {
    uiState = "placed";
  }

  switch (uiState) {
    case "picking":
      pickSpotPill.hidden = false;
      engine.setSpotPickerState({
        mode: "picking",
        ...(chosenSpot ? { x: chosenSpot.x, z: chosenSpot.z } : {}),
      });
      break;
    case "composing":
      bottomBuilder.hidden = false;
      engine.setPreviewPrompt(promptInput.value);
      engine.setSpotPickerState({
        mode: "staked",
        x: chosenSpot?.x ?? 16,
        z: chosenSpot?.z ?? 10,
      });
      break;
    case "building":
      buildingPill.hidden = false;
      renderActiveJobLabel();
      engine.setSpotPickerState({
        mode: "building",
        x: chosenSpot?.x ?? 16,
        z: chosenSpot?.z ?? 10,
      });
      break;
    case "ready": {
      readyGotoBtn.hidden = false;
      const name = readyCreation?.name || "your creation";
      readyGotoLabel.textContent = `Ready · Go to ${name}`;
      engine.setSpotPickerState({ mode: "hidden" });
      break;
    }
    case "placed": {
      locateMineBtn.hidden = false;
      const mine = worldData?.creations?.find((c) => c.id === myCreationId);
      locateMineLabel.textContent = mine ? `Locate · ${mine.name}` : "Locate yours";
      engine.setSpotPickerState({ mode: "hidden" });
      break;
    }
    default:
      addBtn.hidden = false;
      engine.setSpotPickerState({ mode: "hidden" });
      break;
  }
}

async function pollActiveJob() {
  if (!activeJob || jobPollInFlight) return;
  jobPollInFlight = true;
  try {
    const res = await fetch(`/api/job?id=${encodeURIComponent(activeJob.jobId)}`, {
      headers: buildVisitorHeaders(),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.visitorToken) storeVisitorToken(data.visitorToken);
    if (!data.ok || !data.job) return;

    const job = data.job;
    if (job.status === "done") {
      stopJobTracking();
      sculptBtn.disabled = false;
      if (data.world) {
        worldData = data.world;
        engine.applyWorldSnapshot(worldData);
      }
      if (data.feeds) {
        engine.applyLiveFeeds(data.feeds);
      }
      myCreationId = job.creationId || data.world?.myCreationId || myCreationId;
      readyCreation =
        job.creation || worldData?.creations?.find((c) => c.id === myCreationId) || null;
      uiState = "ready";
      syncDockUI();
      return;
    }

    if (job.status === "failed") {
      stopJobTracking();
      sculptBtn.disabled = false;
      if (job.creationId) {
        myCreationId = job.creationId;
        uiState = "placed";
        syncDockUI();
        return;
      }
      uiState = "composing";
      syncDockUI();
      showFormError(job.error || "Could not build that right now — try again.");
      return;
    }

    activeJob = { ...job };
    renderActiveJobLabel();
  } catch {
    // ignore transient poll hiccups; next tick or WS broadcast will recover
  } finally {
    jobPollInFlight = false;
  }
}

function startTrackingJob(jobInfo) {
  stopJobTracking();
  activeJob = { ...jobInfo };
  uiState = "building";
  syncDockUI();

  jobPollInterval = setInterval(() => {
    if (uiState === "building" && activeJob) {
      pollActiveJob();
    }
  }, 2500);
}

// Dynamically resize the 3D staked plot on the island as the visitor describes tiny vs colossal subjects!
promptInput.addEventListener("input", () => {
  engine.setPreviewPrompt(promptInput.value);
});

// 1. Click "+ Add" -> pick where on the island it will go
addBtn.addEventListener("click", () => {
  if (engine.isFirstPerson()) {
    engine.setDragMode("pan");
  }
  if (myCreationId) {
    uiState = "placed";
    syncDockUI();
    return;
  }
  hoverCard.hidden = true;
  engine.setPreviewPrompt(promptInput.value);
  uiState = "picking";
  syncDockUI();
});

cancelPickBtn.addEventListener("click", () => {
  chosenSpot = null;
  uiState = "idle";
  syncDockUI();
});

moveSpotBtn.addEventListener("click", () => {
  uiState = "picking";
  syncDockUI();
});

closeBuilderBtn.addEventListener("click", () => {
  hideError();
  chosenSpot = null;
  uiState = "idle";
  syncDockUI();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (
      characterBuilder?.isOpen?.() ||
      (avatarDialog &&
        (avatarDialog.open || (e.target instanceof Node && avatarDialog.contains(e.target)))) ||
      performance.now() - lastAvatarDialogCloseMs < 80
    ) {
      return;
    }
    if (uiState === "picking" || uiState === "composing") {
      e.preventDefault();
      hideError();
      chosenSpot = null;
      uiState = "idle";
      syncDockUI();
    } else if (engine.isFirstPerson()) {
      e.preventDefault();
      hoverCard.hidden = true;
      engine.setDragMode("pan");
    }
  }
});

worldCanvas.addEventListener("pointerleave", () => {
  hoverCard.hidden = true;
});

readyGotoBtn.addEventListener("click", () => {
  if (!myCreationId) return;
  hoverCard.hidden = true;
  uiState = "placed";
  syncDockUI();
  engine.focusCreationById(myCreationId);
  const mine = worldData?.creations?.find((c) => c.id === myCreationId) || readyCreation;
  if (mine) {
    const desc = mine.description || mine.behavior?.statusLine || "";
    showToast(desc ? `${mine.name} — ${desc}` : mine.name, 4600);
  }
});

locateMineBtn.addEventListener("click", () => {
  if (!myCreationId) return;
  hoverCard.hidden = true;
  engine.focusCreationById(myCreationId);
  const mine = worldData?.creations?.find((c) => c.id === myCreationId);
  if (mine) {
    const desc = mine.description || mine.behavior?.statusLine || "";
    showToast(desc ? `${mine.name} — ${desc}` : mine.name);
  }
});

async function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unsupported image format"));
      img.onload = () => {
        const maxSide = 960;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width >= height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const c = document.createElement("canvas");
        c.width = Math.max(1, width);
        c.height = Math.max(1, height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.86));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.hidden = false;
}

function hideError() {
  formError.hidden = true;
}

async function handleSelectedFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    showFormError("Choose a PNG, JPG, or WebP image.");
    return;
  }
  hideError();
  try {
    selectedImageDataUrl = await resizeImageFile(file);
    dropPreviewImg.src = selectedImageDataUrl;
    dropEmpty.hidden = true;
    dropPreviewWrap.hidden = false;
  } catch (err) {
    showFormError(err.message || "Could not process that image.");
  }
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (file) handleSelectedFile(file);
});

clearImageBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  selectedImageDataUrl = null;
  imageInput.value = "";
  dropPreviewImg.removeAttribute("src");
  dropPreviewWrap.hidden = true;
  dropEmpty.hidden = false;
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleSelectedFile(file);
});

window.addEventListener("paste", (e) => {
  if (uiState !== "composing") return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) handleSelectedFile(f);
      break;
    }
  }
});

// Enqueue build into the multi-user workshop queue -> close builder immediately so visitor can explore while watching live build stages!
sculptBtn.addEventListener("click", async () => {
  if (uiState === "building") return;
  hideError();
  const prompt = promptInput.value.trim();
  if (!prompt && !selectedImageDataUrl) {
    showFormError("Add a photo or short description first.");
    return;
  }

  engine.setPreviewPrompt(prompt);
  const spotX = chosenSpot?.x ?? null;
  const spotZ = chosenSpot?.z ?? null;

  uiState = "building";
  sculptBtn.disabled = true;
  buildingPillLabel.textContent = "Approving query…";
  if (buildingPillSub) {
    buildingPillSub.textContent = "Being built with Gemini 4 Hydrogen";
  }
  syncDockUI();

  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: buildVisitorHeaders({
        "content-type": "application/json",
        "x-meadow-client": "1",
      }),
      body: JSON.stringify({
        prompt,
        imageDataUrl: selectedImageDataUrl || undefined,
        x: spotX,
        z: spotZ,
      }),
    });
    const data = await res.json();
    if (data?.visitorToken) storeVisitorToken(data.visitorToken);

    if (!res.ok || !data.ok) {
      sculptBtn.disabled = false;
      if (data.alreadyPlaced && data.myCreationId) {
        myCreationId = data.myCreationId;
        uiState = "placed";
        syncDockUI();
        return;
      }
      uiState = "composing";
      syncDockUI();
      showFormError(data.error || "Could not build that right now — try again.");
      return;
    }

    if (data.job) {
      startTrackingJob(data.job);
      return;
    }

    // Direct synchronous fallback if ever returned
    sculptBtn.disabled = false;
    worldData = data.world;
    myCreationId = data.creation.id;
    readyCreation = data.creation;
    if (data.feeds) engine.applyLiveFeeds(data.feeds);
    engine.applyWorldSnapshot(worldData);
    uiState = "ready";
    syncDockUI();
  } catch {
    sculptBtn.disabled = false;
    uiState = "composing";
    syncDockUI();
    showFormError("Network hiccup while building — try again.");
  }
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sculptBtn.click();
  }
});

async function refreshLiveFeeds() {
  try {
    const res = await fetch("/api/feeds");
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.feeds) {
      engine.applyLiveFeeds(data.feeds);
    }
  } catch {
    // ignore transient feed errors
  }
}

async function refreshDailyEligibility() {
  if (isOgCapture || uiState === "building" || uiState === "ready") return;
  try {
    const res = await fetch("/api/world", {
      headers: buildVisitorHeaders(),
    });
    if (!res.ok) return;
    const latest = await res.json();
    if (latest?.visitorToken) storeVisitorToken(latest.visitorToken);
    worldData = latest;
    myCreationId = latest.myCreationId || null;
    engine.applyWorldSnapshot(worldData);
    if (latest.myActiveJob && !myCreationId) {
      startTrackingJob(latest.myActiveJob);
    } else if (!myCreationId && uiState === "placed") {
      uiState = "idle";
      syncDockUI();
    }
  } catch {
    // ignore transient network errors
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (uiState === "building" && activeJob) {
      pollActiveJob();
    } else {
      refreshDailyEligibility();
    }
  }
});

function handleWorldMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "queue_tick" && activeJob && uiState === "building") {
    const qIdx = Array.isArray(msg.queuedIds) ? msg.queuedIds.indexOf(activeJob.jobId) : -1;
    const activeEntry = Array.isArray(msg.sculpting)
      ? msg.sculpting.find((s) => s.jobId === activeJob.jobId)
      : null;
    if (qIdx >= 0) {
      activeJob.status = "queued";
      activeJob.phase = "queued";
      activeJob.position = qIdx + 1;
      renderActiveJobLabel();
    } else if (activeEntry) {
      activeJob.status = "sculpting";
      if (activeEntry.phase) {
        activeJob.phase = activeEntry.phase;
      } else if (activeJob.phase === "queued") {
        activeJob.phase = "sculpting";
      }
      activeJob.position = 0;
      renderActiveJobLabel();
    }
    pollActiveJob();
    return;
  }

  if ((msg.type === "creation_placed" || msg.type === "world_updated") && msg.world) {
    worldData = {
      ...msg.world,
      myCreationId,
    };
    engine.applyWorldSnapshot(worldData);
    if (uiState === "building" && activeJob) {
      pollActiveJob();
    } else if (uiState === "placed" || uiState === "ready") {
      syncDockUI();
    }
    refreshLiveFeeds();

    if (
      msg.type === "creation_placed" &&
      msg.creation &&
      msg.creation.id !== myCreationId &&
      uiState !== "building"
    ) {
      showToast(`Someone added "${msg.creation.name}" to GeminIsland!`, 4200);
    }
  }
}

if (!isOgCapture) {
  mpClient = createMultiplayerClient({
    multiplayerEnabled: !isOgCapture,
    getLocalPose: () => engine?.getLocalMultiplayerPose?.(),
    getLocalProfile: () => engine?.getLocalAppearance?.(),
    getExtraHeaders: () => buildVisitorHeaders(),
    onWorldMessage: handleWorldMessage,
    onWelcome(msg) {
      engine?.syncMultiplayerWelcome?.(msg?.players || []);
      if (typeof msg?.onlineCount === "number") {
        updateOnlinePill(msg.onlineCount);
      }
    },
    onPeerJoin(player, msg) {
      engine?.upsertRemotePlayer?.(player);
      if (typeof msg?.onlineCount === "number") {
        updateOnlinePill(msg.onlineCount);
      }
    },
    onPeerPose(poseMsg) {
      engine?.updateRemotePlayerPose?.(poseMsg);
    },
    onPeerProfile(profileMsg) {
      engine?.updateRemotePlayerProfile?.(profileMsg);
    },
    onPeerEmote(emoteMsg) {
      engine?.triggerRemotePlayerEmote?.(emoteMsg);
    },
    onPeerLeave(id, msg) {
      engine?.removeRemotePlayer?.(id);
      if (typeof msg?.onlineCount === "number") {
        updateOnlinePill(msg.onlineCount);
      }
    },
    onOnlineCountChange(count) {
      updateOnlinePill(count);
    },
  });
}

window.__geminIslandMp = mpClient;

async function initWorld() {
  try {
    const res = await fetch("/api/world", {
      headers: buildVisitorHeaders(),
    });
    if (res.ok) {
      worldData = await res.json();
      if (worldData?.visitorToken) storeVisitorToken(worldData.visitorToken);
      myCreationId = worldData.myCreationId || myCreationId || null;
      engine.applyWorldSnapshot(worldData);
      if (!isOgCapture) {
        if (myCreationId) {
          uiState = "placed";
          syncDockUI();
        } else if (worldData.myActiveJob) {
          startTrackingJob(worldData.myActiveJob);
        } else {
          uiState = "idle";
          syncDockUI();
        }
      }
    }
  } catch (err) {
    console.error("Failed to fetch initial world:", err);
  }

  refreshLiveFeeds();
  if (!isOgCapture) {
    setInterval(refreshLiveFeeds, 90_000);
    setInterval(refreshDailyEligibility, 10 * 60_000);
  }
}

initWorld();

// GitHub Modal & Auto-APK Upload Client Logic
const githubBtn = document.getElementById("github-btn");
const githubModal = document.getElementById("github-modal");
const githubModalCloseBtn = document.getElementById("github-modal-close-btn");
const githubZipDownloadBtn = document.getElementById("github-zip-download-btn");
const githubSubmitBtn = document.getElementById("github-submit-btn");
const githubTokenInput = document.getElementById("github-token-input");
const githubRepoInput = document.getElementById("github-repo-input");
const githubAppNameInput = document.getElementById("github-appname-input");
const githubAppIdInput = document.getElementById("github-appid-input");
const githubServerUrlInput = document.getElementById("github-serverurl-input");
const githubDescInput = document.getElementById("github-desc-input");
const githubApkInput = document.getElementById("github-apk-input");
const githubPrivateInput = document.getElementById("github-private-input");
const githubStatusMsg = document.getElementById("github-status-msg");
const githubApkTracker = document.getElementById("github-apk-tracker");

let apkPollTimer = null;

function stopApkPolling() {
  if (apkPollTimer) {
    clearInterval(apkPollTimer);
    apkPollTimer = null;
  }
}

function createSafeLink(href, text, className = "github-apk-link") {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = text;
  if (className) a.className = className;
  return a;
}

function renderApkTracker({ text, runUrl, apkDownloadUrl, releaseUrl }) {
  if (!githubApkTracker) return;
  githubApkTracker.innerHTML = "";
  githubApkTracker.hidden = false;

  const statusLine = document.createElement("div");
  statusLine.textContent = text;
  githubApkTracker.appendChild(statusLine);

  const row = document.createElement("div");
  row.className = "github-apk-tracker-row";

  if (apkDownloadUrl) {
    row.appendChild(createSafeLink(apkDownloadUrl, "⬇️ دانلود مستقیم فایل APK", "github-apk-download-btn"));
  }
  if (releaseUrl) {
    row.appendChild(createSafeLink(releaseUrl, "صفحه Releases گیت‌هاب"));
  } else if (runUrl) {
    row.appendChild(createSafeLink(runUrl, "مشاهده لاگ ساخت در GitHub Actions"));
  }

  if (row.childNodes.length > 0) {
    githubApkTracker.appendChild(row);
  }
}

function startApkPolling({ token, owner, repoName, actionsUrl, releasesUrl }) {
  stopApkPolling();
  let ticks = 0;

  renderApkTracker({
    text: "⏳ گیت‌هاب اکشن فعال شد؛ در حال آماده‌سازی محیط ساخت APK...",
    runUrl: actionsUrl,
  });

  const pollOnce = async () => {
    ticks++;
    if (ticks > 90) {
      stopApkPolling();
      renderApkTracker({
        text: "زمان بررسی خودکار به پایان رسید. وضعیت ساخت را در گیت‌هاب مشاهده کنید:",
        runUrl: actionsUrl,
        releaseUrl: releasesUrl,
      });
      return;
    }

    try {
      const res = await fetch("/api/github/workflow-status", {
        method: "POST",
        headers: buildVisitorHeaders({
          "content-type": "application/json",
          "x-meadow-client": "1",
        }),
        body: JSON.stringify({ token, owner, repoName }),
      });
      if (!res.ok) return;
      const st = await res.json();
      if (!st.ok) return;

      if (st.status === "waiting" || st.status === "queued") {
        renderApkTracker({
          text: "⏳ در صف اجرای GitHub Actions برای تبدیل به APK...",
          runUrl: st.runUrl || actionsUrl,
        });
      } else if (st.status === "in_progress") {
        renderApkTracker({
          text: "⚙️ در حال بیلد و تبدیل پروژه به فایل APK اندروید (حدود ۲ تا ۴ دقیقه)...",
          runUrl: st.runUrl || actionsUrl,
        });
      } else if (st.status === "completed") {
        stopApkPolling();
        if (st.conclusion === "success") {
          renderApkTracker({
            text: "✅ فایل APK با موفقیت ساخته شد و آماده دانلود است!",
            runUrl: st.runUrl || actionsUrl,
            apkDownloadUrl: st.apkDownloadUrl,
            releaseUrl: st.releaseUrl || releasesUrl,
          });
          showToast("فایل APK در گیت‌هاب آماده دانلود شد!", 6000);
        } else {
          renderApkTracker({
            text: `❌ ساخت APK با وضعیت (${st.conclusion || "failed"}) متوقف شد. جزئیات را در Actions ببینید:`,
            runUrl: st.runUrl || actionsUrl,
          });
        }
      }
    } catch {
      // ignore transient network errors while polling
    }
  };

  setTimeout(pollOnce, 3000);
  apkPollTimer = setInterval(pollOnce, 6000);
}

if (githubBtn && githubModal) {
  githubBtn.addEventListener("click", () => {
    githubModal.hidden = false;
    if (githubServerUrlInput && !githubServerUrlInput.value && window.location.origin.startsWith("http")) {
      githubServerUrlInput.value = window.location.origin;
    }
    if (githubStatusMsg) {
      githubStatusMsg.hidden = true;
      githubStatusMsg.textContent = "";
      githubStatusMsg.className = "github-status-msg";
    }
    if (githubApkTracker && !apkPollTimer) {
      githubApkTracker.hidden = true;
      githubApkTracker.innerHTML = "";
    }
  });
}

if (githubModalCloseBtn && githubModal) {
  const closeGithubModal = () => {
    githubModal.hidden = true;
    stopApkPolling();
  };
  githubModalCloseBtn.addEventListener("click", closeGithubModal);
  githubModal.addEventListener("click", (e) => {
    if (e.target === githubModal) {
      closeGithubModal();
    }
  });
}

if (githubZipDownloadBtn) {
  githubZipDownloadBtn.addEventListener("click", () => {
    window.location.href = "/api/github/zip";
  });
}

if (githubSubmitBtn) {
  githubSubmitBtn.addEventListener("click", async () => {
    stopApkPolling();
    const token = githubTokenInput?.value?.trim() || "";
    const repoName = githubRepoInput?.value?.trim() || "geminisland-app";
    const appName = githubAppNameInput?.value?.trim() || "GeminIsland";
    const appId = githubAppIdInput?.value?.trim() || "com.geminisland.app";
    const serverUrl = githubServerUrlInput?.value?.trim() || "";
    const description = githubDescInput?.value?.trim() || "";
    const buildApk = githubApkInput ? Boolean(githubApkInput.checked) : true;
    const isPrivate = Boolean(githubPrivateInput?.checked);

    if (!token) {
      if (githubStatusMsg) {
        githubStatusMsg.textContent = "لطفاً توکن دسترسی شخصی گیت‌هاب (GitHub PAT) را وارد کنید.";
        githubStatusMsg.className = "github-status-msg is-error";
        githubStatusMsg.hidden = false;
      }
      return;
    }

    if (!repoName) {
      if (githubStatusMsg) {
        githubStatusMsg.textContent = "لطفاً نام ریپازیتوری را وارد کنید.";
        githubStatusMsg.className = "github-status-msg is-error";
        githubStatusMsg.hidden = false;
      }
      return;
    }

    if (githubApkTracker) {
      githubApkTracker.hidden = true;
      githubApkTracker.innerHTML = "";
    }
    if (githubStatusMsg) {
      githubStatusMsg.textContent = "در حال ایجاد ریپازیتوری و آپلود یکپارچه پروژه به گیت‌هاب...";
      githubStatusMsg.className = "github-status-msg is-loading";
      githubStatusMsg.hidden = false;
    }
    githubSubmitBtn.disabled = true;

    try {
      const res = await fetch("/api/github/upload", {
        method: "POST",
        headers: buildVisitorHeaders({
          "content-type": "application/json",
          "x-meadow-client": "1",
        }),
        body: JSON.stringify({
          token,
          repoName,
          description,
          isPrivate,
          buildApk,
          appName,
          appId,
          serverUrl,
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        if (githubStatusMsg) {
          githubStatusMsg.innerHTML = "";
          const summary = document.createElement("div");
          summary.textContent = `موفقیت‌آمیز! ${data.uploadedCount} فایل در یک کامیت به ریپازیتوری آپلود شد.`;
          githubStatusMsg.appendChild(summary);
          if (data.repoUrl) {
            githubStatusMsg.appendChild(createSafeLink(data.repoUrl, `مشاهده ریپازیتوری: ${data.fullName || repoName}`));
          }
          githubStatusMsg.className = "github-status-msg is-success";
          githubStatusMsg.hidden = false;
        }
        showToast("پروژه با موفقیت در گیت‌هاب آپلود شد!", 5000);

        if (data.buildApk && data.owner && data.repoName) {
          startApkPolling({
            token,
            owner: data.owner,
            repoName: data.repoName,
            actionsUrl: data.actionsUrl,
            releasesUrl: data.releasesUrl,
          });
        }
      } else {
        throw new Error(data.error || "خطا در آپلود به گیت‌هاب");
      }
    } catch (err) {
      if (githubStatusMsg) {
        githubStatusMsg.textContent = err.message || "خطای ارتباط با سرور.";
        githubStatusMsg.className = "github-status-msg is-error";
        githubStatusMsg.hidden = false;
      }
    } finally {
      githubSubmitBtn.disabled = false;
    }
  });
}
