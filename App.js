import { useState, useCallback, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, SafeAreaView, StatusBar, Alert, Modal,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ============================================================================
// PE Severity Classifier — React Native + AsyncStorage history
// 2026 AHA/ACC acute PE clinical category system (A-E).
// CLINICAL DECISION SUPPORT ONLY. Not a validated or regulated device.
// ============================================================================

const STORAGE_KEY = "pe_classifier_history";

const C = {
  bg:        "#0d1117",
  card:      "#0f1923",
  surface:   "#1a2332",
  border:    "#1e293b",
  border2:   "#2d3f52",
  text:      "#e2e8f0",
  textMid:   "#94a3b8",
  textDim:   "#64748b",
  textFaint: "#475569",
  blue:      "#3b82f6",
  blueDark:  "#1d4ed8",
  blueDeep:  "#1e3a5f",
  green:     "#22c55e",
  greenDim:  "#86efac",
  yellow:    "#f59e0b",
  red:       "#ef4444",
  accent:    "#60a5fa",
};

// ---- initial state --------------------------------------------------------
const initialPatient = {
  symptomatic: "", shockType: "", endOrgan: "", scoreResult: "",
  rvFunction: "", biomarkers: "", spo2: "", rr: "", supplementalO2: "",
};
const initialVars = {
  age: "",
  male: false, cancer: false, heartFailure: false, lungDisease: false,
  ams: false, hr110: false, sbp100: false, sbp90to100: false,
  rr30: false, temp36: false, sat90: false,
  troponin: false, rvd: false,
  h_hemo: false, h_thrombo: false, h_bleed: false, h_o2: false,
  h_pain: false, h_social: false, h_renal: false, h_liver: false, h_pregnant: false,
};

// ---- score computations --------------------------------------------------
function computePESI(v) {
  const a = parseInt(v.age, 10);
  if (isNaN(a)) return null;
  let pts = a;
  if (v.male) pts += 10; if (v.cancer) pts += 30;
  if (v.heartFailure) pts += 10; if (v.lungDisease) pts += 10;
  if (v.hr110) pts += 20; if (v.sbp100) pts += 30;
  if (v.rr30) pts += 20; if (v.temp36) pts += 20;
  if (v.ams) pts += 60; if (v.sat90) pts += 20;
  let cls = "I";
  if (pts > 125) cls = "V"; else if (pts > 105) cls = "IV";
  else if (pts > 85) cls = "III"; else if (pts > 65) cls = "II";
  return { points: pts, cls, level: pts > 85 ? "elevated" : "low" };
}
function computeSPESI(v) {
  const a = parseInt(v.age, 10);
  let pts = 0;
  if (!isNaN(a) && a > 80) pts++;
  if (v.cancer) pts++;
  if (v.heartFailure || v.lungDisease) pts++;
  if (v.hr110) pts++; if (v.sbp100) pts++; if (v.sat90) pts++;
  return { points: pts, level: pts >= 1 ? "elevated" : "low" };
}
function computeBova(v) {
  let pts = 0;
  if (v.hr110) pts += 1; if (v.sbp90to100) pts += 2;
  if (v.troponin) pts += 2; if (v.rvd) pts += 2;
  let stage = "I";
  if (pts > 4) stage = "III"; else if (pts >= 3) stage = "II";
  return { points: pts, stage, level: stage === "I" ? "low" : "elevated" };
}
function computeHestia(v) {
  const n = [v.h_hemo, v.h_thrombo, v.h_bleed, v.h_o2, v.h_pain,
             v.h_social, v.h_renal, v.h_liver, v.h_pregnant].filter(Boolean).length;
  return { points: n, level: n >= 1 ? "elevated" : "low" };
}
function combinedLevel(v) {
  const pesi = computePESI(v), sp = computeSPESI(v),
        bo = computeBova(v), he = computeHestia(v);
  const anyElevated =
    (pesi && pesi.level === "elevated") || sp.level === "elevated" ||
    bo.level === "elevated" || he.level === "elevated";
  return anyElevated ? "elevated" : "low";
}

// ---- management map ------------------------------------------------------
const ANTICOAG_OUTPT = { type: "do", k: "Anticoagulation", v: "DOAC preferred over warfarin (Class 1). Outpatient treatment reasonable using a validated decision tool (Hestia / PESI / sPESI)." };
const ANTICOAG_INPT  = { type: "do", k: "Anticoagulation", v: "LMWH (e.g. enoxaparin) preferred over UFH if parenteral needed (Class 1); transition to DOAC over warfarin (Class 1)." };
const PERT           = { type: "do", k: "PERT activation", v: "Activate the PE Response Team (Class 1, B-NR)." };
const WORKUP         = { type: "do", k: "Workup & disposition", v: "Hospitalize. Cardiac biomarkers + lactate (Class 1). Assess RV by imaging, echo preferred over CT." };
const LACTATE        = { type: "do", k: "Lactate", v: "Measure venous or arterial lactate (Class 1 for categories C-E); identifies occult hypoperfusion." };
const SEDATION       = { type: "avoid", k: "Sedation / intubation", v: "Avoid deep sedation & mechanical ventilation unless necessary (Class 3: Harm) — high cardiac-arrest risk with RV dysfunction." };

const MGMT = {
  A:  [{ type: "do", k: "Disposition", v: "Discharge from ED appropriate; hospitalization not required." }, ANTICOAG_OUTPT, { type: "avoid", k: "Advanced therapy", v: "Systemic thrombolysis: Harm. CDT / MT: not recommended." }],
  B:  [{ type: "do", k: "Disposition", v: "Early discharge generally recommended; use a validated decision tool." }, ANTICOAG_OUTPT, { type: "avoid", k: "Advanced therapy", v: "Systemic thrombolysis: Harm. CDT / MT: not recommended." }],
  C1: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, { type: "avoid", k: "Systemic thrombolysis", v: "Harm in C1." }, { type: "avoid", k: "Catheter therapy (CDT / MT)", v: "No Benefit in C1." }],
  C2: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, { type: "avoid", k: "Systemic thrombolysis", v: "Not recommended outside deterioration." }, { type: "consider", k: "Catheter therapy (CDT / MT)", v: "Benefit 'unclear'; weak 2b option in selected patients." }],
  C3: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, { type: "info", k: "Close monitoring", v: "Monitor first 24-72 h for deterioration. MAP <80 mm Hg may flag need to escalate (2a)." }, { type: "consider", k: "Catheter therapy (CDT / MT)", v: "Benefit 'unclear'; weak 2b option." }],
  D1: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, SEDATION, { type: "consider", k: "Advanced therapy", v: "Systemic thrombolysis, CDT, MT, or surgical embolectomy may be considered." }, { type: "consider", k: "Hemodynamic support", v: "Vasopressors (norepinephrine first-line) if needed." }],
  D2: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, SEDATION, { type: "consider", k: "Advanced therapy", v: "Systemic thrombolysis, CDT, or MT may be considered." }, { type: "consider", k: "Hemodynamic support", v: "Vasopressors / inotropes; HFNC over standard nasal cannula for moderate-severe hypoxia." }],
  E1: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, SEDATION, { type: "do", k: "Advanced therapy", v: "Reasonable: systemic thrombolysis, CDT, MT, or surgical embolectomy." }, { type: "consider", k: "Mechanical circulatory support", v: "MCS reasonable for cardiogenic shock with RV dysfunction." }],
  E2: [WORKUP, LACTATE, ANTICOAG_INPT, PERT, SEDATION, { type: "do", k: "Systemic thrombolysis", v: "Reasonable in cardiopulmonary failure / arrest." }, { type: "do", k: "VA-ECMO", v: "Reasonable for refractory cardiogenic shock with known/suspected PE." }, { type: "avoid", k: "Surgical embolectomy", v: "Not recommended over other options (e.g. VA-ECMO) in this setting." }],
};
const REC = {
  do:       { dot: C.green,  word: "Recommended" },
  consider: { dot: C.yellow, word: "May consider / reasonable" },
  avoid:    { dot: C.red,    word: "Avoid / no benefit" },
  info:     { dot: C.accent, word: "Note" },
};
function getManagement(category) {
  if (!category) return [];
  return MGMT[category.replace("R", "").toUpperCase()] || [];
}

