(function () {
  "use strict";

  let subjectsData = [];
  let initialGlobalAvg = null;
  let simOrderCounter = 1000;

  // Convertit "14,05" -> 14.05
  function parseFrFloat(str) {
    if (!str) return NaN;
    const cleaned = String(str).replace(/\s/g, "").replace(",", ".");
    return parseFloat(cleaned);
  }

  // Permet de saisir un nombre exact ("0.3333", "1,25") OU une fraction ("1/3", "1/7", "2/5")
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

  // Affiche un coefficient proprement
  function formatCoefDisplay(coefStrOrNum) {
    if (typeof coefStrOrNum === "string" && coefStrOrNum.includes("/")) {
      return coefStrOrNum;
    }
    const n = Number(coefStrOrNum);
    if (isNaN(n)) return "1";
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
  }

  // Convertit 14.05 -> "14,05"
  function formatFrFloat(num) {
    if (isNaN(num) || num === null) return "";
    return num.toFixed(2).replace(".", ",");
  }

  // Convertit l'attribut datetime="10-01" de PRONOTE en clé de tri chronologique d'année scolaire (Sept -> Août)
  function dateAttrToSortKey(mmdd, fallbackIdx) {
    if (!mmdd || !mmdd.includes("-")) return 50000 - fallbackIdx;
    const [mStr, dStr] = mmdd.split("-");
    const month = parseInt(mStr, 10);
    const day = parseInt(dStr, 10);
    if (isNaN(month) || isNaN(day)) return 50000 - fallbackIdx;
    // Année scolaire : Septembre (9) à Décembre (12) = année N, Janvier (1) à Août (8) = année N+1
    const schoolYearMonth = month >= 9 ? month - 9 : month + 3;
    return schoolYearMonth * 100 + day;
  }

  // Extrait une note et son barème depuis un élément .note-devoir
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

  // Lit les matières et notes PRONOTE
  function parsePronoteDOM() {
    const grid = document.querySelector('.ListeDernieresNotes [role="tree"]');
    if (!grid) return false;

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

  // Injecte une nouvelle matière simulée dans l'arbre PRONOTE
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
              <span class="ie-line-color static only-color var-height" style="--color-line :${subj.color}; --var-height:2.2rem;"></span>
            </div>
            <div class="zone-centrale">
              <div class="zone-contenu-format">
                <div class="zone-principale">
                  <div class="titre-principal">
                    <span class="ie-titre-gros"><span class="pn-sim-badge">MATIÈRE SIM</span>${subj.name}</span>
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

  // Injecte une note simulée sous sa matière dans PRONOTE
  function injectSimulatedGradeIntoPronoteDOM(subj, gradeObj) {
    if (!subj.domRow) return;

    const hr = document.createElement("hr");
    hr.className = "liste_sepligne pn-simulated-dom-node";
    hr.setAttribute("role", "presentation");

    const row = document.createElement("div");
    row.className = "liste_celluleGrid fd_ligne with-select pn-simulated-row pn-simulated-dom-node";
    row.style.cssText = "grid-column:1;min-height:40px;padding:1px 1px;";

    const scaleHtml = gradeObj.scale !== 20 ? `<span>/${gradeObj.scale}</span>` : "";
    const coefBadge = ` (Coef. ${formatCoefDisplay(gradeObj.coefRaw)})`;

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
                    <div class="ie_ellipsis"><span class="pn-sim-badge">SIM</span>${gradeObj.title}</div>
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

  // Calcule la série chronologique des moyennes (générale ou pour une matière)
  function computeEvolutionSeries(targetFilter) {
    if (targetFilter === "ALL") {
      // Collecter tous les devoirs de toutes les matières avec leur référence matière
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
        // Calculer la moyenne générale à cet instant T
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

  // Dessine le diagramme d'évolution sur le <canvas>
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

    // Échelle Y dynamique pour bien voir les variations tout en restant bornée entre 0 et 20
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

    // Grille horizontale
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

    // Remplissage sous la courbe
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

    // Tracé de la ligne
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

    // Points + valeurs + dates en bas
    points.forEach((pt, i) => {
      const x = getX(i);
      const y = getY(pt.avg);

      // Point (violet si note simulée, vert sinon)
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = pt.isSim ? "#7c3aed" : "#008673";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Valeur au-dessus du premier, dernier ou si peu de points
      if (points.length <= 8 || i === 0 || i === points.length - 1 || pt.isSim) {
        ctx.fillStyle = pt.isSim ? "#5b21b6" : "#1e293b";
        ctx.font = "bold 9.5px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(formatFrFloat(pt.avg), x, y - 8);
      }

      // Date sur l'axe X (espacée pour éviter le chevauchement)
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

  function createSimulatorUI() {
    if (document.getElementById("pn-sim-toggle")) return;

    const toggleBtn = document.createElement("button");
    toggleBtn.id = "pn-sim-toggle";
    toggleBtn.type = "button";
    toggleBtn.innerHTML = `<span>🧮 Simulateur de notes</span>`;
    document.body.appendChild(toggleBtn);

    const panel = document.createElement("div");
    panel.id = "pn-sim-panel";
    panel.className = "pn-hidden";

    panel.innerHTML = `
      <div class="pn-sim-header">
        <span>🧮 Simulateur & Évolution PRONOTE</span>
        <button type="button" id="pn-sim-close" title="Fermer">✕</button>
      </div>

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
    `;

    document.body.appendChild(panel);

    // Navigation entre les onglets
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

    // Ouverture / Fermeture
    toggleBtn.addEventListener("click", () => {
      const isHidden = panel.classList.contains("pn-hidden");
      if (isHidden) {
        if (subjectsData.length === 0 || !document.body.contains(subjectsData[0]?.domRow)) {
          parsePronoteDOM();
        }
        recalculateAll();
        panel.classList.remove("pn-hidden");
      } else {
        panel.classList.add("pn-hidden");
      }
    });

    document.getElementById("pn-sim-close").addEventListener("click", () => {
      panel.classList.add("pn-hidden");
    });

    // Ajout d'une note simulée (avec support des fractions 1/X)
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

    // Création d'une nouvelle matière simulée
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

      // Basculer sur l'onglet Notes avec la nouvelle matière sélectionnée
      document.getElementById("pn-sim-subject").value = newSubj.id;
      panel.querySelector('[data-tab="tab-notes"]').click();
    });

    // Bouton Reset
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

    // Mettre à jour le sélecteur de matière (formulaire)
    const currentSelected = selectEl.value;
    selectEl.innerHTML = subjectsData
      .map((s) => `<option value="${s.id}">${s.name}</option>`)
      .join("");
    if (currentSelected && subjectsData.some((s) => s.id === currentSelected)) {
      selectEl.value = currentSelected;
    }

    // Mettre à jour le sélecteur du graphique d'évolution
    if (chartFilterEl) {
      const prevChartSel = chartFilterEl.value;
      chartFilterEl.innerHTML =
        `<option value="ALL">🌍 Moyenne Générale (toutes les matières)</option>` +
        subjectsData.map((s) => `<option value="${s.id}">📘 ${s.name}</option>`).join("");
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
            ${subj.name}
            ${subj.isSimulatedSubject ? `<button type="button" class="pn-del-subj-btn" title="Supprimer cette matière simulée">🗑️</button>` : ""}
          </span>
          <div class="pn-sim-subj-meta">
            <select class="pn-subj-mode" title="Mode de calcul" style="font-size:11px;padding:1px 2px;border:1px solid #cbd5e1;border-radius:4px;">
              <option value="over20" ${subj.calcMode === "over20" ? "selected" : ""}>/20</option>
              <option value="points" ${subj.calcMode === "points" ? "selected" : ""}>Pts</option>
            </select>
            <label title="Tapez un nombre ou une fraction (ex: 1/2, 1/3)">Coef:</label>
            <input type="text" class="pn-sim-subj-coef" value="${formatCoefDisplay(subj.subjectCoefRaw)}" title="Ex: 1, 2, 0.5 ou 1/3" />
            <span style="min-width:38px;text-align:right;font-size:13.5px;">${avgTxt}</span>
            ${diffHtml}
          </div>
        </div>
        <div class="pn-sim-grades-mini" id="pn-grades-${subj.id}"></div>
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
            <span title="${g.title} (${g.dateLabel})">${formatFrFloat(g.value)}${scaleStr}</span>
            <input type="text" class="pn-grade-coef" title="Coefficient du devoir (ex: 1, 0.5, 1/3)" value="${formatCoefDisplay(g.coefRaw)}" />
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