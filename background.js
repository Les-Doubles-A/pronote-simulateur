"use strict";

function normalizeLocalBaseUrl(rawUrl) {
  const fallback = "http://localhost:1234";
  if (!rawUrl || typeof rawUrl !== "string") return fallback;
  let cleaned = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = "http://" + cleaned;
  }
  try {
    const parsed = new URL(cleaned);
    const allowedHosts = ["localhost", "127.0.0.1"];
    if (!allowedHosts.includes(parsed.hostname)) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "LM_LIST_MODELS") {
    const baseUrl = normalizeLocalBaseUrl(message.baseUrl);
    if (!baseUrl) {
      sendResponse({
        ok: false,
        error: "URL invalide. Utilisez une adresse locale (ex: http://localhost:1234).",
      });
      return false;
    }

    fetchWithTimeout(`${baseUrl}/v1/models`, { method: "GET" }, 6000)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} (${res.statusText || "Erreur serveur"})`);
        }
        const data = await res.json();
        const models = Array.isArray(data?.data)
          ? data.data.map((m) => m.id).filter(Boolean)
          : [];
        sendResponse({ ok: true, baseUrl, models });
      })
      .catch((err) => {
        const isAbort = err?.name === "AbortError";
        const msg = isAbort
          ? "Délai d'attente dépassé (LM Studio ne répond pas)."
          : "Impossible de joindre LM Studio. Vérifiez que le serveur local est démarré (port 1234 par défaut).";
        sendResponse({ ok: false, error: msg, details: String(err?.message || err) });
      });

    return true;
  }

  if (message.type === "LM_CHAT_COMPLETION") {
    const baseUrl = normalizeLocalBaseUrl(message.baseUrl);
    if (!baseUrl) {
      sendResponse({
        ok: false,
        error: "URL LM Studio invalide. Utilisez http://localhost:1234 ou http://127.0.0.1:1234.",
      });
      return false;
    }

    const payload = {
      model: message.model || undefined,
      messages: message.messages || [],
      temperature: typeof message.temperature === "number" ? message.temperature : 0.3,
      max_tokens: typeof message.max_tokens === "number" ? message.max_tokens : 1400,
      stream: false,
    };

    fetchWithTimeout(
      `${baseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      120000
    )
      .then(async (res) => {
        if (!res.ok) {
          let errBody = "";
          try {
            errBody = await res.text();
          } catch {
            // ignore
          }
          throw new Error(`HTTP ${res.status}${errBody ? " - " + errBody.slice(0, 200) : ""}`);
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content || "";
        if (!content.trim()) {
          throw new Error("Réponse vide reçue de LM Studio.");
        }
        sendResponse({
          ok: true,
          content,
          model: data?.model || message.model || "",
          usage: data?.usage || null,
        });
      })
      .catch((err) => {
        const isAbort = err?.name === "AbortError";
        const msg = isAbort
          ? "La génération a pris trop de temps (> 2 min). Essayez un modèle plus rapide ou une synthèse rapide."
          : `Erreur LM Studio : ${err?.message || "Connexion impossible."}`;
        sendResponse({ ok: false, error: msg });
      });

    return true;
  }

  return false;
});