// ---- classification engine -----------------------------------------------
function getRespTag(p) {
  const anyEntered = p.spo2 !== "" || p.rr !== "" || p.supplementalO2 !== "";
  if (!anyEntered) return null;
  const pos = (p.spo2 !== "" && parseFloat(p.spo2) < 90) ||
              (p.rr !== "" && parseFloat(p.rr) >= 30) ||
              p.supplementalO2 === "yes";
  return pos ? "R+" : "R-";
}
function getCSubcategory(p) {
  const rv = p.rvFunction === "abnormal";
  const bio = p.biomarkers === "one_elevated" || p.biomarkers === "both_elevated";
  if (rv && bio) return "3";
  if (rv || bio) return "2";
  if (p.rvFunction === "normal" && p.biomarkers === "normal") return "1";
  return "";
}
function classify(p) {
  if (!p.symptomatic) return null;
  if (p.symptomatic === "no")
    return { category: "A", label: "Category A - Asymptomatic", color: C.green, badge: "LOW RISK", badgeColor: "#16a34a", details: "Incidentally discovered PE without symptoms. DOAC and reliable outpatient follow-up.", resp: null };
  if (p.shockType === "persistent")
    return { category: "E1", label: "Category E1 - Persistent Hypotension with Cardiogenic Shock", color: C.red, badge: "CRITICAL RISK", badgeColor: "#991b1b", details: "Cardiopulmonary failure: persistent hypotension (SBP <90) with cardiogenic shock.", resp: getRespTag(p) };
  if (p.shockType === "arrest")
    return { category: "E2", label: "Category E2 - Refractory Shock / Cardiac Arrest", color: "#7f1d1d", badge: "CRITICAL RISK", badgeColor: "#450a0a", details: "Refractory shock or cardiac arrest secondary to PE.", resp: getRespTag(p) };
  if (p.shockType === "transient")
    return { category: "D1", label: "Category D1 - Transient Hypotension", color: "#ea580c", badge: "HIGH RISK", badgeColor: "#9a3412", details: "Incipient failure: short-lived or volume-responsive hypotension WITHOUT end-organ dysfunction.", resp: getRespTag(p) };
  if (p.shockType === "normotensive_shock" && p.endOrgan === "yes")
    return { category: "D2", label: "Category D2 - Normotensive Shock", color: "#ea580c", badge: "HIGH RISK", badgeColor: "#9a3412", details: "Normotensive shock: end-organ hypoperfusion (lactate >2, AKI, UOP <0.5 mL/kg/h, or CI <2.2) WITHOUT frank hypotension.", resp: getRespTag(p) };
  if (p.scoreResult === "low")
    return { category: "B", label: "Category B - Symptomatic, Low Risk", color: "#84cc16", badge: "LOW RISK", badgeColor: "#3f6212", details: "Symptomatic PE with all clinical severity scores low.", resp: null };
  if (p.scoreResult === "elevated") {
    const sub = getCSubcategory(p);
    const d = {
      "1": "Elevated score, normal RV AND normal biomarkers. Catheter therapy not recommended (No Benefit, C1).",
      "2": "Elevated score with EITHER abnormal RV OR elevated biomarker(s). Invasive benefit unclear; CDT/MT may be considered (2b).",
      "3": "Elevated score with BOTH abnormal RV AND elevated biomarker(s). CDT/MT may be considered (2b).",
      "":  "Elevated score. Enter RV imaging + biomarkers to sub-classify.",
    };
    return { category: `C${sub}`, label: `Category C${sub} - Symptomatic, Elevated Risk, Normotensive`, color: C.yellow, badge: "INTERMEDIATE RISK", badgeColor: "#92400e", details: d[sub], resp: getRespTag(p) };
  }
  return null;
}

