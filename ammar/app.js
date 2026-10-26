const PASSCODE = "2005/10/27";
const TOTAL_BRANCHES = 10;
const SLOTS_PER_BRANCH = 27;
const PAGES = ["songs", "poems", "images"];

// State
let currentPage = "songs";
let currentBranch = null; // null = full tree view, 1..10 = focused branch view
let activeSlot = null; // 1..27
let memoryStore = {
  songs: {},
  poems: {},
  images: {}
};
let pendingImageDataUrl = "";
let pendingAudioDataUrl = "";
let pendingAudioName = "";

// Firebase state
let fbDatabase = null;
let fbFirestore = null;
let fbMode = null; // 'rtdb' | 'firestore' | null
let rtdbMod = null;
let fsMod = null;

// Exact coordinates (% of tree container) matching the 10 spreading branches of cherry-tree.jpg
const BRANCH_COORDS = [
  { id: 1, x: 24, y: 56 },
  { id: 2, x: 18, y: 40 },
  { id: 3, x: 28, y: 27 },
  { id: 4, x: 39, y: 18 },
  { id: 5, x: 50, y: 14 },
  { id: 6, x: 62, y: 18 },
  { id: 7, x: 73, y: 27 },
  { id: 8, x: 82, y: 40 },
  { id: 9, x: 76, y: 56 },
  { id: 10, x: 50, y: 44 }
];

// Coordinates (% of branch stage) for the 27 slots along a single realistic branch
const SLOT_COORDS = generate27SlotCoords();

function generate27SlotCoords() {
  const coords = [];
  // 3 organic tiers along the sweeping branch structure (9 blossoms per tier = 27 slots)
  for (let i = 0; i < 27; i++) {
    const t = i / 26; // 0 to 1 left-to-right
    const row = i % 3; // 0: upper sub-branch, 1: main limb, 2: lower sub-branch
    const baseX = 7 + t * 86;
    const archY = 50 - Math.sin(t * Math.PI) * 14 + Math.cos(t * Math.PI * 2.5) * 4;
    let offsetY = 0;
    if (row === 0) offsetY = -22 - (i % 2) * 5;
    if (row === 1) offsetY = (i % 2 === 0 ? -4 : 5);
    if (row === 2) offsetY = 22 + (i % 2) * 5;
    coords.push({
      slot: i + 1,
      x: Math.max(5, Math.min(95, baseX)),
      y: Math.max(10, Math.min(90, archY + offsetY))
    });
  }
  return coords;
}

function slotKey(branch, slot) {
  return `b${branch}_s${slot}`;
}

// ==========================================
// 1. PASSWORD PROTECTION (2005/10/27)
// ==========================================
const lockScreen = document.getElementById("lock-screen");
const appEl = document.getElementById("app");
const passwordForm = document.getElementById("password-form");
const passwordInput = document.getElementById("password-input");

function isCorrectPasscode(val) {
  const cleaned = (val || "").trim().replace(/[-.\s]/g, "/");
  return cleaned === PASSCODE;
}

function unlockSite() {
  try {
    sessionStorage.setItem("cherry_tree_unlocked", "1");
  } catch (e) {}
  lockScreen.style.opacity = "0";
  setTimeout(() => {
    lockScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    resizeAllCanvases();
  }, 350);
}

try {
  if (sessionStorage.getItem("cherry_tree_unlocked") === "1") {
    lockScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
  }
} catch (e) {}

["input", "keyup", "change"].forEach((evtName) => {
  passwordInput.addEventListener(evtName, () => {
    if (isCorrectPasscode(passwordInput.value)) {
      unlockSite();
    }
  });
});

passwordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (isCorrectPasscode(passwordInput.value)) {
    unlockSite();
  } else {
    passwordInput.classList.remove("shake");
    void passwordInput.offsetWidth;
    passwordInput.classList.add("shake");
    passwordInput.value = "";
  }
});

// ==========================================
// 2. LOCAL BACKUP + FIREBASE CLOUD SYNC
// ==========================================
function loadLocalBackup() {
  try {
    const raw = localStorage.getItem("cherry_tree_cache_v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      PAGES.forEach((p) => {
        if (parsed[p]) memoryStore[p] = parsed[p];
      });
    }
  } catch (e) {
    // ignore storage errors
  }
}

function saveLocalBackup() {
  try {
    localStorage.setItem("cherry_tree_cache_v1", JSON.stringify(memoryStore));
  } catch (e) {
    // ignore quota errors
  }
}

