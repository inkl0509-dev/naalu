// Naalu customer portal — public page, no login.
// Reads only tracking/{receiptNo-last4} and boatpos/{boatId}. Cannot list or search anything.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const db = getFirestore(initializeApp(firebaseConfig));
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const fmt = (ms) => { const d = new Date(ms); return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : fmt(ms);
}
const STATUS = { received: "📥 Received at the boat", loaded: "🚤 On the way", delivered: "✅ Delivered" };

let unsubT = null, unsubP = null, map = null, marker = null, current = null;

function initMap() {
  if (map || !window.L) return;
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([4.17, 73.51], 7); // Maldives
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}
function showPos(p) {
  initMap();
  const note = $("#mapNote");
  if (!p || !p.lat) { note.textContent = "The boat is not sharing its location right now."; return; }
  const stale = Date.now() - p.at > 30 * 60000;
  note.innerHTML = `${p.sharing === false ? "Location sharing stopped. Last known position" : "Last updated"} <b>${ago(p.at)}</b>` +
    (p.speedKn ? ` · ${num(p.speedKn)} knots` : "") + (stale && p.sharing !== false ? " · (no signal at sea recently)" : "");
  note.innerHTML += ` · <a target="_blank" href="https://www.google.com/maps?q=${p.lat},${p.lng}">Open in Google Maps</a>`;
  if (!map) { $("#map").innerHTML = `<div class="center muted" style="padding:120px 10px">Map could not load. Use “Open in Google Maps”.</div>`; return; }
  const ll = [p.lat, p.lng];
  if (!marker) {
    marker = L.marker(ll, { icon: L.divIcon({ className: "boat-icon", html: "🚤", iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(map);
    map.setView(ll, 11);
  } else marker.setLatLng(ll);
  marker.bindPopup(`<b>${esc(p.boatName || "Boat")}</b><br>${ago(p.at)}`);
}

function render(t) {
  current = t;
  $("#findForm").classList.add("hidden");
  $("#result").classList.remove("hidden");
  $("#pageTitle").textContent = `Receipt #${t.receiptNo}`;
  $("#pageSub").textContent = `${t.senderName || ""} → ${t.receiverName || ""}`;
  $("#rBoat").textContent = `🚤 ${t.boatName}`;
  $("#rStatus").textContent = STATUS[t.status] || t.status;
  $("#rRoute").textContent = `${t.from || "—"} → ${t.island || "—"}`;
  $("#rVoyage").textContent = t.voyageName ? `Voyage: ${t.voyageName}` : "";

  const steps = [
    ["received", "📥", "Received at the boat", t.receivedAtMs],
    ["loaded", "🚤", "Loaded – on the way", t.loadedAtMs],
    ["delivered", "✅", `Delivered at ${t.island || "destination"}`, t.deliveredAtMs],
  ];
  const order = ["received", "loaded", "delivered"];
  const idx = order.indexOf(t.status);
  $("#timeline").innerHTML = steps.map(([k, ic, label, at], i) => `
    <div class="step ${i <= idx ? "done" : ""} ${i === idx ? "now" : ""}">
      <div class="dot">${i <= idx ? ic : ""}</div>
      <div><b>${esc(label)}</b><span class="muted">${i <= idx && at ? fmt(at) : (i <= idx ? "" : "Waiting")}</span></div>
    </div>`).join("");

  const items = (t.items || []).join(", ");
  $("#details").innerHTML = `
    <span>Items</span><b>${esc(items) || "-"}</b>
    ${t.pieces ? `<span>Pieces</span><b>${num(t.pieces)}</b>` : ""}
    ${t.weight ? `<span>Weight</span><b>${num(t.weight)} kg</b>` : ""}
    ${t.cbm ? `<span>Volume</span><b>${num(t.cbm)} CBM</b>` : ""}
    <span>From</span><b>${esc(t.senderName)}</b>
    <span>To</span><b>${esc(t.receiverName)}</b>
    <span>Received</span><b>${fmt(t.createdAtMs)}</b>`;
  $("#payBox").innerHTML = t.paid
    ? `<div class="paidok">✅ Paid · MVR ${num(t.total)}</div>`
    : `<div class="due">⏳ To pay when collecting: MVR ${num(t.total)}</div>`;

  const ph = String(t.boatPhone || "").replace(/\D/g, "");
  const intl = ph.length === 7 ? "960" + ph : ph;
  $("#contactBox").innerHTML = ph ? `
    <a class="btn grow" href="tel:+${intl}">📞 Call boat</a>
    <a class="btn wa grow" target="_blank" href="https://wa.me/${intl}?text=${encodeURIComponent(`Hi, about my cargo receipt #${t.receiptNo}`)}">WhatsApp boat</a>` : "";

  // live boat position (only useful until delivered)
  if (!unsubP) {
    if (t.status === "delivered") { initMap(); $("#mapNote").textContent = "Your cargo has been delivered."; }
    else unsubP = onSnapshot(doc(db, "boatpos", t.boatId), (s) => showPos(s.exists() ? s.data() : null), () => showPos(null));
  } else if (t.status === "delivered") { unsubP(); unsubP = null; $("#mapNote").textContent = "Your cargo has been delivered."; }
  setTimeout(() => map?.invalidateSize(), 100);
}

function track(receipt, last4) {
  const r = String(receipt || "").trim().toUpperCase().replace(/\s+/g, "");
  const p = String(last4 || "").replace(/\D/g, "").slice(-4);
  if (!r || p.length !== 4) { $("#findErr").textContent = "Enter the receipt number and 4 digits."; return; }
  $("#findErr").textContent = "Searching…";
  unsubT?.(); unsubP?.(); unsubP = null;
  unsubT = onSnapshot(doc(db, "tracking", `${r}-${p}`), (s) => {
    if (!s.exists()) {
      if (!current) $("#findErr").textContent = "❌ Not found. Check the receipt number and the last 4 digits of the phone given to the boat.";
      return;
    }
    $("#findErr").textContent = "";
    history.replaceState(null, "", `?r=${encodeURIComponent(r)}&p=${p}`);
    render(s.data());
  }, () => { $("#findErr").textContent = "❌ Could not connect. Check internet and try again."; });
}

// Boat-only map view: track.html?boat=ID (used by crew "Map" button)
function boatOnly(boatId) {
  $("#findForm").classList.add("hidden");
  $("#result").classList.remove("hidden");
  [$("#timeline").closest(".box"), $("#details").closest(".box"), $("#contactBox"), $("#againBtn")].forEach((el) => el.classList.add("hidden"));
  $("#rStatus").textContent = "🚤 Boat location";
  $("#pageTitle").textContent = "Boat location";
  $("#pageSub").textContent = "";
  onSnapshot(doc(db, "boatpos", boatId), (s) => {
    const p = s.exists() ? s.data() : null;
    $("#rBoat").textContent = p?.boatName ? `🚤 ${p.boatName}` : "";
    $("#rVoyage").textContent = p?.voyageName ? `Voyage: ${p.voyageName}` : "";
    showPos(p);
  }, () => showPos(null));
  setTimeout(() => map?.invalidateSize(), 100);
}

$("#findForm").addEventListener("submit", (e) => { e.preventDefault(); track($("#fReceipt").value, $("#fPhone").value); });
$("#againBtn").addEventListener("click", () => {
  unsubT?.(); unsubP?.(); unsubT = unsubP = null; current = null;
  if (marker) { marker.remove(); marker = null; }
  history.replaceState(null, "", location.pathname);
  $("#result").classList.add("hidden"); $("#findForm").classList.remove("hidden");
  $("#pageTitle").textContent = "Where is my cargo?";
  $("#pageSub").textContent = "Enter the receipt number and the last 4 digits of your phone number.";
  $("#fReceipt").value = ""; $("#fPhone").value = "";
});

const qs = new URLSearchParams(location.search);
if (qs.get("boat")) boatOnly(qs.get("boat"));
else if (qs.get("r") && qs.get("p")) { $("#fReceipt").value = qs.get("r"); $("#fPhone").value = qs.get("p"); track(qs.get("r"), qs.get("p")); }