// ---- helper: format timestamp -------------------------------------------
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    "  " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// =================== UI COMPONENTS ========================================
function SectionHeader({ title }) {
  return (
    <View style={s.sectionHeader}>
      <Text style={s.sectionTitle}>{title.toUpperCase()}</Text>
    </View>
  );
}

function RadioGroup({ options, value, onChange }) {
  return (
    <View style={s.radioGroup}>
      {options.map(opt => (
        <TouchableOpacity
          key={opt.value}
          style={[s.radioOption, value === opt.value && s.radioSelected]}
          onPress={() => onChange(opt.value)}
          activeOpacity={0.7}
        >
          <View style={[s.radioCircle, value === opt.value && s.radioCircleSelected]}>
            {value === opt.value && <View style={s.radioDot} />}
          </View>
          <Text style={[s.radioLabel, value === opt.value && s.radioLabelSelected]}>{opt.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function CheckRow({ label, checked, onToggle }) {
  return (
    <TouchableOpacity style={[s.checkRow, checked && s.checkRowOn]} onPress={onToggle} activeOpacity={0.7}>
      <View style={[s.checkBox, checked && s.checkBoxOn]}>
        {checked && <Text style={s.checkMark}>✓</Text>}
      </View>
      <Text style={[s.checkLabel, checked && s.checkLabelOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ScoreChip({ label, value, level }) {
  const isElevated = level === "elevated";
  return (
    <View style={s.scoreChip}>
      <Text style={s.scoreChipLabel}>{label}</Text>
      <Text style={s.scoreChipValue}>{value}</Text>
      <Text style={[s.scoreChipLevel, isElevated ? s.levelElevated : s.levelLow]}>
        {label === "Hestia" ? (isElevated ? "positive" : "negative") : level}
      </Text>
    </View>
  );
}

// =================== UNIFIED CALCULATOR ===================================
function UnifiedCalculator({ vars, setVar, onApply }) {
  const t = (id) => () => setVar(id, !vars[id]);
  const pesi = computePESI(vars);
  const sp   = computeSPESI(vars);
  const bo   = computeBova(vars);
  const he   = computeHestia(vars);
  const overall = combinedLevel(vars);

  return (
    <View style={s.calcCard}>
      <Text style={s.calcSub}>SHARED CLINICAL VARIABLES (entered once)</Text>

      <Text style={s.fieldLabel}>Age (years)</Text>
      <TextInput
        style={s.numberInput}
        placeholder="e.g. 68"
        placeholderTextColor={C.textFaint}
        keyboardType="number-pad"
        value={vars.age}
        onChangeText={v => setVar("age", v)}
      />

      <View style={s.checkGrid}>
        <CheckRow label="Male sex"               checked={vars.male}         onToggle={t("male")} />
        <CheckRow label="Cancer"                 checked={vars.cancer}       onToggle={t("cancer")} />
        <CheckRow label="Heart failure"          checked={vars.heartFailure} onToggle={t("heartFailure")} />
        <CheckRow label="Chronic lung disease"   checked={vars.lungDisease}  onToggle={t("lungDisease")} />
        <CheckRow label="Altered mental status"  checked={vars.ams}          onToggle={t("ams")} />
        <CheckRow label="Heart rate >= 110 bpm"  checked={vars.hr110}        onToggle={t("hr110")} />
        <CheckRow label="Systolic BP < 100 mmHg" checked={vars.sbp100}      onToggle={t("sbp100")} />
        <CheckRow label="Systolic BP 90-100 mmHg (Bova)" checked={vars.sbp90to100} onToggle={t("sbp90to100")} />
        <CheckRow label="Resp rate >= 30/min"    checked={vars.rr30}         onToggle={t("rr30")} />
        <CheckRow label="Temperature < 36 C"     checked={vars.temp36}       onToggle={t("temp36")} />
        <CheckRow label="O2 saturation < 90%"    checked={vars.sat90}        onToggle={t("sat90")} />
        <CheckRow label="Elevated troponin"       checked={vars.troponin}     onToggle={t("troponin")} />
        <CheckRow label="RV dysfunction (echo/CT)" checked={vars.rvd}        onToggle={t("rvd")} />
      </View>

      <Text style={[s.calcSub, { marginTop: 16 }]}>HESTIA OUTPATIENT-EXCLUSION ITEMS</Text>
      <View style={s.checkGrid}>
        <CheckRow label="Hemodynamic instability"        checked={vars.h_hemo}     onToggle={t("h_hemo")} />
        <CheckRow label="Needs thrombolysis/embolectomy" checked={vars.h_thrombo}  onToggle={t("h_thrombo")} />
        <CheckRow label="Active bleeding / high risk"    checked={vars.h_bleed}    onToggle={t("h_bleed")} />
        <CheckRow label="O2 needed > 24 h"              checked={vars.h_o2}       onToggle={t("h_o2")} />
        <CheckRow label="Severe pain, IV meds > 24 h"   checked={vars.h_pain}     onToggle={t("h_pain")} />
        <CheckRow label="Medical/social admit reason"    checked={vars.h_social}   onToggle={t("h_social")} />
        <CheckRow label="Severe renal impairment (CrCl <30)" checked={vars.h_renal} onToggle={t("h_renal")} />
        <CheckRow label="Severe liver impairment"        checked={vars.h_liver}    onToggle={t("h_liver")} />
        <CheckRow label="Pregnancy"                      checked={vars.h_pregnant} onToggle={t("h_pregnant")} />
      </View>

      <View style={s.scoreRow}>
        <ScoreChip label="PESI"   value={pesi ? `${pesi.points} (${pesi.cls})` : "-"} level={pesi ? pesi.level : "low"} />
        <ScoreChip label="sPESI"  value={String(sp.points)} level={sp.level} />
        <ScoreChip label="Bova"   value={`${bo.points} (${bo.stage})`} level={bo.level} />
        <ScoreChip label="Hestia" value={String(he.points)} level={he.level} />
      </View>

      <View style={[s.calcResult, overall === "elevated" ? s.calcResultElevated : s.calcResultLow]}>
        <Text style={[s.calcResultText, overall === "elevated" ? s.levelElevated : s.levelLow]}>
          Combined: <Text style={{ fontWeight: "700" }}>{overall === "elevated" ? "ELEVATED" : "LOW"}</Text>
          {"\n"}{overall === "elevated" ? "-> Category C path" : "-> Category B"}
        </Text>
        <TouchableOpacity style={s.applyBtn} onPress={() => onApply(overall)} activeOpacity={0.8}>
          <Text style={s.applyBtnText}>Use this result -></Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// =================== HISTORY MODAL ========================================
function HistoryModal({ visible, history, onClose, onDelete, onClearAll }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalSafe}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Saved Results</Text>
          <View style={s.modalHeaderRight}>
            {history.length > 0 && (
              <TouchableOpacity onPress={onClearAll} style={s.clearAllBtn}>
                <Text style={s.clearAllText}>Clear All</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <Text style={s.closeBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView style={s.modalScroll} contentContainerStyle={s.modalContent}>
          {history.length === 0 ? (
            <View style={s.emptyState}>
              <Text style={s.emptyStateText}>No saved results yet.</Text>
              <Text style={s.emptyStateHint}>Classify a patient and tap "Save Result" to see it here.</Text>
            </View>
          ) : (
            history.map((item, i) => (
              <View key={item.id} style={[s.historyCard, { borderLeftColor: item.result.color }]}>
                <View style={s.historyTop}>
                  <View>
                    <Text style={[s.historyCat, { color: item.result.color }]}>
                      {item.result.category}{item.result.resp === "R+" ? "R" : ""}
                    </Text>
                    <Text style={s.historyBadge}>{item.result.badge}</Text>
                  </View>
                  <TouchableOpacity onPress={() => onDelete(item.id)} style={s.deleteBtn}>
                    <Text style={s.deleteBtnText}>Delete</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.historyLabel}>{item.result.label}</Text>
                {item.note ? <Text style={s.historyNote}>"{item.note}"</Text> : null}
                <Text style={s.historyDate}>{formatDate(item.savedAt)}</Text>
              </View>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// =================== CATEGORY DIAGRAM MODAL ===============================
const DIAGRAM_TOP = [
  { key: "A",  label: "A",  sub: "No symptoms",        color: C.green },
  { key: "B",  label: "B",  sub: "Mild symptoms",      color: "#84cc16" },
  { key: "C",  label: "C",  sub: "Strained heart",     color: C.yellow },
  { key: "D",  label: "D",  sub: "Low blood pressure", color: "#ea580c" },
  { key: "E",  label: "E",  sub: "Cardiac arrest",     color: C.red },
];
const DIAGRAM_C = [
  { key: "C1", label: "C1", sub: "RV normal, biomarkers normal" },
  { key: "C2", label: "C2", sub: "RV strained OR biomarkers high" },
  { key: "C3", label: "C3", sub: "RV strained AND biomarkers high" },
];
const DIAGRAM_D = [
  { key: "D1", label: "D1", sub: "Brief drop, recovers with fluids; no organ damage yet" },
  { key: "D2", label: "D2", sub: "Pressure normal but organs aren't getting enough blood" },
];
const DIAGRAM_E = [
  { key: "E1", label: "E1", sub: "Shock that doesn't respond to standard treatment" },
  { key: "E2", label: "E2", sub: "Heart/lungs failing entirely, or cardiac arrest" },
];

function DiagramBox({ label, sub, color, active, dimmed, wide }) {
  return (
    <View
      style={[
        s.diagBox,
        wide && s.diagBoxWide,
        { borderColor: dimmed ? C.border2 : color },
        active && { backgroundColor: color + "22", borderWidth: 2 },
        dimmed && s.diagBoxDimmed,
      ]}
    >
      <Text style={[s.diagLabel, { color: dimmed ? C.textFaint : color }]}>{label}</Text>
      <Text style={[s.diagSub, dimmed && { color: C.textFaint }]}>{sub}</Text>
      {active && <Text style={s.diagHereTag}>YOU ARE HERE</Text>}
    </View>
  );
}

function CategoryDiagramModal({ visible, category, onClose }) {
  // category may have an "R" suffix (e.g. "C2R") - strip it for matching
  const baseCat = (category || "").replace("R", "");

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.modalSafe}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Category Reference</Text>
          <TouchableOpacity onPress={onClose} style={s.closeBtn}>
            <Text style={s.closeBtnText}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={s.modalScroll} contentContainerStyle={s.modalContent}>
          <Text style={s.diagIntro}>
            Severity increases left to right. Letters track overall severity; numbers after C, D, and E explain why.
          </Text>

          <View style={s.diagRow}>
            {DIAGRAM_TOP.map(item => (
              <DiagramBox
                key={item.key}
                label={item.label}
                sub={item.sub}
                color={item.color}
                active={baseCat === item.key}
                dimmed={baseCat !== item.key}
              />
            ))}
          </View>

          <Text style={s.diagSectionTitle}>CATEGORY C SUB-STAGES</Text>
          <Text style={s.diagSectionHint}>Based on RV imaging and cardiac biomarkers</Text>
          <View style={s.diagColumn}>
            {DIAGRAM_C.map(item => (
              <DiagramBox
                key={item.key}
                label={item.label}
                sub={item.sub}
                color={C.yellow}
                active={baseCat === item.key}
                dimmed={baseCat !== item.key}
                wide
              />
            ))}
          </View>

          <Text style={s.diagSectionTitle}>CATEGORY D SUB-STAGES</Text>
          <Text style={s.diagSectionHint}>Based on how the low blood pressure developed</Text>
          <View style={s.diagColumn}>
            {DIAGRAM_D.map(item => (
              <DiagramBox
                key={item.key}
                label={item.label}
                sub={item.sub}
                color="#ea580c"
                active={baseCat === item.key}
                dimmed={baseCat !== item.key}
                wide
              />
            ))}
          </View>

          <Text style={s.diagSectionTitle}>CATEGORY E SUB-STAGES</Text>
          <Text style={s.diagSectionHint}>Based on response to treatment</Text>
          <View style={s.diagColumn}>
            {DIAGRAM_E.map(item => (
              <DiagramBox
                key={item.key}
                label={item.label}
                sub={item.sub}
                color={C.red}
                active={baseCat === item.key}
                dimmed={baseCat !== item.key}
                wide
              />
            ))}
          </View>

          <View style={s.diagRBox}>
            <Text style={s.diagRTitle}>"R" suffix (e.g. C2R)</Text>
            <Text style={s.diagRSub}>Added when oxygen levels or breathing are also affected.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// =================== MAIN APP =============================================
export default function App() {
  const [patient, setPatient]     = useState(initialPatient);
  const [vars, setVars]           = useState(initialVars);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult]       = useState(null);
  const [history, setHistory]     = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showDiagram, setShowDiagram] = useState(false);
  const [saving, setSaving]       = useState(false);

  const set    = useCallback((k, v) => setPatient(prev => ({ ...prev, [k]: v })), []);
  const setVar = useCallback((k, v) => setVars(prev => ({ ...prev, [k]: v })), []);

  // ---- load history on mount ---------------------------------------------
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (raw) setHistory(JSON.parse(raw));
    }).catch(() => {});
  }, []);

  // ---- persist history whenever it changes --------------------------------
  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(history)).catch(() => {});
  }, [history]);

  // ---- save current result ------------------------------------------------
  const handleSave = () => {
    if (!result) return;
    Alert.prompt(
      "Add a note (optional)",
      "E.g. patient initials, MRN, or clinical context",
      [
        { text: "Skip", onPress: () => saveEntry("") },
        { text: "Save", onPress: (note) => saveEntry(note || "") },
      ],
      "plain-text",
      "",
    );
  };

  const saveEntry = (note) => {
    const entry = {
      id: Date.now().toString(),
      savedAt: new Date().toISOString(),
      note,
      result: {
        category:   result.category,
        label:      result.label,
        badge:      result.badge,
        color:      result.color,
        badgeColor: result.badgeColor,
        resp:       result.resp,
      },
    };
    setHistory(prev => [entry, ...prev]);
    setSaving(true);
    setTimeout(() => setSaving(false), 1800);
  };

  const handleDelete = (id) => {
    Alert.alert("Delete this result?", "", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => setHistory(prev => prev.filter(h => h.id !== id)) },
    ]);
  };

  const handleClearAll = () => {
    Alert.alert("Clear all saved results?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear All", style: "destructive", onPress: () => setHistory([]) },
    ]);
  };

  const handleClassify = () => { setResult(classify(patient)); setSubmitted(true); setSaving(false); };
  const handleReset    = () => { setPatient(initialPatient); setVars(initialVars); setSubmitted(false); setResult(null); setSaving(false); };

  const showHemo         = patient.symptomatic === "yes";
  const showEndOrgan     = showHemo && patient.shockType === "normotensive_shock";
  const normotensivePath = showHemo && (patient.shockType === "none" || patient.shockType === "" || (patient.shockType === "normotensive_shock" && patient.endOrgan === "no"));
  const showScore        = normotensivePath;
  const showRV           = normotensivePath && patient.scoreResult === "elevated";
  const showResp         = showHemo && (patient.shockType === "transient" || patient.shockType === "persistent" || patient.shockType === "arrest" || (patient.shockType === "normotensive_shock" && patient.endOrgan === "yes") || showRV);
  const mgmtActions      = result ? getManagement(result.category) : [];

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <HistoryModal
        visible={showHistory}
        history={history}
        onClose={() => setShowHistory(false)}
        onDelete={handleDelete}
        onClearAll={handleClearAll}
      />

      <CategoryDiagramModal
        visible={showDiagram}
        category={result ? result.category : ""}
        onClose={() => setShowDiagram(false)}
      />

      <ScrollView style={s.scroll} contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={s.header}>
          <Text style={s.eyebrow}>CLINICAL DECISION SUPPORT TOOL</Text>
          <Text style={s.title}>PE <Text style={s.titleItalic}>Severity</Text> Classifier</Text>
          <Text style={s.subtitle}>AHA/ACC Acute Pulmonary Embolism Clinical Categories</Text>
          <View style={s.guidelineTag}>
            <Text style={s.guidelineText}>2026 AHA/ACC/ACCP/ACEP/CHEST Guideline</Text>
          </View>
          {/* History button */}
          <TouchableOpacity style={s.historyBtn} onPress={() => setShowHistory(true)} activeOpacity={0.7}>
            <Text style={s.historyBtnText}>History ({history.length})</Text>
          </TouchableOpacity>
        </View>

        {/* Form card */}
        <View style={s.card}>
          <SectionHeader title="Presentation" />
          <Text style={s.fieldLabel}>Is the PE symptomatic?</Text>
          <RadioGroup
            value={patient.symptomatic}
            onChange={v => set("symptomatic", v)}
            options={[
              { value: "no",  label: "Asymptomatic (incidental)" },
              { value: "yes", label: "Symptomatic" },
            ]}
          />

          {showHemo && (
            <>
              <View style={s.divider} />
              <SectionHeader title="Hemodynamic Status" />
              <Text style={s.fieldLabel}>Blood pressure / shock status <Text style={s.hint}>(SBP &lt;90 = hypotension)</Text></Text>
              <RadioGroup
                value={patient.shockType}
                onChange={v => set("shockType", v)}
                options={[
                  { value: "none",              label: "Normotensive (SBP >=90)" },
                  { value: "transient",          label: "Transient hypotension" },
                  { value: "normotensive_shock", label: "Normotensive shock (suspected)" },
                  { value: "persistent",         label: "Persistent hypotension + cardiogenic shock" },
                  { value: "arrest",             label: "Refractory shock / cardiac arrest" },
                ]}
              />
            </>
          )}

          {showEndOrgan && (
            <>
              <View style={s.divider} />
              <SectionHeader title="End-Organ Perfusion (defines D2)" />
              <Text style={s.fieldLabel}>Marker of hypoperfusion present? <Text style={s.hint}>lactate &gt;2, AKI, UOP &lt;0.5 mL/kg/h, or CI &lt;2.2</Text></Text>
              <RadioGroup
                value={patient.endOrgan}
                onChange={v => set("endOrgan", v)}
                options={[
                  { value: "yes", label: "Yes (meets D2)" },
                  { value: "no",  label: "No (use severity score)" },
                ]}
              />
            </>
          )}

          {showScore && (
            <>
              <View style={s.divider} />
              <SectionHeader title="Clinical Severity Scores" />
              <UnifiedCalculator vars={vars} setVar={setVar} onApply={(lvl) => set("scoreResult", lvl)} />
              {patient.scoreResult !== "" && (
                <Text style={s.appliedTag}>
                  Checkmark Applied: {patient.scoreResult === "elevated" ? "elevated -> Category C path" : "low -> Category B"}
                </Text>
              )}
            </>
          )}

          {showRV && (
            <>
              <View style={s.divider} />
              <SectionHeader title="RV & Biomarker Assessment (sub-classifies C)" />
              <Text style={s.fieldLabel}>Right ventricular function <Text style={s.hint}>by CT or echo</Text></Text>
              <RadioGroup
                value={patient.rvFunction}
                onChange={v => set("rvFunction", v)}
                options={[
                  { value: "normal",   label: "Normal RV" },
                  { value: "abnormal", label: "RV dysfunction / dilation" },
                  { value: "unknown",  label: "Not assessed" },
                ]}
              />
              <Text style={[s.fieldLabel, { marginTop: 12 }]}>Cardiac biomarkers <Text style={s.hint}>troponin I/T and/or BNP / NT-proBNP</Text></Text>
              <RadioGroup
                value={patient.biomarkers}
                onChange={v => set("biomarkers", v)}
                options={[
                  { value: "normal",        label: "Both normal" },
                  { value: "one_elevated",  label: "One elevated" },
                  { value: "both_elevated", label: "Both elevated" },
                  { value: "unknown",       label: "Pending" },
                ]}
              />
            </>
          )}

          {showResp && (
            <>
              <View style={s.divider} />
              <SectionHeader title="Respiratory Status (R modifier)" />
              <Text style={s.fieldLabel}>SpO2 <Text style={s.hint}>R+ if &lt;90%</Text></Text>
              <TextInput
                style={s.numberInput}
                placeholder="e.g. 94"
                placeholderTextColor={C.textFaint}
                keyboardType="number-pad"
                value={patient.spo2}
                onChangeText={v => set("spo2", v)}
              />
              <Text style={[s.fieldLabel, { marginTop: 12 }]}>Respiratory rate <Text style={s.hint}>R+ if >=30/min</Text></Text>
              <TextInput
                style={s.numberInput}
                placeholder="e.g. 22"
                placeholderTextColor={C.textFaint}
                keyboardType="number-pad"
                value={patient.rr}
                onChangeText={v => set("rr", v)}
              />
              <Text style={[s.fieldLabel, { marginTop: 12 }]}>Requires supplemental O2? <Text style={s.hint}>R+ if yes</Text></Text>
              <RadioGroup
                value={patient.supplementalO2}
                onChange={v => set("supplementalO2", v)}
                options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]}
              />
            </>
          )}
        </View>

        <TouchableOpacity style={s.classifyBtn} onPress={handleClassify} activeOpacity={0.85}>
          <Text style={s.classifyBtnText}>CLASSIFY -></Text>
        </TouchableOpacity>

        {/* Result */}
        {submitted && result && (
          <View style={[s.resultCard, { borderColor: result.color }]}>
            <View style={s.resultTop}>
              <TouchableOpacity onPress={() => setShowDiagram(true)} activeOpacity={0.7}>
                <Text style={[s.resultCat, { color: result.color }]}>
                  {result.category}{result.resp === "R+" ? "R" : ""}
                </Text>
                <Text style={s.tapHint}>Tap to see where this fits ›</Text>
              </TouchableOpacity>
              <View style={s.resultBadges}>
                <View style={[s.riskBadge, { backgroundColor: result.badgeColor }]}>
                  <Text style={s.riskBadgeText}>{result.badge}</Text>
                </View>
                {result.resp && (
                  <View style={s.respBadge}>
                    <Text style={s.respBadgeText}>{result.resp}</Text>
                  </View>
                )}
              </View>
            </View>
            <Text style={s.resultLabel}>{result.label}</Text>
            <Text style={s.resultDetails}>{result.details}</Text>

            <View style={s.mgmtBox}>
              <Text style={s.mgmtTitle}>SUGGESTED MANAGEMENT - AHA/ACC 2026</Text>
              {mgmtActions.map((a, i) => (
                <View key={i} style={[s.mgmtItem, i === mgmtActions.length - 1 && { borderBottomWidth: 0 }]}>
                  <View style={[s.mgmtDot, { backgroundColor: REC[a.type].dot }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.mgmtK}>{a.k}</Text>
                    <Text style={s.mgmtV}>{a.v}</Text>
                    <Text style={[s.mgmtTag, { color: REC[a.type].dot }]}>{REC[a.type].word}</Text>
                  </View>
                </View>
              ))}
            </View>

            {/* Save button */}
            <TouchableOpacity
              style={[s.saveBtn, saving && s.saveBtnSaved]}
              onPress={handleSave}
              activeOpacity={0.8}
              disabled={saving}
            >
              <Text style={s.saveBtnText}>{saving ? "Saved!" : "Save Result"}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={s.resetBtn} onPress={handleReset} activeOpacity={0.7}>
              <Text style={s.resetBtnText}>Classify Another Patient</Text>
            </TouchableOpacity>
          </View>
        )}

        {submitted && !result && (
          <View style={[s.resultCard, { borderColor: C.border2 }]}>
            <Text style={[s.resultLabel, { color: C.yellow }]}>Incomplete Data</Text>
            <Text style={s.resultDetails}>
              {patient.symptomatic === ""
                ? "Indicate whether the PE is symptomatic."
                : "Calculate the severity scores and apply the result to separate Category B from C."}
            </Text>
            <TouchableOpacity style={s.resetBtn} onPress={handleReset} activeOpacity={0.7}>
              <Text style={s.resetBtnText}>Reset</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.disclaimer}>
          <Text style={s.disclaimerText}>
            <Text style={{ color: C.textDim, fontWeight: "700" }}>Clinical Decision Support Only{"\n"}</Text>
            Implements the 2026 AHA/ACC/ACCP/ACEP/CHEST PE Clinical Category system. Assists - does not replace - clinical judgment. Always individualize care.
          </Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// =================== STYLES ===============================================
const s = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: C.bg },
  scroll:     { flex: 1 },
  container:  { padding: 16, paddingBottom: 48 },

  header:        { alignItems: "center", marginBottom: 24, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  eyebrow:       { fontSize: 10, letterSpacing: 2, color: C.textDim, marginBottom: 8, fontWeight: "600" },
  title:         { fontSize: 32, fontWeight: "700", color: "#f1f5f9", marginBottom: 4, textAlign: "center" },
  titleItalic:   { fontStyle: "italic", color: C.accent },
  subtitle:      { fontSize: 13, color: C.textDim, textAlign: "center" },
  guidelineTag:  { marginTop: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border2, borderRadius: 4, paddingHorizontal: 10, paddingVertical: 4 },
  guidelineText: { fontSize: 10, color: C.accent, letterSpacing: 1 },
  historyBtn:    { marginTop: 12, borderWidth: 1, borderColor: C.border2, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 7 },
  historyBtnText:{ fontSize: 12, color: C.textMid, fontWeight: "600" },

  card:          { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 16, marginBottom: 16 },
  sectionHeader: { marginBottom: 10 },
  sectionTitle:  { fontSize: 10, letterSpacing: 2, color: C.textFaint, fontWeight: "600" },
  divider:       { height: 1, backgroundColor: C.border, marginVertical: 16 },
  fieldLabel:    { fontSize: 13, fontWeight: "700", color: C.textMid, marginBottom: 8, marginTop: 4 },
  hint:          { fontWeight: "400", color: C.textFaint, fontSize: 11 },

  radioGroup:          { gap: 6 },
  radioOption:         { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderWidth: 1, borderColor: C.border2, borderRadius: 8, padding: 10, gap: 10 },
  radioSelected:       { backgroundColor: C.blueDeep, borderColor: C.blue },
  radioCircle:         { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: C.textFaint, alignItems: "center", justifyContent: "center" },
  radioCircleSelected: { borderColor: C.blue },
  radioDot:            { width: 8, height: 8, borderRadius: 4, backgroundColor: C.blue },
  radioLabel:          { fontSize: 13, color: C.textMid, flex: 1 },
  radioLabelSelected:  { color: "#93c5fd" },

  checkGrid:    { gap: 6 },
  checkRow:     { flexDirection: "row", alignItems: "center", backgroundColor: C.surface, borderWidth: 1, borderColor: C.border2, borderRadius: 6, padding: 10, gap: 10 },
  checkRowOn:   { backgroundColor: C.blueDeep, borderColor: C.blue },
  checkBox:     { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: C.textFaint, alignItems: "center", justifyContent: "center" },
  checkBoxOn:   { backgroundColor: "#2563eb", borderColor: "#2563eb" },
  checkMark:    { color: "#fff", fontSize: 12, fontWeight: "700" },
  checkLabel:   { fontSize: 13, color: "#cbd5e1", flex: 1 },
  checkLabelOn: { color: "#dbeafe" },

  calcCard:           { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12, marginTop: 8 },
  calcSub:            { fontSize: 10, letterSpacing: 1.5, color: C.textFaint, marginBottom: 10, fontWeight: "600" },
  numberInput:        { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border2, borderRadius: 6, color: C.text, padding: 10, fontSize: 14, width: 140, marginBottom: 12 },
  scoreRow:           { flexDirection: "row", gap: 6, marginTop: 12, flexWrap: "wrap" },
  scoreChip:          { flex: 1, minWidth: 70, backgroundColor: "#111c28", borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 8, alignItems: "center" },
  scoreChipLabel:     { fontSize: 9, letterSpacing: 1, color: C.textDim, textTransform: "uppercase", fontWeight: "600" },
  scoreChipValue:     { fontSize: 15, fontWeight: "700", color: "#f1f5f9", marginVertical: 2 },
  scoreChipLevel:     { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontWeight: "600" },
  levelElevated:      { color: C.yellow },
  levelLow:           { color: C.greenDim },
  calcResult:         { marginTop: 12, padding: 12, borderRadius: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
  calcResultLow:      { backgroundColor: "#14241a", borderWidth: 1, borderColor: "#1f5135" },
  calcResultElevated: { backgroundColor: "#2a1d12", borderWidth: 1, borderColor: "#7c4a17" },
  calcResultText:     { fontSize: 12, fontWeight: "500", flex: 1 },
  applyBtn:           { backgroundColor: C.blueDark, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8 },
  applyBtnText:       { color: "#fff", fontSize: 12, fontWeight: "700" },
  appliedTag:         { marginTop: 8, fontSize: 12, color: C.greenDim, fontWeight: "600" },

  classifyBtn:     { backgroundColor: C.blueDark, borderRadius: 8, padding: 16, alignItems: "center", marginBottom: 16 },
  classifyBtnText: { color: "#fff", fontSize: 15, fontWeight: "700", letterSpacing: 1 },

  resultCard:    { borderWidth: 2, borderRadius: 12, padding: 20, marginBottom: 16 },
  resultTop:     { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  resultCat:     { fontSize: 52, fontWeight: "700", lineHeight: 56 },
  resultBadges:  { alignItems: "flex-end", gap: 6 },
  riskBadge:     { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 4 },
  riskBadgeText: { color: "#fff", fontSize: 10, letterSpacing: 1.5, fontWeight: "700" },
  respBadge:     { backgroundColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: "#334155" },
  respBadgeText: { color: C.textMid, fontSize: 11, fontWeight: "600" },
  resultLabel:   { fontSize: 18, fontWeight: "700", color: "#f1f5f9", marginBottom: 6 },
  resultDetails: { fontSize: 13, color: C.textMid, lineHeight: 20, marginBottom: 14 },

  mgmtBox:   { backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12 },
  mgmtTitle: { fontSize: 9, letterSpacing: 2, color: C.textFaint, marginBottom: 10, fontWeight: "600" },
  mgmtItem:  { flexDirection: "row", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#161f2b" },
  mgmtDot:   { width: 9, height: 9, borderRadius: 5, marginTop: 4, flexShrink: 0 },
  mgmtK:     { fontSize: 13, fontWeight: "700", color: C.text, marginBottom: 2 },
  mgmtV:     { fontSize: 12, color: C.textMid, lineHeight: 18 },
  mgmtTag:   { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", fontWeight: "600", marginTop: 3 },

  saveBtn:      { marginTop: 14, backgroundColor: C.blueDark, borderRadius: 8, padding: 13, alignItems: "center" },
  saveBtnSaved: { backgroundColor: "#16a34a" },
  saveBtnText:  { color: "#fff", fontSize: 14, fontWeight: "700" },
  resetBtn:     { marginTop: 10, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12, alignItems: "center" },
  resetBtnText: { color: C.textDim, fontSize: 13 },

  disclaimer:     { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 14, marginTop: 8 },
  disclaimerText: { fontSize: 11, color: C.textFaint, lineHeight: 17, textAlign: "center" },

  // Modal
  modalSafe:       { flex: 1, backgroundColor: C.bg },
  modalHeader:     { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, borderBottomWidth: 1, borderBottomColor: C.border },
  modalTitle:      { fontSize: 18, fontWeight: "700", color: C.text },
  modalHeaderRight:{ flexDirection: "row", alignItems: "center", gap: 12 },
  closeBtn:        { backgroundColor: C.blueDark, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 7 },
  closeBtnText:    { color: "#fff", fontSize: 13, fontWeight: "700" },
  clearAllBtn:     { paddingHorizontal: 4 },
  clearAllText:    { color: C.red, fontSize: 13, fontWeight: "600" },
  modalScroll:     { flex: 1 },
  modalContent:    { padding: 16, paddingBottom: 40 },

  emptyState:     { alignItems: "center", paddingTop: 60 },
  emptyStateText: { fontSize: 16, color: C.textMid, fontWeight: "600", marginBottom: 8 },
  emptyStateHint: { fontSize: 13, color: C.textFaint, textAlign: "center", lineHeight: 20 },

  historyCard:    { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderLeftWidth: 4, borderRadius: 10, padding: 14, marginBottom: 12 },
  historyTop:     { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 },
  historyCat:     { fontSize: 28, fontWeight: "700", lineHeight: 32 },
  historyBadge:   { fontSize: 10, color: C.textDim, fontWeight: "600", letterSpacing: 1, marginTop: 2 },
  historyLabel:   { fontSize: 13, color: C.textMid, marginBottom: 4 },
  historyNote:    { fontSize: 12, color: C.accent, fontStyle: "italic", marginBottom: 4 },
  historyDate:    { fontSize: 11, color: C.textFaint },
  deleteBtn:      { borderWidth: 1, borderColor: "#3f1f1f", borderRadius: 5, paddingHorizontal: 10, paddingVertical: 5 },
  deleteBtnText:  { color: C.red, fontSize: 11, fontWeight: "600" },

  tapHint:        { fontSize: 11, color: C.textFaint, marginTop: 2 },

  diagIntro:        { fontSize: 13, color: C.textMid, lineHeight: 19, marginBottom: 18 },
  diagRow:          { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 8 },
  diagColumn:       { gap: 10, marginBottom: 8 },
  diagSectionTitle: { fontSize: 10, letterSpacing: 1.5, color: C.textFaint, fontWeight: "600", marginTop: 22, marginBottom: 2 },
  diagSectionHint:  { fontSize: 12, color: C.textDim, marginBottom: 10 },

  diagBox:        { flexBasis: "30%", flexGrow: 1, backgroundColor: C.card, borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 84 },
  diagBoxWide:    { flexBasis: "100%" },
  diagBoxDimmed:  { opacity: 0.45 },
  diagLabel:      { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  diagSub:        { fontSize: 12, color: C.textMid, lineHeight: 16 },
  diagHereTag:    { fontSize: 9, letterSpacing: 1, color: C.accent, fontWeight: "700", marginTop: 8 },

  diagRBox:   { backgroundColor: C.card, borderWidth: 1, borderColor: C.border2, borderRadius: 10, padding: 14, marginTop: 22 },
  diagRTitle: { fontSize: 13, fontWeight: "700", color: C.text, marginBottom: 4 },
  diagRSub:   { fontSize: 12, color: C.textMid, lineHeight: 17 },
});