function getEffectiveFirebaseConfig() {
  if (
    window.FIREBASE_CONFIG &&
    (window.FIREBASE_CONFIG.apiKey ||
      window.FIREBASE_CONFIG.databaseURL ||
      window.FIREBASE_CONFIG.projectId)
  ) {
    return window.FIREBASE_CONFIG;
  }
  try {
    const saved = localStorage.getItem("cherry_tree_firebase_config");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && (parsed.apiKey || parsed.databaseURL || parsed.projectId)) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

async function initFirebase() {
  const cfg = getEffectiveFirebaseConfig();
  const syncDot = document.getElementById("sync-dot");
  if (!cfg || typeof window.firebase === "undefined") {
    syncDot.classList.remove("connected");
    return;
  }

  try {
    if (!cfg.databaseURL && cfg.projectId) {
      cfg.databaseURL = `https://${cfg.projectId}-default-rtdb.firebaseio.com`;
    }

    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(cfg);
    }

    // 1. Connect Realtime Database listener (if enabled in Firebase project)
    if (window.firebase.database && cfg.databaseURL) {
      try {
        fbDatabase = window.firebase.database();
        fbDatabase.ref("cherryTree").on(
          "value",
          (snapshot) => {
            const val = snapshot.val();
            if (val) {
              PAGES.forEach((p) => {
                memoryStore[p] = { ...(memoryStore[p] || {}), ...(val[p] || {}) };
              });
              saveLocalBackup();
              refreshUI();
            }
            syncDot.classList.add("connected");
          },
          () => {
            // Realtime DB not enabled or rules locked; Firestore below will handle it
          }
        );
      } catch (e) {}
    }

    // 2. Connect Cloud Firestore listener (if enabled in Firebase project)
    if (window.firebase.firestore && cfg.projectId) {
      try {
        fbFirestore = window.firebase.firestore();
        PAGES.forEach((pageName) => {
          fbFirestore.collection(`cherryTree_${pageName}`).onSnapshot(
            (snap) => {
              snap.docChanges().forEach(async (change) => {
                if (change.type === "removed") {
                  delete memoryStore[pageName][change.doc.id];
                } else {
                  const docData = change.doc.data();
                  if (docData.chunkCount && docData.chunkCount > 0) {
                    const chunkSnaps = await fbFirestore
                      .collection(`cherryTree_chunks`)
                      .where("parentKey", "==", `${pageName}_${change.doc.id}`)
                      .get();
                    const sorted = [];
                    chunkSnaps.forEach((cs) => sorted.push(cs.data()));
                    sorted.sort((a, b) => a.index - b.index);
                    docData.audioData = sorted.map((c) => c.data).join("");
                  }
                  memoryStore[pageName][change.doc.id] = docData;
                }
                saveLocalBackup();
                refreshUI();
              });
              syncDot.classList.add("connected");
            },
            () => {
              // Firestore not enabled; Realtime DB above will handle it
            }
          );
        });
      } catch (e) {}
    }
  } catch (err) {
    console.warn("Firebase connection error:", err);
    syncDot.classList.remove("connected");
  }
}

async function persistSlotToCloud(page, branch, slot, dataOrNull) {
  const key = slotKey(branch, slot);
  if (dataOrNull === null) {
    delete memoryStore[page][key];
  } else {
    memoryStore[page][key] = dataOrNull;
  }
  saveLocalBackup();
  refreshUI();

  if (fbDatabase) {
    try {
      const itemRef = fbDatabase.ref(`cherryTree/${page}/${key}`);
      if (dataOrNull === null) {
        await itemRef.remove();
      } else {
        await itemRef.set(dataOrNull);
      }
    } catch (e) {}
  }

  if (fbFirestore) {
    try {
      const docRef = fbFirestore.collection(`cherryTree_${page}`).doc(key);
      if (dataOrNull === null) {
        await docRef.delete();
      } else {
        const copy = { ...dataOrNull };
        const CHUNK_SIZE = 700000;
        if (copy.audioData && copy.audioData.length > CHUNK_SIZE) {
          const fullAudio = copy.audioData;
          copy.audioData = "";
          const totalChunks = Math.ceil(fullAudio.length / CHUNK_SIZE);
          copy.chunkCount = totalChunks;
          for (let i = 0; i < totalChunks; i++) {
            await fbFirestore
              .collection("cherryTree_chunks")
              .doc(`${page}_${key}_${i}`)
              .set({
                parentKey: `${page}_${key}`,
                index: i,
                data: fullAudio.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
              });
          }
        }
        await docRef.set(copy);
      }
    } catch (e) {}
  }
}

