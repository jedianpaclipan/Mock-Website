/* PawAlert mock-up: JavaScript
   script.js controls the whole page:
     - navigation (pages) and roles (citizen / rescuer)
     - case status, progress bars and action buttons
     - report form (photo preview, REAL species detection, validation, new case)
     - live map (Leaflet): one pin per case, filters and counter
     - report map: click to drop a pin
     - adopt page (list an animal, replace a photo, adopt -> moves to the Adopted page)
     - one photo viewer for every photo
   Species is detected in the browser (TensorFlow.js + MobileNet).
   Injury and urgency are chosen by the reporter: a photo classifier can't judge them. */

(() => {
  "use strict";

  /* =====================================================
     1. Config
     ===================================================== */
  const TABS  = ["home", "report", "map", "adopt", "adopted"];
  const ROLES = ["citizen", "rescuer"];

  const MIN_DESC_LENGTH   = 10;
  const MIN_SPECIES_SCORE = 0.25;   // below this the AI says "not sure"
  const LIKELY_SCORE      = 0.6;    // at or above this the wording is "Likely"

  // Case life cycle. Each status has the action that moves the case to the next one.
  const STATUSES = ["Reported", "Claimed", "Rescued", "Treated", "Listed"];
  const ADVANCE = {
    Reported: { to: "Claimed", label: "Claim case" },
    Claimed:  { to: "Rescued", label: "Mark as Rescued" },
    Rescued:  { to: "Treated", label: "Mark as Treated" },
    Treated:  { to: "Listed",  label: "Vet cleared: upload photo & list for adoption" },
  };
  const FINAL_LABEL = "✅ Listed for adoption";

  // Map: centered on the area of the mock-up (Sta. Cruz, Davao del Sur)
  const MAP_CENTER = [6.8338, 125.4152];
  const MAP_ZOOM   = 15;
  const URGENCY_PIN = { High: "🔴", Medium: "🟠", Low: "🟢" };

  // MobileNet predicts 1000 ImageNet classes. We add up the ones that belong to each animal.
  const SPECIES = [
    { animal: "Dog",  icon: "🐕", tone: "p1", ranges: [[151, 268]] },
    { animal: "Cat",  icon: "🐈", tone: "p2", ranges: [[281, 285]] },
    { animal: "Bird", icon: "🐦", tone: "p4", ranges: [[7, 24], [80, 100], [127, 146]] },
  ];
  const UNKNOWN_SPECIES = { animal: "Animal", icon: "🐾", tone: "p3" };


  /* =====================================================
     2. Helpers
     ===================================================== */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const escapeHTML = (str) =>
    str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const store = {
    get(key)        { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } },
  };

  // Show an uploaded file in an <img> and return its temporary URL
  const fileURL = (file) => URL.createObjectURL(file);


  /* =====================================================
     3. State and elements
     ===================================================== */
  const view  = { tab: "home", role: "citizen" };
  const state = { species: UNKNOWN_SPECIES, photoURL: null, detectId: 0 };

  const app = $(".app");

  const el = {
    // report form
    photo:   $("#photo-input"),
    aiBox:   $("#ai-box"),
    injury:  $("#injury"),
    urgency: $("#urgency"),
    desc:    $("#description"),
    contact: $("#contact"),
    error:   $("#form-error"),
    reportMap: $("#report-map"),
    pinStatus: $("#pin-status"),
    ok:      $("#report-ok"),
    // live map
    liveMap:    $("#live-map"),
    caseGrid:   $("#case-grid"),
    statusSel:  $("#filter-status"),
    urgencySel: $("#filter-urgency"),
    counter:    $("#case-count"),
    // adopt
    adoptGrid:  $("#adopt-grid"),
    adoptEmpty: $("#adopt-empty"),
    adoptedGrid:  $("#adopted-grid"),
    adoptedCount: $("#adopted-count"),
    adoptFile:  $("#adopt-file"),
    adoptNote:  $("#adopt-note"),
    adoptError: $("#adopt-error"),
    adoptOk:    $("#adopt-ok"),
    // photo viewer
    lightbox:  $("#lightbox"),
    lbPhoto:   $("#lightbox-photo"),
    lbCaption: $("#lightbox-caption"),
  };

  const AI_DEFAULT_HTML = `<b>AI suggestion</b><br>
    <span class="mut">Upload a photo and the AI will guess the animal.</span>`;


  /* =====================================================
     4. Navigation and roles
     ===================================================== */
  function render() {
    // Citizens who open "Adopted" see the "rescuers only" page
    const page = view.tab === "adopted" && view.role === "citizen" ? "denied" : view.tab;

    $$(".page").forEach((p) => (p.hidden = p.id !== `p-${page}`));
    app.dataset.role = view.role;

    $$("header [data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === view.tab));
    $$("[data-as]").forEach((b) => b.classList.toggle("active", b.dataset.as === view.role));
    invalidateMaps();
  }

  function goTo(tab) {
    if (!TABS.includes(tab)) return;
    view.tab = tab;
    store.set("tab", tab);
    render();
    window.scrollTo({ top: 0 });
  }

  function setRole(role) {
    if (!ROLES.includes(role)) return;
    view.role = role;
    store.set("role", role);
    render();
  }


  /* =====================================================
     4b. Maps (Leaflet + OpenStreetMap)
         Report page: click to drop a pin.
         Live map: one pin per active case.
     ===================================================== */
  const maps = { live: null, report: null };
  const caseMarkers = new Map();     // case card -> its pin on the live map
  let reportMarker = null;           // the pin the reporter dropped

  const emojiIcon = (emoji, anchor) =>
    L.divIcon({ className: "emoji-pin", html: emoji, iconSize: [28, 28], iconAnchor: anchor });

  function createMap(container) {
    const map = L.map(container).setView(MAP_CENTER, MAP_ZOOM);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    return map;
  }

  function initMaps() {
    if (!window.L) {   // Leaflet didn't load (offline)
      [el.liveMap, el.reportMap].forEach((box) => {
        box.innerHTML = `<p class="map-msg mut">Map unavailable (are you offline?).</p>`;
      });
      return;
    }
    maps.live   = createMap(el.liveMap);
    maps.report = createMap(el.reportMap);
    maps.report.on("click", (e) => dropPin(e.latlng));
    updatePinStatus();
  }

  // Maps are created while their page is hidden, so resize them when they appear
  const invalidateMaps = () => Object.values(maps).forEach((m) => m?.invalidateSize());

  // --- Report page: the pin
  function dropPin(latlng) {
    if (reportMarker) {
      reportMarker.setLatLng(latlng);
    } else {
      reportMarker = L.marker(latlng, { icon: emojiIcon("📍", [14, 28]), draggable: true }).addTo(maps.report);
      reportMarker.on("dragend", updatePinStatus);
    }
    updatePinStatus();
  }

  function clearPin() {
    reportMarker?.remove();
    reportMarker = null;
    updatePinStatus();
  }

  function updatePinStatus() {
    if (!maps.report) return;
    if (!reportMarker) {
      el.pinStatus.textContent = "Click the map to drop a pin where the animal is.";
      return;
    }
    const { lat, lng } = reportMarker.getLatLng();
    el.pinStatus.textContent = `📍 Pin dropped (${lat.toFixed(5)}, ${lng.toFixed(5)}). Drag it to adjust.`;
  }

  // --- Live map: pins for cases
  function captionParts(card) {
    const [animal, ...rest] = (card.dataset.caption || "").replace(/ · sample photo$/, "").split(" · ");
    return { animal: animal || "Animal", detail: rest.join(" · ") };
  }

  function popupHTML(card) {
    const { animal, detail } = captionParts(card);
    return `<b>${escapeHTML(animal)}</b>${detail ? ` · ${escapeHTML(detail)}` : ""}<br>
            ${escapeHTML(card.dataset.status)} · ${escapeHTML(card.dataset.urgency)} urgency`;
  }

  // Get (or create) the pin for a case. Cases without a location have no pin.
  function caseMarker(card) {
    if (!maps.live || !card.dataset.lat) return null;
    let marker = caseMarkers.get(card);
    if (!marker) {
      marker = L.marker([+card.dataset.lat, +card.dataset.lng], {
        icon: emojiIcon(URGENCY_PIN[card.dataset.urgency] || "🟠", [14, 14]),
      }).bindPopup(popupHTML(card));
      caseMarkers.set(card, marker);
    }
    marker.setPopupContent(popupHTML(card));   // keeps the status up to date
    return marker;
  }

  function locateCase(card) {
    const marker = caseMarkers.get(card);
    if (!marker) return;
    el.liveMap.scrollIntoView({ behavior: "smooth", block: "center" });
    maps.live.setView(marker.getLatLng(), 17);
    marker.openPopup();
  }

  // A case leaves the live map completely (card and pin)
  function removeCase(card) {
    caseMarkers.get(card)?.remove();
    caseMarkers.delete(card);
    card.remove();
  }


  /* =====================================================
     5. Photo viewer (one lightbox for all photos)
     ===================================================== */
  let lastTrigger = null;

  function setCardPhoto(card, url) {
    card.dataset.photo = url;
    const thumb = $(".thumb", card);
    thumb.dataset.icon ||= thumb.textContent.trim();     // remember the emoji
    const img = Object.assign(document.createElement("img"), { src: url, alt: card.dataset.caption || "Photo" });
    thumb.replaceChildren(img);
  }

  function openPhoto(card, trigger) {
    const thumb   = $(".thumb", card);
    const tone    = [...thumb.classList].find((c) => /^p\d$/.test(c)) || "";
    const caption = card.dataset.caption || "";

    el.lbPhoto.className = `photo ${tone}`;
    if (card.dataset.photo) {
      el.lbPhoto.replaceChildren(Object.assign(document.createElement("img"), { src: card.dataset.photo, alt: caption }));
    } else {
      el.lbPhoto.textContent = thumb.textContent.trim();   // emoji placeholder
    }
    el.lbCaption.textContent = caption;

    lastTrigger = trigger;
    el.lightbox.hidden = false;
    $(".close", el.lightbox).focus();
  }

  function closePhoto() {
    el.lightbox.hidden = true;
    lastTrigger?.focus();
  }


  /* =====================================================
     6. Cases: status, progress bar, action button
     ===================================================== */
  function renderCase(card) {
    const status = card.dataset.status;
    const index  = STATUSES.indexOf(status);

    $("[data-status-tag]", card).textContent = status;
    $(".steps", card).innerHTML = STATUSES
      .map((_, i) => `<i class="${i <= index ? "d" : ""}"></i>`)
      .join("");

    const button = $('[data-action="advance"]', card);
    const next = ADVANCE[status];
    button.textContent = next ? next.label : FINAL_LABEL;
    button.disabled = !next;
  }

  function advanceCase(card) {
    const next = ADVANCE[card.dataset.status];
    if (!next) return;
    card.dataset.status = next.to;

    if (next.to === "Listed") {
      listCaseForAdoption(card);   // now on the Adopt page (citizens and rescuers)
      removeCase(card);            // and gone from the live map
    } else {
      renderCase(card);
    }
    refreshMap();
  }

  // Live map filters + "N shown" counter
  function refreshMap() {
    const cases = $$(".case", el.caseGrid);
    let shown = 0;

    cases.forEach((c) => {
      const match =
        (el.statusSel.value  === "all" || c.dataset.status  === el.statusSel.value) &&
        (el.urgencySel.value === "all" || c.dataset.urgency === el.urgencySel.value);
      c.classList.toggle("filtered-out", !match);

      const marker = caseMarker(c);
      if (marker) match ? marker.addTo(maps.live) : marker.remove();

      if (match) shown++;
    });

    el.counter.textContent = `${shown} shown`;
  }


  /* =====================================================
     7. AI: species detection (TensorFlow.js + MobileNet)
     ===================================================== */
  let modelPromise = null;

  function loadModel() {
    if (!window.mobilenet || !window.tf) return Promise.reject(new Error("AI libraries not loaded"));
    modelPromise ??= mobilenet.load({ version: 2, alpha: 1.0 });
    return modelPromise;
  }

  async function detectSpecies(img) {
    const model = await loadModel();
    await img.decode();

    const logits = model.infer(img);                              // 1000 raw scores
    const probsTensor = tf.tidy(() => tf.softmax(logits));
    const probs = await probsTensor.data();
    logits.dispose();
    probsTensor.dispose();

    const sum = ([from, to]) => probs.slice(from, to + 1).reduce((a, b) => a + b, 0);
    const scored = SPECIES.map((sp) => ({ ...sp, score: sp.ranges.reduce((t, r) => t + sum(r), 0) }));
    const best = scored.sort((a, b) => b.score - a.score)[0];

    return best.score >= MIN_SPECIES_SCORE ? best : { ...UNKNOWN_SPECIES, score: best.score };
  }

  const showAI = (html) => (el.aiBox.innerHTML = `<b>AI suggestion</b><br>${html}`);

  function showSpecies(result) {
    state.species = result;
    if (result.animal === "Animal") {
      showAI(`<span class="mut">Not sure what animal this is. A rescuer will check the photo.</span>`);
      return;
    }
    const certainty = result.score >= LIKELY_SCORE ? "Likely" : "Possible";
    showAI(`<span class="tag">${result.icon} ${result.animal}</span>
            <span class="mut">${certainty} match · injury and urgency: please choose below</span>`);
  }

  async function onPhotoChosen() {
    const file = el.photo.files[0];
    if (!file) return;

    const id = ++state.detectId;          // ignore results from older photos
    el.ok.hidden = true;

    if (state.photoURL) URL.revokeObjectURL(state.photoURL);
    state.photoURL = fileURL(file);

    let img = $(".preview", el.photo.parentElement);
    if (!img) {
      img = Object.assign(document.createElement("img"), { className: "preview", alt: "Photo preview" });
      el.photo.parentElement.appendChild(img);
    }
    img.src = state.photoURL;

    showAI(`<span class="mut">Analysing photo… (the first time loads the AI model)</span>`);
    try {
      const result = await detectSpecies(img);
      if (id === state.detectId) showSpecies(result);
    } catch (err) {
      console.error(err);
      if (id !== state.detectId) return;
      state.species = UNKNOWN_SPECIES;
      showAI(`<span class="mut">AI is unavailable (are you offline?). You can still submit the report.</span>`);
    }
  }


  /* =====================================================
     8. Report form
     ===================================================== */
  function validateReport() {
    if (el.desc.value.trim().length < MIN_DESC_LENGTH) {
      return { field: el.desc, message: `Please describe the situation (at least ${MIN_DESC_LENGTH} characters).` };
    }
    if (!el.contact.value.trim()) {
      return { field: el.contact, message: "Please add your name or contact number." };
    }
    if (maps.report && !reportMarker) {
      return { field: el.reportMap, message: "Please click the map to drop a pin where the animal is." };
    }
    return null;
  }

  function createReportCard() {
    const { species, photoURL } = state;
    const injury  = el.injury.value;
    const urgency = el.urgency.value;

    const card = document.createElement("div");
    card.className = "card case";
    card.dataset.status  = "Reported";
    card.dataset.urgency = urgency;
    card.dataset.caption = `${species.animal} · ${injury}`;
    card.innerHTML = `
      <button class="thumb ${species.tone}" data-action="view" title="View photo">${species.icon}</button>
      <div class="body">
        <b>${species.animal}</b> · ${injury}
        <span class="tag u-${urgency}">${urgency}</span>
        <span class="tag" data-status-tag></span>
        <div class="desc">${escapeHTML(el.desc.value.trim())}</div>
        <div class="mut">Reported by ${escapeHTML(el.contact.value.trim())} · Your report</div>
        <div class="steps"></div>
        <div class="row">
          <button class="btn" data-action="view">📷 View photo</button>
          <button class="btn" data-action="locate">📍 Locate</button>
          <button class="btn pri rescuer-only" data-action="advance"></button>
        </div>
      </div>`;

    if (reportMarker) {
      const { lat, lng } = reportMarker.getLatLng();
      card.dataset.lat = lat;
      card.dataset.lng = lng;
    }
    if (photoURL) setCardPhoto(card, photoURL);
    return card;
  }

  function resetReportForm() {
    el.desc.value = "";
    el.contact.value = "";
    el.injury.selectedIndex = 0;
    el.urgency.value = "Medium";
    el.photo.value = "";
    $(".preview", el.photo.parentElement)?.remove();
    el.aiBox.innerHTML = AI_DEFAULT_HTML;
    clearPin();

    state.detectId++;                     // cancel any detection still running
    state.photoURL = null;                // the card keeps its own copy of the URL
    state.species = UNKNOWN_SPECIES;
  }

  function submitReport() {
    const problem = validateReport();
    el.error.textContent = problem ? problem.message : "";
    if (problem) return problem.field.focus();

    const card = createReportCard();
    el.caseGrid.prepend(card);
    renderCase(card);
    refreshMap();

    resetReportForm();
    el.ok.hidden = false;
  }


  /* =====================================================
     9. Adopt page
     ===================================================== */
  // Colour + emoji of a card's thumbnail (so a copy of the card looks the same)
  function thumbLook(card) {
    const thumb = $(".thumb", card);
    return {
      tone: [...thumb.classList].find((c) => /^p\d$/.test(c)) || "p3",
      icon: thumb.dataset.icon || thumb.textContent.trim() || "🐾",
    };
  }

  // Empty message on the Adopt page and the "N rehomed" counter on the Adopted page
  function syncAdoptPages() {
    el.adoptEmpty.hidden = el.adoptGrid.children.length > 0;
    el.adoptedCount.textContent = `${el.adoptedGrid.children.length} rehomed`;
  }

  // Step 1: "Adopt / Foster" opens a small form for the adopter's name
  function showAdoptForm(button) {
    const card = button.closest(".case");
    if ($(".adopt-form", card)) return;

    const form = document.createElement("div");
    form.className = "row adopt-form";
    form.innerHTML = `
      <input type="text" class="adopter" placeholder="Your name" aria-label="Your name">
      <button class="btn pri" data-action="confirm-adopt">Confirm</button>
      <button class="btn" data-action="cancel-adopt">Cancel</button>
      <div class="err" role="alert"></div>`;

    button.hidden = true;
    $(".row", card).after(form);
    $(".adopter", form).focus();
  }

  function cancelAdoption(button) {
    const card = button.closest(".case");
    $(".adopt-form", card).remove();
    $('[data-action="adopt"]', card).hidden = false;
  }

  // Step 2: confirm. The animal leaves the Adopt page and goes to the Adopted page.
  function confirmAdoption(button) {
    const card  = button.closest(".case");
    const input = $(".adopter", card);
    const adopter = input.value.trim();

    if (!adopter) {
      $(".adopt-form .err", card).textContent = "Please enter your name.";
      return input.focus();
    }

    const { animal, detail } = captionParts(card);
    addAdoptedCard({
      animal,
      detail:  detail || "Rehomed",
      note:    $(".desc", card)?.textContent.trim() || "Now in a loving home.",
      care:    $(".mut", card)?.textContent.trim() || "",
      adopter,
      caption: card.dataset.caption,
      photo:   card.dataset.photo,
      ...thumbLook(card),
    });

    card.remove();
    syncAdoptPages();
  }

  function addAdoptedCard({ animal, detail, note, care, adopter, tone, icon, caption, photo }) {
    const card = document.createElement("div");
    card.className = "card case";
    card.dataset.caption = caption;
    card.innerHTML = `
      <button class="thumb ${tone}" data-action="view" title="View photo">${icon}</button>
      <div class="body">
        <b>${escapeHTML(animal)}</b> · ${escapeHTML(detail)} <span class="tag">Adopted</span>
        <div class="desc">${escapeHTML(note)}</div>
        <div class="mut">Adopted by ${escapeHTML(adopter)}${care ? ` · ${escapeHTML(care)}` : ""}</div>
      </div>`;
    if (photo) setCardPhoto(card, photo);
    el.adoptedGrid.prepend(card);
  }

  // One builder for every animal on the Adopt page
  function addAdoptCard({ animal, detail, note, care, tone, icon, caption, photo }) {
    const card = document.createElement("div");
    card.className = "card case";
    card.dataset.caption = caption;
    card.innerHTML = `
      <button class="thumb ${tone}" data-action="view" title="View photo">${icon}</button>
      <div class="body">
        <b>${escapeHTML(animal)}</b> · ${escapeHTML(detail)}
        <div class="desc">${escapeHTML(note)}</div>
        <div class="mut">${escapeHTML(care)}</div>
        <div class="row top">
          <button class="btn pri" data-action="adopt">Adopt / Foster</button>
          <button class="btn" data-action="view">📷 View photo</button>
          <label class="btn rescuer-only">🔄 Replace photo
            <input type="file" accept="image/*" hidden data-action="replace-photo">
          </label>
        </div>
      </div>`;
    if (photo) setCardPhoto(card, photo);
    el.adoptGrid.prepend(card);
    syncAdoptPages();
  }

  // A case on the Live Map reached "Listed": copy it to the Adopt page
  function listCaseForAdoption(caseCard) {
    const { animal, detail } = captionParts(caseCard);
    const handler = $(".mut", caseCard)?.textContent.match(/Handled by (.+)$/)?.[1];

    addAdoptCard({
      animal,
      detail:  detail || "Ready for a home",
      note:    $(".desc", caseCard)?.textContent.trim() || "Vet cleared and ready for a home.",
      care:    handler ? `Cared for by ${handler}` : "Listed by a rescuer",
      ...thumbLook(caseCard),
      caption: caseCard.dataset.caption || `${animal} · Ready for a home`,
      photo:   caseCard.dataset.photo,
    });
  }

  // A rescuer adds an animal directly from the Adopt page
  function listForAdoption() {
    const file = el.adoptFile.files[0];
    el.adoptOk.hidden = true;

    if (!file) {
      el.adoptError.textContent = "Please choose a photo of the animal first.";
      return el.adoptFile.focus();
    }
    el.adoptError.textContent = "";

    addAdoptCard({
      animal:  "Animal",
      detail:  "Ready for a home",
      note:    el.adoptNote.value.trim() || "Newly listed, vet cleared.",
      care:    "Listed by a rescuer",
      tone:    "p3",
      icon:    "🐾",
      caption: "Animal · Ready for a home",
      photo:   fileURL(file),
    });

    el.adoptFile.value = "";
    el.adoptNote.value = "";
    el.adoptOk.hidden = false;
  }

  function replacePhoto(input) {
    const file = input.files[0];
    if (file) setCardPhoto(input.closest(".case"), fileURL(file));
    input.value = "";
  }


  /* =====================================================
     10. Event wiring (one listener each, works for new cards too)
     ===================================================== */

  // data-action="..." on a clicked element runs the matching function
  const ACTIONS = {
    "view":          (button) => openPhoto(button.closest(".case"), button),
    "advance":       (button) => advanceCase(button.closest(".case")),
    "locate":        (button) => locateCase(button.closest(".case")),
    "adopt":         showAdoptForm,
    "confirm-adopt": confirmAdoption,
    "cancel-adopt":  cancelAdoption,
    "list-adoption": listForAdoption,
    "submit":        submitReport,
    "close-photo":   closePhoto,
  };

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-go], [data-as], [data-action]");
    if (!target) return;

    if (target.dataset.go) return goTo(target.dataset.go);
    if (target.dataset.as) return setRole(target.dataset.as);
    ACTIONS[target.dataset.action]?.(target);
  });

  document.addEventListener("change", (e) => {
    if (e.target.matches('[data-action="replace-photo"]')) replacePhoto(e.target);
  });

  el.photo.addEventListener("change", onPhotoChosen);
  [el.statusSel, el.urgencySel].forEach((s) => s.addEventListener("change", refreshMap));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.lightbox.hidden) closePhoto();
    if (e.key === "Enter" && e.target.matches(".adopter")) confirmAdoption(e.target);
  });


  /* =====================================================
     11. Start
     ===================================================== */
  const savedTab  = store.get("tab");
  const savedRole = store.get("role");
  if (TABS.includes(savedTab))   view.tab  = savedTab;
  if (ROLES.includes(savedRole)) view.role = savedRole;

  el.aiBox.innerHTML = AI_DEFAULT_HTML;
  initMaps();
  syncAdoptPages();
  $$(".case[data-status]", el.caseGrid).forEach(renderCase);
  refreshMap();
  render();
})();
