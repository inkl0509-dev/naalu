// Naalu — cargo receipts for local goods-carrying boats (MVR)
// Firebase Auth + Firestore (works offline, syncs when internet returns)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail, sendEmailVerification
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// App owner / admin. Must match the email in firestore.rules
const ADMIN_EMAIL = "iirufan@gmail.com";
const CURRENCY = "MVR";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ---------------- State ----------------
const DEFAULT_BOAT = {
  name: "My Boat", phone: "", address: "", country: "960",
  footer: "Thank you for choosing us 🚤", islands: []
};
const S = {
  uid: null, boatId: null,
  boat: { ...DEFAULT_BOAT },
  rates: [], cargo: [], contacts: new Map(),
  lines: [], payment: "cash",
  line: null,              // line being edited in modal
  rateMode: "kg", editRateId: null,
  bill: null,              // cargo shown in receipt modal
  filter: "all",
  period: "today", periodCargo: [],
  unsub: [],
};

// ---------------- Helpers ----------------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const money = (n) => `${CURRENCY} ${num(n)}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const col = (name) => collection(db, "boats", S.boatId, name);
const pad = (n) => String(n).padStart(2, "0");
const fmtDateTime = (d) =>
  `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const STATUS = { received: "📥 Received", loaded: "🚤 On boat", delivered: "✅ Delivered" };
const PAY = { cash: "Paid – Cash", transfer: "Paid – Transfer", unpaid: "NOT PAID – collect from receiver" };

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}
const fail = (e) => toast("Error: " + (e?.code || e?.message || e));

function openModal(id) { $(id).classList.remove("hidden"); }
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) e.target.closest(".modal").classList.add("hidden");
  else if (e.target.classList.contains("modal")) e.target.classList.add("hidden");
});

// Maldives: 7-digit local number -> 960xxxxxxx; keeps numbers that already have a country code
function normalizePhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  const cc = S.boat.country || "960";
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = cc + d.slice(1);
  else if (d.length === 7) d = cc + d;
  return d;
}

function updateNet() { $("#netStatus").classList.toggle("hidden", navigator.onLine); }
window.addEventListener("online", updateNet);
window.addEventListener("offline", updateNet);

// ---------------- Auth ----------------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value); }
  catch (err) { fail(err); }
});
$("#signupBtn").addEventListener("click", async () => {
  const email = $("#email").value.trim(), pass = $("#password").value;
  if (!email || pass.length < 6) return toast("Enter email and a 6+ letter password");
  try { await createUserWithEmailAndPassword(auth, email, pass); toast("Account created"); }
  catch (err) { fail(err); }
});
$("#resetBtn").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  if (!email) return toast("Type your email first");
  try { await sendPasswordResetEmail(auth, email); toast("Reset email sent"); }
  catch (err) { fail(err); }
});
$("#logoutBtn").addEventListener("click", () => { if (confirm("Logout from this phone?")) signOut(auth); });
$$("[data-logout]").forEach((b) => b.addEventListener("click", () => signOut(auth)));

// ---------------- Screens / routing ----------------
const SCREENS = ["#login", "#verifyScreen", "#joinScreen", "#adminScreen", "#app"];
function showScreen(id) { SCREENS.forEach((s) => $(s).classList.toggle("hidden", s !== id)); }
function stopListeners() { S.unsub.forEach((u) => u()); S.unsub = []; }

onAuthStateChanged(auth, async (user) => {
  stopListeners();
  S.boatId = null; S.rates = []; S.cargo = []; S.lines = [];
  if (!user) { S.uid = null; showScreen("#login"); return; }
  S.uid = user.uid;
  updateNet();
  $$(".whoami").forEach((el) => el.textContent = "Logged in as " + user.email);
  try {
    if ((user.email || "").toLowerCase() === ADMIN_EMAIL) {
      if (!user.emailVerified) { showScreen("#verifyScreen"); return; }
      await user.getIdToken(true);
      startAdmin(); return;
    }
    const adm = await getDoc(doc(db, "admins", user.uid));
    if (adm.exists()) { startAdmin(); return; }
    const me = await getDoc(doc(db, "users", user.uid));
    if (me.exists()) { await startBoat(me.data().boatId); return; }
    showJoin("");
  } catch (e) {
    showJoin("Could not connect. Check internet and try again. (" + (e.code || e.message) + ")");
  }
});

// Admin email verification
$("#sendVerifyBtn").addEventListener("click", async () => {
  try {
    await sendEmailVerification(auth.currentUser);
    $("#verifyMsg").textContent = `✅ Link sent to ${auth.currentUser.email}. Open Gmail and tap the link (check Spam).`;
  } catch (e) { $("#verifyMsg").textContent = "❌ " + (e.code || e.message); }
});
$("#verifiedBtn").addEventListener("click", async () => {
  const u = auth.currentUser;
  await u.reload();
  if (!u.emailVerified) { $("#verifyMsg").textContent = "Not verified yet. Tap the link in your email first."; return; }
  await u.getIdToken(true);
  startAdmin();
});

// ---------------- Join a boat with a code ----------------
const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const prettyCode = (c) => c.length === 8 ? c.slice(0, 4) + "-" + c.slice(4) : c;

function showJoin(msg) {
  $("#joinMsg").textContent = msg || "";
  $("#joinCode").value = "";
  showScreen("#joinScreen");
}
$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = cleanCode($("#joinCode").value);
  if (code.length < 6) return toast("Enter the code from admin");
  $("#joinMsg").textContent = "Checking…";
  try {
    const c = await getDoc(doc(db, "codes", code));
    if (!c.exists()) { $("#joinMsg").textContent = "❌ Wrong code. Ask admin for the correct code."; return; }
    const boatId = c.data().boatId;
    await setDoc(doc(db, "users", S.uid), { boatId, code, email: auth.currentUser.email || "", joinedAt: Date.now() });
    await startBoat(boatId);
    toast("Welcome aboard! 🚤");
  } catch (err) { $("#joinMsg").textContent = "❌ Could not join: " + (err.code || err.message); }
});

const blocked = () => showJoin("⛔ This boat is turned off or this phone was removed. Contact admin.");
const onListenErr = (e) => (e.code === "permission-denied" ? blocked() : fail(e));

async function startBoat(boatId) {
  S.boatId = boatId;
  let snap;
  try { snap = await getDoc(doc(db, "boats", boatId)); } catch { blocked(); return; }
  if (!snap.exists()) { showJoin("⛔ Boat not found. Contact admin."); return; }
  S.boat = { ...DEFAULT_BOAT, ...snap.data() };
  showScreen("#app");
  applyBoat();

  S.unsub.push(onSnapshot(doc(db, "boats", boatId), (d) => {
    if (d.exists()) { S.boat = { ...DEFAULT_BOAT, ...d.data() }; applyBoat(); }
  }, onListenErr));
  S.unsub.push(onSnapshot(query(col("rates"), orderBy("name")), (snap) => {
    S.rates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRateChips(); renderRateList();
  }, onListenErr));
  S.unsub.push(onSnapshot(query(col("cargo"), orderBy("createdAtMs", "desc"), limit(500)), (snap) => {
    S.cargo = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCargoList();
    if (S.bill) { const fresh = S.cargo.find((c) => c.id === S.bill.id); if (fresh) refreshBill(fresh); }
  }, onListenErr));
  S.unsub.push(onSnapshot(col("contacts"), (snap) => {
    S.contacts = new Map(snap.docs.map((d) => [d.id, d.data().name]));
    $("#contactList").innerHTML = [...S.contacts].map(([p, n]) => `<option value="${esc(p)}">${esc(n)}</option>`).join("");
  }, onListenErr));
}

// ---------------- Navigation ----------------
$$(".bottomnav button").forEach((b) => b.addEventListener("click", () => {
  $$(".bottomnav button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + b.dataset.view).classList.remove("hidden");
  if (b.dataset.view === "accounts") loadAccounts();
  if (b.dataset.view === "settings") fillSettings();
  window.scrollTo(0, 0);
}));

// ---------------- RECEIVE CARGO ----------------
// Auto-fill name when a known phone number is typed
function autofill(phoneSel, nameSel) {
  $(phoneSel).addEventListener("change", () => {
    const p = $(phoneSel).value.replace(/\D/g, "");
    const n = S.contacts.get(p);
    if (n && !$(nameSel).value.trim()) $(nameSel).value = n;
  });
}
autofill("#sPhone", "#sName");
autofill("#rPhone", "#rName");

function renderRateChips() {
  $("#rateChips").innerHTML = S.rates.map((r) =>
    `<button type="button" class="chip" data-rate="${r.id}"><b>${esc(r.name)}</b><small>${num(r.rate)}${r.mode === "kg" ? "/kg" : "/pc"}</small></button>`
  ).join("") + `<button type="button" class="chip other" data-rate="">＋ Other item</button>`;
}
$("#rateChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  const r = S.rates.find((x) => x.id === b.dataset.rate);
  openLine(r ? { desc: r.name, mode: r.mode, rate: r.rate, min: r.min || 0, qty: "" }
             : { desc: "", mode: "fixed", rate: "", min: 0, qty: "" }, -1);
});

// --- Item line modal ---
function openLine(line, index) {
  S.line = { ...line, index };
  $("#lineTitle").textContent = index >= 0 ? "Edit item" : "Add item";
  $("#lDesc").value = line.desc;
  $("#lQty").value = line.mode === "kg" ? (line.weight ?? line.qty ?? "") : (line.qty ?? "");
  $("#lRate").value = line.rate ?? "";
  $("#lAmount").value = line.amount ?? "";
  setLineMode(line.mode);
  openModal("#lineModal");
  setTimeout(() => (line.desc ? $(line.mode === "fixed" ? "#lAmount" : "#lQty") : $("#lDesc")).focus(), 80);
}
function setLineMode(mode) {
  S.line.mode = mode;
  $$("#lineModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#lQtyRow").classList.toggle("hidden", mode === "fixed");
  $("#lQtyLabel").firstChild.textContent = mode === "kg" ? "Weight (kg) " : "Pieces ";
  $("#lRateLabel").firstChild.textContent = mode === "kg" ? "Rate (MVR/kg) " : "Price each (MVR) ";
  $("#lQty").step = mode === "kg" ? "any" : "1";
  calcLine();
}
$("#lineModeSeg").addEventListener("click", (e) => { if (e.target.dataset.mode) setLineMode(e.target.dataset.mode); });

function calcLine() {
  const L = S.line; if (!L) return;
  if (L.mode === "fixed") { $("#lMinNote").classList.add("hidden"); return; }
  const q = Number($("#lQty").value) || 0, r = Number($("#lRate").value) || 0;
  let amt = round2(q * r);
  const min = Number(L.min) || 0;
  const useMin = min > 0 && q > 0 && amt < min;
  if (useMin) amt = min;
  $("#lMinNote").textContent = useMin ? `Minimum charge ${money(min)} applied` : "";
  $("#lMinNote").classList.toggle("hidden", !useMin);
  $("#lAmount").value = q && r ? amt : "";
}
$("#lQty").addEventListener("input", calcLine);
$("#lRate").addEventListener("input", calcLine);

$("#lineForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const L = S.line;
  const q = Number($("#lQty").value) || 0;
  const line = {
    desc: $("#lDesc").value.trim(),
    mode: L.mode,
    qty: L.mode === "piece" ? q : (L.mode === "fixed" ? 1 : 0),
    weight: L.mode === "kg" ? q : 0,
    rate: L.mode === "fixed" ? 0 : Number($("#lRate").value) || 0,
    min: Number(L.min) || 0,
    amount: round2($("#lAmount").value),
  };
  if (!line.desc) return toast("Enter description");
  if (L.mode !== "fixed" && !q) return toast(L.mode === "kg" ? "Enter weight" : "Enter number of pieces");
  if (L.index >= 0) S.lines[L.index] = line; else S.lines.push(line);
  $("#lineModal").classList.add("hidden");
  renderLines();
});

function lineLabel(l) {
  const minNote = l.min && l.amount === l.min && round2((l.weight || l.qty) * l.rate) < l.min ? " (min charge)" : "";
  if (l.mode === "kg") return `${num(l.weight)} kg × ${num(l.rate)}${minNote}`;
  if (l.mode === "piece") return `${num(l.qty)} pc${l.qty === 1 ? "" : "s"} × ${num(l.rate)}${minNote}`;
  return "Fixed price";
}
const linesTotal = () => round2(S.lines.reduce((s, l) => s + l.amount, 0));

function renderLines() {
  $("#lineList").innerHTML = S.lines.map((l, i) => `
    <div class="line tap" data-i="${i}">
      <div class="grow"><b>${esc(l.desc)}</b><div class="muted">${lineLabel(l)}</div></div>
      <b>${num(l.amount)}</b>
      <button type="button" class="x" data-del="${i}">✕</button>
    </div>`).join("") || `<div class="empty small">No items yet</div>`;
  $("#cTotal").textContent = money(linesTotal());
}
$("#lineList").addEventListener("click", (e) => {
  if (e.target.dataset.del !== undefined) { S.lines.splice(+e.target.dataset.del, 1); renderLines(); return; }
  const row = e.target.closest(".line"); if (row) openLine(S.lines[+row.dataset.i], +row.dataset.i);
});

function setPayment(p) {
  S.payment = p;
  $$("#paySeg button").forEach((b) => b.classList.toggle("active", b.dataset.pay === p));
  $("#cRef").classList.toggle("hidden", p !== "transfer");
  $("#unpaidHint").classList.toggle("hidden", p !== "unpaid");
}
$("#paySeg").addEventListener("click", (e) => { if (e.target.dataset.pay) setPayment(e.target.dataset.pay); });

function clearForm() {
  $("#cargoForm").reset();
  S.lines = []; renderLines(); setPayment("cash");
}
$("#clearFormBtn").addEventListener("click", () => { if (confirm("Clear this form?")) clearForm(); });

function makeReceiptNo(d) {
  const r = Math.floor(Math.random() * 90 + 10);
  return `N${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${r}`;
}

$("#cargoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!S.lines.length) return toast("Add at least one item");
  const now = new Date();
  const sPhone = $("#sPhone").value.replace(/\D/g, "");
  const rPhone = $("#rPhone").value.replace(/\D/g, "");
  const island = $("#rIsland").value.trim();
  const paid = S.payment !== "unpaid";
  const cargo = {
    receiptNo: makeReceiptNo(now),
    sender: { name: $("#sName").value.trim(), phone: sPhone },
    receiver: { name: $("#rName").value.trim(), phone: rPhone, island },
    lines: S.lines,
    pieces: S.lines.reduce((s, l) => s + (l.mode === "piece" ? l.qty : 1), 0),
    weight: round2(S.lines.reduce((s, l) => s + (l.weight || 0), 0)),
    total: linesTotal(),
    payment: S.payment,
    paid,
    paidMethod: paid ? S.payment : "",
    paidAtMs: paid ? now.getTime() : 0,
    ref: S.payment === "transfer" ? $("#cRef").value.trim() : "",
    notes: $("#cNotes").value.trim(),
    status: "received",
    statusAtMs: now.getTime(),
    createdBy: auth.currentUser?.email || "",
    createdAtMs: now.getTime(),
    createdAt: serverTimestamp(),
  };
  const ref = doc(col("cargo"));
  setDoc(ref, cargo).catch(fail);   // not awaited: works offline
  cargo.id = ref.id;

  // remember contacts + island for next time
  if (sPhone) setDoc(doc(col("contacts"), sPhone), { name: cargo.sender.name, updatedAt: Date.now() }).catch(() => {});
  if (rPhone) setDoc(doc(col("contacts"), rPhone), { name: cargo.receiver.name, updatedAt: Date.now() }).catch(() => {});
  if (island && !(S.boat.islands || []).includes(island))
    updateDoc(doc(db, "boats", S.boatId), { islands: arrayUnion(island) }).catch(() => {});

  clearForm();
  showBill(cargo);
  toast(`Saved ✔ ${money(cargo.total)}`);
});

// ---------------- RECEIPT ----------------
function receiptText(c) {
  const L = [`*${S.boat.name}*`];
  if (S.boat.phone) L.push(`📞 ${S.boat.phone}`);
  L.push(`Receipt #${c.receiptNo}`, fmtDateTime(new Date(c.createdAtMs)), "--------------------------");
  L.push(`From: ${c.sender.name}${c.sender.phone ? ` (${c.sender.phone})` : ""}`);
  L.push(`To: ${c.receiver.name}${c.receiver.phone ? ` (${c.receiver.phone})` : ""}`);
  L.push(`Island: ${c.receiver.island}`, "--------------------------");
  c.lines.forEach((l) => {
    if (l.mode === "fixed") L.push(`${l.desc} = ${num(l.amount)}`);
    else L.push(`${l.desc}\n   ${lineLabel(l)} = ${num(l.amount)}`);
  });
  L.push("--------------------------");
  L.push(`*TOTAL: ${money(c.total)}*`);
  if (c.paid) L.push(`✅ Paid – ${c.paidMethod === "transfer" ? "Bank Transfer" : "Cash"}${c.ref ? ` (${c.ref})` : ""}`);
  else L.push(`⏳ NOT PAID – collect ${money(c.total)} from receiver`);
  L.push(`Status: ${STATUS[c.status] || c.status}`);
  if (c.notes) L.push(`Note: ${c.notes}`);
  if (S.boat.footer) L.push("", S.boat.footer);
  return L.join("\n");
}