// ==========================================
// 3. NAVIGATION & TREE / BRANCH UI
// ==========================================
const branchBar = document.getElementById("branch-bar");
const branchHotspots = document.getElementById("branch-hotspots");
const treeView = document.getElementById("tree-view");
const branchView = document.getElementById("branch-view");
const slotsGrid = document.getElementById("slots-grid");
const branchLabel = document.getElementById("branch-label");

function buildBranchNavigation() {
  branchBar.innerHTML = "";
  branchHotspots.innerHTML = "";

  for (let b = 1; b <= TOTAL_BRANCHES; b++) {
    // Top bar pill
    const pill = document.createElement("button");
    pill.className = "branch-pill";
    pill.dataset.branch = b;
    pill.textContent = b;
    pill.addEventListener("click", () => openBranch(b));
    branchBar.appendChild(pill);

    // Tree hotspot node
    const coord = BRANCH_COORDS[b - 1];
    const node = document.createElement("button");
    node.className = "branch-node";
    node.dataset.branch = b;
    node.style.left = `${coord.x}%`;
    node.style.top = `${coord.y}%`;
    node.style.animationDelay = `${(b - 1) * 0.28}s`;
    node.innerHTML = `<span>${b}</span><span class="count-badge hidden">0</span>`;
    node.addEventListener("click", () => openBranch(b));
    branchHotspots.appendChild(node);
  }
}

function buildSlotsGrid() {
  slotsGrid.innerHTML = "";
  SLOT_COORDS.forEach(({ slot, x, y }) => {
    const btn = document.createElement("button");
    btn.className = "slot-blossom";
    btn.dataset.slot = slot;
    btn.style.left = `${x}%`;
    btn.style.top = `${y}%`;
    btn.innerHTML = `<span class="slot-num">${slot}</span>`;
    btn.addEventListener("click", () => openSlotModal(slot));
    slotsGrid.appendChild(btn);
  });
}

function openBranch(branchNum) {
  currentBranch = branchNum;
  branchLabel.textContent = branchNum;
  treeView.classList.add("hidden");
  branchView.classList.remove("hidden");
  refreshUI();
  drawSingleBranchCanvas();
}

function showFullTree() {
  currentBranch = null;
  branchView.classList.add("hidden");
  treeView.classList.remove("hidden");
  refreshUI();
}

document.getElementById("back-to-tree").addEventListener("click", showFullTree);
document.getElementById("home-tree-btn").addEventListener("click", showFullTree);

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPage = btn.dataset.page;
    refreshUI();
    if (currentBranch !== null) {
      drawSingleBranchCanvas();
    }
  });
});

function countBranchFilled(page, branch) {
  let count = 0;
  const pageData = memoryStore[page] || {};
  for (let s = 1; s <= SLOTS_PER_BRANCH; s++) {
    if (pageData[slotKey(branch, s)]) count++;
  }
  return count;
}

function refreshUI() {
  // Update branch pills & hotspots
  document.querySelectorAll(".branch-pill").forEach((pill) => {
    const b = Number(pill.dataset.branch);
    const count = countBranchFilled(currentPage, b);
    pill.classList.toggle("active", currentBranch === b);
    pill.classList.toggle("has-items", count > 0);
  });

  document.querySelectorAll(".branch-node").forEach((node) => {
    const b = Number(node.dataset.branch);
    const count = countBranchFilled(currentPage, b);
    const badge = node.querySelector(".count-badge");
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  });

  // Update 27 slots if in branch view
  if (currentBranch !== null) {
    const pageData = memoryStore[currentPage] || {};
    document.querySelectorAll(".slot-blossom").forEach((btn) => {
      const s = Number(btn.dataset.slot);
      const item = pageData[slotKey(currentBranch, s)];
      btn.classList.toggle("filled", Boolean(item));
      if (currentPage === "images" && item && item.imageData) {
        btn.innerHTML = `<img class="slot-thumb" src="${item.imageData}" alt="" /><span class="slot-num">${s}</span>`;
      } else {
        btn.innerHTML = `<span class="slot-num">${s}</span>`;
      }
    });
    drawSingleBranchCanvas();
  }
}

// ==========================================
// 4. SLOT MODAL (SONGS, POEMS, IMAGES)
// ==========================================
const slotModal = document.getElementById("slot-modal");
const modalSlotId = document.getElementById("modal-slot-id");
const modalSongs = document.getElementById("modal-songs");
const modalPoems = document.getElementById("modal-poems");
const modalImages = document.getElementById("modal-images");
const deleteSlotBtn = document.getElementById("delete-slot-btn");

