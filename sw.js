const CACHE="coinvault-v2";
const APP_SHELL=["./","./index.html","./styles.css","./app.js","./admin.html","./admin.js","./firebase-config.js","./manifest.json"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  if(url.origin===location.origin){event.respondWith(caches.match(event.request).then(c=>c||fetch(event.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return r}).catch(()=>caches.match("./index.html"))))}
});
