
'use strict';
// ═══════ Port JS du moteur v0.2 (engine.ts + engine-v02.ts) — même logique ═══════
const FEE_GAP_MAX = 800, DED_HINT_MAX = 0.15, DATE_WINDOW = 45;

const deburr = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s) => deburr(s).toUpperCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refRe = (p) => new RegExp(`(?<![A-Z0-9])${p}(?![A-Z0-9])`);
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const fmtEur = (c) => { const s = c < 0 ? '-' : ''; const v = Math.abs(c); return `${s}${Math.floor(v / 100).toLocaleString('fr-FR')},${String(v % 100).padStart(2, '0')} €`; };

function refPatterns(inv) {
  const up = norm(inv.number);
  const m = up.match(/^([A-Z]*)(\d[\d .\-/]*\d|\d)(.*)$/);
  const patterns = [];
  if (m) {
    const [, alpha, digits, tail] = m;
    const groups = digits.split(/[ .\-/]+/).filter(Boolean);
    const sep = '[ .\\-/]?';
    if (groups.length > 1) {
      const lax = groups.map((g, i) => (i > 0 ? g.replace(/^0+/, '') : g));
      patterns.push(`${alpha}${sep}${groups.join(sep)}${tail}`);
      patterns.push(`${alpha}${sep}${lax.join(sep)}${tail}`);
      if (alpha) { patterns.push(`${sep}${groups.join(sep)}${tail}`); patterns.push(`${sep}${lax.join(sep)}${tail}`); }
    } else {
      patterns.push(`${alpha}${sep}${digits}${tail}`);
      if (alpha) patterns.push(`${sep}${digits}${tail}`);
    }
  } else patterns.push(escapeRe(up));
  if (inv.customerReference) patterns.push(escapeRe(norm(inv.customerReference)));
  return patterns;
}
function findRefHits(labelNorm, invs) { return invs.filter((inv) => refPatterns(inv).some((p) => refRe(p).test(labelNorm))); }
function detectCustomer(labelNorm, customers) {
  let best = null;
  for (const c of customers) {
    const cn = norm(c);
    if (cn.length < 3) continue;
    if (refRe(escapeRe(cn)).test(labelNorm) && (!best || cn.length > norm(best).length)) best = c;
  }
  return best;
}