// Inputs
const songTitleInput = document.getElementById("song-title-input");
const songUrlInput = document.getElementById("song-url-input");
const songFileInput = document.getElementById("song-file-input");
const songFileLabel = document.getElementById("song-file-label");
const songPlayerArea = document.getElementById("song-player-area");

const poemTitleInput = document.getElementById("poem-title-input");
const poemTextInput = document.getElementById("poem-text-input");

const imageFileInput = document.getElementById("image-file-input");
const imageCaptionInput = document.getElementById("image-caption-input");
const imagePreviewArea = document.getElementById("image-preview-area");
const slotImagePreview = document.getElementById("slot-image-preview");

function extractYouTubeEmbedUrl(url) {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regExp);
  if (match && match[1]) {
    return `https://www.youtube.com/embed/${match[1]}?rel=0`;
  }
  return null;
}

function renderSongPlayer(url, audioData) {
  songPlayerArea.innerHTML = "";
  const ytEmbed = extractYouTubeEmbedUrl(url);
  if (ytEmbed) {
    songPlayerArea.classList.remove("hidden");
    const iframe = document.createElement("iframe");
    iframe.src = ytEmbed;
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
    iframe.allowFullscreen = true;
    songPlayerArea.appendChild(iframe);
  } else if (audioData || (url && url.startsWith("http"))) {
    songPlayerArea.classList.remove("hidden");
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = audioData || url;
    songPlayerArea.appendChild(audio);
  } else {
    songPlayerArea.classList.add("hidden");
  }
}

function openSlotModal(slotNum) {
  activeSlot = slotNum;
  modalSlotId.textContent = `${currentBranch} · ${slotNum}`;

  modalSongs.classList.add("hidden");
  modalPoems.classList.add("hidden");
  modalImages.classList.add("hidden");

  const existing = (memoryStore[currentPage] || {})[slotKey(currentBranch, slotNum)];
  deleteSlotBtn.classList.toggle("hidden", !existing);

  pendingImageDataUrl = "";
  pendingAudioDataUrl = "";
  pendingAudioName = "";

  if (currentPage === "songs") {
    modalSongs.classList.remove("hidden");
    songTitleInput.value = existing?.title || "";
    songUrlInput.value = existing?.url || "";
    pendingAudioDataUrl = existing?.audioData || "";
    pendingAudioName = existing?.audioName || "";
    songFileLabel.textContent = pendingAudioName || "mp3";
    songFileInput.value = "";
    renderSongPlayer(existing?.url || "", existing?.audioData || "");
  } else if (currentPage === "poems") {
    modalPoems.classList.remove("hidden");
    poemTitleInput.value = existing?.title || "";
    poemTextInput.value = existing?.text || "";
  } else if (currentPage === "images") {
    modalImages.classList.remove("hidden");
    imageCaptionInput.value = existing?.caption || "";
    pendingImageDataUrl = existing?.imageData || "";
    imageFileInput.value = "";
    if (pendingImageDataUrl) {
      slotImagePreview.src = pendingImageDataUrl;
      imagePreviewArea.classList.remove("hidden");
    } else {
      slotImagePreview.src = "";
      imagePreviewArea.classList.add("hidden");
    }
  }

  slotModal.classList.remove("hidden");
}

function closeSlotModal() {
  songPlayerArea.innerHTML = "";
  slotModal.classList.add("hidden");
  activeSlot = null;
}

document.getElementById("close-modal").addEventListener("click", closeSlotModal);
document.getElementById("modal-backdrop").addEventListener("click", closeSlotModal);

songUrlInput.addEventListener("input", () => {
  renderSongPlayer(songUrlInput.value.trim(), pendingAudioDataUrl);
});

// Handle MP3 / Audio file from device
songFileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  pendingAudioName = file.name;
  songFileLabel.textContent = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    pendingAudioDataUrl = reader.result;
    renderSongPlayer(songUrlInput.value.trim(), pendingAudioDataUrl);
  };
  reader.readAsDataURL(file);
});

// Handle Image file straight from phone storage (compressed on Canvas for cloud database)
imageFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const compressed = await compressImageFile(file, 1080, 0.78);
  pendingImageDataUrl = compressed;
  slotImagePreview.src = compressed;
  imagePreviewArea.classList.remove("hidden");
});

function compressImageFile(file, maxDim = 1080, quality = 0.78) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        let dataUrl = c.toDataURL("image/webp", quality);
        if (dataUrl.length > 750000) {
          dataUrl = c.toDataURL("image/jpeg", 0.62);
        }
        resolve(dataUrl);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// Save Slot
