import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getDatabase, ref, onValue, off } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js";
import { createChart, CandlestickSeries } from "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/+esm";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const R = (path) => ref(db, `coinvault/${path}`);
const functions = getFunctions(app);

const $ = (id) => document.getElementById(id);
const ui = {
  authView: $("authView"), appView: $("appView"), toast: $("toast"),
  loginForm: $("loginForm"), registerForm: $("registerForm"),
  cashBalance: $("cashBalance"), portfolioValue: $("portfolioValue"), selectedCoinValue: $("selectedCoinValue"),
  selectedCoinPrice: $("selectedCoinPrice"), selectedCoinChange: $("selectedCoinChange"),
  marketCoinLabel: $("marketCoinLabel"), marketPrice: $("marketPrice"), marketPercent: $("marketPercent"),
  coinSearch: $("coinSearch"), marketList: $("marketList"), marketFilter: $("marketFilter"), coinCount: $("coinCount"),
  packageGrid: $("packageGrid"), holdingsList: $("holdingsList"), activityList: $("activityList"), requestList: $("requestList"),
  chart: $("chart"), chartStatus: $("chartStatus")
};

let currentUser = null;
let userProfile = null;
let wallet = { cashBalancePkr: 0, holdings: {} };
let settings = { usdtPkrRate: 280, tradingFeePct: 0.5, minBuyPkr: 100, maxBuyPkr: 100000, referralBonusPct: 1, referralBonusCapPkr: 500 };
let coinRows = [];
let currentCoin = "BTC";
let currentTicker = null;
let tickerPrices = new Map();
let userUnsubs = [];
let chart = null;
let candleSeries = null;
let chartResizeObserver = null;
let currentInterval = "1m";
let socket = null;
let socketSeq = 0;
let chartRequestSeq = 0;