// ── v0.1 : moteur de référence ──
function v01(payment, openInvoices, context) {
  const label = norm(payment.label);
  const base = (decision, classification) => ({ paymentId: payment.id, requiresHuman: true, decision, classification, proposal: null, candidates: [], notes: [], llmCalls: 0 });
  if (payment.amountCents < 0) {
    const r = base('flag', 'rejected_or_reversal');
    r.notes.push('transaction négative : rejet ou annulation probable — à vérifier, jamais proposée en rapprochement');
    return r;
  }
  const refHits = findRefHits(label, openInvoices);
  const customer = detectCustomer(label, context.customers);
  if (refHits.length >= 2) {
    const sameNumber = new Set(refHits.map((i) => norm(i.number).replace(/[ \-/]/g, ''))).size === 1;
    if (sameNumber) {
      const r = base('flag', 'ambiguous');
      r.candidates = refHits.map((i) => ({ invoiceId: i.id, score: 0.5, reason: 'référence identique sur plusieurs factures' }));
      r.notes.push('doublon de facture possible (référence identique sur plusieurs factures ouvertes)');
      return r;
    }
    const r = base('flag', 'multi_reference_grouped');
    r.candidates = refHits.map((i) => ({ invoiceId: i.id, score: 0.7, reason: 'référence lue dans le libellé' }));
    r.notes.push(`virement groupé suspecté (${refHits.length} références distinctes) — ventilation en phase 2, aucun montant affecté`);
    return r;
  }
  if (refHits.length === 1) {
    const inv = refHits[0];
    if (payment.currency !== inv.currency) {
      const r = base('flag', 'currency_mismatch');
      r.notes.push(`rapprochement bloqué : devise du paiement (${payment.currency}) ≠ devise de la facture (${inv.currency})`);
      return r;
    }
    if (customer && norm(customer) !== norm(inv.customer)) {
      const r = base('flag', 'ambiguous');
      r.candidates = [{ invoiceId: inv.id, score: 0.4, reason: 'référence lue mais client du libellé différent' }];
      r.notes.push(`référence trouvée chez « ${inv.customer} » alors que le libellé désigne « ${customer} » — erreur de saisie probable`);
      return r;
    }
    const gap = inv.amountCents - payment.amountCents;
    const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
    const dateEvidence = { kind: 'date_window', detail: dateGapDays <= DATE_WINDOW ? `écart de ${dateGapDays} j avec l'échéance (dans la fenêtre)` : `écart de ${dateGapDays} j avec l'échéance (hors fenêtre de ${DATE_WINDOW} j)` };
    if (gap === 0) {
      const confidence = customer ? 0.99 : 0.9;
      const evidence = [
        { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
        { kind: 'amount_exact', detail: `montant reçu = montant de la facture (${fmtEur(payment.amountCents)})` },
        dateEvidence,
      ];
      if (customer) evidence.push({ kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer})` });
      const r = base('proposal', 'matched_exact');
      r.proposal = {
        invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0, confidence, evidence,
        explanation: customer
          ? `Référence ${inv.number} lue dans le libellé, montant exact et client cohérent — affectation proposée, validation humaine requise.`
          : `Référence ${inv.number} lue dans le libellé et montant exact, sans client identifiable — affectation proposée, validation humaine requise.`,
      };
      if (dateGapDays > DATE_WINDOW) r.notes.push(`date hors fenêtre : ${dateGapDays} j de l'échéance — vérifier avec le client`);
      return r;
    }
    if (gap > 0) {
      const hintDeduction = /ESCOMPTE|REMISE/.test(label);
      if (hintDeduction && gap <= Math.round(inv.amountCents * DED_HINT_MAX)) {
        const r = base('flag', 'amount_mismatch');
        r.notes.push(`écart de ${fmtEur(gap)} avec la facture — déduction/escompte signalé dans le libellé, justificatif requis (résolution en phase 2)`);
        return r;
      }
      if (gap <= FEE_GAP_MAX) {
        const r = base('flag', 'amount_mismatch');
        r.notes.push(`écart de ${fmtEur(gap)} avec la facture — type frais bancaires ou déduction (résolution en phase 2)`);
        return r;
      }
      const evidence = [
        { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
        { kind: 'partial_amount', detail: `reçu ${fmtEur(payment.amountCents)} sur une facture de ${fmtEur(inv.amountCents)}` },
        dateEvidence,
      ];
      const r = base('proposal', 'matched_partial');
      r.proposal = { invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: gap, confidence: 0.9, evidence, explanation: `Paiement partiel sur la facture ${inv.number} (référence explicite) — reste à recevoir : ${fmtEur(gap)}.` };
      if (payment.amountCents / inv.amountCents < 0.1) r.notes.push('acompte très partiel — vérifier auprès du client');
      return r;
    }
    const r = base('flag', 'amount_mismatch');
    r.notes.push(`montant reçu supérieur à la facture de ${fmtEur(-gap)} — couverture d'autres éléments possible (résolution en phase 2)`);
    return r;
  }
  if (!customer) {
    const r = base('abstain', 'unmatched_no_candidate');
    r.notes.push('aucune référence ni client identifiable dans le libellé — pas de rapprochement approximatif sur les numéros');
    return r;
  }
  const own = openInvoices.filter((i) => norm(i.customer) === norm(customer));
  const exact = own.filter((i) => i.amountCents === payment.amountCents && i.currency === payment.currency);
  if (exact.length === 1) {
    const inv = exact[0];
    const r = base('proposal', 'matched_exact');
    r.proposal = {
      invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0, confidence: 0.8,
      evidence: [
        { kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer})` },
        { kind: 'amount_exact', detail: `montant reçu = montant de la facture (${fmtEur(payment.amountCents)})` },
        { kind: 'date_window', detail: `écart de ${Math.round(dayDiff(payment.date, inv.dueDate))} j avec l'échéance` },
      ],
      explanation: `Affectation sans référence (client ${customer} + montant exact) — confiance limitée, validation humaine obligatoire.`,
    };
    r.notes.push("affectation sans référence — vérifier l'intitulé avec le client avant validation");
    return r;
  }
  if (exact.length >= 2) {
    const r = base('flag', 'ambiguous');
    r.candidates = exact.map((i) => ({ invoiceId: i.id, score: 1 / (1 + dayDiff(payment.date, i.dueDate)), reason: 'même client, même montant' })).sort((a, b) => b.score - a.score);
    r.notes.push('plusieurs factures ouvertes de même montant pour ce client — le libellé ne permet pas de trancher');
    return r;
  }
  const r = base('abstain', 'unmatched_no_candidate');
  r.notes.push('client identifié mais aucun montant ne correspond — ventilation ou paiement partiel possible (résolution en phase 2)');
  return r;
}

// ── v0.2 : couche phase 2 ──
function groupedBreakdown(hits, mode, k) {
  return hits.map((inv) => {
    const assigned = mode === 'sum' ? inv.amountCents : mode === 'ded' ? inv.amountCents - Math.round(inv.amountCents * 0.02) : Math.round(inv.amountCents * k / 20);
    return { invoiceId: inv.id, invoiceNumber: inv.number, assignedCents: assigned, residualCents: inv.amountCents - assigned };
  });
}
function subsetSums(invs, target) {
  const found = [];
  for (let mask = 0; mask < (1 << invs.length); mask++) {
    let bits = 0, x = mask;
    while (x) { bits += x & 1; x >>= 1; }
    if (bits < 2) continue;
    let s = 0; const picked = [];
    for (let i = 0; i < invs.length; i++) if (mask & (1 << i)) { s += invs[i].amountCents; picked.push(invs[i]); }
    if (s === target) found.push(picked);
  }
  return found;
}
function v02(payment, openInvoices, context) {
  const r1 = v01(payment, openInvoices, context);
  const label = norm(payment.label);
  const refHits = findRefHits(label, openInvoices);
  const customer = detectCustomer(label, context.customers);
  const hasNote = (frag) => r1.notes.some((n) => n.includes(frag));

  // P1 — ventilation des virements groupés
  if (r1.decision === 'flag' && r1.classification === 'multi_reference_grouped' && refHits.length >= 2) {
    const hits = refHits;
    const pay = payment.amountCents;
    const sum = hits.reduce((a, i) => a + i.amountCents, 0);
    if (!hits.every((i) => i.currency === payment.currency)) {
      r1.notes.push('phase 2 : devises hétérogènes dans le groupe — rapprochement impossible sans vérification humaine');
    } else {
      let mode = null, prorataK = 0;
      if (pay === sum) mode = 'sum';
      else if (groupedBreakdown(hits, 'ded', 0).reduce((a, b) => a + b.assignedCents, 0) === pay) mode = 'ded';
      else { for (let k = 1; k <= 19; k++) { if (groupedBreakdown(hits, 'prorata', k).reduce((a, b) => a + b.assignedCents, 0) === pay) { mode = 'prorata'; prorataK = k; break; } } }
      if (mode) {
        const breakdown = groupedBreakdown(hits, mode, prorataK);
        const residualTotal = breakdown.reduce((a, b) => a + b.residualCents, 0);
        const nums = hits.map((i) => i.number).join(' + ');
        const dateGapDays = Math.round(dayDiff(payment.date, hits.map((i) => i.dueDate).sort()[0]));
        const confidence = mode === 'sum' ? 0.9 : mode === 'ded' ? 0.85 : 0.8;
        const evidence = [
          { kind: 'references_in_label', detail: `${hits.length} références lues dans le libellé : ${nums}` },
          mode === 'sum'
            ? { kind: 'exact_group_sum', detail: `somme des ${hits.length} factures = montant du virement (${fmtEur(pay)})` }
            : mode === 'ded'
              ? { kind: 'deduction_justified', detail: `déduction de 2 % reconnue sur le groupe : chaque facture est réglée à 98 % (écart total ${fmtEur(sum - pay)})` }
              : { kind: 'proportional_split', detail: `ventilation au prorata : taux uniforme de ${prorataK * 5} % (k = ${prorataK}/20) appliqué à chaque facture` },
          { kind: 'date_window', detail: `écart de ${dateGapDays} j avec la première échéance du groupe (fenêtre ${DATE_WINDOW} j)` },
        ];
        const r2 = { paymentId: payment.id, requiresHuman: true, decision: 'proposal', classification: 'multi_reference_grouped', candidates: hits.map((i) => ({ invoiceId: i.id, score: 0.7, reason: 'référence lue dans le libellé' })), notes: [...r1.notes, 'virement groupé ventilé en phase 2 — vérifier chaque ligne avant validation'], llmCalls: 0, proposal: {
          invoiceId: breakdown[0].invoiceId, assignedAmountCents: pay, residualCents: residualTotal, confidence, evidence, breakdown,
          explanation: mode === 'sum'
            ? `Virement groupé : la somme des ${hits.length} factures (${nums}) égale exactement le montant reçu — ventilation proposée, validation humaine requise.`
            : mode === 'ded'
              ? `Virement groupé avec déduction de 2 % : chaque facture est réglée à 98 % de son montant (écart total ${fmtEur(sum - pay)}) — ventilation proposée, validation humaine requise.`
              : `Virement groupé au prorata : taux uniforme de ${prorataK * 5} % appliqué aux ${hits.length} factures — ventilation proposée, validation humaine requise.`,
        } };
        return r2;
      }
      r1.notes.push('phase 2 : aucune ventilation exacte trouvée (somme, escompte 2 %, prorata 5–95 %) — vérification humaine requise, aucun montant affecté');
    }
  }

  // P2 — déduction de 2 % reconnue
  if (refHits.length === 1 && (r1.classification === 'amount_mismatch' || (r1.decision === 'proposal' && r1.classification === 'matched_partial'))) {
    const inv = refHits[0];
    const gap = inv.amountCents - payment.amountCents;
    const currencyOk = inv.currency === payment.currency;
    const customerOk = !customer || norm(customer) === norm(inv.customer);
    if (currencyOk && customerOk && gap === Math.round(inv.amountCents * 0.02)) {
      const hint = /ESCOMPTE/.test(label) ? 'escompte' : /REMISE/.test(label) ? 'remise' : null;
      const confidence = hint ? 0.9 : 0.85;
      const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
      const r2 = { paymentId: payment.id, requiresHuman: true, decision: 'proposal', classification: 'matched_exact', candidates: [], notes: [...r1.notes, 'déduction de 2 % reconnue en phase 2 — conserver le justificatif (escompte/remise) attaché au lettrage'], llmCalls: 0, proposal: {
        invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0, confidence,
        evidence: [
          { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
          { kind: 'deduction_justified', detail: hint ? `« ${hint.toUpperCase()} » lu dans le libellé et écart = 2 % exactement de la facture (${fmtEur(gap)})` : `écart de ${fmtEur(gap)} = 2 % exactement de la facture, sans indice textuel — déduction reconnue par le ratio` },
          { kind: 'amount_after_deduction', detail: `reçu ${fmtEur(payment.amountCents)} = facture ${fmtEur(inv.amountCents)} − 2 %` },
          { kind: 'date_window', detail: `écart de ${dateGapDays} j avec l'échéance (fenêtre ${DATE_WINDOW} j)` },
        ],
        explanation: hint
          ? `Déduction de 2 % reconnue sur la facture ${inv.number} (${hint} signalé dans le libellé) — affectation proposée au montant reçu, validation humaine requise.`
          : `Écart de ${fmtEur(gap)} = exactement 2 % de la facture ${inv.number}, sans indice textuel — déduction reconnue par le ratio, validation humaine requise.`,
      } };
      return r2;
    }
  }

  // P3/P4 — abstention « ventilation ou paiement partiel »
  if (r1.decision === 'abstain' && r1.classification === 'unmatched_no_candidate' && customer && hasNote('ventilation ou paiement partiel')) {
    const own = openInvoices.filter((i) => norm(i.customer) === norm(customer) && i.currency === payment.currency);
    const pay = payment.amountCents;
    if (own.length === 1 && pay < own[0].amountCents && /ACOMPTE/.test(label)) {
      const inv = own[0];
      const gap = inv.amountCents - pay;
      if (gap > FEE_GAP_MAX && pay / inv.amountCents >= 0.1) {
        const r2 = { paymentId: payment.id, requiresHuman: true, decision: 'proposal', classification: 'matched_partial', candidates: [], notes: [...r1.notes, "paiement partiel sans référence — proposé uniquement parce que le client n'a qu'une seule facture ouverte et que le libellé mentionne un acompte ; vérifier avec le client"], llmCalls: 0, proposal: {
          invoiceId: inv.id, assignedAmountCents: pay, residualCents: gap, confidence: 0.7,
          evidence: [
            { kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer}), facture ouverte unique` },
            { kind: 'partial_hint', detail: `« ACOMPTE » lu dans le libellé` },
            { kind: 'partial_amount', detail: `reçu ${fmtEur(pay)} sur une facture de ${fmtEur(inv.amountCents)}` },
            { kind: 'date_window', detail: `écart de ${Math.round(dayDiff(payment.date, inv.dueDate))} j avec l'échéance (fenêtre ${DATE_WINDOW} j)` },
          ],
          explanation: `Paiement partiel sans référence (acompte) sur la facture ${inv.number} — reste à recevoir : ${fmtEur(gap)}. Validation humaine requise.`,
        } };
        return r2;
      }
    }
    if (own.length >= 2 && own.length <= 12) {
      const combos = subsetSums(own, pay);
      if (combos.length === 1) {
        const picked = combos[0];
        const breakdown = picked.map((inv) => ({ invoiceId: inv.id, invoiceNumber: inv.number, assignedCents: inv.amountCents, residualCents: 0 }));
        const nums = picked.map((i) => i.number).join(' + ');
        const r2 = { paymentId: payment.id, requiresHuman: true, decision: 'proposal', classification: 'multi_reference_grouped', candidates: picked.map((i) => ({ invoiceId: i.id, score: 0.6, reason: 'membre de la combinaison unique' })), notes: [...r1.notes, 'ventilation libre sans référence — combinaison unique, aucune affectation approximative'], llmCalls: 0, proposal: {
          invoiceId: picked[0].id, assignedAmountCents: pay, residualCents: 0, confidence: 0.8, breakdown,
          evidence: [
            { kind: 'customer_consistency', detail: `client du libellé = ${customer}` },
            { kind: 'unique_subset_sum', detail: `seule combinaison des factures ouvertes sommant à ${fmtEur(pay)} : ${nums} (testées ${2 ** own.length - own.length - 1} combinaisons)` },
            { kind: 'date_window', detail: `écart de ${Math.round(dayDiff(payment.date, picked.map((i) => i.dueDate).sort()[0]))} j avec la première échéance (fenêtre ${DATE_WINDOW} j)` },
          ],
          explanation: `Ventilation sans référence : seule combinaison des factures ouvertes de ${customer} sommant au montant reçu (${nums}) — validation humaine requise.`,
        } };
        return r2;
      }
      if (combos.length >= 2) {
        const union = [...new Map(combos.flat().map((i) => [i.id, i])).values()];
        return { paymentId: payment.id, requiresHuman: true, decision: 'flag', classification: 'ambiguous', proposal: null, candidates: union.map((i) => ({ invoiceId: i.id, score: 0.5, reason: 'combinaison possible de factures sommant au montant' })), notes: [...r1.notes, `phase 2 : ${combos.length} combinaisons de factures ouvertes somment au montant — demander la ventilation au client, aucune affectation`], llmCalls: 0 };
      }
    }
  }

  // P5 — doublon de facture confirmé
  if (r1.decision === 'flag' && r1.classification === 'ambiguous' && hasNote('doublon de facture possible') && refHits.length >= 2) {
    const sameAmount = refHits.every((i) => i.amountCents === refHits[0].amountCents);
    const sameCustomer = refHits.every((i) => norm(i.customer) === norm(refHits[0].customer));
    if (sameAmount && sameCustomer && refHits.every((i) => i.currency === refHits[0].currency)) {
      r1.notes.push("phase 2 : doublon de facture confirmé (même numéro, même montant, même client) — double saisie probable : lettrer une seule facture et faire corriger l'autre ; aucune affectation automatique");
    } else {
      r1.notes.push('phase 2 : même numéro mais données divergentes (montant ou client) — incohérence de saisie à corriger avant lettrage');
    }
  }

  // P6 — doublon de paiement probable
  if (r1.decision === 'flag' && r1.classification === 'ambiguous' && customer && hasNote('plusieurs factures ouvertes de même montant') && context.batchPayments) {
    const twins = context.batchPayments.filter((p) => p.id !== payment.id && p.amountCents === payment.amountCents && p.currency === payment.currency && dayDiff(p.date, payment.date) <= 3 && detectCustomer(norm(p.label), context.customers) === customer);
    if (twins.length >= 1) {
      r1.notes.push(`phase 2 : doublon de paiement probable — ${1 + twins.length} virements identiques du même client (même montant, même jour ± 3 j : ${twins.map((t) => t.id).join(', ')}) : vérifier avec le client (double virement ou règlement de deux factures distinctes) ; aucune affectation automatique`);
    }
  }

  return r1;
}


export {
  FEE_GAP_MAX, DED_HINT_MAX, DATE_WINDOW,
  deburr, norm, escapeRe, refRe, dayDiff, fmtEur,
  refPatterns, findRefHits, detectCustomer, subsetSums, groupedBreakdown,
  v01, v02,
};