document.getElementById("save-slot-btn").addEventListener("click", async () => {
  if (!currentBranch || !activeSlot) return;

  let payload = null;
  if (currentPage === "songs") {
    const title = songTitleInput.value.trim();
    const url = songUrlInput.value.trim();
    if (!title && !url && !pendingAudioDataUrl) {
      closeSlotModal();
      return;
    }
    payload = {
      title,
      url,
      audioData: pendingAudioDataUrl || "",
      audioName: pendingAudioName || "",
      updatedAt: Date.now()
    };
  } else if (currentPage === "poems") {
    const title = poemTitleInput.value.trim();
    const text = poemTextInput.value.trim();
    if (!title && !text) {
      closeSlotModal();
      return;
    }
    payload = {
      title,
      text,
      updatedAt: Date.now()
    };
  } else if (currentPage === "images") {
    const caption = imageCaptionInput.value.trim();
    if (!pendingImageDataUrl && !caption) {
      closeSlotModal();
      return;
    }
    payload = {
      imageData: pendingImageDataUrl,
      caption,
      updatedAt: Date.now()
    };
  }

  await persistSlotToCloud(currentPage, currentBranch, activeSlot, payload);
  closeSlotModal();
});

// Delete Slot
deleteSlotBtn.addEventListener("click", async () => {
  if (!currentBranch || !activeSlot) return;
  await persistSlotToCloud(currentPage, currentBranch, activeSlot, null);
  closeSlotModal();
});

// ==========================================
// 5. FIREBASE CONFIG MODAL
// ==========================================
const firebaseModal = document.getElementById("firebase-modal");
const firebaseJsonInput = document.getElementById("firebase-json-input");

document.getElementById("firebase-btn").addEventListener("click", () => {
  const currentCfg = getEffectiveFirebaseConfig();
  firebaseJsonInput.value = currentCfg ? JSON.stringify(currentCfg, null, 2) : "";
  firebaseModal.classList.remove("hidden");
});

function closeFirebaseModal() {
  firebaseModal.classList.add("hidden");
}

document.getElementById("close-firebase-modal").addEventListener("click", closeFirebaseModal);
document.getElementById("firebase-backdrop").addEventListener("click", closeFirebaseModal);

document.getElementById("save-firebase-btn").addEventListener("click", () => {
  const raw = firebaseJsonInput.value.trim();
  if (!raw) {
    localStorage.removeItem("cherry_tree_firebase_config");
    closeFirebaseModal();
    return;
  }
  try {
    // Allow pasting either pure JSON or JS object snippet from Firebase Console
    const normalized = raw
      .replace(/^[^{]*({[\s\S]*})[^}]*$/, "$1")
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":')
      .replace(/'/g, '"')
      .replace(/,\s*}/g, "}");
    const parsed = JSON.parse(normalized);
    localStorage.setItem("cherry_tree_firebase_config", JSON.stringify(parsed));
    closeFirebaseModal();
    window.location.reload();
  } catch (err) {
    firebaseJsonInput.style.borderColor = "#e598ad";
  }
});

// ==========================================
// 6. ULTRA-REALISTIC CHERRY TREE & BRANCH RENDERER
// ==========================================
const treeCanvas = document.getElementById("tree-canvas");
const treeCtx = treeCanvas.getContext("2d");
const singleBranchCanvas = document.getElementById("single-branch-canvas");
const sbCtx = singleBranchCanvas.getContext("2d");

const treeImg = new Image();
let treeImgLoaded = false;
let maskedTreeCanvas = null;

treeImg.onload = () => {
  treeImgLoaded = true;
  maskedTreeCanvas = createSoftFeatheredTree(treeImg);
};
treeImg.src = "assets/cherry-tree.jpg";

function createSoftFeatheredTree(img) {
  const off = document.createElement("canvas");
  off.width = 1400;
  off.height = 1100;
  const octx = off.getContext("2d");

  // Draw the high-res realistic cherry tree image
  octx.drawImage(img, 0, 0, off.width, off.height);

  // Soft pastel color-grading tint so it harmonizes with low-contrast baby pink & sky blue
  octx.globalCompositeOperation = "soft-light";
  const tint = octx.createLinearGradient(0, 0, 0, off.height);
  tint.addColorStop(0, "rgba(202, 232, 249, 0.35)");
  tint.addColorStop(0.6, "rgba(249, 212, 224, 0.35)");
  tint.addColorStop(1, "rgba(244, 198, 210, 0.4)");
  octx.fillStyle = tint;
  octx.fillRect(0, 0, off.width, off.height);

  // Soft radial edge feather mask so the tree floats seamlessly in the pastel sky
  octx.globalCompositeOperation = "destination-in";
  const mask = octx.createRadialGradient(
    off.width * 0.5,
    off.height * 0.48,
    off.width * 0.25,
    off.width * 0.5,
    off.height * 0.48,
    off.width * 0.49
  );
  mask.addColorStop(0, "rgba(255,255,255,1)");
  mask.addColorStop(0.76, "rgba(255,255,255,0.92)");
  mask.addColorStop(0.92, "rgba(255,255,255,0.35)");
  mask.addColorStop(1, "rgba(255,255,255,0)");
  octx.fillStyle = mask;
  octx.fillRect(0, 0, off.width, off.height);

  octx.globalCompositeOperation = "source-over";
  return off;
}