const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const money = (n) => `Rs. ${Number(n || 0).toLocaleString("en-PK", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
const num = (n, d=8) => Number(n || 0).toLocaleString("en-US", {maximumFractionDigits:d});
const nowId = () => `${Date.now()}_${crypto.randomUUID ? crypto.randomUUID().slice(0,8) : Math.random().toString(36).slice(2,10)}`;
function toast(msg, error=false){ ui.toast.textContent = msg; ui.toast.className = `toast show${error ? " error" : ""}`; clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(()=>ui.toast.className="toast",3200); }
function friendlyError(e){ return e?.message?.replace(/^FirebaseError:\s*/i,"") || "Something went wrong."; }
function normalizeLoginName(v){ return String(v||"").trim().replace(/\s+/g," ").slice(0,80); }
function authEmailForName(name){
  const clean=normalizeLoginName(name).toLowerCase();
  const slug=clean.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "user";
  let hash=2166136261;
  for(let i=0;i<clean.length;i++){ hash^=clean.charCodeAt(i); hash=Math.imul(hash,16777619); }
  const suffix=(hash>>>0).toString(36);
  return `${slug.slice(0,48)}-${suffix}@coinvault.app`;
}
function loginNameFromAuthEmail(email){
  const local=String(email||"").split("@")[0];
  return local.replace(/-[a-z0-9]+$/i,"").replace(/-/g," ").trim() || "User";
}

function showAuthTab(tab){
  document.querySelectorAll("[data-auth-tab]").forEach(b=>b.classList.toggle("active",b.dataset.authTab===tab));
  ui.loginForm.classList.toggle("hidden",tab!=="login"); ui.registerForm.classList.toggle("hidden",tab!=="register");
}

document.querySelectorAll("[data-auth-tab]").forEach(b=>b.addEventListener("click",()=>showAuthTab(b.dataset.authTab)));

ui.loginForm.addEventListener("submit", async (ev)=>{
  ev.preventDefault();
  const name=normalizeLoginName($("loginName").value); const password=$("loginPassword").value;
  if(!name) return toast("Enter your name",true);
  try { await signInWithEmailAndPassword(auth,authEmailForName(name),password); toast("Login successful"); }
  catch(e){
    const code=e?.code||"";
    if(code.includes("auth/invalid-credential") || code.includes("auth/user-not-found") || code.includes("auth/wrong-password")) toast("Name or password is incorrect",true);
    else toast(friendlyError(e),true);
  }
});

ui.registerForm.addEventListener("submit", async (ev)=>{
  ev.preventDefault();
  const name=normalizeLoginName($("registerName").value); const password=$("registerPassword").value;
  if(name.length<2) return toast("Name must contain at least 2 characters",true);
  if(password.length<6) return toast("Password must be at least 6 characters",true);
  const email=authEmailForName(name);
  try {
    const cred=await createUserWithEmailAndPassword(auth,email,password);
    const fn=httpsCallable(functions,"initializeUserProfile");
    await fn({name,email});
    toast("Account created successfully");
    ui.registerForm.reset();
  } catch(e){ toast(friendlyError(e),true); }
});
$("logoutBtn").addEventListener("click",()=>signOut(auth).catch(e=>toast(friendlyError(e),true)));

document.querySelectorAll("[data-nav]").forEach(b=>b.addEventListener("click",()=>showSection(b.dataset.nav)));
function showSection(name){
  document.querySelectorAll(".page-section").forEach(s=>s.classList.remove("active")); const target=$(name+"Section"); if(target) target.classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.nav===name)); window.scrollTo({top:0,behavior:"smooth"});
  if(name==="buy") renderPackages(); if(name==="market") renderMarketList(); if(name==="wallet") renderWallet();
}

async function call(name,data={}){ const fn=httpsCallable(functions,name); const r=await fn(data); return r.data; }

async function loadMarketUniverse(){
  ui.chartStatus.textContent="Loading active Binance coins…";
  const res=await fetch("https://data-api.binance.vision/api/v3/exchangeInfo");
  if(!res.ok) throw new Error(`Binance market list HTTP ${res.status}`);
  const data=await res.json();
  const baseMap=new Map();
  for(const s of data.symbols||[]){
    if(s.status!=="TRADING" || s.quoteAsset!=="USDT" || s.isSpotTradingAllowed===false) continue;
    const base=s.baseAsset;
    const row={symbol:s.symbol,baseAsset:base,quoteAsset:"USDT",name:base};
    if(!baseMap.has(base)) baseMap.set(base,row);
  }
  coinRows=Array.from(baseMap.values()).sort((a,b)=>a.baseAsset.localeCompare(b.baseAsset));
  const list=$("coinDatalist"); list.innerHTML=coinRows.map(c=>`<option value="${safe(c.baseAsset)}">${safe(c.baseAsset)}</option>`).join("");
  ui.coinCount.textContent=`${coinRows.length} active USDT coins`;
  const chosen=(userProfile?.selectedCoin && baseMap.has(userProfile.selectedCoin))?userProfile.selectedCoin:"BTC";
  setSelectedCoin(chosen,false);
  ui.chartStatus.textContent=`${coinRows.length} active spot coins loaded`;
}

function coinSymbol(base){ return `${base}USDT`; }

async function fetchTicker(base){
  const res=await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(coinSymbol(base))}`); if(!res.ok) throw new Error("Ticker unavailable"); return await res.json();
}

function setSelectedCoin(value, persist=true){
  const v=String(value||"").trim().toUpperCase(); if(!coinRows.some(c=>c.baseAsset===v)) return toast("Coin not found in active Binance USDT spot list",true);
  currentCoin=v; currentTicker=null; ui.coinSearch.value=v; ui.marketCoinLabel.textContent=v; ui.selectedCoinBadge.textContent=v;
  if(persist && currentUser) call("setSelectedCoin",{coin:v}).catch(e=>toast(friendlyError(e),true));
  loadChart(); connectMarketStreams(); renderSelectedMetricsOnly();
}


ui.coinSearch.addEventListener("change",()=>setSelectedCoin(ui.coinSearch.value,true));
ui.coinSearch.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();setSelectedCoin(ui.coinSearch.value,true)}});

