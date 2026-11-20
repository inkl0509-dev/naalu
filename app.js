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
  footer: "Thank you for choosing us 🚤", islands: [],
  legalName: "", tin: "", gstRate: 8, gstInclusive: false, taxDefault: false, currentVoyageId: ""
};
const S = {
  uid: null, boatId: null,
  boat: { ...DEFAULT_BOAT },
  rates: [], cargo: [], contacts: new Map(), voyages: [],
  acctMode: "dates", acctVoyageId: "",
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
function stopListeners() { S.unsub.forEach((u) => u()); S.unsub = []; if (typeof stopLocation === "function") stopLocation(true); }

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
  clearForm();
  $("#portalLink").textContent = portalUrl();
  resumeLocationIfWanted();

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
  S.unsub.push(onSnapshot(query(col("voyages"), orderBy("createdAtMs", "desc")), (snap) => {
    S.voyages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderVoyageSelects();
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

// ---------------- LANGUAGE (English / Dhivehi) ----------------
const DV = {
  sender: "ފޮނުވާ ފަރާތް (ކަސްޓަމަރު)",
  senderPhone: "ފޮނުވާ ފަރާތުގެ ފޯނު ނަންބަރު",
  senderName: "ފޮނުވާ ފަރާތުގެ ނަން",
  receiver: "ލިބޭ ފަރާތް",
  receiverName: "ލިބޭ ފަރާތުގެ ނަން",
  receiverPhone: "ލިބޭ ފަރާތުގެ ފޯނު ނަންބަރު",
  items: "އައިޓަމްތައް، އިތުރުކުރުމަށް ރޭޓަށް ފިތާލާ",
  otherItem: "އެހެނިހެން އައިޓަމް",
  noItems: "އަދި އެއްވެސް އައިޓަމެއް ނެތް",
  total: "ޖުމްލަ",
  cash: "ނަގުދު ފައިސާ",
  transfer: "ޓްރާންސްފަރ",
  unpaid: "ފައިސާ ނުދައްކާ",
  card: "ކާޑު",
  save: "ސޭވްކޮށް ރަސީދު ހަދާ",
  clear: "ފޯމު ހުސްކުރޭ",
  sendTo: "ފޮނުވާ ރަށް / ތަން",
  notes: "ނޯޓު (އިޚްތިޔާރީ) މިސާލަކަށް: ނާޒުކު، ހިއްކާފައި ބެހެއްޓުން",
  taxInvoice: "🧾 ޓެކްސް އިންވޮއިސް (ޖީ.އެސް.ޓީ {r}%)",
  voyage: "ދަތުރު",
  noVoyage: "ދަތުރެއް ނެތް",
  newVoyage: "އާ ދަތުރު",
  ratesIntro: "އަގުތައް އެއްފަހަރު ކަނޑައަޅާށެވެ. އެއަށްފަހު މުދާ ބަލައިގަންނައިރު އޭގައި ޓެޕްކޮށްލާށެވެ.",
  rateName: "މުދަލުގެ ނަން، މިސާލަކަށް: ފޮށިގަނޑު، ސައިކަލް، ސިމެންތި ބަސްތާ",
  perKg: "ކިލޯއަކަށް",
  perPiece: "ޕީސްއަކަށް",
  perCbm: "ސީ.ބީ.އެމް އަކަށް",
  bySize: "ސައިޒުން",
  priceKg: "ކިލޯއެއްގެ އަގު (ދިވެހި ރުފިޔާ)",
  pricePiece: "ޕީސްއެއްގެ އަގު (ދިވެހި ރުފިޔާ)",
  priceCbm: "ސީ.ބީ.އެމް އެއްގެ އަގު (ދިވެހި ރުފިޔާ)",
  minCharge: "އެންމެ ކުޑަ އަގު (ދިވެހި ރުފިޔާ) (އިޚްތިޔާރީ)",
  addRate: "ރޭޓް އިތުރުކުރޭ",
  noRates: "އަދި އެއްވެސް ރޭޓެއް ނެތެވެ. މިސާލު: ފޮށިގަނޑު (ކިލޯއަކަށް)، ސައިކަލް (ޕީސްއަކަށް)، ފަރުނީޗަރު (ސީ.ބީ.އެމް އަކަށް)، ކޮންޓޭނަރު (ސައިޒުން).",
  boatName: "ދޯނީގެ ނަން",
  boatPhone: "ދޯނީގެ ފޯނު",
  homeIsland: "ރަށް (ހޯމް އައިލެންޑް) / އޮފީސް",
  country: "ކަންޓްރީ ކޯޑު (ދިވެހިރާއްޖެ = 960)",
  footer: "ރަސީދުގެ ތިރީގައި ހިމަނާ މެސެޖު",
  taxHead: "🧾 ޓެކްސް (ޖީ.އެސް.ޓީ) އިންވޮއިސް",
  legalName: "ރަޖިސްޓްރީކޮށްފައިވާ ވިޔަފާރީގެ ނަން",
  asOnCert: "ޖީ.އެސް.ޓީ ސެޓްފިކެޓުގައިވާ ގޮތަށް",
  tin: "ޓީ.އައި.އެން / ޖީ.އެސް.ޓީ ރަޖިސްޓްރީ ނަންބަރު",
  gstRate: "ޖީ.އެސް.ޓީ ރޭޓް (%)",
  gstIncl: "އަހަރެންގެ އަގުތަކުގައި ޖީ.އެސް.ޓީ ހިމެނިފައި",
  taxDefault: "ކޮންމެ ރަސީދެއް ޓެކްސް އިންވޮއިސްއަކަށް ހަދާ",
  saveSettings: "ސެޓިންގްސް ސޭވްކުރޭ",
  islandsList: "ރަށްތަކުގެ ލިސްޓު",
  islandsAuto: "މުދާ ސޭވްކުރުމުން އާ ރަށްތައް އަމިއްލައަށް އިތުރުވާނެއެވެ.",
  noneYet: "އަދި އެއްވެސް އެއްޗެއް ނެތް",
  logout: "ލޮގް އައުޓް",
};
const EN = {
  otherItem: "＋ Other item", noItems: "No items yet", taxInvoice: "🧾 Tax invoice (GST {r}%)",
  noVoyage: "No voyage", priceKg: "Price per kg (MVR)", pricePiece: "Price per piece (MVR)",
  priceCbm: "Price per CBM (MVR)", addRate: "Add rate",
  noRates: "No rates yet. Examples: Box (per kg), Motorcycle (per piece), Furniture (per CBM), Container (by size).",
  noneYet: "None yet",
};
// Receipt footer suggestions (receipt text itself is chosen by the boat, not by phone language)
const FOOTERS = ["Thank you for choosing us 🚤", "އަޅުގަނޑުމެން އިޚްތިޔާރު ކުރެއްވި ކަމަށްޓަކައި ޝުކުރިއްޔާ 🚤"];
let LANG = "en";
try { LANG = localStorage.getItem("naalu-lang") || "en"; } catch {}
const t = (k) => (LANG === "dv" && DV[k]) || EN[k] || k;

function applyLang() {
  const dv = LANG === "dv";
  $$("[data-i18n]").forEach((el) => {
    if (el.dataset.en === undefined) el.dataset.en = el.textContent;
    el.textContent = dv && DV[el.dataset.i18n] ? DV[el.dataset.i18n] : el.dataset.en;
    el.classList.toggle("dv", dv);
  });
  $$("[data-i18n-ph]").forEach((el) => {
    if (el.dataset.enPh === undefined) el.dataset.enPh = el.placeholder;
    el.placeholder = dv && DV[el.dataset.i18nPh] ? DV[el.dataset.i18nPh] : el.dataset.enPh;
    el.classList.toggle("dv-ph", dv);
  });
  $("#langBtn").textContent = dv ? "EN" : "ދިވެހި";
  $("#langBtn").classList.toggle("dv", !dv);
  renderTaxLbl(); renderRateChips(); renderLines(); renderRateList(); renderVoyageSelects(); renderIslands();
  if (!S.editRateId) { $("#rateSave").textContent = "+ " + t("addRate"); $("#rateSave").classList.toggle("dv", dv); }
  $("#rateValueLbl").textContent = t(RATE_KEY[S.rateMode] || "priceKg");
  $("#rateValueLbl").classList.toggle("dv", dv);
}
function renderTaxLbl() {
  $("#taxLbl").textContent = t("taxInvoice").replace("{r}", Number(S.boat.gstRate) || 0);
  $("#taxLbl").classList.toggle("dv", LANG === "dv");
}
$("#langBtn").addEventListener("click", () => {
  LANG = LANG === "dv" ? "en" : "dv";
  try { localStorage.setItem("naalu-lang", LANG); } catch {}
  applyLang();
});

// ---------------- VOYAGES ----------------
const voyageById = (id) => S.voyages.find((v) => v.id === id);
const voyageLabel = (v) => v ? `${v.name}${v.from || v.to ? ` · ${v.from || "?"} → ${v.to || "?"}` : ""}${v.date ? ` · ${v.date.split("-").reverse().join("-")}` : ""}` : "";

function renderVoyageSelects() {
  const cur = S.boat.currentVoyageId || "";
  const open = S.voyages.filter((v) => v.status !== "closed" || v.id === cur);
  $("#voyageSel").innerHTML = `<option value="">— ${t("noVoyage")} —</option>` +
    open.map((v) => `<option value="${v.id}" ${v.id === cur ? "selected" : ""}>${esc(voyageLabel(v))}</option>`).join("");
  const all = S.voyages.map((v) => `<option value="${v.id}">${esc(voyageLabel(v))}${v.status === "closed" ? " (closed)" : ""}</option>`).join("");
  const cv = $("#cargoVoyageSel").value;
  $("#cargoVoyageSel").innerHTML = `<option value="">🚢 All voyages</option>` + all;
  $("#cargoVoyageSel").value = voyageById(cv) ? cv : "";
  const av = S.acctVoyageId || cur || S.voyages[0]?.id || "";
  $("#acctVoyageSel").innerHTML = all || `<option value="">No voyages yet</option>`;
  $("#acctVoyageSel").value = av;
}
$("#voyageSel").addEventListener("change", () => {
  updateDoc(doc(db, "boats", S.boatId), { currentVoyageId: $("#voyageSel").value }).catch(fail);
  S.boat.currentVoyageId = $("#voyageSel").value;
  toast($("#voyageSel").value ? "Voyage selected for new cargo" : "No voyage selected");
});
$("#newVoyageBtn").addEventListener("click", () => {
  $("#vName").value = `Voyage ${S.voyages.length + 1}`;
  $("#vFrom").value = S.boat.address || ""; $("#vTo").value = "";
  $("#vDate").value = toDateInput(new Date());
  openModal("#voyageModal");
});
$("#voyageForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const ref = doc(col("voyages"));
  setDoc(ref, {
    name: $("#vName").value.trim(), from: $("#vFrom").value.trim(), to: $("#vTo").value.trim(),
    date: $("#vDate").value, status: "open", createdAtMs: Date.now(),
  }).catch(fail);
  updateDoc(doc(db, "boats", S.boatId), { currentVoyageId: ref.id }).catch(fail);
  S.boat.currentVoyageId = ref.id;
  $("#voyageModal").classList.add("hidden");
  toast("Voyage started 🚢");
});

// ---------------- RECEIVE CARGO ----------------
function autofill(phoneSel, nameSel) {
  $(phoneSel).addEventListener("change", () => {
    const p = $(phoneSel).value.replace(/\D/g, "");
    const n = S.contacts.get(p);
    if (n && !$(nameSel).value.trim()) $(nameSel).value = n;
  });
}
autofill("#sPhone", "#sName");
autofill("#rPhone", "#rName");

const MODE_UNIT = { kg: "/kg", piece: "/pc", cbm: "/CBM" };
function renderRateChips() {
  $("#rateChips").innerHTML = S.rates.map((r) => {
    const sub = r.mode === "size"
      ? (r.sizes || []).map((z) => z.name).join(" · ")
      : `${num(r.rate)}${MODE_UNIT[r.mode] || ""}`;
    return `<button type="button" class="chip" data-rate="${r.id}"><b>${esc(r.name)}</b><small>${esc(sub)}</small></button>`;
  }).join("") + `<button type="button" class="chip other ${LANG === "dv" ? "dv" : ""}" data-rate="">${t("otherItem")}</button>`;
}
$("#rateChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  const r = S.rates.find((x) => x.id === b.dataset.rate);
  openLine(r ? { desc: r.name, mode: r.mode, rate: r.mode === "size" ? "" : r.rate, min: r.min || 0, sizes: r.sizes || [] }
             : { desc: "", mode: "fixed", rate: "", min: 0, sizes: [] }, -1);
});

// --- Item line modal ---
const UNIT_M = { cm: 0.01, in: 0.0254, ft: 0.3048, m: 1 };
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

function openLine(line, index) {
  S.line = { ...line, index, origMode: line.mode, origRate: line.rate, unit: line.dims?.unit || "cm", size: line.size || "" };
  $("#lineTitle").textContent = index >= 0 ? "Edit item" : "Add item";
  $("#lDesc").value = line.desc || "";
  $("#lWeight").value = line.weight || "";
  $("#lPcs").value = line.qty || (line.mode === "fixed" ? "" : (index >= 0 ? line.qty : 1));
  $("#lL").value = line.dims?.l || ""; $("#lW").value = line.dims?.w || ""; $("#lH").value = line.dims?.h || "";
  $("#lRate").value = line.rate ?? "";
  $("#lAmount").value = line.amount ?? "";
  setUnit(S.line.unit);
  setLineMode(line.mode, true);
  openModal("#lineModal");
  const focus = { kg: "#lWeight", piece: "#lPcs", cbm: "#lL", size: "#lPcs", fixed: "#lAmount" }[line.mode];
  setTimeout(() => $(line.desc ? focus : "#lDesc").focus(), 80);
}
function setUnit(u) {
  S.line.unit = u;
  $$("#unitSeg button").forEach((b) => b.classList.toggle("active", b.dataset.u === u));
  calcLine();
}
$("#unitSeg").addEventListener("click", (e) => { if (e.target.dataset.u) setUnit(e.target.dataset.u); });

function setLineMode(mode, initial) {
  const L = S.line;
  if (!initial) $("#lRate").value = mode === L.origMode ? (L.origRate ?? "") : "";
  L.mode = mode;
  $$("#lineModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $('#lineModeSeg [data-mode="size"]').classList.toggle("hidden", !(L.sizes || []).length);
  $("#lWeightLbl").classList.toggle("hidden", mode !== "kg");
  $("#lPcsLbl").classList.toggle("hidden", mode === "kg" || mode === "fixed");
  $("#lRateLbl").classList.toggle("hidden", mode === "fixed");
  $("#lDimBox").classList.toggle("hidden", mode !== "cbm");
  $("#lCbmOut").classList.toggle("hidden", mode !== "cbm");
  $("#lSizeBox").classList.toggle("hidden", mode !== "size");
  $("#lRateTxt").textContent = { kg: "Rate per kg", piece: "Price each", cbm: "Rate per CBM", size: "Price each" }[mode] || "Rate";
  if (mode === "size") renderSizeButtons();
  calcLine();
}
$("#lineModeSeg").addEventListener("click", (e) => { if (e.target.dataset.mode) setLineMode(e.target.dataset.mode); });

function renderSizeButtons() {
  const L = S.line;
  $("#lSizeBox").innerHTML = (L.sizes || []).map((z) =>
    `<button type="button" class="chip ${z.name === L.size ? "sel" : ""}" data-size="${esc(z.name)}"><b>${esc(z.name)}</b><small>${num(z.price)}</small></button>`).join("");
}
$("#lSizeBox").addEventListener("click", (e) => {
  const b = e.target.closest("[data-size]"); if (!b) return;
  const z = S.line.sizes.find((x) => x.name === b.dataset.size); if (!z) return;
  S.line.size = z.name;
  $("#lRate").value = z.price;
  renderSizeButtons(); calcLine();
});

function lineCbm() {
  const f = UNIT_M[S.line.unit] || 0.01;
  const each = (Number($("#lL").value) || 0) * f * (Number($("#lW").value) || 0) * f * (Number($("#lH").value) || 0) * f;
  return { each, total: round3(each * (Number($("#lPcs").value) || 0)) };
}
function calcLine() {
  const L = S.line; if (!L) return;
  if (L.mode === "fixed") { $("#lMinNote").classList.add("hidden"); return; }
  const r = Number($("#lRate").value) || 0;
  const pcs = Number($("#lPcs").value) || 0;
  let qty = 0;
  if (L.mode === "kg") qty = Number($("#lWeight").value) || 0;
  else if (L.mode === "cbm") {
    const c = lineCbm(); qty = c.total;
    $("#lCbmOut").textContent = c.total ? `= ${round3(c.each)} CBM each × ${pcs} = ${c.total} CBM` : "Enter length, width, height and pieces";
  } else qty = pcs;
  let amt = round2(qty * r);
  const min = Number(L.min) || 0;
  const useMin = min > 0 && qty > 0 && amt < min;
  if (useMin) amt = min;
  $("#lMinNote").textContent = useMin ? `Minimum charge ${money(min)} applied` : "";
  $("#lMinNote").classList.toggle("hidden", !useMin);
  $("#lAmount").value = qty && r ? amt : "";
}
["#lWeight", "#lPcs", "#lRate", "#lL", "#lW", "#lH"].forEach((s) => $(s).addEventListener("input", calcLine));

$("#lineForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const L = S.line, m = L.mode;
  const pcs = Number($("#lPcs").value) || 0;
  const line = {
    desc: $("#lDesc").value.trim(), mode: m,
    qty: m === "fixed" ? 1 : (m === "kg" ? 0 : pcs),
    weight: m === "kg" ? Number($("#lWeight").value) || 0 : 0,
    rate: m === "fixed" ? 0 : Number($("#lRate").value) || 0,
    min: Number(L.min) || 0,
    sizes: L.sizes || [],
    amount: round2($("#lAmount").value),
  };
  if (m === "cbm") {
    line.dims = { l: Number($("#lL").value) || 0, w: Number($("#lW").value) || 0, h: Number($("#lH").value) || 0, unit: L.unit };
    line.cbm = lineCbm().total;
    if (!line.cbm) return toast("Enter length, width, height and pieces");
  }
  if (m === "size") {
    if (!L.size) return toast("Choose a size");
    line.size = L.size;
  }
  if (!line.desc) return toast("Enter description");
  if (m === "kg" && !line.weight) return toast("Enter weight");
  if ((m === "piece" || m === "size") && !pcs) return toast("Enter number of pieces");
  if (!line.amount && line.amount !== 0) return toast("Enter amount");
  if (L.index >= 0) S.lines[L.index] = line; else S.lines.push(line);
  $("#lineModal").classList.add("hidden");
  renderLines();
});

function lineLabel(l) {
  const base = l.mode === "cbm" ? l.cbm : (l.mode === "kg" ? l.weight : l.qty);
  const minNote = l.min && l.amount === l.min && round2(base * l.rate) < l.min ? " (min charge)" : "";
  const pcs = (n) => `${num(n)} pc${n === 1 ? "" : "s"}`;
  switch (l.mode) {
    case "kg": return `${num(l.weight)} kg × ${num(l.rate)}${minNote}`;
    case "piece": return `${pcs(l.qty)} × ${num(l.rate)}${minNote}`;
    case "cbm": return `${l.dims.l}×${l.dims.w}×${l.dims.h} ${l.dims.unit} × ${pcs(l.qty)} = ${l.cbm} CBM × ${num(l.rate)}${minNote}`;
    case "size": return `${l.size} × ${pcs(l.qty)} @ ${num(l.rate)}${minNote}`;
    default: return "Fixed price";
  }
}
const linesSubtotal = () => round2(S.lines.reduce((s, l) => s + l.amount, 0));

// GST: either added on top, or already inside prices (Settings)
function computeTotals(subtotal, tax) {
  if (!tax) return { taxable: subtotal, gst: 0, total: subtotal, gstRate: 0 };
  const rate = Number(S.boat.gstRate) || 0;
  if (S.boat.gstInclusive) {
    const gst = round2(subtotal * rate / (100 + rate));
    return { taxable: round2(subtotal - gst), gst, total: subtotal, gstRate: rate };
  }
  const gst = round2(subtotal * rate / 100);
  return { taxable: subtotal, gst, total: round2(subtotal + gst), gstRate: rate };
}

function renderLines() {
  $("#lineList").innerHTML = S.lines.map((l, i) => `
    <div class="line tap" data-i="${i}">
      <div class="grow"><b>${esc(l.desc)}</b><div class="muted">${esc(lineLabel(l))}</div></div>
      <b>${num(l.amount)}</b>
      <button type="button" class="x" data-del="${i}">✕</button>
    </div>`).join("") || `<div class="empty small ${LANG === "dv" ? "dv" : ""}">${t("noItems")}</div>`;
  const tax = $("#cTax").checked;
  const T = computeTotals(linesSubtotal(), tax);
  $("#subRow").classList.toggle("hidden", !tax);
  $("#gstRow").classList.toggle("hidden", !tax);
  $("#cSub").textContent = money(T.taxable);
  $("#gstLbl").textContent = `GST ${T.gstRate}%${S.boat.gstInclusive ? " (included)" : ""}`;
  $("#cGst").textContent = money(T.gst);
  $("#cTotal").textContent = money(T.total);
}
$("#lineList").addEventListener("click", (e) => {
  if (e.target.dataset.del !== undefined) { S.lines.splice(+e.target.dataset.del, 1); renderLines(); return; }
  const row = e.target.closest(".line"); if (row) openLine(S.lines[+row.dataset.i], +row.dataset.i);
});
$("#cTax").addEventListener("change", () => { $("#cTin").classList.toggle("hidden", !$("#cTax").checked); renderLines(); });

function setPayment(p) {
  S.payment = p;
  $$("#paySeg button").forEach((b) => b.classList.toggle("active", b.dataset.pay === p));
  $("#cRef").classList.toggle("hidden", !(p === "transfer" || p === "card"));
  $("#unpaidHint").classList.toggle("hidden", p !== "unpaid");
}
$("#paySeg").addEventListener("click", (e) => { const b = e.target.closest("[data-pay]"); if (b) setPayment(b.dataset.pay); });

function clearForm() {
  $("#cargoForm").reset();
  $("#cTax").checked = !!S.boat.taxDefault;
  $("#cTin").classList.toggle("hidden", !$("#cTax").checked);
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
  const tax = $("#cTax").checked;
  const subtotal = linesSubtotal();
  const T = computeTotals(subtotal, tax);
  const v = voyageById(S.boat.currentVoyageId);
  const cargo = {
    receiptNo: makeReceiptNo(now),
    sender: { name: $("#sName").value.trim(), phone: sPhone, tin: tax ? $("#cTin").value.trim() : "" },
    receiver: { name: $("#rName").value.trim(), phone: rPhone, island },
    lines: S.lines.map(({ sizes, ...l }) => l),
    pieces: S.lines.reduce((s, l) => s + (l.mode === "kg" || l.mode === "fixed" ? 1 : l.qty), 0),
    weight: round2(S.lines.reduce((s, l) => s + (l.weight || 0), 0)),
    cbm: round3(S.lines.reduce((s, l) => s + (l.cbm || 0), 0)),
    subtotal,
    tax, gstRate: T.gstRate, gstInclusive: !!S.boat.gstInclusive, taxable: T.taxable, gst: T.gst,
    total: T.total,
    payment: S.payment, paid,
    paidMethod: paid ? S.payment : "",
    paidAtMs: paid ? now.getTime() : 0,
    ref: S.payment === "transfer" || S.payment === "card" ? $("#cRef").value.trim() : "",
    notes: $("#cNotes").value.trim(),
    voyageId: v ? v.id : "", voyageName: v ? voyageLabel(v) : "",
    status: "received", statusAtMs: now.getTime(), receivedAtMs: now.getTime(),
    createdBy: auth.currentUser?.email || "",
    createdAtMs: now.getTime(), createdAt: serverTimestamp(),
  };
  const ref = doc(col("cargo"));
  setDoc(ref, cargo).catch(fail);   // not awaited: works offline
  cargo.id = ref.id;
  syncTracking(cargo);

  if (sPhone) setDoc(doc(col("contacts"), sPhone), { name: cargo.sender.name, updatedAt: Date.now() }).catch(() => {});
  if (rPhone) setDoc(doc(col("contacts"), rPhone), { name: cargo.receiver.name, updatedAt: Date.now() }).catch(() => {});
  if (island && !(S.boat.islands || []).includes(island))
    updateDoc(doc(db, "boats", S.boatId), { islands: arrayUnion(island) }).catch(() => {});

  clearForm();
  showBill(cargo);
  toast(`Saved ✔ ${money(cargo.total)}`);
});

// ---------------- RECEIPT ----------------
const PAYNAME = { cash: "Cash", transfer: "Bank Transfer", card: "Card" };
function receiptText(c, forPhone) {
  const L = [];
  if (c.tax) {
    L.push("*TAX INVOICE*", `*${S.boat.legalName || S.boat.name}*`);
    if (S.boat.legalName && S.boat.legalName !== S.boat.name) L.push(S.boat.name);
    if (S.boat.tin) L.push(`TIN: ${S.boat.tin}`);
  } else L.push(`*${S.boat.name}*`);
  if (S.boat.address) L.push(S.boat.address);
  if (S.boat.phone) L.push(`📞 ${S.boat.phone}`);
  L.push(`${c.tax ? "Invoice" : "Receipt"} #${c.receiptNo}`, fmtDateTime(new Date(c.createdAtMs)));
  if (c.voyageName) L.push(`Voyage: ${c.voyageName}`);
  L.push("--------------------------");
  L.push(`From: ${c.sender.name}${c.sender.phone ? ` (${c.sender.phone})` : ""}`);
  if (c.tax && c.sender.tin) L.push(`Customer TIN: ${c.sender.tin}`);
  L.push(`To: ${c.receiver.name}${c.receiver.phone ? ` (${c.receiver.phone})` : ""}`);
  L.push(`Island: ${c.receiver.island}`, "--------------------------");
  c.lines.forEach((l) => {
    if (l.mode === "fixed") L.push(`${l.desc} = ${num(l.amount)}`);
    else L.push(`${l.desc}\n   ${lineLabel(l)} = ${num(l.amount)}`);
  });
  L.push("--------------------------");
  if (c.tax) {
    L.push(`Taxable value: ${money(c.taxable)}`);
    L.push(`GST ${c.gstRate}%${c.gstInclusive ? " (included)" : ""}: ${money(c.gst)}`);
  }
  L.push(`*TOTAL: ${money(c.total)}*`);
  if (c.paid) L.push(`✅ Paid – ${PAYNAME[c.paidMethod] || c.paidMethod}${c.ref ? ` (${c.ref})` : ""}`);
  else L.push(`⏳ NOT PAID – collect ${money(c.total)} from receiver`);
  L.push(`Status: ${STATUS[c.status] || c.status}`);
  if (c.notes) L.push(`Note: ${c.notes}`);
  const link = trackLink(c, forPhone);
  if (link) L.push("", `📍 Track your cargo: ${link}`);
  if (S.boat.footer) L.push("", S.boat.footer);
  return L.join("\n");
}

function showBill(c) { refreshBill(c); openModal("#billModal"); }
function refreshBill(c) {
  S.bill = c;
  $("#billTitle").textContent = c.tax ? "Tax invoice" : "Receipt";
  $("#billText").textContent = receiptText(c);
  $$("#billStatusSeg button").forEach((b) => b.classList.toggle("active", b.dataset.s === c.status));
  $("#payNowBox").classList.toggle("hidden", !!c.paid);
  $("#billDeleteBtn").classList.toggle("hidden", !c.id);
}
new MutationObserver(() => { if ($("#billModal").classList.contains("hidden")) S.bill = null; })
  .observe($("#billModal"), { attributes: true, attributeFilter: ["class"] });

$("#billStatusSeg").addEventListener("click", (e) => {
  const s = e.target.dataset.s; if (!s || !S.bill) return;
  const now = Date.now();
  const upd = { status: s, statusAtMs: now, [s + "AtMs"]: now };
  updateDoc(doc(col("cargo"), S.bill.id), upd).catch(fail);
  refreshBill({ ...S.bill, ...upd });
  syncTracking(S.bill);
  toast(STATUS[s]);
});
$("#payNowBox").addEventListener("click", (e) => {
  const m = e.target.dataset.paynow; if (!m || !S.bill) return;
  const upd = { paid: true, paidMethod: m, paidAtMs: Date.now() };
  updateDoc(doc(col("cargo"), S.bill.id), upd).catch(fail);
  refreshBill({ ...S.bill, ...upd });
  syncTracking(S.bill);
  toast("Marked as paid ✔");
});

$("#billModal").addEventListener("click", async (e) => {
  const how = e.target.dataset.send; if (!how || !S.bill) return;
  const c = S.bill;
  const raw = how.endsWith("receiver") ? c.receiver.phone : c.sender.phone;
  const phone = normalizePhone(raw);
  const text = receiptText(c, raw);
  if (how.startsWith("wa")) {
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank");
  } else {
    // Viber can't reliably pre-fill text for a number: copy receipt, open the chat, user pastes
    const plain = text.replace(/\*/g, "");
    try { await navigator.clipboard.writeText(plain); } catch {}
    if (phone) {
      toast("Receipt copied – paste it in Viber");
      location.href = `viber://chat?number=%2B${phone}&draft=${encodeURIComponent(plain)}`;
    } else {
      location.href = `viber://forward?text=${encodeURIComponent(plain)}`;
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
  printWindow((S.bill.tax ? "Tax invoice " : "Receipt ") + S.bill.receiptNo,
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
      ${c.voyageName ? `<div class="sm">🚢 ${esc(c.voyageName)}</div>` : ""}
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
  deleteTracking(S.bill);
  $("#billModal").classList.add("hidden");
  toast("Receipt deleted");
  if (!$("#view-accounts").classList.contains("hidden")) setTimeout(loadAccounts, 300);
});

// ---------------- CARGO LIST ----------------
function cargoRow(c) {
  return `<div class="line tap cargo-row" data-id="${c.id}">
    <div class="grow">
      <b>${esc(c.receiver.name)}</b> <span class="isl-tag">${esc(c.receiver.island)}</span>
      <div class="muted">From ${esc(c.sender.name)} · #${esc(c.receiptNo)}${c.tax ? " · 🧾" : ""}</div>
      <div class="muted">${fmtDateTime(new Date(c.createdAtMs))} · ${c.lines.length} item${c.lines.length === 1 ? "" : "s"}${c.voyageName ? ` · 🚢 ${esc(c.voyageName.split(" · ")[0])}` : ""}</div>
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
  const vid = $("#cargoVoyageSel").value;
  const list = S.cargo.filter((c) => {
    if (vid && c.voyageId !== vid) return false;
    if (S.filter === "unpaid" ? c.paid : (S.filter !== "all" && c.status !== S.filter)) return false;
    if (!q) return true;
    return [c.receiptNo, c.sender.name, c.sender.phone, c.receiver.name, c.receiver.phone, c.receiver.island, c.notes]
      .join(" ").toLowerCase().includes(q);
  });
  const tot = round2(list.reduce((s, c) => s + c.total, 0));
  $("#cargoSummary").textContent = list.length ? `${list.length} receipt${list.length === 1 ? "" : "s"} · ${money(tot)}` : "";
  $("#cargoList").innerHTML = list.map(cargoRow).join("") || `<div class="empty">No cargo found</div>`;
}
$("#cargoSearch").addEventListener("input", renderCargoList);
$("#cargoVoyageSel").addEventListener("change", renderCargoList);
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
const RATE_KEY = { kg: "priceKg", piece: "pricePiece", cbm: "priceCbm" };
function setRateMode(m) {
  S.rateMode = m;
  $$("#rateModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("#rateValueRow").classList.toggle("hidden", m === "size");
  $("#sizeEditor").classList.toggle("hidden", m !== "size");
  $("#rateValueLbl").textContent = RATE_KEY[m] ? t(RATE_KEY[m]) : "";
  if (m === "size" && !$("#sizeRows").children.length) ["Small", "Medium", "Large"].forEach((n) => addSizeRow(n, ""));
}
$("#rateModeSeg").addEventListener("click", (e) => { if (e.target.dataset.mode) setRateMode(e.target.dataset.mode); });

function addSizeRow(name, price) {
  const row = document.createElement("div");
  row.className = "row size-row";
  row.innerHTML = `<input placeholder="Size name e.g. Large / 20ft" value="${esc(name)}">
    <input type="number" inputmode="decimal" min="0" step="any" placeholder="MVR" class="narrow" value="${esc(price)}">
    <button type="button" class="x">✕</button>`;
  row.querySelector(".x").addEventListener("click", () => row.remove());
  $("#sizeRows").appendChild(row);
}
$("#addSizeBtn").addEventListener("click", () => addSizeRow("", ""));
const readSizes = () => [...$$("#sizeRows .size-row")].map((r) => {
  const [n, p] = r.querySelectorAll("input");
  return { name: n.value.trim(), price: Number(p.value) || 0 };
}).filter((z) => z.name);

function renderRateList() {
  const desc = (r) => r.mode === "size"
    ? (r.sizes || []).map((z) => `${esc(z.name)} ${num(z.price)}`).join(" · ")
    : { kg: "Per kg", piece: "Per piece", cbm: "Per CBM (m³)" }[r.mode];
  $("#rateList").innerHTML = S.rates.map((r) => `
    <div class="line tap" data-id="${r.id}">
      <div class="grow"><b>${esc(r.name)}</b>
        <div class="muted">${desc(r)}${r.min ? ` · min ${money(r.min)}` : ""}</div></div>
      ${r.mode === "size" ? "<b>📏</b>" : `<b>${money(r.rate)}${MODE_UNIT[r.mode] || ""}</b>`}
      <button class="x" data-del-rate="${r.id}">🗑</button>
    </div>`).join("") || `<div class="empty ${LANG === "dv" ? "dv" : ""}">${t("noRates")}</div>`;
}
function resetRateForm() {
  S.editRateId = null; $("#rateForm").reset(); $("#sizeRows").innerHTML = ""; setRateMode("kg");
  $("#rateSave").textContent = "+ " + t("addRate"); $("#rateCancel").classList.add("hidden");
}
$("#rateCancel").addEventListener("click", resetRateForm);
$("#rateList").addEventListener("click", (e) => {
  const del = e.target.dataset.delRate;
  if (del) { if (confirm("Delete this rate?")) deleteDoc(doc(col("rates"), del)).catch(fail); return; }
  const row = e.target.closest(".line"); if (!row) return;
  const r = S.rates.find((x) => x.id === row.dataset.id); if (!r) return;
  S.editRateId = r.id;
  $("#rateName").value = r.name; $("#rateValue").value = r.rate || ""; $("#rateMin").value = r.min || "";
  $("#sizeRows").innerHTML = "";
  (r.sizes || []).forEach((z) => addSizeRow(z.name, z.price));
  setRateMode(r.mode);
  $("#rateSave").textContent = "Save changes"; $("#rateCancel").classList.remove("hidden");
  window.scrollTo(0, 0);
});
$("#rateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = S.rateMode;
  const data = {
    name: $("#rateName").value.trim(), mode: m,
    rate: m === "size" ? 0 : Number($("#rateValue").value) || 0,
    min: Number($("#rateMin").value) || 0,
    sizes: m === "size" ? readSizes() : [],
  };
  if (m === "size" && !data.sizes.length) return toast("Add at least one size");
  if (m !== "size" && !$("#rateValue").value) return toast("Enter the price");
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
      const tt = $("#toDate").value ? new Date($("#toDate").value + "T00:00") : sod;
      return [f, addDays(tt, 1)];
    }
    default: return [sod, addDays(sod, 1)];
  }
}
$("#acctModeSeg").addEventListener("click", (e) => {
  const m = e.target.dataset.am; if (!m) return;
  S.acctMode = m;
  $$("#acctModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.am === m));
  $("#acctDates").classList.toggle("hidden", m !== "dates");
  $("#acctVoyage").classList.toggle("hidden", m !== "voyage");
  loadAccounts();
});
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
$("#acctVoyageSel").addEventListener("change", () => { S.acctVoyageId = $("#acctVoyageSel").value; loadAccounts(); });

function renderVoyageActions() {
  const v = voyageById(S.acctVoyageId);
  if (!v) { $("#voyageActions").innerHTML = ""; return; }
  const isCur = S.boat.currentVoyageId === v.id;
  $("#voyageActions").innerHTML = `
    <span class="tag ${v.status === "closed" ? "offtag" : "cash"}">${v.status === "closed" ? "Closed" : "Open"}${isCur ? " · current" : ""}</span>
    ${isCur ? "" : `<button class="btn small" data-va="current">Use for new cargo</button>`}
    <button class="btn small" data-va="toggle">${v.status === "closed" ? "Reopen" : "Close voyage"}</button>`;
}
$("#voyageActions").addEventListener("click", (e) => {
  const a = e.target.dataset.va; const v = voyageById(S.acctVoyageId); if (!a || !v) return;
  if (a === "current") {
    updateDoc(doc(db, "boats", S.boatId), { currentVoyageId: v.id }).catch(fail);
    S.boat.currentVoyageId = v.id; toast("New cargo will go to this voyage");
  } else {
    const closing = v.status !== "closed";
    updateDoc(doc(col("voyages"), v.id), { status: closing ? "closed" : "open" }).catch(fail);
    if (closing && S.boat.currentVoyageId === v.id) {
      updateDoc(doc(db, "boats", S.boatId), { currentVoyageId: "" }).catch(fail);
      S.boat.currentVoyageId = "";
    }
    toast(closing ? "Voyage closed" : "Voyage reopened");
  }
  setTimeout(renderVoyageActions, 200);
});

async function loadAccounts() {
  if (!S.boatId) return;
  let cargo = [], expenses = [];
  const byVoyage = S.acctMode === "voyage";
  try {
    if (byVoyage) {
      S.acctVoyageId = $("#acctVoyageSel").value;
      renderVoyageActions();
      $("#expVoyageNote").textContent = S.acctVoyageId ? "Expenses added here go to this voyage." : "";
      if (!S.acctVoyageId) { cargo = []; expenses = []; }
      else {
        const vq = (name) => query(col(name), where("voyageId", "==", S.acctVoyageId));
        const [cs, es] = await Promise.all([getDocs(vq("cargo")), getDocs(vq("expenses"))]);
        cargo = cs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAtMs - a.createdAtMs);
        expenses = es.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAtMs - a.createdAtMs);
      }
    } else {
      const cur = voyageById(S.boat.currentVoyageId);
      $("#expVoyageNote").textContent = cur ? `Expenses added here also go to voyage: ${voyageLabel(cur)}` : "";
      const [from, to] = periodRange().map((d) => d.getTime());
      const rangeQ = (name) => query(col(name), where("createdAtMs", ">=", from), where("createdAtMs", "<", to), orderBy("createdAtMs", "desc"));
      const [cs, es] = await Promise.all([getDocs(rangeQ("cargo")), getDocs(rangeQ("expenses"))]);
      cargo = cs.docs.map((d) => ({ id: d.id, ...d.data() }));
      expenses = es.docs.map((d) => ({ id: d.id, ...d.data() }));
    }
  } catch (e) { return fail(e); }
  S.periodCargo = cargo;

  const sum = (arr, f) => round2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
  const paidBy = (m) => sum(cargo.filter((c) => c.paid && c.paidMethod === m), (c) => c.total);
  const billed = sum(cargo, (c) => c.total);
  const cash = paidBy("cash"), transfer = paidBy("transfer"), card = paidBy("card");
  const unpaid = sum(cargo.filter((c) => !c.paid), (c) => c.total);
  const gst = sum(cargo, (c) => c.gst);
  const kg = sum(cargo, (c) => c.weight);
  const cbm = round3(cargo.reduce((s, c) => s + (c.cbm || 0), 0));
  const exp = sum(expenses, (e) => e.amount);
  const gstPaid = sum(cargo.filter((c) => c.paid), (c) => c.gst);
  const net = round2(cash + transfer + card - gstPaid - exp);

  const stat = (label, value, cls = "") => `<div class="stat ${cls}"><span>${label}</span><b>${value}</b></div>`;
  $("#stats").innerHTML =
    stat("Total billed", money(billed), "big") +
    stat("Receipts", cargo.length) +
    stat("Carried", `${num(kg)} kg · ${num(cbm)} CBM`) +
    stat("💵 Cash", money(cash)) +
    stat("🏦 Transfer", money(transfer)) +
    stat("💳 Card", money(card)) +
    stat("⏳ Not paid yet", money(unpaid), unpaid ? "bad" : "") +
    stat("🧾 GST on invoices", money(gst)) +
    stat("Expenses", money(exp)) +
    stat("Profit (received − GST − expenses)", money(net), net >= 0 ? "good big" : "bad big");

  const agg = {};
  cargo.forEach((c) => { const a = agg[c.receiver.island || "-"] ||= { n: 0, amt: 0 }; a.n++; a.amt += c.total; });
  $("#byIsland").innerHTML = Object.entries(agg).sort((a, b) => b[1].amt - a[1].amt).map(([isl, a]) =>
    `<div class="line"><div class="grow">${esc(isl)}</div><span class="muted">${a.n} receipt${a.n === 1 ? "" : "s"}</span><b>${money(a.amt)}</b></div>`
  ).join("") || `<div class="empty">No cargo here yet</div>`;

  $("#billList").innerHTML = cargo.map(cargoRow).join("") || `<div class="empty">No receipts</div>`;
  $("#expenseList").innerHTML = expenses.map((e) => `
    <div class="line">
      <div class="grow">${esc(e.title)}<div class="muted">${fmtDateTime(new Date(e.createdAtMs))}${e.voyageName ? ` · 🚢 ${esc(e.voyageName.split(" · ")[0])}` : ""}</div></div>
      <b>${money(e.amount)}</b><button class="x" data-del-exp="${e.id}">🗑</button>
    </div>`).join("") || `<div class="empty">No expenses</div>`;
}
$("#billList").addEventListener("click", (e) => {
  const row = e.target.closest(".line"); if (!row) return;
  const c = S.periodCargo.find((x) => x.id === row.dataset.id); if (c) showBill(c);
});
$("#expenseForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = voyageById(S.acctMode === "voyage" ? S.acctVoyageId : S.boat.currentVoyageId);
  setDoc(doc(col("expenses")), {
    title: $("#expTitle").value.trim(), amount: Number($("#expAmount").value) || 0,
    voyageId: v ? v.id : "", voyageName: v ? voyageLabel(v) : "",
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
  if (!S.periodCargo.length) return toast("No receipts here");
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Receipt", "Date", "Voyage", "Sender", "Sender phone", "Receiver", "Receiver phone", "Island",
    "Item", "Pricing", "Weight kg", "CBM", "Size", "Pieces", "Rate", "Amount",
    "Tax invoice", "Taxable", "GST", "Receipt total", "Paid", "Method", "Status"]];
  S.periodCargo.forEach((c) => c.lines.forEach((l, i) => rows.push([
    c.receiptNo, fmtDateTime(new Date(c.createdAtMs)), c.voyageName, c.sender.name, c.sender.phone, c.receiver.name,
    c.receiver.phone, c.receiver.island, l.desc, l.mode, l.weight || "", l.cbm || "", l.size || "",
    l.mode === "kg" || l.mode === "fixed" ? "" : l.qty, l.rate || "", l.amount,
    c.tax ? "Yes" : "No", i === 0 ? c.taxable ?? c.total : "", i === 0 ? c.gst || 0 : "", i === 0 ? c.total : "",
    c.paid ? "Yes" : "No", c.paidMethod, c.status])));
  const blob = new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `naalu-${S.acctMode === "voyage" ? "voyage" : S.period}-${toDateInput(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------- SETTINGS ----------------
function applyBoat() {
  $("#shopTitle").textContent = "🚤 " + S.boat.name;
  document.title = S.boat.name + " · Naalu";
  const islands = S.boat.islands || [];
  $("#islandList").innerHTML = islands.map((i) => `<option value="${esc(i)}">`).join("");
  renderIslands();
  renderTaxLbl();
  renderVoyageSelects();
  renderLines();
}
function renderIslands() {
  $("#islandChips").innerHTML = (S.boat.islands || []).map((i) =>
    `<span class="chip static">${esc(i)} <button class="x" data-del-isl="${esc(i)}">✕</button></span>`).join("")
    || `<span class="muted ${LANG === "dv" ? "dv" : ""}">${t("noneYet")}</span>`;
}
$("#footerChips").innerHTML = FOOTERS.map((f) => `<button type="button" class="chip" data-footer="${esc(f)}">${esc(f)}</button>`).join("");
$("#footerChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-footer]"); if (b) $("#setFooter").value = b.dataset.footer;
});
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
  $("#setLegalName").value = S.boat.legalName || "";
  $("#setTin").value = S.boat.tin || "";
  $("#setGst").value = S.boat.gstRate ?? 8;
  $("#setGstIncl").checked = !!S.boat.gstInclusive;
  $("#setTaxDefault").checked = !!S.boat.taxDefault;
}
$("#settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const changes = {
    name: $("#setName").value.trim() || "My Boat",
    phone: $("#setPhone").value.trim(),
    address: $("#setAddress").value.trim(),
    country: $("#setCountry").value.replace(/\D/g, "") || "960",
    footer: $("#setFooter").value.trim(),
    legalName: $("#setLegalName").value.trim(),
    tin: $("#setTin").value.trim(),
    gstRate: Number($("#setGst").value) || 0,
    gstInclusive: $("#setGstIncl").checked,
    taxDefault: $("#setTaxDefault").checked,
  };
  const taxDefaultChanged = changes.taxDefault !== !!S.boat.taxDefault;
  S.boat = { ...S.boat, ...changes };
  updateDoc(doc(db, "boats", S.boatId), changes).catch(fail);
  if (taxDefaultChanged && !S.lines.length) { $("#cTax").checked = changes.taxDefault; $("#cTin").classList.toggle("hidden", !changes.taxDefault); }
  applyBoat();
  toast("Settings saved ✔");
});

// ---------------- CUSTOMER TRACKING (public, limited copy) ----------------
// tracking/{receiptNo}-{last 4 digits of phone}: what the customer portal may see. No full phone numbers, no accounts.
const last4 = (p) => String(p || "").replace(/\D/g, "").slice(-4);
const shortName = (n) => { const p = String(n || "").trim().split(/\s+/); return p[0] ? p[0] + (p[1] ? " " + p[1][0] + "." : "") : ""; };
const portalUrl = () => new URL("track.html", location.href).href.split("?")[0];
function trackIds(c) {
  const ids = new Set();
  [c.sender?.phone, c.receiver?.phone].forEach((p) => { if (last4(p).length === 4) ids.add(`${c.receiptNo}-${last4(p)}`); });
  return [...ids];
}
function trackLink(c, forPhone) {
  const p = last4(forPhone || c.sender?.phone || c.receiver?.phone);
  return p.length === 4 && c.receiptNo ? `${portalUrl()}?r=${encodeURIComponent(c.receiptNo)}&p=${p}` : "";
}
function syncTracking(c) {
  const v = voyageById(c.voyageId);
  const data = {
    boatId: S.boatId, boatName: S.boat.name, boatPhone: S.boat.phone || "",
    receiptNo: c.receiptNo, status: c.status,
    receivedAtMs: c.receivedAtMs || c.createdAtMs, loadedAtMs: c.loadedAtMs || 0, deliveredAtMs: c.deliveredAtMs || 0,
    from: v?.from || S.boat.address || "", island: c.receiver.island,
    voyageName: c.voyageName || "", voyageDate: v?.date || "",
    senderName: shortName(c.sender.name), receiverName: shortName(c.receiver.name),
    items: c.lines.map((l) => l.desc).slice(0, 20), pieces: c.pieces || 0, weight: c.weight || 0, cbm: c.cbm || 0,
    total: c.total, paid: !!c.paid,
    createdAtMs: c.createdAtMs, updatedAtMs: Date.now(),
  };
  trackIds(c).forEach((id) => setDoc(doc(db, "tracking", id), data).catch(() => {}));
}
function deleteTracking(c) { trackIds(c).forEach((id) => deleteDoc(doc(db, "tracking", id)).catch(() => {})); }

// ---------------- BOAT LOCATION (shared from one crew phone) ----------------
const G = { watchId: null, last: null, lastSentAt: 0, wake: null };
const LOC_KEY = "naalu-share-loc";
function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function locStatus(msg, on) {
  $("#locStatus").textContent = msg;
  $("#locBtn").textContent = on ? "Stop" : "📍 Share location";
  $("#locBtn").classList.toggle("primary", !on);
  $("#locBar").classList.toggle("on", !!on);
}
async function keepAwake() {
  try { if ("wakeLock" in navigator && !G.wake) { G.wake = await navigator.wakeLock.request("screen"); G.wake.addEventListener("release", () => { G.wake = null; }); } } catch {}
}
document.addEventListener("visibilitychange", () => { if (G.watchId !== null && document.visibilityState === "visible") keepAwake(); });

function startLocation() {
  if (!navigator.geolocation) return locStatus("This phone can't share location", false);
  if (G.watchId !== null) return;
  locStatus("Getting GPS…", true);
  keepAwake();
  try { localStorage.setItem(LOC_KEY, "1"); } catch {}
  G.watchId = navigator.geolocation.watchPosition((pos) => {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const now = Date.now();
    // send at most once a minute, or sooner if the boat moved more than 300 m
    if (G.last && now - G.lastSentAt < 60000 && distM(G.last, p) < 300) return;
    G.last = p; G.lastSentAt = now;
    const v = voyageById(S.boat.currentVoyageId);
    setDoc(doc(db, "boatpos", S.boatId), {
      lat: p.lat, lng: p.lng, acc: Math.round(pos.coords.accuracy || 0),
      speedKn: pos.coords.speed != null ? Math.round(pos.coords.speed * 1.94384 * 10) / 10 : null,
      heading: pos.coords.heading ?? null,
      at: now, sharing: true, boatName: S.boat.name, voyageName: v ? voyageLabel(v) : "",
      by: auth.currentUser?.email || "",
    }).catch(() => {});
    const t = new Date(now);
    locStatus(`Sharing · sent ${pad(t.getHours())}:${pad(t.getMinutes())}${navigator.onLine ? "" : " (offline – will send when signal returns)"}`, true);
  }, (err) => {
    const m = err.code === 1 ? "Location permission denied – allow it in phone settings" : "No GPS signal yet…";
    locStatus(m, err.code !== 1);
    if (err.code === 1) stopLocation();
  }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 120000 });
}
function stopLocation(keepPref) {
  if (G.watchId !== null) navigator.geolocation.clearWatch(G.watchId);
  const wasOn = G.watchId !== null;
  G.watchId = null; G.last = null;
  try { G.wake?.release(); } catch {}
  G.wake = null;
  if (!keepPref) { try { localStorage.removeItem(LOC_KEY); } catch {} }
  if (wasOn && S.boatId && !keepPref) updateDoc(doc(db, "boatpos", S.boatId), { sharing: false, at: Date.now() }).catch(() => {});
  if ($("#locStatus")) locStatus("Location not shared from this phone", false);
}
$("#locBtn").addEventListener("click", () => {
  if (G.watchId !== null) { if (confirm("Stop sharing the boat location?")) stopLocation(); }
  else startLocation();
});
$("#locMapBtn").addEventListener("click", () => window.open(`${portalUrl()}?boat=${S.boatId}`, "_blank"));
function resumeLocationIfWanted() {
  let want = false; try { want = localStorage.getItem(LOC_KEY) === "1"; } catch {}
  if (want) startLocation(); else locStatus("Location not shared from this phone", false);
}
$("#portalShareBtn").addEventListener("click", () => {
  const msg = `Track your cargo with *${S.boat.name}*:\n${portalUrl()}\n\nEnter your receipt number and the last 4 digits of your phone.`;
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
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

applyLang();