// Animated glowing blossoms on the main tree canvas
const treeSparkles = Array.from({ length: 65 }, (_, i) => ({
  x: 240 + Math.random() * 920,
  y: 130 + Math.random() * 540,
  r: 3 + Math.random() * 6,
  phase: Math.random() * Math.PI * 2,
  speed: 0.015 + Math.random() * 0.02
}));

function renderMainTreeLoop(time) {
  treeCtx.clearRect(0, 0, treeCanvas.width, treeCanvas.height);

  if (treeImgLoaded && maskedTreeCanvas) {
    const swayX = Math.sin(time * 0.0007) * 2.5;
    treeCtx.save();
    treeCtx.translate(swayX, 0);
    treeCtx.drawImage(maskedTreeCanvas, 0, 0);

    // Subtle glowing sakura blossoms breathing on the canopy
    treeSparkles.forEach((sp) => {
      const alpha = 0.25 + 0.35 * Math.sin(time * 0.002 + sp.phase);
      const grad = treeCtx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, sp.r * 2.6);
      grad.addColorStop(0, `rgba(255, 240, 245, ${alpha})`);
      grad.addColorStop(0.5, `rgba(247, 194, 210, ${alpha * 0.65})`);
      grad.addColorStop(1, "rgba(247, 194, 210, 0)");
      treeCtx.fillStyle = grad;
      treeCtx.beginPath();
      treeCtx.arc(sp.x, sp.y, sp.r * 2.6, 0, Math.PI * 2);
      treeCtx.fill();
    });

    treeCtx.restore();
  }
}

// High-detail realistic Cherry Branch renderer for the 27-slot view
function drawSingleBranchCanvas() {
  const w = singleBranchCanvas.width;
  const h = singleBranchCanvas.height;
  sbCtx.clearRect(0, 0, w, h);

  // Soft atmospheric glow behind branch
  const glow = sbCtx.createRadialGradient(w * 0.5, h * 0.5, 40, w * 0.5, h * 0.5, w * 0.46);
  glow.addColorStop(0, "rgba(253, 224, 234, 0.42)");
  glow.addColorStop(0.6, "rgba(202, 233, 250, 0.25)");
  glow.addColorStop(1, "rgba(202, 233, 250, 0)");
  sbCtx.fillStyle = glow;
  sbCtx.fillRect(0, 0, w, h);

  // Draw twigs connecting each of the 27 slots to the main sweeping bough
  SLOT_COORDS.forEach(({ slot, x, y }) => {
    const px = (x / 100) * w;
    const py = (y / 100) * h;
    const t = (slot - 1) / 26;
    const mainY = (0.5 - Math.sin(t * Math.PI) * 0.14 + Math.cos(t * Math.PI * 2.5) * 0.04) * h;
    const anchorX = px - 28;
    const anchorY = mainY;

    sbCtx.save();
    sbCtx.beginPath();
    sbCtx.moveTo(anchorX, anchorY);
    sbCtx.quadraticCurveTo((anchorX + px) * 0.5, anchorY, px, py);
    sbCtx.strokeStyle = "rgba(138, 108, 118, 0.58)";
    sbCtx.lineWidth = 4.2;
    sbCtx.lineCap = "round";
    sbCtx.stroke();

    // Paint delicate sakura petals around each slot node on the canvas
    const isFilled = Boolean((memoryStore[currentPage] || {})[slotKey(currentBranch, slot)]);
    drawSakuraCluster(sbCtx, px, py, isFilled ? 34 : 24, isFilled);
    sbCtx.restore();
  });

  // Main realistic sculpted wooden branch limb across the stage
  sbCtx.save();
  sbCtx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const bx = w * 0.02 + t * w * 0.94;
    const by = (0.5 - Math.sin(t * Math.PI) * 0.14 + Math.cos(t * Math.PI * 2.5) * 0.04) * h;
    if (i === 0) sbCtx.moveTo(bx, by);
    else sbCtx.lineTo(bx, by);
  }
  const barkGrad = sbCtx.createLinearGradient(0, h * 0.3, 0, h * 0.65);
  barkGrad.addColorStop(0, "#9e828c");
  barkGrad.addColorStop(0.5, "#7d646e");
  barkGrad.addColorStop(1, "#69525b");
  sbCtx.strokeStyle = barkGrad;
  sbCtx.lineWidth = 18;
  sbCtx.lineCap = "round";
  sbCtx.shadowColor = "rgba(140, 115, 128, 0.28)";
  sbCtx.shadowBlur = 12;
  sbCtx.stroke();

  // Subtle bark highlight
  sbCtx.strokeStyle = "rgba(250, 228, 236, 0.32)";
  sbCtx.lineWidth = 4;
  sbCtx.stroke();
  sbCtx.restore();
}