function connectMarketStreams(){
  const seq=++socketSeq;
  if(socket){try{socket.onclose=null;socket.close()}catch{}}
  const stream=`${coinSymbol(currentCoin).toLowerCase()}@ticker/${coinSymbol(currentCoin).toLowerCase()}@kline_${currentInterval}`;
  socket=new WebSocket(`wss://data-stream.binance.vision:443/stream?streams=${stream}`);
  socket.onmessage=(ev)=>{
    if(seq!==socketSeq)return;
    try{
      const payload=JSON.parse(ev.data); const d=payload.data||payload;
      if(d.e==="24hrTicker"){currentTicker=d;tickerPrices.set(currentCoin,Number(d.c));renderSelectedMetrics();}
      if(d.e==="kline" && candleSeries){const k=d.k;candleSeries.update({time:Math.floor(k.t/1000),open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c)});}
    }catch{}
  };
  socket.onopen=()=>{if(seq===socketSeq)ui.chartStatus.textContent=`Live ${currentCoin}/USDT • ${currentInterval}`};
  socket.onclose=()=>{if(seq===socketSeq) setTimeout(()=>{if(seq===socketSeq && document.visibilityState!=="hidden") connectMarketStreams()},3000)};
  socket.onerror=()=>{if(seq===socketSeq)ui.chartStatus.textContent="Market stream reconnecting…"};
}