function showBill(c) {
  S.bill = c;
  refreshBill(c);
  openModal("#billModal");
}
function refreshBill(c) {
  S.bill = c;
  $("#billText").textContent = receiptText(c);
  $$("#billStatusSeg button").forEach((b) => b.classList.toggle("active", b.dataset.s === c.status));
  $("#payNowBox").classList.toggle("hidden", !!c.paid);
  $("#billDeleteBtn").classList.toggle("hidden", !c.id);
}
// Close receipt → forget it so list updates don't re-open it
new MutationObserver(() => { if ($("#billModal").classList.contains("hidden")) S.bill = null; })
  .observe($("#billModal"), { attributes: true, attributeFilter: ["class"] });

$("#billStatusSeg").addEventListener("click", (e) => {
  const s = e.target.dataset.s; if (!s || !S.bill) return;
  updateDoc(doc(col("cargo"), S.bill.id), { status: s, statusAtMs: Date.now() }).catch(fail);
  refreshBill({ ...S.bill, status: s });
  toast(STATUS[s]);
});
$("#payNowBox").addEventListener("click", (e) => {
  const m = e.target.dataset.paynow; if (!m || !S.bill) return;
  const upd = { paid: true, paidMethod: m, paidAtMs: Date.now() };
  updateDoc(doc(col("cargo"), S.bill.id), upd).catch(fail);
  refreshBill({ ...S.bill, ...upd });
  toast("Marked as paid ✔");
});