function drawSakuraCluster(ctx, cx, cy, radius, isBloomed) {
  const petals = 5;
  for (let p = 0; p < petals; p++) {
    const angle = (p * Math.PI * 2) / petals - Math.PI / 2;
    const px = cx + Math.cos(angle) * (radius * 0.65);
    const py = cy + Math.sin(angle) * (radius * 0.65);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 0.55, radius * 0.36, 0, 0, Math.PI * 2);
    ctx.fillStyle = isBloomed
      ? "rgba(248, 184, 204, 0.78)"
      : "rgba(252, 218, 229, 0.48)";
    ctx.fill();
    ctx.restore();
  }
}

// ==========================================
// 7. BACKGROUND FLOATING HELLO KITTY CATS & FALLING CHERRY BLOSSOMS
// ==========================================
const bgCanvas = document.getElementById("bg-canvas");
const bgCtx = bgCanvas.getContext("2d");
const fgCanvas = document.getElementById("fg-canvas");
const fgCtx = fgCanvas.getContext("2d");

let kittySpriteCanvas = null;
const rawKittyImg = new Image();
rawKittyImg.onload = () => {
  kittySpriteCanvas = removeExteriorWhiteBackground(rawKittyImg);
};
rawKittyImg.src = "assets/hello-kitty.jpg";

// Flood-fill from corners so exterior white background becomes transparent while keeping Hello Kitty's white face opaque!
function removeExteriorWhiteBackground(img) {
  const w = 360;
  const h = 360;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const visited = new Uint8Array(w * h);
    const queue = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];

    const isNearWhite = (idx) => {
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      return r > 240 && g > 238 && b > 240;
    };

    while (queue.length > 0) {
      const pos = queue.pop();
      if (visited[pos]) continue;
      visited[pos] = 1;

      const pixelIdx = pos * 4;
      if (isNearWhite(pixelIdx)) {
        data[pixelIdx + 3] = 0; // make transparent
        const x = pos % w;
        const y = (pos - x) / w;
        if (x > 0 && !visited[pos - 1]) queue.push(pos - 1);
        if (x < w - 1 && !visited[pos + 1]) queue.push(pos + 1);
        if (y > 0 && !visited[pos - w]) queue.push(pos - w);
        if (y < h - 1 && !visited[pos + w]) queue.push(pos + w);
      }
    }

    ctx.putImageData(imgData, 0, 0);
  } catch (e) {
    // Fallback for file:// protocol where getImageData is restricted
    ctx.globalCompositeOperation = "destination-in";
    const mask = ctx.createRadialGradient(w / 2, h / 2, w * 0.22, w / 2, h / 2, w * 0.44);
    mask.addColorStop(0, "rgba(255,255,255,1)");
    mask.addColorStop(0.82, "rgba(255,255,255,0.92)");
    mask.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  return c;
}

const floatingKitties = [];
const bgPetals = [];
const fgPetals = [];

function initParticles() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  floatingKitties.length = 0;
  const kittyCount = Math.max(7, Math.min(13, Math.floor(w / 140)));
  for (let i = 0; i < kittyCount; i++) {
    floatingKitties.push({
      x: Math.random() * w,
      y: Math.random() * h,
      size: 56 + Math.random() * 42,
      vx: (Math.random() - 0.5) * 0.32,
      vy: -0.18 - Math.random() * 0.25,
      bobPhase: Math.random() * Math.PI * 2,
      bobSpeed: 0.012 + Math.random() * 0.012,
      tiltPhase: Math.random() * Math.PI * 2,
      opacity: 0.42 + Math.random() * 0.26
    });
  }

  bgPetals.length = 0;
  for (let i = 0; i < 65; i++) {
    bgPetals.push(createPetal(w, h, false));
  }

  fgPetals.length = 0;
  for (let i = 0; i < 24; i++) {
    fgPetals.push(createPetal(w, h, true));
  }
}