async function loadChart(){
  if(!chart){
    chart=createChart(ui.chart,{layout:{background:{color:"transparent"},textColor:"#8d9ab1"},grid:{vertLines:{color:"rgba(255,255,255,.04)"},horzLines:{color:"rgba(255,255,255,.04)"}},crosshair:{mode:1},rightPriceScale:{borderColor:"rgba(255,255,255,.08)"},timeScale:{borderColor:"rgba(255,255,255,.08)",timeVisible:true,secondsVisible:false},handleScale:{mouseWheel:true,pinch:true},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:true}});
    candleSeries=chart.addSeries(CandlestickSeries,{upColor:"#25d59a",downColor:"#ff6d7a",borderVisible:false,wickUpColor:"#25d59a",wickDownColor:"#ff6d7a"});
    chartResizeObserver=new ResizeObserver(()=>{try{chart.applyOptions({width:ui.chart.clientWidth,height:ui.chart.clientHeight})}catch{}}); chartResizeObserver.observe(ui.chart);
  }
  const seq=++chartRequestSeq; ui.chartStatus.textContent=`Loading ${currentCoin} ${currentInterval} chart…`;
  try{ const res=await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coinSymbol(currentCoin)}&interval=${currentInterval}&limit=500`); if(!res.ok) throw new Error("Kline request failed"); const rows=await res.json(); if(seq!==chartRequestSeq)return; candleSeries.setData(rows.map(r=>({time:Math.floor(r[0]/1000),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4])}))); chart.timeScale().fitContent(); ui.chartStatus.textContent=`${currentCoin}/USDT • ${currentInterval} • live`; }
  catch(e){ui.chartStatus.textContent=friendlyError(e);}
}

$("intervalControls").addEventListener("click",e=>{const b=e.target.closest("[data-interval]");if(!b)return;currentInterval=b.dataset.interval;document.querySelectorAll("#intervalControls .segment-btn").forEach(x=>x.classList.toggle("active",x===b));loadChart();connectMarketStreams();});
$("fitChartBtn").addEventListener("click",()=>chart?.timeScale().fitContent());
$("fullChartBtn").addEventListener("click",async()=>{try{if(!document.fullscreenElement) await ui.chart.requestFullscreen(); else await document.exitFullscreen();}catch{toast("Fullscreen is not available in this browser",true)}});


async function updatePortfolioValue(){
  const holdings=wallet.holdings||{}; let total=Number(wallet.cashBalancePkr||0);
  for(const [coin,qty] of Object.entries(holdings)){
    if(Number(qty)<=0) continue;
    let p=tickerPrices.get(coin);
    if(!p){ try{const t=await fetchTicker(coin); p=Number(t.lastPrice); tickerPrices.set(coin,p);}catch{} }
    if(p) total += Number(qty)*p*Number(settings.usdtPkrRate||0);
  }
  ui.cashBalance.textContent=money(wallet.cashBalancePkr); ui.portfolioValue.textContent=money(total);
  renderSelectedMetricsOnly(); renderHoldings();
}
function renderSelectedMetricsOnly(){
  const t=currentTicker; const price=Number(t?.c || tickerPrices.get(currentCoin) || 0); const pct=Number(t?.P || 0); const qty=Number(wallet.holdings?.[currentCoin]||0); const value=qty*price*Number(settings.usdtPkrRate||0);
  ui.selectedCoinValue.textContent=money(value); ui.selectedCoinPrice.textContent=price?`$ ${price.toLocaleString("en-US",{maximumFractionDigits:10})}`:"—"; ui.marketPrice.textContent=price?`$ ${price.toLocaleString("en-US",{maximumFractionDigits:10})}`:"—"; ui.marketPercent.textContent=`${pct>=0?"+":""}${pct.toFixed(2)}%`; ui.selectedCoinChange.textContent=`${pct>=0?"+":""}${pct.toFixed(2)}%`; ui.selectedCoinChange.className=pct>=0?"market-up":"market-down";
}
function renderSelectedMetrics(){ renderSelectedMetricsOnly(); updatePortfolioValue(); }

async function subscribeUserData(){
  userUnsubs.forEach(u=>u()); userUnsubs=[];
  if(!currentUser)return;
  const refs=[
    [R(`users/${currentUser.uid}`),(snap)=>{userProfile=snap.val()||{};renderProfile();}],
    [R(`wallets/${currentUser.uid}`),(snap)=>{wallet=snap.val()||{cashBalancePkr:0,holdings:{}};renderWallet();updatePortfolioValue();}],
    [R(`moneyRequests/${currentUser.uid}`),(snap)=>{renderRequests(snap.val()||{});}],
    [R(`ledger/${currentUser.uid}`),(snap)=>{renderActivity(snap.val()||{});}]
  ];
  for(const [r,cb] of refs){const unsub=onValue(r,cb);userUnsubs.push(()=>off(r));}
  try{const s=await call("getPublicSettings");settings={...settings,...s};renderSettings();updatePortfolioValue();}catch(e){toast(friendlyError(e),true)}
  try{await call("ensureReferralStats");}catch{}
}

function renderProfile(){
  const name=userProfile?.name||loginNameFromAuthEmail(currentUser?.email)||"User"; $("welcomeName").textContent=name; $("profileName").textContent=name; $("profileEmail").textContent=`Login name: ${name}`; $("profileInitial").textContent=(name[0]||"C").toUpperCase(); $("myReferralCode").textContent=userProfile?.referralCode||"—"; $("referralCount").textContent=`${Number(userProfile?.referralCount||0)} users`;
}
function renderSettings(){ $("usdtPkrLabel").textContent=money(settings.usdtPkrRate); $("feeLabel").textContent=`${Number(settings.tradingFeePct||0).toFixed(2)}%`; $("minBuyLabel").textContent=money(settings.minBuyPkr); $("buyFeeHint").textContent=`Minimum ${money(settings.minBuyPkr)} • Maximum ${money(settings.maxBuyPkr)} • Fee after first purchase: ${Number(settings.tradingFeePct||0).toFixed(2)}%`; }

function renderHoldings(){
  const entries=Object.entries(wallet.holdings||{}).filter(([,q])=>Number(q)>0); $("holdingCount").textContent=`${entries.length} coins`;
  if(!entries.length){ui.holdingsList.innerHTML='<div class="muted">No coin holdings yet. Buy a package to start.</div>';return;}
  ui.holdingsList.innerHTML=entries.map(([coin,qty])=>{const p=tickerPrices.get(coin)||0; const value=p?Number(qty)*p*Number(settings.usdtPkrRate||0):0; return `<button class="holding-item" data-holding-coin="${safe(coin)}"><div class="holding-main"><span class="coin-dot">${safe(coin.slice(0,3))}</span><div><strong>${safe(coin)}</strong><small>${num(qty)} units</small></div></div><div class="market-item-side"><strong>${money(value)}</strong><small>${p?`$ ${num(p,10)}`:"price loading"}</small></div></button>`}).join("");
  ui.holdingsList.querySelectorAll("[data-holding-coin]").forEach(b=>b.addEventListener("click",()=>{setSelectedCoin(b.dataset.holdingCoin,true);showSection("home")}));
}
function renderWallet(){renderHoldings();}

async function renderMarketList(){
  const filter=ui.marketFilter.value.trim().toUpperCase(); const rows=coinRows.filter(c=>c.baseAsset.includes(filter)||c.symbol.includes(filter)).slice(0,180);
  ui.marketList.innerHTML=rows.map(c=>{const p=tickerPrices.get(c.baseAsset); return `<button class="market-item" data-market-coin="${safe(c.baseAsset)}"><div class="market-item-main"><span class="coin-dot">${safe(c.baseAsset.slice(0,3))}</span><div><strong>${safe(c.baseAsset)}/USDT</strong><small>Active spot market</small></div></div><div class="market-item-side"><strong>${p?`$ ${num(p,10)}`:"—"}</strong><small>Click to chart</small></div></button>`}).join("");
  ui.marketList.querySelectorAll("[data-market-coin]").forEach(b=>b.addEventListener("click",()=>{setSelectedCoin(b.dataset.marketCoin,true);showSection("home")}));
}
ui.marketFilter.addEventListener("input",renderMarketList);

function renderPackages(){
  if(!coinRows.length){ui.packageGrid.innerHTML='<div class="muted">Market list is still loading…</div>';return;}
  const seed=(Date.now()/60000|0); const picked=[]; let x=seed;
  const rnd=()=>{x=(x*1664525+1013904223)>>>0;return x/4294967296};
  while(picked.length<9){const c=coinRows[Math.floor(rnd()*coinRows.length)]; if(!picked.some(p=>p.coin===c.baseAsset)) picked.push({coin:c.baseAsset});}
  const amounts=[500,1000,2500,5000,10000,25000,1500,7500,15000];
  ui.packageGrid.innerHTML=picked.map((p,i)=>`<div class="package-card"><span class="package-badge">Random package</span><div class="package-coin">${safe(p.coin)}</div><div class="package-amount">${money(amounts[i])}</div><small>Buy ${safe(p.coin)} at the live Binance market price. The selected PKR amount is converted into coin quantity using the current server-validated price.</small><button class="btn primary wide package-buy" data-coin="${safe(p.coin)}" data-amount="${amounts[i]}" style="margin-top:12px">Buy package</button></div>`).join("");
  ui.packageGrid.querySelectorAll(".package-buy").forEach(b=>b.addEventListener("click",()=>buyCoin(b.dataset.coin,Number(b.dataset.amount))));
}

async function buyCoin(coin,amount){
  if(!Number.isFinite(amount)||amount<=0)return toast("Enter a valid amount",true);
  if(amount<Number(settings.minBuyPkr)||amount>Number(settings.maxBuyPkr))return toast(`Buy amount must be between ${money(settings.minBuyPkr)} and ${money(settings.maxBuyPkr)}`,true);
  try{ const r=await call("purchaseCoin",{coin,amountPkr:amount,clientTxnId:nowId()}); toast(`Purchased ${coin}. Quantity: ${num(r.quantity)}`); setSelectedCoin(coin,true); renderPackages(); }catch(e){toast(friendlyError(e),true)}
}
$("manualBuyBtn").addEventListener("click",()=>buyCoin($("manualBuyCoin").value.trim().toUpperCase(),Number($("manualBuyAmount").value)));

$("depositForm").addEventListener("submit",async(ev)=>{ev.preventDefault();try{const r=await call("createDepositRequest",{amountPkr:Number($("depositAmount").value),method:$("depositMethod").value,account:$("depositAccount").value.trim(),txnId:$("depositTxn").value.trim()});toast(`Deposit request ${r.requestId} submitted`);ev.target.reset();}catch(e){toast(friendlyError(e),true)}});
$("withdrawForm").addEventListener("submit",async(ev)=>{ev.preventDefault();try{const r=await call("createWithdrawalRequest",{amountPkr:Number($("withdrawAmount").value),method:$("withdrawMethod").value,account:$("withdrawAccount").value.trim(),holder:$("withdrawHolder").value.trim(),clientTxnId:nowId()});toast(`Withdrawal ${r.requestId} submitted`);ev.target.reset();}catch(e){toast(friendlyError(e),true)}});

async function refreshConvertQuote(){
  const from=$("convertFrom").value.trim().toUpperCase(), to=$("convertTo").value.trim().toUpperCase(), qty=Number($("convertQty").value); if(!from||!to||!qty||qty<=0){$("convertQuote").textContent="Enter From, To and amount to preview.";return;}
  if(from===to){$("convertQuote").textContent="From and To coin must be different.";return;}
  try{const r=await call("quoteConversion",{from,to,quantity:qty});$("convertQuote").innerHTML=`<div>Source value: <strong>${money(r.sourceValuePkr)}</strong></div><div>Fee: <strong>${money(r.feePkr)}</strong></div><div>Receive: <strong>${num(r.targetQuantity)}</strong> ${safe(to)}</div><div class="muted" style="margin-top:6px">Rates are sampled server-side for this quote.</div>`;}catch(e){$("convertQuote").textContent=friendlyError(e);}
}
["convertFrom","convertTo","convertQty"].forEach(id=>$(id).addEventListener("input",refreshConvertQuote));
$("convertBtn").addEventListener("click",async()=>{const from=$("convertFrom").value.trim().toUpperCase(),to=$("convertTo").value.trim().toUpperCase(),quantity=Number($("convertQty").value);try{const r=await call("convertCoin",{from,to,quantity,clientTxnId:nowId()});toast(`Converted successfully. Received ${num(r.targetQuantity)} ${to}`);refreshConvertQuote();}catch(e){toast(friendlyError(e),true)}});
function evictQuote(){ $("convertFrom").value="";$("convertTo").value="";$("convertQty").value="";$("convertQuote").textContent="Enter From, To and amount to preview."; }

function renderActivity(data){
  const items=Object.values(data||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,25);
  ui.activityList.innerHTML=items.length?items.map(x=>`<div class="activity-item"><div><strong>${safe(x.type||"Activity")}</strong><small class="muted">${safe(x.description||"")}</small></div><div class="market-item-side"><strong>${x.amountPkr!=null?money(x.amountPkr):"—"}</strong><small class="muted">${new Date(x.createdAt||Date.now()).toLocaleString("en-PK")}</small></div></div>`).join(""): '<div class="muted">No activity yet.</div>';
}
function renderRequests(data){
  const arr=Object.values(data||{}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,25);
  ui.requestList.innerHTML=arr.length?arr.map(x=>`<div class="request-item"><div><strong>${safe(x.type)} • ${safe(x.method||"")}</strong><small class="muted">${safe(x.status)} • ${safe(x.destination||x.txnId||"")}</small></div><div class="market-item-side"><strong>${money(x.amountPkr)}</strong><small class="muted">${new Date(x.createdAt||Date.now()).toLocaleString("en-PK")}</small></div></div>`).join(""):'<div class="muted">No money requests yet.</div>';
}

$("copyReferralBtn").addEventListener("click",async()=>{try{await navigator.clipboard.writeText($("myReferralCode").textContent);toast("Referral code copied")}catch{toast("Could not copy automatically",true)}});

onAuthStateChanged(auth, async(user)=>{
  currentUser=user; if(!user){ui.authView.classList.remove("hidden");ui.appView.classList.add("hidden");userProfile=null;wallet={cashBalancePkr:0,holdings:{}};userUnsubs.forEach(u=>u());userUnsubs=[];return;}
  try{
    await call("initializeUserProfile",{name:loginNameFromAuthEmail(user.email),email:user.email||""}).catch(()=>{});
    await subscribeUserData(); await loadMarketUniverse();
    ui.authView.classList.add("hidden");ui.appView.classList.remove("hidden");
    renderProfile();renderSettings();renderWallet();renderMarketList();renderPackages();showSection("home");
  }catch(e){toast(friendlyError(e),true)}
});


setInterval(async()=>{ if(!currentUser || document.visibilityState==="hidden") return; try{ for(const coin of Object.keys(wallet.holdings||{})){ if(Number(wallet.holdings[coin])>0){ const t=await fetchTicker(coin); tickerPrices.set(coin,Number(t.lastPrice)); } } await updatePortfolioValue(); }catch{} }, 10000);

window.addEventListener("beforeunload",()=>{if(socket)try{socket.close()}catch{}});
if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(()=>{}));
