export function localContext(userId, controlId) {
  return encodeURIComponent(String(userId)) + ":" + encodeURIComponent(String(controlId));
}

export async function attemptFingerprint(url, body, multipart = false) {
  let content;
  if (multipart) {
    const file = body.get(url === "/api/audio" ? "audio" : "file");
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    content = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") + "|" + file.type + "|" + file.name;
  } else content = JSON.stringify(body);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url + "|" + content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function attemptBody(attempt) {
  if (!attempt.multipart) return attempt.payload;
  const body = new FormData();
  body.append(attempt.url === "/api/audio" ? "audio" : "file", attempt.file, attempt.fileName);
  return body;
}

export function remainingDraft(draft, attempts) {
  if (!draft) return null;
  const remaining = structuredClone(draft);
  for (const attempt of attempts) {
    if (attempt.url === "/api/chat") {
      const key = attempt.origin === "chat" ? "chatText" : "text";
      if ((remaining[key] || "").trim() === attempt.payload.message) remaining[key] = "";
    }
    if (attempt.url === "/api/transactions" && remaining.manual && Object.entries(remaining.manual).every(([key, value]) => String(attempt.payload[key] ?? "") === value)) {
      remaining.manual = {};
    }
  }
  return remaining;
}

export class LocalCaptures {
  constructor(indexedDB = globalThis.indexedDB) {
    this.memory = { drafts: new Map(), outbox: new Map() };
    this.persistent = true;
    this.ready = new Promise((resolve) => {
      if (!indexedDB) { this.persistent = false; resolve(null); return; }
      const request = indexedDB.open("finup-local-captures", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("drafts", { keyPath: "context" });
        request.result.createObjectStore("outbox", { keyPath: "id" });
      };
      request.onsuccess = () => { if (!this.persistent) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = request.onblocked = () => { this.persistent = false; resolve(null); };
    });
  }

  async operation(store, mode, action, memory) {
    const db = await this.ready;
    if (!db) return memory(this.memory[store]);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(new Error("Não foi possível guardar neste aparelho. Libere espaço ou remova envios locais antigos."));
    });
  }
  all(store) { return this.operation(store, "readonly", (db) => db.getAll(), (map) => [...map.values()].map((item) => structuredClone(item))); }
  put(store, value) { return this.operation(store, "readwrite", (db) => db.put(value), (map) => { map.set(value.id || value.context, structuredClone(value)); }); }
  remove(store, key) { return this.operation(store, "readwrite", (db) => db.delete(key), (map) => map.delete(key)); }
  async draft(context) { return (await this.all("drafts")).find((item) => item.context === context) || null; }
  async pending(context) { return (await this.all("outbox")).filter((item) => item.context === context).sort((a, b) => a.createdAt - b.createdAt); }
  async enqueue(context, url, body, multipart = false, label = "", origin = "capture") {
    const fingerprint = await attemptFingerprint(url, body, multipart);
    const pending = await this.pending(context);
    const existing = pending.find((item) => item.fingerprint === fingerprint);
    if (existing) return existing;
    if (pending.length >= 20) throw new Error("Há 20 envios locais pendentes neste espaço. Retome ou remova alguns antes de adicionar outro.");
    const file = multipart ? body.get(url === "/api/audio" ? "audio" : "file") : null;
    const totalBytes = (await this.all("outbox")).reduce((sum, item) => sum + (item.file?.size || 0), 0);
    if (file && totalBytes + file.size > 50 * 1024 * 1024) throw new Error("O limite local de anexos é 50 MB. Retome ou remova envios antigos para liberar espaço.");
    const attempt = { id: crypto.randomUUID(), context, url, multipart, fingerprint, label: label.slice(0, 160), origin, createdAt: Date.now(), payload: multipart ? null : body, file, fileName: file?.name || null, attempted: false };
    await this.put("outbox", attempt);
    return attempt;
  }
  async clearUser(userId) {
    const prefix = encodeURIComponent(String(userId)) + ":";
    for (const store of ["drafts", "outbox"]) {
      for (const item of await this.all(store)) if (item.context.startsWith(prefix)) await this.remove(store, item.id || item.context);
    }
  }
}