$("#billModal").addEventListener("click", async (e) => {
  const how = e.target.dataset.send; if (!how || !S.bill) return;
  const c = S.bill;
  const toReceiver = how.endsWith("receiver");
  const phone = normalizePhone(toReceiver ? c.receiver.phone : c.sender.phone);
  const text = receiptText(c);
  if (how.startsWith("wa")) {
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank");
  } else {
    // Viber can't reliably pre-fill text for a number: copy receipt, open the chat, user pastes
    try { await navigator.clipboard.writeText(text.replace(/\*/g, "")); } catch {}
    if (phone) {
      toast("Receipt copied – paste it in Viber");
      location.href = `viber://chat?number=%2B${phone}&draft=${encodeURIComponent(text.replace(/\*/g, ""))}`;
    } else {
      location.href = `viber://forward?text=${encodeURIComponent(text.replace(/\*/g, ""))}`;
    }
  }
});

function printWindow(title, body, css) {
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups to print"); return; }
  w.document.write(`<html><head><title>${esc(title)}</title><style>${css}</style></head><body>${body}
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
}
$("#billPrintBtn").addEventListener("click", () => {
  printWindow("Receipt " + S.bill.receiptNo,
    `<pre>${esc(receiptText(S.bill).replace(/\*/g, ""))}</pre>`,
    "body{font:13px monospace;width:72mm;margin:0 auto;padding:6px}pre{white-space:pre-wrap;margin:0}");
});
$("#labelPrintBtn").addEventListener("click", () => {
  const c = S.bill;
  const n = parseInt(prompt("How many box labels?", String(c.pieces || 1)), 10);
  if (!n || n < 1) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  try { JsBarcode(svg, c.receiptNo, { format: "CODE128", height: 40, width: 1.6, fontSize: 12, margin: 0 }); } catch {}
  const bc = svg.outerHTML;
  const labels = Array.from({ length: Math.min(n, 200) }, (_, i) => `
    <div class="lb">
      <div class="to">TO: ${esc(c.receiver.name)}</div>
      <div class="isl">${esc(c.receiver.island)}</div>
      <div>📞 ${esc(c.receiver.phone)}</div>
      <div class="sm">From: ${esc(c.sender.name)} ${esc(c.sender.phone)}</div>
      <div class="row"><b>${i + 1} / ${n}</b><span>${c.paid ? "PAID" : "COLLECT " + esc(money(c.total))}</span></div>
      ${bc}
      <div class="sm">${esc(S.boat.name)}</div>
    </div>`).join("");
  printWindow("Labels " + c.receiptNo, labels,
    `body{font-family:sans-serif;margin:0}.lb{width:90mm;border:2px solid #000;border-radius:6px;padding:8px;margin:6px;display:inline-block;vertical-align:top;page-break-inside:avoid}
     .to{font-size:20px;font-weight:800}.isl{font-size:26px;font-weight:900;text-transform:uppercase}.sm{font-size:11px;color:#333}
     .row{display:flex;justify-content:space-between;margin:4px 0;font-size:14px}svg{max-width:100%}`);
});
$("#billDeleteBtn").addEventListener("click", () => {
  if (!confirm("Delete this receipt? This cannot be undone.")) return;
  deleteDoc(doc(col("cargo"), S.bill.id)).catch(fail);
  $("#billModal").classList.add("hidden");
  toast("Receipt deleted");
  if (!$("#view-accounts").classList.contains("hidden")) setTimeout(loadAccounts, 300);
});

// ---------------- CARGO LIST ----------------
function cargoRow(c) {
  return `<div class="line tap cargo-row" data-id="${c.id}">
    <div class="grow">
      <b>${esc(c.receiver.name)}</b> <span class="isl-tag">${esc(c.receiver.island)}</span>
      <div class="muted">From ${esc(c.sender.name)} · #${esc(c.receiptNo)}</div>
      <div class="muted">${fmtDateTime(new Date(c.createdAtMs))} · ${c.lines.length} item${c.lines.length === 1 ? "" : "s"}</div>
    </div>
    <div class="right">
      <b>${money(c.total)}</b>
      <span class="tag ${c.paid ? "cash" : "offtag"}">${c.paid ? "Paid" : "Not paid"}</span>
      <span class="tag st-${c.status}">${STATUS[c.status]}</span>
    </div>
  </div>`;
}
function renderCargoList() {
  const q = $("#cargoSearch").value.trim().toLowerCase();
  const list = S.cargo.filter((c) => {
    if (S.filter === "unpaid" ? c.paid : (S.filter !== "all" && c.status !== S.filter)) return false;
    if (!q) return true;
    return [c.receiptNo, c.sender.name, c.sender.phone, c.receiver.name, c.receiver.phone, c.receiver.island, c.notes]
      .join(" ").toLowerCase().includes(q);
  });
  $("#cargoList").innerHTML = list.map(cargoRow).join("") || `<div class="empty">No cargo found</div>`;
}
$("#cargoSearch").addEventListener("input", renderCargoList);
$("#statusSeg").addEventListener("click", (e) => {
  const f = e.target.dataset.f; if (!f) return;
  S.filter = f;
  $$("#statusSeg button").forEach((b) => b.classList.toggle("active", b.dataset.f === f));
  renderCargoList();
});
$("#cargoList").addEventListener("click", (e) => {
  const row = e.target.closest(".line"); if (!row) return;
  const c = S.cargo.find((x) => x.id === row.dataset.id); if (c) showBill(c);
});

// ---------------- RATES ----------------
function setRateMode(m) {
  S.rateMode = m;
  $$("#rateModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
}
$("#rateModeSeg").addEventListener("click", (e) => { if (e.target.dataset.mode) setRateMode(e.target.dataset.mode); });

function renderRateList() {
  $("#rateList").innerHTML = S.rates.map((r) => `
    <div class="line tap" data-id="${r.id}">
      <div class="grow"><b>${esc(r.name)}</b>
        <div class="muted">${r.mode === "kg" ? "Per kg" : "Per piece"}${r.min ? ` · min ${money(r.min)}` : ""}</div></div>
      <b>${money(r.rate)}${r.mode === "kg" ? "/kg" : ""}</b>
      <button class="x" data-del-rate="${r.id}">🗑</button>
    </div>`).join("") || `<div class="empty">No rates yet. Examples: Box (per kg), Motorcycle (per piece), Cement bag (per piece).</div>`;
}
function resetRateForm() {
  S.editRateId = null; $("#rateForm").reset(); setRateMode("kg");
  $("#rateSave").textContent = "+ Add rate"; $("#rateCancel").classList.add("hidden");
}
$("#rateCancel").addEventListener("click", resetRateForm);
$("#rateList").addEventListener("click", (e) => {
  const del = e.target.dataset.delRate;
  if (del) {
    if (confirm("Delete this rate?")) deleteDoc(doc(col("rates"), del)).catch(fail);
    return;
  }
  const row = e.target.closest(".line"); if (!row) return;
  const r = S.rates.find((x) => x.id === row.dataset.id); if (!r) return;
  S.editRateId = r.id;
  $("#rateName").value = r.name; $("#rateValue").value = r.rate; $("#rateMin").value = r.min || "";
  setRateMode(r.mode);
  $("#rateSave").textContent = "Save changes"; $("#rateCancel").classList.remove("hidden");
  window.scrollTo(0, 0);
});
$("#rateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = {
    name: $("#rateName").value.trim(), mode: S.rateMode,
    rate: Number($("#rateValue").value) || 0, min: Number($("#rateMin").value) || 0,
  };
  const ref = S.editRateId ? doc(col("rates"), S.editRateId) : doc(col("rates"));
  setDoc(ref, data).catch(fail);
  toast(S.editRateId ? "Rate updated" : "Rate added");
  resetRateForm();
});

// ---------------- ACCOUNTS ----------------
function periodRange() {
  const now = new Date();
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  switch (S.period) {
    case "yesterday": return [addDays(sod, -1), sod];
    case "week": return [addDays(sod, -6), addDays(sod, 1)];
    case "month": return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1)];
    case "custom": {
      const f = $("#fromDate").value ? new Date($("#fromDate").value + "T00:00") : sod;
      const t = $("#toDate").value ? new Date($("#toDate").value + "T00:00") : sod;
      return [f, addDays(t, 1)];
    }
    default: return [sod, addDays(sod, 1)];
  }
}
$("#periodSeg").addEventListener("click", (e) => {
  const p = e.target.dataset.p; if (!p) return;
  S.period = p;
  $$("#periodSeg button").forEach((b) => b.classList.toggle("active", b.dataset.p === p));
  $("#customRange").classList.toggle("hidden", p !== "custom");
  if (p === "custom") {
    const today = toDateInput(new Date());
    if (!$("#fromDate").value) $("#fromDate").value = today;
    if (!$("#toDate").value) $("#toDate").value = today;
  }
  loadAccounts();
});
$("#applyRange").addEventListener("click", loadAccounts);

async function loadAccounts() {
  if (!S.boatId) return;
  const [from, to] = periodRange().map((d) => d.getTime());
  const rangeQ = (name) => query(col(name), where("createdAtMs", ">=", from), where("createdAtMs", "<", to), orderBy("createdAtMs", "desc"));
  let cargo = [], expenses = [];
  try {
    const [cs, es] = await Promise.all([getDocs(rangeQ("cargo")), getDocs(rangeQ("expenses"))]);
    cargo = cs.docs.map((d) => ({ id: d.id, ...d.data() }));
    expenses = es.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { return fail(e); }
  S.periodCargo = cargo;

  const sum = (arr, f) => round2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  const billed = sum(cargo, (c) => c.total);
  const cash = sum(cargo.filter((c) => c.paid && c.paidMethod === "cash"), (c) => c.total);
  const transfer = sum(cargo.filter((c) => c.paid && c.paidMethod === "transfer"), (c) => c.total);
  const unpaid = sum(cargo.filter((c) => !c.paid), (c) => c.total);
  const kg = sum(cargo, (c) => c.weight);
  const exp = sum(expenses, (e) => e.amount);
  const collected = cash + transfer;
  const net = collected - exp;

  const stat = (label, value, cls = "") => `<div class="stat ${cls}"><span>${label}</span><b>${value}</b></div>`;
  $("#stats").innerHTML =
    stat("Total billed", money(billed), "big") +
    stat("Receipts", cargo.length) +
    stat("Weight carried", `${num(kg)} kg`) +
    stat("💵 Cash received", money(cash)) +
    stat("🏦 Transfer received", money(transfer)) +
    stat("⏳ Not paid yet", money(unpaid), unpaid ? "bad" : "") +
    stat("Expenses", money(exp)) +
    stat("Profit (received − expenses)", money(net), net >= 0 ? "good big" : "bad big");

  const agg = {};
  cargo.forEach((c) => {
    const a = agg[c.receiver.island || "-"] ||= { n: 0, amt: 0 };
    a.n++; a.amt += c.total;
  });
  $("#byIsland").innerHTML = Object.entries(agg).sort((a, b) => b[1].amt - a[1].amt).map(([isl, a]) =>
    `<div class="line"><div class="grow">${esc(isl)}</div><span class="muted">${a.n} receipt${a.n === 1 ? "" : "s"}</span><b>${money(a.amt)}</b></div>`
  ).join("") || `<div class="empty">No cargo in this period</div>`;

  $("#billList").innerHTML = cargo.map(cargoRow).join("") || `<div class="empty">No receipts</div>`;
  $("#expenseList").innerHTML = expenses.map((e) => `
    <div class="line">
      <div class="grow">${esc(e.title)}<div class="muted">${fmtDateTime(new Date(e.createdAtMs))}</div></div>
      <b>${money(e.amount)}</b><button class="x" data-del-exp="${e.id}">🗑</button>
    </div>`).join("") || `<div class="empty">No expenses</div>`;
}
$("#billList").addEventListener("click", (e) => {
  const row = e.target.closest(".line"); if (!row) return;
  const c = S.periodCargo.find((x) => x.id === row.dataset.id); if (c) showBill(c);
});
$("#expenseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  setDoc(doc(col("expenses")), {
    title: $("#expTitle").value.trim(), amount: Number($("#expAmount").value) || 0,
    createdAtMs: Date.now(), createdAt: serverTimestamp(),
  }).catch(fail);
  $("#expTitle").value = ""; $("#expAmount").value = "";
  toast("Expense added");
  setTimeout(loadAccounts, 300);
});
$("#expenseList").addEventListener("click", (e) => {
  const id = e.target.dataset.delExp; if (!id || !confirm("Delete this expense?")) return;
  deleteDoc(doc(col("expenses"), id)).catch(fail);
  setTimeout(loadAccounts, 300);
});
$("#exportCsv").addEventListener("click", () => {
  if (!S.periodCargo.length) return toast("No receipts in this period");
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Receipt", "Date", "Sender", "Sender phone", "Receiver", "Receiver phone", "Island",
    "Item", "Weight kg", "Pieces", "Rate", "Amount", "Receipt total", "Paid", "Method", "Status"]];
  S.periodCargo.forEach((c) => c.lines.forEach((l) => rows.push([
    c.receiptNo, fmtDateTime(new Date(c.createdAtMs)), c.sender.name, c.sender.phone, c.receiver.name, c.receiver.phone,
    c.receiver.island, l.desc, l.weight || "", l.mode === "piece" ? l.qty : "", l.rate || "", l.amount, c.total,
    c.paid ? "Yes" : "No", c.paidMethod, c.status])));
  const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `naalu-${S.period}-${toDateInput(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------- SETTINGS ----------------
function applyBoat() {
  $("#shopTitle").textContent = "🚤 " + S.boat.name;
  document.title = S.boat.name + " · Naalu";
  const islands = S.boat.islands || [];
  $("#islandList").innerHTML = islands.map((i) => `<option value="${esc(i)}">`).join("");
  $("#islandChips").innerHTML = islands.map((i) =>
    `<span class="chip static">${esc(i)} <button class="x" data-del-isl="${esc(i)}">✕</button></span>`).join("")
    || `<span class="muted">None yet</span>`;
}
$("#islandChips").addEventListener("click", (e) => {
  const isl = e.target.dataset.delIsl; if (isl === undefined) return;
  updateDoc(doc(db, "boats", S.boatId), { islands: (S.boat.islands || []).filter((x) => x !== isl) }).catch(fail);
});
function fillSettings() {
  $("#setName").value = S.boat.name;
  $("#setPhone").value = S.boat.phone;
  $("#setAddress").value = S.boat.address;
  $("#setCountry").value = S.boat.country;
  $("#setFooter").value = S.boat.footer;
}
$("#settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const changes = {
    name: $("#setName").value.trim() || "My Boat",
    phone: $("#setPhone").value.trim(),
    address: $("#setAddress").value.trim(),
    country: $("#setCountry").value.replace(/\D/g, "") || "960",
    footer: $("#setFooter").value.trim(),
  };
  S.boat = { ...S.boat, ...changes };
  updateDoc(doc(db, "boats", S.boatId), changes).catch(fail);
  applyBoat();
  toast("Settings saved ✔");
});

// ---------------- ADMIN ----------------
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  const r = crypto.getRandomValues(new Uint32Array(8));
  return [...r].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
}
const A = { boats: [], users: [] };

function startAdmin() {
  showScreen("#adminScreen");
  S.unsub.push(onSnapshot(query(collection(db, "boats"), orderBy("createdAtMs", "desc")), (snap) => {
    A.boats = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderAdmin();
  }, fail));
  S.unsub.push(onSnapshot(collection(db, "users"), (snap) => {
    A.users = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderAdmin();
  }, fail));
}
function renderAdmin() {
  $("#adminCount").textContent = `${A.boats.length} boat${A.boats.length === 1 ? "" : "s"}`;
  $("#shopList").innerHTML = A.boats.length ? A.boats.map((b) => {
    const members = A.users.filter((u) => u.boatId === b.id);
    return `<div class="shopcard ${b.active ? "" : "off"}" data-id="${b.id}">
      <div class="row between"><b class="grow">🚤 ${esc(b.name)}</b>
        <span class="tag ${b.active ? "cash" : "offtag"}">${b.active ? "Active" : "Turned off"}</span></div>
      <div class="code">${prettyCode(esc(b.code))}</div>
      <div class="row wrap">
        <button class="btn small wa" data-a="share">Share code</button>
        <button class="btn small" data-a="copy">Copy</button>
        <button class="btn small" data-a="regen">New code</button>
        <button class="btn small ${b.active ? "danger-outline" : ""}" data-a="toggle">${b.active ? "Turn off" : "Turn on"}</button>
      </div>
      <div class="muted">📱 ${members.length} phone${members.length === 1 ? "" : "s"} logged in</div>
      ${members.map((u) => `<div class="member"><span class="grow">${esc(u.email || u.id)}</span>
        <button class="x" data-a="kick" data-uid="${u.id}" title="Remove">✕</button></div>`).join("")}
    </div>`;
  }).join("") : `<div class="empty">No boats yet. Create the first one above.</div>`;
}
$("#newShopForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newShopName").value.trim(); if (!name) return;
  const code = newCode();
  const ref = doc(collection(db, "boats"));
  const b = writeBatch(db);
  b.set(ref, { ...DEFAULT_BOAT, name, code, active: true, createdAtMs: Date.now() });
  b.set(doc(db, "codes", code), { boatId: ref.id, createdAtMs: Date.now() });
  try { await b.commit(); $("#newShopName").value = ""; toast(`Boat created. Code: ${prettyCode(code)}`); }
  catch (err) { fail(err); }
});
$("#shopList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-a]"); if (!btn) return;
  const bt = A.boats.find((x) => x.id === btn.closest(".shopcard").dataset.id); if (!bt) return;
  const msg = `Your *Naalu* boat code for "${bt.name}":\n\n*${prettyCode(bt.code)}*\n\n1. Open ${location.origin}\n2. Create account / login\n3. Enter this code`;
  try {
    switch (btn.dataset.a) {
      case "share": window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank"); break;
      case "copy": await navigator.clipboard.writeText(prettyCode(bt.code)); toast("Code copied"); break;
      case "toggle":
        if (bt.active && !confirm(`Turn off "${bt.name}"? Its phones will stop working until you turn it on.`)) return;
        await updateDoc(doc(db, "boats", bt.id), { active: !bt.active });
        break;
      case "regen": {
        if (!confirm("Make a new code? The old code stops working for NEW phones. Phones already logged in keep working.")) return;
        const code = newCode();
        const b = writeBatch(db);
        b.delete(doc(db, "codes", bt.code));
        b.set(doc(db, "codes", code), { boatId: bt.id, createdAtMs: Date.now() });
        b.update(doc(db, "boats", bt.id), { code });
        await b.commit();
        toast("New code: " + prettyCode(code));
        break;
      }
      case "kick": {
        const u = A.users.find((x) => x.id === btn.dataset.uid);
        if (!confirm(`Remove ${u?.email || "this phone"} from "${bt.name}"?`)) return;
        await deleteDoc(doc(db, "users", btn.dataset.uid));
        toast("Removed");
        break;
      }
    }
  } catch (err) { fail(err); }
});

renderLines();
