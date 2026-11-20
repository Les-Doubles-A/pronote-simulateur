(function () {
  "use strict";

  // =========================================================================
  // ÉTAT GLOBAL (NOTES + DEVOIRS IA + PAGE EN 1ER PLAN)
  // =========================================================================
  let subjectsData = [];
  let initialGlobalAvg = null;
  let simOrderCounter = 1000;

  let detectedPage = { mode: "other", label: "PRONOTE" };
  let activeMode = "notes"; // "notes" | "devoirs"
  let userManualOverride = false;

  let homeworkItems = [];
  let rawHomeworkPageText = "";
  let lmSettings = {
    baseUrl: "http://localhost:1234",
    model: "",
    temperature: 0.3,
    onlyUndone: true,
  };
  let lmModels = [];
  let lmConnected = false;
  let lmChecking = false;
  let lmGenerating = false;
  let selectedAnalysisMode = "complete"; // "complete" | "quick" | "schedule"
  let lastAiMarkdown = "";
  let fgObserverTimer = null;

  // =========================================================================
  // UTILITAIRES GÉNÉRAUX
  // =========================================================================
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isElementVisible(el) {
    if (!el || !document.body.contains(el)) return false;
    if (el.closest("#pn-sim-panel, #pn-sim-toggle")) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 10 && rect.height > 10;
  }

  function normalizeText(str) {
    return String(str || "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sendRuntimeMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
              resolve({
                ok: false,
                error: `Erreur d'extension : ${chrome.runtime.lastError.message}`,
              });
              return;
            }
            resolve(response || { ok: false, error: "Aucune réponse du service d'arrière-plan." });
          });
        } catch (err) {
          resolve({ ok: false, error: String(err?.message || err) });
        }
      } else {
        resolve({
          ok: false,
          error: "API d'extension indisponible (chargez l'extension dans Chrome/Edge).",
        });
      }
    });
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["pnLmSettings"], (res) => {
          if (res && res.pnLmSettings) {
            lmSettings = { ...lmSettings, ...res.pnLmSettings };
          }
          resolve(lmSettings);
        });
      } else {
        try {
          const saved = localStorage.getItem("pnLmSettings");
          if (saved) lmSettings = { ...lmSettings, ...JSON.parse(saved) };
        } catch {
          // ignore
        }
        resolve(lmSettings);
      }
    });
  }

  function saveSettings() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ pnLmSettings: lmSettings });
    } else {
      try {
        localStorage.setItem("pnLmSettings", JSON.stringify(lmSettings));
      } catch {
        // ignore
      }
    }
  }

  // Convertit Markdown léger en HTML sécurisé pour les réponses LM Studio
  function renderMarkdownSafe(md) {
    if (!md) return "";
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let inUl = false;
    let inOl = false;

    const closeLists = () => {
      if (inUl) {
        html += "</ul>";
        inUl = false;
      }
      if (inOl) {
        html += "</ol>";
        inOl = false;
      }
    };

    const formatInline = (text) => {
      let safe = escapeHtml(text);
      safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
      safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      safe = safe.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      safe = safe.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
      return safe;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        closeLists();
        continue;
      }

      const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (hMatch) {
        closeLists();
        const level = Math.min(4, hMatch[1].length);
        html += `<h${level}>${formatInline(hMatch[2])}</h${level}>`;
        continue;
      }

      const ulMatch = line.match(/^[-*•]\s+(.+)$/);
      if (ulMatch) {
        if (inOl) {
          html += "</ol>";
          inOl = false;
        }
        if (!inUl) {
          html += "<ul>";
          inUl = true;
        }
        html += `<li>${formatInline(ulMatch[1])}</li>`;
        continue;
      }

      const olMatch = line.match(/^\d+[.)]\s+(.+)$/);
      if (olMatch) {
        if (inUl) {
          html += "</ul>";
          inUl = false;
        }
        if (!inOl) {
          html += "<ol>";
          inOl = true;
        }
        html += `<li>${formatInline(olMatch[1])}</li>`;
        continue;
      }

      closeLists();
      html += `<p>${formatInline(line)}</p>`;
    }

    closeLists();
    return html;
  }

  // =========================================================================
  // DÉTECTION DE LA PAGE EN 1ER PLAN (PRONOTE SPA)
  // =========================================================================
  function getActiveMenuHints() {
    const selectors = [
      '.item-menu_niveau0.item-selected',
      '.item-menu_niveau1.item-selected',
      '.objetBandeauEntete_menu .item-selected',
      '[aria-current="page"]',
      '[role="tab"][aria-selected="true"]',
      '.menu-principal [aria-selected="true"]',
      '.ariane',
      'main h1',
      '[role="main"] h1',
    ];
    const texts = [];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (isElementVisible(el)) {
          const t = normalizeText(el.textContent);
          if (t && t.length < 120) texts.push(t);
        }
      });
    });
    return texts.join(" | ");
  }

  function detectForegroundPage() {
    const notesTree = document.querySelector('.ListeDernieresNotes [role="tree"]');
    const notesFullContainer = document.querySelector(".ListeDernieresNotes, .ObjetGrilleNotes, [class*='DernieresNotes']");
    const hasVisibleNotesTree = isElementVisible(notesTree) && !notesTree.closest(".widget");
    const hasVisibleNotesContainer = isElementVisible(notesFullContainer) && !notesFullContainer.closest(".widget");

    if (hasVisibleNotesTree || hasVisibleNotesContainer) {
      return { mode: "notes", label: "Mes notes" };
    }

    const hwFullSelectors = [
      '[class*="TravailAFaire"]:not(.widget)',
      '[class*="CahierDeTexte"]:not(.widget)',
      ".InterfaceCahierDeTexte",
      ".conteneur-liste-devoirs",
      ".liste-devoirs",
      ".liste-travaux",
    ];
    for (const sel of hwFullSelectors) {
      const el = document.querySelector(sel);
      if (isElementVisible(el) && !el.closest(".widget")) {
        return { mode: "devoirs", label: "Cahier de textes / Devoirs" };
      }
    }

    const hints = getActiveMenuHints();
    const isDevoirsHint = /\b(cahier de textes?|travail [àa] faire|devoirs?|tareas?|homework)\b/i.test(hints);
    const isNotesHint = /\b(mes notes|notes|relev[ée]|calificaciones|grades?)\b/i.test(hints);

    if (isDevoirsHint && !isNotesHint) {
      return { mode: "devoirs", label: "Travail à faire" };
    }
    if (isNotesHint && !isDevoirsHint) {
      return { mode: "notes", label: "Notes" };
    }

    // Sur la page d'accueil, vérifier s'il y a un widget Travail à faire visible
    const hwWidget = document.querySelector(
      '.widget.travailafaire, .widget[class*="travail"], .widget[class*="devoir"], section[class*="travail"]'
    );
    if (isElementVisible(hwWidget)) {
      return { mode: "devoirs", label: "Accueil (Travail à faire)" };
    }

    return { mode: "other", label: hints ? hints.split("|")[0].trim().slice(0, 32) : "PRONOTE" };
  }

  // =========================================================================
  // MODULE 1 : SIMULATEUR DE NOTES (LOGIQUE EXISTANTE PRÉSERVÉE)
  // =========================================================================
  function parseFrFloat(str) {
    if (!str) return NaN;
    const cleaned = String(str).replace(/\s/g, "").replace(",", ".");
    return parseFloat(cleaned);
  }

  function parseExactCoef(inputStr) {
    if (!inputStr) return NaN;
    const str = String(inputStr).trim().replace(",", ".");
    if (str.includes("/")) {
      const parts = str.split("/");
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        if (!isNaN(num) && !isNaN(den) && den !== 0) {
          return num / den;
        }
      }
      return NaN;
    }
    return parseFloat(str);
  }

  function formatCoefDisplay(coefStrOrNum) {
    if (typeof coefStrOrNum === "string" && coefStrOrNum.includes("/")) {
      return coefStrOrNum;
    }
    const n = Number(coefStrOrNum);
    if (isNaN(n)) return "1";
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  }

  function formatFrFloat(num) {
    if (isNaN(num) || num === null) return "";
    return num.toFixed(2).replace(".", ",");
  }

  function dateAttrToSortKey(mmdd, fallbackIdx) {
    if (!mmdd || !mmdd.includes("-")) return 50000 - fallbackIdx;
    const [mStr, dStr] = mmdd.split("-");
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);
    if (isNaN(month) || isNaN(day)) return 50000 - fallbackIdx;
    const schoolYearMonth = month >= 9 ? month - 9 : month + 3;
    return schoolYearMonth * 100 + day;
  }

  function extractGradeAndScale(noteEl) {
    if (!noteEl) return null;
    const scaleSpan = noteEl.querySelector("span");
    let scale = 20;

    let fullText = noteEl.textContent.trim();
    if (scaleSpan) {
      const scaleRaw = scaleSpan.textContent.trim();
      const parsedScale = parseFrFloat(scaleRaw.replace("/", ""));
      if (!isNaN(parsedScale) && parsedScale > 0) scale = parsedScale;
      fullText = fullText.replace(scaleRaw, "").trim();
    }

    const value = parseFrFloat(fullText);
    if (isNaN(value)) {
      return { isNonNumeric: true };
    }
    return { isNonNumeric: false, value, scale };
  }

  function getGlobalAverageSpan() {
    const footerArticles = document.querySelectorAll(".liste-totale-fd .total-content article");
    if (footerArticles.length > 0) {
      const spans = footerArticles[0].querySelectorAll("span");
      if (spans.length >= 2) return spans[1];
    }
    return null;
  }

  function calcSubjectAverage(grades, mode = "over20") {
    if (!grades || grades.length === 0) return NaN;

    if (mode === "points") {
      let sumVal = 0;
      let sumScale = 0;
      for (let i = 0; i < grades.length; i++) {
        sumVal += grades[i].value * grades[i].coef;
        sumScale += grades[i].scale * grades[i].coef;
      }
      return sumScale > 0 ? (sumVal / sumScale) * 20 : NaN;
    } else {
      let sumWeighted20 = 0;
      let sumCoef = 0;
      for (let i = 0; i < grades.length; i++) {
        const noteOn20 = (grades[i].value / grades[i].scale) * 20;
        sumWeighted20 += noteOn20 * grades[i].coef;
        sumCoef += grades[i].coef;
      }
      return sumCoef > 0 ? sumWeighted20 / sumCoef : NaN;
    }
  }

  function parsePronoteDOM() {
    const grid = document.querySelector('.ListeDernieresNotes [role="tree"]');
    if (!grid) {
      subjectsData = [];
      return false;
    }

    grid.querySelectorAll(".pn-simulated-dom-node").forEach((n) => n.remove());

    const items = grid.querySelectorAll('[role="treeitem"]');
    const parsedSubjects = [];
    let currentSubject = null;

    items.forEach((item, idx) => {
      if (item.closest(".pn-simulated-dom-node")) return;

      const level = item.getAttribute("aria-level");
      const wrapperCell = item.closest(".liste_celluleGrid");

      if (level === "1") {
        const titleEl = item.querySelector(".zone-principale .ie-titre-gros");
        const avgEl = item.querySelector(".zone-complementaire .ie-titre-gros");
        const colorEl = item.querySelector(".ie-line-color");
        const name = titleEl ? titleEl.textContent.trim() : `Matière ${idx}`;

        if (avgEl && !avgEl.hasAttribute("data-orig-avg")) {
          avgEl.setAttribute("data-orig-avg", avgEl.textContent.trim());
        }
        const origAvgTxt = avgEl ? avgEl.getAttribute("data-orig-avg") : "";
        const origAvg = parseFrFloat(origAvgTxt);

        const color = colorEl
          ? colorEl.style.getPropertyValue("--color-line").trim() || "#008673"
          : "#008673";

        currentSubject = {
          id: `subj_${parsedSubjects.length}`,
          name,
          color,
          subjectCoef: 1,
          subjectCoefRaw: "1",
          origAvg,
          currentAvg: origAvg,
          domRow: wrapperCell,
          domAvgEl: avgEl,
          calcMode: "over20",
          isSimulatedSubject: false,
          grades: [],
        };
        parsedSubjects.push(currentSubject);
      } else if (level === "2" && currentSubject) {
        const titleEl = item.querySelector(".zone-principale .ie_ellipsis");
        const timeEl = item.querySelector("time.date-contain");
        const noteEl = item.querySelector(".zone-complementaire .note-devoir");
        const parsedNote = extractGradeAndScale(noteEl);

        if (parsedNote && !parsedNote.isNonNumeric) {
          const dateLabel = timeEl ? timeEl.textContent.trim() : "Devoir";
          const dtAttr = timeEl ? timeEl.getAttribute("datetime") : "";

          currentSubject.grades.push({
            id: `g_${currentSubject.id}_${currentSubject.grades.length}`,
            title: titleEl ? titleEl.textContent.trim() : "Devoir",
            dateLabel,
            sortOrder: dateAttrToSortKey(dtAttr, idx),
            value: parsedNote.value,
            scale: parsedNote.scale,
            coef: 1,
            coefRaw: "1",
            isSimulated: false,
          });
        }
      }
    });

    parsedSubjects.forEach((subj) => {
      if (subj.grades.length === 0 || isNaN(subj.origAvg)) return;
      const avg20 = calcSubjectAverage(subj.grades, "over20");
      const avgPts = calcSubjectAverage(subj.grades, "points");

      if (Math.abs(avgPts - subj.origAvg) < Math.abs(avg20 - subj.origAvg)) {
        subj.calcMode = "points";
      } else {
        subj.calcMode = "over20";
      }
    });

    const globalSpan = getGlobalAverageSpan();
    if (globalSpan) {
      if (!globalSpan.hasAttribute("data-orig-global")) {
        globalSpan.setAttribute("data-orig-global", globalSpan.textContent.trim());
      }
      initialGlobalAvg = parseFrFloat(globalSpan.getAttribute("data-orig-global"));
    }

    subjectsData = parsedSubjects;
    return true;
  }

  function recalculateAll() {
    let totalWeightedSubj = 0;
    let totalSubjCoef = 0;

    subjectsData.forEach((subj) => {
      const newAvg = calcSubjectAverage(subj.grades, subj.calcMode);
      subj.currentAvg = newAvg;

      if (subj.domAvgEl) {
        if (!isNaN(newAvg)) {
          subj.domAvgEl.textContent = formatFrFloat(newAvg);
          if (!isNaN(subj.origAvg) && Math.abs(newAvg - subj.origAvg) >= 0.01) {
            subj.domAvgEl.style.color = newAvg > subj.origAvg ? "#059669" : "#dc2626";
          } else if (subj.isSimulatedSubject) {
            subj.domAvgEl.style.color = "#7c3aed";
          } else {
            subj.domAvgEl.style.color = "";
          }
        } else {
          subj.domAvgEl.textContent = "";
        }
      }

      if (!isNaN(newAvg) && subj.subjectCoef > 0) {
        totalWeightedSubj += newAvg * subj.subjectCoef;
        totalSubjCoef += subj.subjectCoef;
      }
    });

    const newGlobalAvg = totalSubjCoef > 0 ? totalWeightedSubj / totalSubjCoef : NaN;

    const globalSpan = getGlobalAverageSpan();
    if (globalSpan && !isNaN(newGlobalAvg)) {
      globalSpan.textContent = formatFrFloat(newGlobalAvg);
    }

    updateSimulatorUI(newGlobalAvg);
    renderEvolutionChart();
  }

  function injectSimulatedSubjectIntoPronoteDOM(subj) {
    const grid = document.querySelector('.ListeDernieresNotes [role="tree"]');
    if (!grid) return;

    const row = document.createElement("div");
    row.className = "liste_celluleGrid fd_ligne with-select pn-simulated-row pn-simulated-dom-node";
    row.style.cssText = "grid-column:1;min-height:40px;padding:1px 1px;";

    row.innerHTML = `
      <div class="liste_contenu_cellule liste-cellule-focusable" tabindex="-1" role="treeitem" aria-level="1">
        <div class="liste_contenu_cellule_contenu" style="width:607px;min-height:37px;">
          <div style="width:607px;overflow:hidden;" class="liste_contenu_ligne">
            <div class="zone-gauche">
              <span class="ie-line-color static only-color var-height" style="--color-line :${escapeHtml(subj.color)}; --var-height:2.2rem;"></span>
            </div>
            <div class="zone-centrale">
              <div class="zone-contenu-format">
                <div class="zone-principale">
                  <div class="titre-principal">
                    <span class="ie-titre-gros"><span class="pn-sim-badge">MATIÈRE SIM</span>${escapeHtml(subj.name)}</span>
                  </div>
                </div>
                <div class="zone-complementaire">
                  <div class="flex-contain">
                    <div class="ie-titre-gros pn-subj-avg-target" style="color:#7c3aed;"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    grid.prepend(row);
    subj.domRow = row;
    subj.domAvgEl = row.querySelector(".pn-subj-avg-target");
  }

  function injectSimulatedGradeIntoPronoteDOM(subj, gradeObj) {
    if (!subj.domRow) return;

    const hr = document.createElement("hr");
    hr.className = "liste_sepligne pn-simulated-dom-node";
    hr.setAttribute("role", "presentation");

    const row = document.createElement("div");
    row.className = "liste_celluleGrid fd_ligne with-select pn-simulated-row pn-simulated-dom-node";
    row.style.cssText = "grid-column:1;min-height:40px;padding:1px 1px;";

    const scaleHtml = gradeObj.scale !== 20 ? `<span>/${escapeHtml(gradeObj.scale)}</span>` : "";
    const coefBadge = ` (Coef. ${escapeHtml(formatCoefDisplay(gradeObj.coefRaw))})`;

    row.innerHTML = `
      <div class="liste_contenu_cellule" style="padding: 4px 8px;">
        <div class="liste_contenu_cellule_contenu" style="width:100%;min-height:34px;">
          <div style="width:100%;overflow:hidden;" class="liste_contenu_ligne">
            <div class="zone-gauche">
              <time class="date-contain" style="color:#7c3aed;font-weight:600;">Simulé</time>
            </div>
            <div class="zone-centrale">
              <div class="zone-contenu-format">
                <div class="zone-principale">
                  <div class="titre-principal">
                    <div class="ie_ellipsis"><span class="pn-sim-badge">SIM</span>${escapeHtml(gradeObj.title)}</div>
                  </div>
                  <div class="infos-supp">
                    <span class="ie-sous-titre">Note simulée${coefBadge}</span>
                  </div>
                </div>
                <div class="zone-complementaire">
                  <div class="flex-contain flex-gap flex-center">
                    <span class="note-devoir" style="color:#7c3aed;font-weight:700;">${formatFrFloat(gradeObj.value)}${scaleHtml}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    gradeObj.domNodes = [hr, row];
    subj.domRow.insertAdjacentElement("afterend", row);
    subj.domRow.insertAdjacentElement("afterend", hr);
  }

  function computeEvolutionSeries(targetFilter) {
    if (targetFilter === "ALL") {
      const allEvents = [];
      subjectsData.forEach((subj) => {
        if (subj.subjectCoef <= 0) return;
        subj.grades.forEach((g) => {
          allEvents.push({
            subjId: subj.id,
            grade: g,
            sortOrder: g.sortOrder,
            label: `${g.dateLabel} (${subj.name.slice(0, 6)}.)`,
            isSim: g.isSimulated,
          });
        });
      });

      allEvents.sort((a, b) => a.sortOrder - b.sortOrder);

      const activeGradesBySubj = {};
      subjectsData.forEach((s) => (activeGradesBySubj[s.id] = []));

      const points = [];
      allEvents.forEach((ev) => {
        activeGradesBySubj[ev.subjId].push(ev.grade);
        let sumW = 0;
        let sumC = 0;
        subjectsData.forEach((s) => {
          const gList = activeGradesBySubj[s.id];
          if (gList && gList.length > 0 && s.subjectCoef > 0) {
            const avg = calcSubjectAverage(gList, s.calcMode);
            if (!isNaN(avg)) {
              sumW += avg * s.subjectCoef;
              sumC += s.subjectCoef;
            }
          }
        });
        if (sumC > 0) {
          points.push({
            avg: sumW / sumC,
            label: ev.label,
            noteInfo: `${ev.grade.title}: ${formatFrFloat(ev.grade.value)}/${ev.grade.scale}`,
            isSim: ev.isSim,
          });
        }
      });
      return { points, color: "#008673", title: "Moyenne Générale" };
    } else {
      const subj = subjectsData.find((s) => s.id === targetFilter);
      if (!subj) return { points: [], color: "#008673", title: "" };

      const chronological = [...subj.grades].sort((a, b) => a.sortOrder - b.sortOrder);
      const accumulated = [];
      const points = [];

      chronological.forEach((g) => {
        accumulated.push(g);
        const avg = calcSubjectAverage(accumulated, subj.calcMode);
        if (!isNaN(avg)) {
          points.push({
            avg,
            label: g.dateLabel,
            noteInfo: `${g.title}: ${formatFrFloat(g.value)}/${g.scale}`,
            isSim: g.isSimulated,
          });
        }
      });
      return { points, color: subj.color || "#008673", title: subj.name };
    }
  }

  function renderEvolutionChart() {
    const canvas = document.getElementById("pn-sim-chart");
    const filterSelect = document.getElementById("pn-chart-filter");
    const statsEl = document.getElementById("pn-chart-stats");
    if (!canvas || !filterSelect) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 380;
    const height = canvas.clientHeight || 210;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const { points, color } = computeEvolutionSeries(filterSelect.value);

    if (points.length === 0) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Aucune note disponible pour tracer la courbe.", width / 2, height / 2);
      if (statsEl) statsEl.textContent = "";
      return;
    }

    const padLeft = 34;
    const padRight = 18;
    const padTop = 18;
    const padBottom = 34;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const values = points.map((p) => p.avg);
    let minVal = Math.max(0, Math.floor(Math.min(...values) - 1.5));
    let maxVal = Math.min(20, Math.ceil(Math.max(...values) + 1.5));
    if (maxVal - minVal < 4) {
      minVal = Math.max(0, minVal - 2);
      maxVal = Math.min(20, maxVal + 2);
    }

    const getX = (i) =>
      points.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (points.length - 1)) * plotW;
    const getY = (v) => padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#64748b";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";

    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const val = minVal + ((maxVal - minVal) * s) / steps;
      const y = getY(val);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
      ctx.fillText(val.toFixed(1).replace(".", ","), padLeft - 5, y + 3);
    }

    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(getX(0), getY(points[0].avg));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(getX(i), getY(points[i].avg));
      }
      ctx.lineTo(getX(points.length - 1), padTop + plotH);
      ctx.lineTo(getX(0), padTop + plotH);
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 134, 115, 0.10)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.strokeStyle = color && color !== "#FFED00" ? color : "#008673";
    ctx.lineWidth = 2.5;
    points.forEach((pt, i) => {
      const x = getX(i);
      const y = getY(pt.avg);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    points.forEach((pt, i) => {
      const x = getX(i);
      const y = getY(pt.avg);

      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = pt.isSim ? "#7c3aed" : "#008673";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (points.length <= 8 || i === 0 || i === points.length - 1 || pt.isSim) {
        ctx.fillStyle = pt.isSim ? "#5b21b6" : "#1e293b";
        ctx.font = "bold 9.5px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(formatFrFloat(pt.avg), x, y - 8);
      }

      const stepLabel = Math.max(1, Math.ceil(points.length / 5));
      if (i % stepLabel === 0 || i === points.length - 1) {
        ctx.fillStyle = "#64748b";
        ctx.font = "9.5px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(pt.label.slice(0, 9), x, height - 10);
      }
    });

    if (statsEl) {
      const first = points[0].avg;
      const last = points[points.length - 1].avg;
      const delta = last - first;
      const sign = delta > 0 ? "+" : "";
      statsEl.innerHTML = `Début : <b>${formatFrFloat(first)}</b> → Actuel : <b>${formatFrFloat(last)}</b> (${sign}${formatFrFloat(delta)} pt)`;
    }
  }

  // =========================================================================
  // MODULE 2 : EXTRACTION DES DEVOIRS PRONOTE (MULTI-STRATÉGIE)
  // =========================================================================
  const DATE_HEADER_REGEX =
    /^(pour\s+(le\s+)?)?(aujourd'hui|demain|apr[èe]s-demain|(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b|\d{1,2}\s+(janv|f[ée]vr|mars|avr|mai|juin|juil|ao[ûu]t|sept|oct|nov|d[ée]c))/i;

  function findClosestDateLabel(el, container) {
    let cur = el;
    while (cur && cur !== container && cur !== document.body) {
      let prev = cur.previousElementSibling;
      while (prev) {
        const dateEl = prev.matches(".date-devoir, .titre-date, h2, h3, legend, .as-header, time")
          ? prev
          : prev.querySelector(".date-devoir, .titre-date, h2, h3, .as-header, time");
        const candidate = normalizeText((dateEl || prev).textContent);
        if (candidate && candidate.length <= 60 && DATE_HEADER_REGEX.test(candidate)) {
          return candidate;
        }
        prev = prev.previousElementSibling;
      }
      const ownHeader = cur.querySelector(":scope > h2, :scope > h3, :scope > .date-devoir, :scope > .titre-date, :scope > .as-header");
      if (ownHeader && !ownHeader.contains(el)) {
        const txt = normalizeText(ownHeader.textContent);
        if (txt && txt.length <= 60 && DATE_HEADER_REGEX.test(txt)) {
          return txt;
        }
      }
      cur = cur.parentElement;
    }
    return "Date non précisée";
  }

  function extractHomeworkDoneState(item) {
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox) return Boolean(checkbox.checked);
    const ariaChecked = item.querySelector('[aria-checked]');
    if (ariaChecked) return ariaChecked.getAttribute("aria-checked") === "true";
    const ariaPressed = item.querySelector('[aria-pressed]');
    if (ariaPressed) return ariaPressed.getAttribute("aria-pressed") === "true";
    if (item.matches(".fait, .devoir-fait") || item.querySelector(".cb-fait.checked, .est-fait, .tag-fait")) {
      return true;
    }
    const statusTexts = Array.from(item.querySelectorAll("label, button, span, .tag-style, .ie-chips"))
      .map((n) => normalizeText(n.textContent).toLowerCase());
    if (statusTexts.some((t) => t === "fait" || t === "terminé" || t === "rendu")) return true;
    return false;
  }

  function extractColorFromNode(item) {
    const colorNode = item.querySelector(".ie-line-color, [style*='--color-line'], [style*='border-left']");
    if (colorNode) {
      const cssVar = colorNode.style?.getPropertyValue("--color-line")?.trim();
      if (cssVar) return cssVar;
      const borderCol = window.getComputedStyle(colorNode).borderLeftColor;
      if (borderCol && borderCol !== "rgba(0, 0, 0, 0)" && borderCol !== "rgb(0, 0, 0)") {
        return borderCol;
      }
    }
    return "#4f46e5";
  }

  function extractRawForegroundText() {
    const candidates = [
      '[class*="TravailAFaire"]',
      '[class*="CahierDeTexte"]',
      ".InterfaceCahierDeTexte",
      ".conteneur-liste-devoirs",
      ".widget.travailafaire",
      'main',
      '[role="main"]',
      ".interface_affV",
    ];
    let target = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (isElementVisible(el)) {
        target = el;
        break;
      }
    }
    if (!target) target = document.body;

    const clone = target.cloneNode(true);
    clone
      .querySelectorAll("#pn-sim-panel, #pn-sim-toggle, script, style, nav, [role='navigation']")
      .forEach((n) => n.remove());

    const text = normalizeText(clone.innerText || clone.textContent || "");
    return text.slice(0, 11000);
  }

  function parsePronoteHomeworkDOM() {
    const containerSelectors = [
      '[class*="TravailAFaire"]:not(.widget)',
      '[class*="CahierDeTexte"]:not(.widget)',
      ".InterfaceCahierDeTexte",
      ".conteneur-liste-devoirs",
      ".liste-devoirs",
      ".liste-travaux",
      '.widget.travailafaire',
      '.widget[class*="travail"]',
      'main',
      '[role="main"]',
      ".interface_affV",
    ];

    let container = null;
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (isElementVisible(el)) {
        container = el;
        break;
      }
    }

    rawHomeworkPageText = extractRawForegroundText();

    if (!container) {
      homeworkItems = [];
      return [];
    }

    const itemSelectors = [
      "article",
      "li.devoir",
      'li[class*="devoir"]',
      ".devoir",
      ".taf-item",
      ".bloc-devoir",
      ".wrap-devoir",
      '.liste_celluleGrid',
      '[role="listitem"]',
      "ul > li",
    ];

    let rawNodes = [];
    for (const sel of itemSelectors) {
      const found = Array.from(container.querySelectorAll(sel)).filter((n) => {
        if (!isElementVisible(n)) return false;
        if (n.closest("nav, [role='navigation'], header, .menu-principal")) return false;
        // Ignorer les conteneurs parents qui contiennent déjà plusieurs sous-items du même sélecteur
        if (n.querySelectorAll(sel).length > 0 && sel === "ul > li") return false;
        const txt = normalizeText(n.textContent);
        return txt.length >= 12 && txt.length <= 3500;
      });
      if (found.length > 0) {
        rawNodes = found;
        break;
      }
    }

    const parsed = [];
    const seen = new Set();

    rawNodes.forEach((node, idx) => {
      const subjectEl = node.querySelector(
        ".ie-titre-gros, .titre-matiere, .matiere, .libelle-matiere, .titre-principal, h3, h4, strong"
      );
      let subject = subjectEl ? normalizeText(subjectEl.textContent) : "";

      const descEl = node.querySelector(
        ".description, .contenu, .as-content, .texte-devoir, .ie-texte, .contenu-devoir, .infos-supp, p"
      );
      let description = descEl ? normalizeText(descEl.textContent) : "";

      // Si pas de description dédiée, prendre tout le texte du bloc en retirant le titre/statut
      if (!description || description === subject) {
        const full = normalizeText(node.innerText || node.textContent);
        description = subject ? normalizeText(full.replace(subject, "")) : full;
      }

      // Nettoyer les libellés d'interface courants
      description = normalizeText(
        description
          .replace(/\b(Marquer comme fait|Non fait|Fait|J'ai terminé|Déposer ma copie)\b/gi, "")
      );

      if (!subject && description) {
        const firstLine = description.split("\n")[0].trim();
        if (firstLine.length > 1 && firstLine.length <= 45) {
          subject = firstLine;
          description = normalizeText(description.slice(firstLine.length));
        } else {
          subject = `Devoir ${idx + 1}`;
        }
      }

      if (!description && !subject) return;
      if (DATE_HEADER_REGEX.test(subject) && !description) return;

      const dateLabel = findClosestDateLabel(node, container);
      const done = extractHomeworkDoneState(node);
      const color = extractColorFromNode(node);

      const tags = [];
      node.querySelectorAll(".tag-style, .ie-chips, .etiquette, .badge, .piece-jointe, .pj").forEach((t) => {
        const txt = normalizeText(t.textContent);
        if (txt && txt.length <= 40 && !/^(fait|non fait)$/i.test(txt) && !tags.includes(txt)) {
          tags.push(txt);
        }
      });

      const dedupKey = `${subject.toLowerCase()}|${description.slice(0, 90).toLowerCase()}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      parsed.push({
        id: `hw_${idx}_${Date.now()}`,
        subject: subject.slice(0, 70),
        description: description || "(Sans détail texte)",
        date: dateLabel,
        done,
        tags,
        color,
        selected: !done,
      });
    });

    homeworkItems = parsed;
    return parsed;
  }

  // =========================================================================
  // MODULE 2 : CONNEXION LM STUDIO & ANALYSE IA
  // =========================================================================
  function updateLmStatusUI(statusText, state) {
    const dot = document.getElementById("pn-lm-dot");
    const txt = document.getElementById("pn-lm-status-text");
    if (dot) {
      dot.className = `pn-lm-dot ${state || ""}`;
    }
    if (txt) {
      txt.textContent = statusText;
      txt.title = statusText;
    }
  }

  async function testAndLoadLmModels() {
    if (lmChecking) return;
    lmChecking = true;
    updateLmStatusUI("Connexion à LM Studio...", "checking");

    const res = await sendRuntimeMessage({
      type: "LM_LIST_MODELS",
      baseUrl: lmSettings.baseUrl,
    });

    lmChecking = false;

    const modelSelect = document.getElementById("pn-lm-model-select");

    if (res.ok) {
      lmConnected = true;
      lmModels = res.models || [];
      if (lmModels.length > 0 && (!lmSettings.model || !lmModels.includes(lmSettings.model))) {
        lmSettings.model = lmModels[0];
        saveSettings();
      }

      if (modelSelect) {
        if (lmModels.length === 0) {
          modelSelect.innerHTML = `<option value="">Aucun modèle chargé dans LM Studio</option>`;
        } else {
          modelSelect.innerHTML = lmModels
            .map(
              (m) =>
                `<option value="${escapeHtml(m)}" ${m === lmSettings.model ? "selected" : ""}>${escapeHtml(m)}</option>`
            )
            .join("");
        }
      }

      const activeModelLabel = lmSettings.model || "Aucun modèle chargé";
      updateLmStatusUI(
        lmModels.length > 0 ? `Connecté • ${activeModelLabel}` : "Connecté (chargez un modèle dans LM Studio)",
        lmModels.length > 0 ? "online" : "checking"
      );
    } else {
      lmConnected = false;
      lmModels = [];
      updateLmStatusUI(`Déconnecté (${lmSettings.baseUrl})`, "offline");
    }
  }

  function buildHomeworkPrompt(mode, customQuestion) {
    const visibleItems = homeworkItems.filter((item) => {
      if (lmSettings.onlyUndone && item.done) return false;
      return item.selected;
    });

    let homeworkContext = "";
    if (visibleItems.length > 0) {
      homeworkContext = visibleItems
        .map((it, i) => {
          const tagsStr = it.tags.length > 0 ? ` [${it.tags.join(", ")}]` : "";
          const statusStr = it.done ? " (Fait)" : " (À faire)";
          return `${i + 1}. **${it.subject}** — Échéance : ${it.date}${statusStr}${tagsStr}\n   Consigne : ${it.description}`;
        })
        .join("\n\n");
    } else if (rawHomeworkPageText && rawHomeworkPageText.length > 30) {
      homeworkContext = `Contenu brut extrait de la page PRONOTE active (${detectedPage.label}) :\n\n${rawHomeworkPageText}`;
    } else {
      return null;
    }

    const todayStr = new Date().toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const systemPrompt =
      "Tu es un assistant scolaire bienveillant, clair et très organisé. Tu réponds toujours en français en Markdown propre et concis. Tu aides un élève à comprendre, résumer, prioriser et planifier ses devoirs PRONOTE sans inventer de devoirs absents des données fournies.";

    let userInstruction = "";
    if (customQuestion && customQuestion.trim()) {
      userInstruction = `Date du jour : ${todayStr}.\n\nVoici les devoirs PRONOTE de l'élève :\n\n${homeworkContext}\n\nQuestion / demande de l'élève : ${customQuestion.trim()}`;
    } else if (mode === "quick") {
      userInstruction = `Date du jour : ${todayStr}.\n\nVoici les devoirs PRONOTE de l'élève :\n\n${homeworkContext}\n\nFais une **synthèse ultra-rapide** en points clés :\n1. **En un coup d'œil** (nombre de devoirs, urgences principales).\n2. **Liste résumée** (1 ligne par devoir avec matière, échéance et action concrète).`;
    } else if (mode === "schedule") {
      userInstruction = `Date du jour : ${todayStr}.\n\nVoici les devoirs PRONOTE de l'élève :\n\n${homeworkContext}\n\nPropose un **planning de travail priorisé** :\n1. **Ordre de priorité** (du plus urgent / évalué au moins urgent).\n2. **Estimation du temps** pour chaque tâche.\n3. **Plan d'action concret** (ce qu'il faut faire aujourd'hui vs les jours suivants, avec conseils d'organisation).`;
    } else {
      userInstruction = `Date du jour : ${todayStr}.\n\nVoici les devoirs PRONOTE de l'élève :\n\n${homeworkContext}\n\nRéalise une **analyse et un résumé structurés** :\n1. **Résumé global** (charge de travail, matières concernées, évaluations ou rendus importants).\n2. **Priorités & Urgences** (ce qu'il faut traiter en premier).\n3. **Détail par devoir** (objectif résumé, temps estimé, difficulté estimée, conseil rapide pour démarrer).\n4. **Plan d'action conseillé** (ordre optimal pour avancer efficacement).`;
    }

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInstruction },
    ];
  }

  async function runHomeworkAnalysis(customQuestion = "") {
    if (lmGenerating) return;

    const resultBox = document.getElementById("pn-ai-result-box");
    const resultContent = document.getElementById("pn-ai-result-content");
    const resultTitle = document.getElementById("pn-ai-result-title");
    const analyzeBtn = document.getElementById("pn-ai-analyze-btn");

    if (!resultBox || !resultContent) return;

    // Si aucun devoir chargé, tenter une relecture immédiate
    if (homeworkItems.length === 0 && !rawHomeworkPageText) {
      parsePronoteHomeworkDOM();
      renderHomeworkList();
    }

    const messages = buildHomeworkPrompt(selectedAnalysisMode, customQuestion);
    if (!messages) {
      resultBox.classList.remove("pn-hidden");
      resultTitle.textContent = "Aucun devoir à analyser";
      resultContent.innerHTML = `<div class="pn-ai-error">Aucun devoir sélectionné ou détecté sur la page active. Ouvrez <b>Cahier de textes → Travail à faire</b> puis cliquez sur <b>Relire la page</b>.</div>`;
      return;
    }

    if (!lmConnected) {
      await testAndLoadLmModels();
    }

    lmGenerating = true;
    if (analyzeBtn) analyzeBtn.disabled = true;
    resultBox.classList.remove("pn-hidden");
    resultTitle.textContent = customQuestion
      ? "Réponse LM Studio"
      : selectedAnalysisMode === "quick"
        ? "Synthèse rapide (LM Studio)"
        : selectedAnalysisMode === "schedule"
          ? "Planning conseillé (LM Studio)"
          : "Analyse & Résumé des devoirs (LM Studio)";

    resultContent.innerHTML = `<div class="pn-ai-loading"><span class="pn-spinner"></span><span>Analyse en cours via LM Studio (${escapeHtml(lmSettings.model || "modèle actif")})...</span></div>`;

    const res = await sendRuntimeMessage({
      type: "LM_CHAT_COMPLETION",
      baseUrl: lmSettings.baseUrl,
      model: lmSettings.model,
      temperature: Number(lmSettings.temperature) || 0.3,
      messages,
    });

    lmGenerating = false;
    if (analyzeBtn) analyzeBtn.disabled = false;

    if (res.ok) {
      lastAiMarkdown = res.content;
      resultContent.innerHTML = renderMarkdownSafe(res.content);
      if (res.model) {
        updateLmStatusUI(`Connecté • ${res.model}`, "online");
        lmConnected = true;
      }
    } else {
      lastAiMarkdown = "";
      resultContent.innerHTML = `<div class="pn-ai-error"><b>Échec de l'analyse :</b> ${escapeHtml(res.error)}<br><br><small>Vérifiez que <b>LM Studio</b> est ouvert, qu'un modèle est chargé et que le <b>Local Server</b> est démarré sur <code>${escapeHtml(lmSettings.baseUrl)}</code>.</small></div>`;
    }
  }

  function renderHomeworkList() {
    const listEl = document.getElementById("pn-hw-list");
    const countEl = document.getElementById("pn-hw-count");
    if (!listEl) return;

    const filtered = homeworkItems.filter((it) => !(lmSettings.onlyUndone && it.done));
    if (countEl) {
      countEl.textContent = String(filtered.length);
    }

    if (filtered.length === 0) {
      const hasRaw = rawHomeworkPageText && rawHomeworkPageText.length > 60;
      listEl.innerHTML = `
        <div class="pn-hw-empty">
          ${
            homeworkItems.length > 0 && lmSettings.onlyUndone
              ? "🎉 Tous les devoirs détectés sur cette page sont marqués comme <b>faits</b> ! Décochez « Non faits uniquement » pour les afficher."
              : hasRaw
                ? `📄 Aucune carte structurée détectée, mais <b>la lecture directe de la page active est prête</b> (${rawHomeworkPageText.length} caractères). Vous pouvez lancer l'analyse IA directement ou ouvrir <b>Cahier de textes → Travail à faire</b>.`
                : "Ouvrez l'onglet <b>Cahier de textes → Travail à faire</b> sur PRONOTE puis cliquez sur <b>🔄 Relire</b>."
          }
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    filtered.forEach((item) => {
      const card = document.createElement("div");
      card.className = `pn-hw-card ${item.done ? "is-done" : ""}`;
      card.style.borderLeftColor = item.color || "#4f46e5";

      const tagsHtml = item.tags
        .slice(0, 3)
        .map((t) => `<span class="pn-hw-tag">${escapeHtml(t)}</span>`)
        .join("");
      const doneBadge = item.done ? `<span class="pn-hw-tag done">Fait</span>` : "";

      card.innerHTML = `
        <input type="checkbox" class="pn-hw-check" ${item.selected ? "checked" : ""} title="Inclure dans l'analyse IA" />
        <div class="pn-hw-card-body">
          <div class="pn-hw-card-head">
            <span class="pn-hw-subject">${escapeHtml(item.subject)}</span>
            <div class="pn-hw-badges">
              <span class="pn-hw-date">${escapeHtml(item.date)}</span>
              ${doneBadge}
              ${tagsHtml}
            </div>
          </div>
          <div class="pn-hw-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</div>
        </div>
      `;

      card.querySelector(".pn-hw-check").addEventListener("change", (e) => {
        item.selected = e.target.checked;
      });

      listEl.appendChild(card);
    });
  }

  // =========================================================================
  // SYNCHRONISATION DE L'INTERFACE AVEC LA PAGE EN 1ER PLAN
  // =========================================================================
  function applyActiveModeUI() {
    const toggleBtn = document.getElementById("pn-sim-toggle");
    const header = document.getElementById("pn-sim-header");
    const headerTitle = document.getElementById("pn-header-title");
    const pageBadge = document.getElementById("pn-page-badge");
    const notesView = document.getElementById("pn-view-notes");
    const devoirsView = document.getElementById("pn-view-devoirs");

    if (!toggleBtn || !notesView || !devoirsView) return;

    // Mise à jour du bouton flottant en fonction de la page en 1er plan
    toggleBtn.classList.remove("pn-mode-devoirs", "pn-mode-other");
    if (detectedPage.mode === "devoirs") {
      toggleBtn.classList.add("pn-mode-devoirs");
      toggleBtn.innerHTML = `<span>📚 Devoirs IA</span>`;
    } else if (detectedPage.mode === "notes") {
      toggleBtn.innerHTML = `<span>🧮 Simulateur de notes</span>`;
    } else {
      toggleBtn.classList.add("pn-mode-other");
      toggleBtn.innerHTML = `<span>✨ Assistant PRONOTE</span>`;
    }

    // Badge de la page active
    if (pageBadge) {
      pageBadge.textContent = `Page active : ${detectedPage.label}`;
    }

    // Boutons de bascule de mode
    document.querySelectorAll(".pn-mode-btn").forEach((btn) => {
      const m = btn.getAttribute("data-mode");
      btn.classList.toggle("active", m === activeMode);
      btn.classList.toggle("is-foreground", m === detectedPage.mode);
    });

    // En-tête et vue affichée
    if (activeMode === "devoirs") {
      header?.classList.add("pn-header-devoirs");
      if (headerTitle) headerTitle.textContent = "📚 Analyse & Résumé Devoirs IA";
      notesView.classList.remove("active");
      devoirsView.classList.add("active");
    } else {
      header?.classList.remove("pn-header-devoirs");
      if (headerTitle) headerTitle.textContent = "🧮 Simulateur & Évolution PRONOTE";
      devoirsView.classList.remove("active");
      notesView.classList.add("active");
    }
  }

  function syncWithForegroundPage(forceRefreshData = false) {
    const nextPage = detectForegroundPage();
    const pageChanged =
      nextPage.mode !== detectedPage.mode || nextPage.label !== detectedPage.label;

    detectedPage = nextPage;

    if (pageChanged) {
      userManualOverride = false;
      if (detectedPage.mode === "notes" || detectedPage.mode === "devoirs") {
        activeMode = detectedPage.mode;
      }
    } else if (!userManualOverride && (detectedPage.mode === "notes" || detectedPage.mode === "devoirs")) {
      activeMode = detectedPage.mode;
    }

    applyActiveModeUI();

    const panel = document.getElementById("pn-sim-panel");
    const isOpen = panel && !panel.classList.contains("pn-hidden");

    if (forceRefreshData || (pageChanged && isOpen)) {
      if (activeMode === "notes") {
        if (subjectsData.length === 0 || !document.body.contains(subjectsData[0]?.domRow)) {
          parsePronoteDOM();
        }
        recalculateAll();
      } else if (activeMode === "devoirs") {
        parsePronoteHomeworkDOM();
        renderHomeworkList();
        if (!lmConnected && !lmChecking) {
          testAndLoadLmModels();
        }
      }
    }
  }

  function startForegroundWatcher() {
    const scheduleCheck = () => {
      if (fgObserverTimer) clearTimeout(fgObserverTimer);
      fgObserverTimer = setTimeout(() => {
        syncWithForegroundPage(false);
      }, 350);
    };

    const observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const target = mutations[i].target;
        if (target && target.nodeType === 1 && target.closest("#pn-sim-panel, #pn-sim-toggle")) {
          continue;
        }
        scheduleCheck();
        break;
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-selected", "aria-current", "style"],
    });

    window.addEventListener("hashchange", scheduleCheck);
    window.addEventListener("popstate", scheduleCheck);
    document.addEventListener(
      "click",
      (e) => {
        if (e.target && e.target.closest && !e.target.closest("#pn-sim-panel, #pn-sim-toggle")) {
          scheduleCheck();
        }
      },
      true
    );
  }

  // =========================================================================
  // CRÉATION DE L'INTERFACE UNIFIÉE
  // =========================================================================
  async function createSimulatorUI() {
    if (document.getElementById("pn-sim-toggle")) return;

    await loadSettings();

    const toggleBtn = document.createElement("button");
    toggleBtn.id = "pn-sim-toggle";
    toggleBtn.type = "button";
    toggleBtn.innerHTML = `<span>✨ Assistant PRONOTE</span>`;
    document.body.appendChild(toggleBtn);

    const panel = document.createElement("div");
    panel.id = "pn-sim-panel";
    panel.className = "pn-hidden";

    panel.innerHTML = `
      <div class="pn-sim-header" id="pn-sim-header">
        <div class="pn-header-title-wrap">
          <span id="pn-header-title">🧮 Simulateur & Évolution PRONOTE</span>
          <span class="pn-page-badge" id="pn-page-badge">Page active : PRONOTE</span>
        </div>
        <button type="button" id="pn-sim-close" title="Fermer">✕</button>
      </div>

      <div class="pn-mode-bar">
        <button type="button" class="pn-mode-btn active" data-mode="notes" title="Simulateur de notes et moyennes">
          <span class="pn-fg-dot"></span>🧮 Notes
        </button>
        <button type="button" class="pn-mode-btn" data-mode="devoirs" title="Analyse et résumé des devoirs via LM Studio local">
          <span class="pn-fg-dot"></span>📚 Devoirs IA
        </button>
      </div>

      <!-- ===================== VUE 1 : NOTES ===================== -->
      <div id="pn-view-notes" class="pn-module-view active">
        <div class="pn-sim-tabs">
          <button type="button" class="pn-sim-tab active" data-tab="tab-notes">📝 Notes & Coefs</button>
          <button type="button" class="pn-sim-tab" data-tab="tab-matieres">➕ Matières</button>
          <button type="button" class="pn-sim-tab" data-tab="tab-chart">📈 Évolution</button>
        </div>

        <div class="pn-sim-body">
          <div class="pn-sim-summary">
            <div>
              <div style="font-size:11px;color:#555;font-weight:600;">MOYENNE GÉNÉRALE SIMULÉE</div>
              <div style="font-size:11px;color:#777;" id="pn-sim-orig-label">Initiale : --</div>
            </div>
            <div style="display:flex;align-items:center;">
              <span class="pn-sim-summary-val" id="pn-sim-global-val">--</span>
              <span id="pn-sim-global-diff"></span>
            </div>
          </div>

          <div id="pn-sim-warning" style="display:none;background:#fff3cd;color:#856404;padding:8px;border-radius:6px;font-size:12px;">
            Ouvrez l'onglet <b>Mes notes (Mis calificaciones)</b> en affichage <b>Par matière (Por asignatura)</b> puis cliquez sur <b>Relire / Reset</b>.
          </div>

          <!-- ONGLET 1 : NOTES & COEFS -->
          <div id="tab-notes" class="pn-tab-content active">
            <div>
              <div class="pn-sim-section-title">Ajouter une note simulée</div>
              <form class="pn-sim-form" id="pn-sim-add-form">
                <div class="pn-sim-field pn-full">
                  <label>Matière</label>
                  <select id="pn-sim-subject" required></select>
                </div>
                <div class="pn-sim-field pn-full">
                  <label>Intitulé du devoir (optionnel)</label>
                  <input type="text" id="pn-sim-title" placeholder="Ex: DS 3, Bac blanc..." />
                </div>
                <div class="pn-sim-field">
                  <label>Note obtenue</label>
                  <input type="text" id="pn-sim-value" placeholder="Ex: 15,5" required />
                </div>
                <div class="pn-sim-field">
                  <label>Barème (/X)</label>
                  <input type="text" id="pn-sim-scale" value="20" required />
                </div>
                <div class="pn-sim-field">
                  <label title="Tapez un nombre (ex: 2, 0.25) ou une fraction exacte (ex: 1/3, 1/6)">Coef (ex: 1/3, 2)</label>
                  <input type="text" id="pn-sim-coef" value="1" placeholder="Ex: 1 ou 1/3" required />
                </div>
                <div class="pn-full" style="display:flex;gap:8px;margin-top:4px;">
                  <button type="submit" class="pn-sim-btn-primary" style="flex:1;">+ Ajouter la note</button>
                  <button type="button" id="pn-sim-reset" class="pn-sim-btn-secondary">🔄 Relire / Reset</button>
                </div>
              </form>
            </div>

            <div>
              <div class="pn-sim-section-title">Détail par matière & Coefs (accepte 1/X)</div>
              <div class="pn-sim-subj-list" id="pn-sim-subj-list"></div>
            </div>
          </div>

          <!-- ONGLET 2 : AJOUTER UNE MATIÈRE -->
          <div id="tab-matieres" class="pn-tab-content">
            <div>
              <div class="pn-sim-section-title">Créer une nouvelle matière</div>
              <form class="pn-sim-form" id="pn-sim-add-subj-form">
                <div class="pn-sim-field pn-span-2">
                  <label>Nom de la matière</label>
                  <input type="text" id="pn-new-subj-name" placeholder="Ex: PHILOSOPHIE, NSI, OPTION..." required />
                </div>
                <div class="pn-sim-field">
                  <label>Couleur</label>
                  <input type="color" id="pn-new-subj-color" value="#8b5cf6" style="height:31px;padding:2px;" />
                </div>
                <div class="pn-sim-field pn-span-2">
                  <label>Coefficient matière (ex: 4, 1/2, 0.5)</label>
                  <input type="text" id="pn-new-subj-coef" value="1" required />
                </div>
                <div class="pn-sim-field">
                  <label>1ère note (/20 opt.)</label>
                  <input type="text" id="pn-new-subj-grade" placeholder="Ex: 16" />
                </div>
                <div class="pn-full" style="margin-top:4px;">
                  <button type="submit" class="pn-sim-btn-primary" style="width:100%;">+ Créer la matière dans PRONOTE</button>
                </div>
              </form>
            </div>
            <div style="font-size:12px;color:#555;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #e2e8f0;">
              💡 <b>Astuce :</b> Une fois la matière créée, elle apparaît directement dans votre liste PRONOTE et dans le menu déroulant pour y ajouter autant de notes simulées que vous voulez.
            </div>
          </div>

          <!-- ONGLET 3 : DIAGRAMME D'ÉVOLUTION -->
          <div id="tab-chart" class="pn-tab-content">
            <div class="pn-chart-box">
              <div class="pn-sim-field">
                <label>Afficher l'évolution pour :</label>
                <select id="pn-chart-filter">
                  <option value="ALL">🌍 Moyenne Générale (toutes les matières)</option>
                </select>
              </div>
              <div class="pn-chart-canvas-wrap">
                <canvas id="pn-sim-chart"></canvas>
              </div>
              <div class="pn-chart-legend">
                <span id="pn-chart-stats"></span>
                <span>🟢 Réel &nbsp; 🟣 Simulé</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===================== VUE 2 : DEVOIRS IA (LM STUDIO) ===================== -->
      <div id="pn-view-devoirs" class="pn-module-view">
        <div class="pn-sim-body">
          <!-- Barre de statut LM Studio -->
          <div class="pn-lm-status-bar">
            <div class="pn-lm-status-left">
              <span class="pn-lm-dot" id="pn-lm-dot"></span>
              <span class="pn-lm-status-text" id="pn-lm-status-text">LM Studio non vérifié</span>
            </div>
            <div class="pn-lm-actions-inline">
              <button type="button" id="pn-lm-test-btn" class="pn-sim-btn-secondary" title="Tester la connexion et charger les modèles">🔄 Tester</button>
              <button type="button" id="pn-lm-config-toggle" class="pn-sim-btn-secondary" title="Configurer LM Studio">⚙️ Config</button>
            </div>
          </div>

          <!-- Configuration LM Studio (repliable) -->
          <div class="pn-lm-config-box pn-hidden" id="pn-lm-config-box">
            <div class="pn-lm-config-row">
              <div class="pn-sim-field">
                <label>URL serveur local LM Studio</label>
                <input type="text" id="pn-lm-url-input" value="${escapeHtml(lmSettings.baseUrl)}" placeholder="http://localhost:1234" />
              </div>
              <div class="pn-sim-field">
                <label>Température</label>
                <input type="number" id="pn-lm-temp-input" min="0" max="1" step="0.1" value="${escapeHtml(lmSettings.temperature)}" />
              </div>
            </div>
            <div class="pn-sim-field">
              <label>Modèle chargé dans LM Studio</label>
              <select id="pn-lm-model-select">
                <option value="">Cliquez sur « Tester » pour charger les modèles</option>
              </select>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:6px;">
              <button type="button" id="pn-lm-save-config" class="pn-btn-indigo" style="padding:6px 12px;font-size:12px;">💾 Enregistrer & Tester</button>
            </div>
          </div>

          <!-- Devoirs détectés -->
          <div>
            <div class="pn-hw-toolbar">
              <div class="pn-sim-section-title" style="margin-bottom:0;">
                Devoirs détectés (<span id="pn-hw-count">0</span>)
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <label class="pn-hw-filter-label">
                  <input type="checkbox" id="pn-hw-only-undone" ${lmSettings.onlyUndone ? "checked" : ""} />
                  Non faits uniquement
                </label>
                <button type="button" id="pn-hw-refresh" class="pn-sim-btn-secondary" style="padding:4px 8px;font-size:11.5px;">🔄 Relire</button>
              </div>
            </div>
            <div class="pn-hw-list" id="pn-hw-list" style="margin-top:6px;"></div>
          </div>

          <!-- Mode d'analyse & déclenchement -->
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div class="pn-sim-section-title" style="margin-bottom:0;">Type d'analyse IA</div>
            <div class="pn-ai-modes">
              <button type="button" class="pn-ai-mode-pill active" data-ai-mode="complete">📋 Résumé & Analyse</button>
              <button type="button" class="pn-ai-mode-pill" data-ai-mode="quick">⚡ Synthèse rapide</button>
              <button type="button" class="pn-ai-mode-pill" data-ai-mode="schedule">🗓️ Planning</button>
            </div>
            <button type="button" id="pn-ai-analyze-btn" class="pn-btn-indigo">
              ✨ Analyser & Résumer les devoirs
            </button>
            <form class="pn-ai-custom-row" id="pn-ai-custom-form">
              <input type="text" id="pn-ai-custom-input" placeholder="Question libre (ex: Explique le DM de maths, planning ce soir...)" />
              <button type="submit" class="pn-sim-btn-secondary">Envoyer</button>
            </form>
          </div>

          <!-- Résultat de l'analyse LM Studio -->
          <div class="pn-ai-result-box pn-hidden" id="pn-ai-result-box">
            <div class="pn-ai-result-head">
              <span id="pn-ai-result-title">Analyse LM Studio</span>
              <div style="display:flex;gap:4px;">
                <button type="button" id="pn-ai-copy-btn" class="pn-sim-btn-secondary" style="padding:2px 7px;font-size:11px;">📋 Copier</button>
                <button type="button" id="pn-ai-clear-btn" class="pn-sim-btn-secondary" style="padding:2px 7px;font-size:11px;">✕</button>
              </div>
            </div>
            <div class="pn-ai-result-content" id="pn-ai-result-content"></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    // =====================================================================
    // ÉVÉNEMENTS GLOBAUX & BASCULE DE MODE
    // =====================================================================
    panel.querySelectorAll(".pn-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        activeMode = mode;
        userManualOverride = true;
        applyActiveModeUI();

        if (mode === "notes") {
          if (subjectsData.length === 0 || !document.body.contains(subjectsData[0]?.domRow)) {
            parsePronoteDOM();
          }
          recalculateAll();
        } else if (mode === "devoirs") {
          parsePronoteHomeworkDOM();
          renderHomeworkList();
          if (!lmConnected && !lmChecking) {
            testAndLoadLmModels();
          }
        }
      });
    });

    toggleBtn.addEventListener("click", () => {
      const isHidden = panel.classList.contains("pn-hidden");
      if (isHidden) {
        panel.classList.remove("pn-hidden");
        syncWithForegroundPage(true);
      } else {
        panel.classList.add("pn-hidden");
      }
    });

    document.getElementById("pn-sim-close").addEventListener("click", () => {
      panel.classList.add("pn-hidden");
    });

    // =====================================================================
    // ÉVÉNEMENTS MODULE NOTES
    // =====================================================================
    panel.querySelectorAll(".pn-sim-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        panel.querySelectorAll(".pn-sim-tab").forEach((b) => b.classList.remove("active"));
        panel.querySelectorAll(".pn-tab-content").forEach((c) => c.classList.remove("active"));
        tabBtn.classList.add("active");
        const target = document.getElementById(tabBtn.getAttribute("data-tab"));
        if (target) target.classList.add("active");
        if (tabBtn.getAttribute("data-tab") === "tab-chart") {
          renderEvolutionChart();
        }
      });
    });

    document.getElementById("pn-chart-filter").addEventListener("change", () => {
      renderEvolutionChart();
    });

    document.getElementById("pn-sim-add-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const subjId = document.getElementById("pn-sim-subject").value;
      const titleInput = document.getElementById("pn-sim-title").value.trim();
      const val = parseFrFloat(document.getElementById("pn-sim-value").value);
      const scale = parseFrFloat(document.getElementById("pn-sim-scale").value);
      const coefRaw = document.getElementById("pn-sim-coef").value.trim();
      const coef = parseExactCoef(coefRaw);

      if (isNaN(val) || isNaN(scale) || scale <= 0 || isNaN(coef) || coef <= 0) {
        alert("Veuillez vérifier la note, le barème ou le coefficient (ex: 1, 0.5 ou 1/3).");
        return;
      }

      const subj = subjectsData.find((s) => s.id === subjId);
      if (!subj) return;

      simOrderCounter++;
      const newGrade = {
        id: `sim_${Date.now()}`,
        title: titleInput || "Devoir simulé",
        dateLabel: "Simulé",
        sortOrder: 90000 + simOrderCounter,
        value: val,
        scale: scale,
        coef: coef,
        coefRaw: coefRaw,
        isSimulated: true,
        domNodes: [],
      };

      subj.grades.unshift(newGrade);
      injectSimulatedGradeIntoPronoteDOM(subj, newGrade);

      document.getElementById("pn-sim-value").value = "";
      document.getElementById("pn-sim-title").value = "";
      recalculateAll();
    });

    document.getElementById("pn-sim-add-subj-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const nameInput = document.getElementById("pn-new-subj-name").value.trim().toUpperCase();
      const colorInput = document.getElementById("pn-new-subj-color").value;
      const coefRaw = document.getElementById("pn-new-subj-coef").value.trim();
      const coef = parseExactCoef(coefRaw);
      const firstGradeVal = parseFrFloat(document.getElementById("pn-new-subj-grade").value);

      if (!nameInput || isNaN(coef) || coef <= 0) {
        alert("Veuillez entrer un nom de matière et un coefficient valide (ex: 1, 2 ou 1/2).");
        return;
      }

      const newSubj = {
        id: `sim_subj_${Date.now()}`,
        name: nameInput,
        color: colorInput || "#8b5cf6",
        subjectCoef: coef,
        subjectCoefRaw: coefRaw,
        origAvg: NaN,
        currentAvg: NaN,
        domRow: null,
        domAvgEl: null,
        calcMode: "over20",
        isSimulatedSubject: true,
        grades: [],
      };

      injectSimulatedSubjectIntoPronoteDOM(newSubj);
      subjectsData.unshift(newSubj);

      if (!isNaN(firstGradeVal)) {
        simOrderCounter++;
        const initGrade = {
          id: `sim_${Date.now()}_init`,
          title: "Note initiale simulée",
          dateLabel: "Simulé",
          sortOrder: 90000 + simOrderCounter,
          value: firstGradeVal,
          scale: 20,
          coef: 1,
          coefRaw: "1",
          isSimulated: true,
          domNodes: [],
        };
        newSubj.grades.push(initGrade);
        injectSimulatedGradeIntoPronoteDOM(newSubj, initGrade);
      }

      document.getElementById("pn-new-subj-name").value = "";
      document.getElementById("pn-new-subj-grade").value = "";
      recalculateAll();

      document.getElementById("pn-sim-subject").value = newSubj.id;
      panel.querySelector('[data-tab="tab-notes"]').click();
    });

    document.getElementById("pn-sim-reset").addEventListener("click", () => {
      subjectsData.forEach((s) => {
        if (s.domAvgEl && s.domAvgEl.hasAttribute("data-orig-avg")) {
          s.domAvgEl.textContent = s.domAvgEl.getAttribute("data-orig-avg");
          s.domAvgEl.style.color = "";
        }
      });
      const globalSpan = getGlobalAverageSpan();
      if (globalSpan && globalSpan.hasAttribute("data-orig-global")) {
        globalSpan.textContent = globalSpan.getAttribute("data-orig-global");
      }
      parsePronoteDOM();
      recalculateAll();
    });

    // =====================================================================
    // ÉVÉNEMENTS MODULE DEVOIRS IA & LM STUDIO
    // =====================================================================
    document.getElementById("pn-lm-test-btn").addEventListener("click", () => {
      testAndLoadLmModels();
    });

    document.getElementById("pn-lm-config-toggle").addEventListener("click", () => {
      document.getElementById("pn-lm-config-box").classList.toggle("pn-hidden");
    });

    document.getElementById("pn-lm-model-select").addEventListener("change", (e) => {
      lmSettings.model = e.target.value;
      saveSettings();
      if (lmConnected && lmSettings.model) {
        updateLmStatusUI(`Connecté • ${lmSettings.model}`, "online");
      }
    });

    document.getElementById("pn-lm-save-config").addEventListener("click", () => {
      const urlVal = document.getElementById("pn-lm-url-input").value.trim();
      const tempVal = parseFloat(document.getElementById("pn-lm-temp-input").value);
      const modelVal = document.getElementById("pn-lm-model-select").value;

      lmSettings.baseUrl = urlVal || "http://localhost:1234";
      lmSettings.temperature = isNaN(tempVal) ? 0.3 : Math.max(0, Math.min(1, tempVal));
      if (modelVal) lmSettings.model = modelVal;
      saveSettings();
      testAndLoadLmModels();
    });

    document.getElementById("pn-hw-only-undone").addEventListener("change", (e) => {
      lmSettings.onlyUndone = e.target.checked;
      saveSettings();
      renderHomeworkList();
    });

    document.getElementById("pn-hw-refresh").addEventListener("click", () => {
      parsePronoteHomeworkDOM();
      renderHomeworkList();
    });

    panel.querySelectorAll(".pn-ai-mode-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        panel.querySelectorAll(".pn-ai-mode-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        selectedAnalysisMode = pill.getAttribute("data-ai-mode") || "complete";
      });
    });

    document.getElementById("pn-ai-analyze-btn").addEventListener("click", () => {
      runHomeworkAnalysis("");
    });

    document.getElementById("pn-ai-custom-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("pn-ai-custom-input");
      const q = input.value.trim();
      if (!q) return;
      runHomeworkAnalysis(q);
    });

    document.getElementById("pn-ai-copy-btn").addEventListener("click", async () => {
      if (!lastAiMarkdown) return;
      try {
        await navigator.clipboard.writeText(lastAiMarkdown);
        const btn = document.getElementById("pn-ai-copy-btn");
        btn.textContent = "✅ Copié";
        setTimeout(() => (btn.textContent = "📋 Copier"), 1500);
      } catch {
        // ignore
      }
    });

    document.getElementById("pn-ai-clear-btn").addEventListener("click", () => {
      lastAiMarkdown = "";
      document.getElementById("pn-ai-result-box").classList.add("pn-hidden");
    });

    // Initialisation détection page active + observateur temps réel
    syncWithForegroundPage(false);
    startForegroundWatcher();
  }

  function updateSimulatorUI(newGlobalAvg) {
    const selectEl = document.getElementById("pn-sim-subject");
    const chartFilterEl = document.getElementById("pn-chart-filter");
    const listEl = document.getElementById("pn-sim-subj-list");
    const globalValEl = document.getElementById("pn-sim-global-val");
    const globalDiffEl = document.getElementById("pn-sim-global-diff");
    const origLabelEl = document.getElementById("pn-sim-orig-label");
    const warningEl = document.getElementById("pn-sim-warning");

    if (!selectEl || !listEl) return;

    if (subjectsData.length === 0) {
      warningEl.style.display = "block";
      selectEl.innerHTML = "";
      listEl.innerHTML = "";
      globalValEl.textContent = "--";
      return;
    } else {
      warningEl.style.display = "none";
    }

    const currentSelected = selectEl.value;
    selectEl.innerHTML = subjectsData
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");
    if (currentSelected && subjectsData.some((s) => s.id === currentSelected)) {
      selectEl.value = currentSelected;
    }

    if (chartFilterEl) {
      const prevChartSel = chartFilterEl.value;
      chartFilterEl.innerHTML =
        `<option value="ALL">🌍 Moyenne Générale (toutes les matières)</option>` +
        subjectsData
          .map((s) => `<option value="${escapeHtml(s.id)}">📘 ${escapeHtml(s.name)}</option>`)
          .join("");
      if (prevChartSel && (prevChartSel === "ALL" || subjectsData.some((s) => s.id === prevChartSel))) {
        chartFilterEl.value = prevChartSel;
      }
    }

    origLabelEl.textContent = `Initiale : ${!isNaN(initialGlobalAvg) ? formatFrFloat(initialGlobalAvg) : "--"}`;
    globalValEl.textContent = !isNaN(newGlobalAvg) ? formatFrFloat(newGlobalAvg) : "--";

    if (!isNaN(newGlobalAvg) && !isNaN(initialGlobalAvg)) {
      const diff = newGlobalAvg - initialGlobalAvg;
      if (Math.abs(diff) >= 0.01) {
        const sign = diff > 0 ? "+" : "";
        globalDiffEl.className = `pn-sim-diff ${diff > 0 ? "pn-diff-up" : "pn-diff-down"}`;
        globalDiffEl.textContent = `${sign}${formatFrFloat(diff)}`;
      } else {
        globalDiffEl.className = "";
        globalDiffEl.textContent = "";
      }
    }

    listEl.innerHTML = "";
    subjectsData.forEach((subj) => {
      const card = document.createElement("div");
      card.className = "pn-sim-subj-card";
      card.style.borderLeft = `4px solid ${subj.color}`;

      const avgTxt = !isNaN(subj.currentAvg) ? formatFrFloat(subj.currentAvg) : "—";
      let diffHtml = "";
      if (!isNaN(subj.currentAvg) && !isNaN(subj.origAvg)) {
        const d = subj.currentAvg - subj.origAvg;
        if (Math.abs(d) >= 0.01) {
          const sign = d > 0 ? "+" : "";
          diffHtml = `<span class="pn-sim-diff ${d > 0 ? "pn-diff-up" : "pn-diff-down"}">${sign}${formatFrFloat(d)}</span>`;
        }
      }

      card.innerHTML = `
        <div class="pn-sim-subj-top">
          <span style="display:flex;align-items:center;gap:4px;">
            ${escapeHtml(subj.name)}
            ${subj.isSimulatedSubject ? `<button type="button" class="pn-del-subj-btn" title="Supprimer cette matière simulée">🗑️</button>` : ""}
          </span>
          <div class="pn-sim-subj-meta">
            <select class="pn-subj-mode" title="Mode de calcul" style="font-size:11px;padding:1px 2px;border:1px solid #cbd5e1;border-radius:4px;">
              <option value="over20" ${subj.calcMode === "over20" ? "selected" : ""}>/20</option>
              <option value="points" ${subj.calcMode === "points" ? "selected" : ""}>Pts</option>
            </select>
            <label title="Tapez un nombre ou une fraction (ex: 1/2, 1/3)">Coef:</label>
            <input type="text" class="pn-sim-subj-coef" value="${escapeHtml(formatCoefDisplay(subj.subjectCoefRaw))}" title="Ex: 1, 2, 0.5 ou 1/3" />
            <span style="min-width:38px;text-align:right;font-size:13.5px;">${avgTxt}</span>
            ${diffHtml}
          </div>
        </div>
        <div class="pn-sim-grades-mini" id="pn-grades-${escapeHtml(subj.id)}"></div>
      `;

      listEl.appendChild(card);

      if (subj.isSimulatedSubject) {
        card.querySelector(".pn-del-subj-btn").addEventListener("click", () => {
          subj.grades.forEach((g) => {
            if (g.domNodes) g.domNodes.forEach((n) => n.remove());
          });
          if (subj.domRow) subj.domRow.remove();
          subjectsData = subjectsData.filter((s) => s.id !== subj.id);
          recalculateAll();
        });
      }

      card.querySelector(".pn-subj-mode").addEventListener("change", (e) => {
        subj.calcMode = e.target.value;
        recalculateAll();
      });

      card.querySelector(".pn-sim-subj-coef").addEventListener("change", (e) => {
        const raw = e.target.value.trim();
        const val = parseExactCoef(raw);
        if (!isNaN(val) && val >= 0) {
          subj.subjectCoef = val;
          subj.subjectCoefRaw = raw;
          recalculateAll();
        } else {
          e.target.value = formatCoefDisplay(subj.subjectCoefRaw);
        }
      });

      const gradesContainer = card.querySelector(`#pn-grades-${subj.id}`);
      if (subj.grades.length === 0) {
        gradesContainer.innerHTML = `<span style="color:#888;font-size:11px;font-style:italic;">Aucune note chiffrée</span>`;
      } else {
        subj.grades.forEach((g) => {
          const chip = document.createElement("span");
          chip.className = `pn-sim-chip ${g.isSimulated ? "is-sim" : ""}`;
          const scaleStr = g.scale !== 20 ? `/${g.scale}` : "";
          chip.innerHTML = `
            <span title="${escapeHtml(g.title)} (${escapeHtml(g.dateLabel)})">${formatFrFloat(g.value)}${escapeHtml(scaleStr)}</span>
            <input type="text" class="pn-grade-coef" title="Coefficient du devoir (ex: 1, 0.5, 1/3)" value="${escapeHtml(formatCoefDisplay(g.coefRaw))}" />
            ${g.isSimulated ? `<button type="button" title="Supprimer">✕</button>` : ""}
          `;

          chip.querySelector(".pn-grade-coef").addEventListener("change", (e) => {
            const raw = e.target.value.trim();
            const c = parseExactCoef(raw);
            if (!isNaN(c) && c > 0) {
              g.coef = c;
              g.coefRaw = raw;
              recalculateAll();
            } else {
              e.target.value = formatCoefDisplay(g.coefRaw);
            }
          });

          if (g.isSimulated) {
            chip.querySelector("button").addEventListener("click", () => {
              if (g.domNodes) g.domNodes.forEach((n) => n.remove());
              subj.grades = subj.grades.filter((item) => item.id !== g.id);
              recalculateAll();
            });
          }

          gradesContainer.appendChild(chip);
        });
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createSimulatorUI);
  } else {
    createSimulatorUI();
  }
})();