function createPetal(w, h, isForeground) {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    size: isForeground ? 9 + Math.random() * 8 : 5 + Math.random() * 7,
    vy: 0.45 + Math.random() * 0.75,
    vx: 0.25 + Math.random() * 0.55,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.025,
    swayPhase: Math.random() * Math.PI * 2,
    swaySpeed: 0.015 + Math.random() * 0.02,
    alpha: isForeground ? 0.55 + Math.random() * 0.25 : 0.4 + Math.random() * 0.35,
    tint: Math.random() > 0.28 ? "#f7c2d0" : "#FADADD"
  };
}

function drawSakuraPetal(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.angle);
  ctx.globalAlpha = p.alpha;

  // Notched realistic sakura petal silhouette
  ctx.beginPath();
  ctx.moveTo(0, p.size);
  ctx.bezierCurveTo(p.size * 0.9, p.size * 0.4, p.size * 0.85, -p.size * 0.7, p.size * 0.2, -p.size);
  ctx.lineTo(0, -p.size * 0.72);
  ctx.lineTo(-p.size * 0.2, -p.size);
  ctx.bezierCurveTo(-p.size * 0.85, -p.size * 0.7, -p.size * 0.9, p.size * 0.4, 0, p.size);
  ctx.closePath();

  ctx.fillStyle = p.tint;
  ctx.fill();
  ctx.restore();
}

function updateAndDrawPetalList(ctx, list, w, h) {
  list.forEach((p) => {
    p.swayPhase += p.swaySpeed;
    p.x += p.vx + Math.sin(p.swayPhase) * 0.55;
    p.y += p.vy;
    p.angle += p.spin;

    if (p.y > h + 25) {
      p.y = -20;
      p.x = Math.random() * w;
    }
    if (p.x > w + 25) {
      p.x = -20;
    }
    drawSakuraPetal(ctx, p);
  });
}

function drawFloatingKitty(ctx, k) {
  ctx.save();
  ctx.translate(k.x, k.y);
  ctx.rotate(Math.sin(k.tiltPhase) * 0.12);
  ctx.globalAlpha = k.opacity;

  if (kittySpriteCanvas) {
    ctx.drawImage(kittySpriteCanvas, -k.size / 2, -k.size / 2, k.size, k.size);
  } else {
    // Vector fallback while sprite loads
    const r = k.size * 0.36;
    ctx.fillStyle = "rgba(255, 250, 252, 0.9)";
    ctx.strokeStyle = "#eab8c6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.2, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function resizeAllCanvases() {
  bgCanvas.width = window.innerWidth;
  bgCanvas.height = window.innerHeight;
  fgCanvas.width = window.innerWidth;
  fgCanvas.height = window.innerHeight;
  if (currentBranch !== null) {
    drawSingleBranchCanvas();
  }
}

window.addEventListener("resize", () => {
  resizeAllCanvases();
  initParticles();
});

function animate(time) {
  const w = bgCanvas.width;
  const h = bgCanvas.height;

  bgCtx.clearRect(0, 0, w, h);
  fgCtx.clearRect(0, 0, w, h);

  // 1. Floating Hello Kitty cats in the background
  floatingKitties.forEach((k) => {
    k.bobPhase += k.bobSpeed;
    k.tiltPhase += k.bobSpeed * 0.8;
    k.x += k.vx + Math.sin(k.bobPhase) * 0.25;
    k.y += k.vy;

    if (k.y < -k.size) {
      k.y = h + k.size;
      k.x = Math.random() * w;
    }
    if (k.x < -k.size) k.x = w + k.size;
    if (k.x > w + k.size) k.x = -k.size;

    drawFloatingKitty(bgCtx, k);
  });

  // 2. Falling cherry blossoms in background
  updateAndDrawPetalList(bgCtx, bgPetals, w, h);

  // 3. Main ultra-realistic cherry tree animation
  if (currentBranch === null) {
    renderMainTreeLoop(time);
  }

  // 4. Foreground falling cherry blossom petals
  updateAndDrawPetalList(fgCtx, fgPetals, w, h);

  requestAnimationFrame(animate);
}

// Initialize
loadLocalBackup();
buildBranchNavigation();
buildSlotsGrid();
resizeAllCanvases();
initParticles();
refreshUI();
initFirebase();
requestAnimationFrame(animate);
