// ─────────────────────────────────────────────────────────────────────────────
// Jeu de données ClearMatch v0.1 — 114 paiements, vérité terrain complète.
// Période : 15/09/2026 → 28/11/2026 (T+2 mois après l'entrée en vigueur de la
// réforme ; première clôture mixte en approche).
//
//   C1 (40) — terrain natif Pennylane : rapprochements simples (référence lue
//             dans le libellé + montant exact). Le moteur ne doit en rater AUCUN.
//   C2 (56) — terrain v0.1 spécifié : partiels, écarts, devises, rejets,
//             ambiguïtés, abstinence — et une affectation client+montant sans
//             référence. Un faux appariement = échec audit.
//   C3 (18) — terrain phase 2 : 17 cas VERROUILLÉS (virements groupés,
//             ventilation libre, déductions justifiées, doublons) + 1 témoin
//             déverrouillé (déduction sans indice lisible : v0.1 doit proposer
//             un paiement partiel, pas deviner la déduction). Sur un cas
//             verrouillé, v0.1 doit s'abstenir ou flagger — JAMAIS forcer.
// ─────────────────────────────────────────────────────────────────────────────
import type { Case, Cohort, Expected, Invoice, Payment } from './types.ts';

// ── Noms clients (uniques par cas ; le couple « doublon paiement » partage le sien) ──
const NAMES: string[] = [
  'SARL BATIPLUS', 'Meubles Delmas', 'Atelier Novatek', 'Distribution Sud', 'Étoile Impression',
  'Gauthier et Fils', 'Profil Alu Sud', 'Cabinet Vermeulen', 'Transports Balland', 'Omeda France',
  'Laiterie du Val', 'Comptoir du Pont', 'Sélection Habitat', 'Fermetures Morel', 'Piscines Lagon',
  'Bio Marais', 'Toutenbois', 'Marchand d\'Art', 'Clef du Bastion', 'Groupe Rouvière',
  'Panorama Vélo', 'Solution Bureau', 'Forge du Moulin', 'Imprimerie Salomon', 'Aquatech',
  'Menuiserie Lebreton', 'Distribution Phare', 'Cavalier Outils', 'Atlas Couture', 'Ferme des Trois Rivières',
  'Électro Dépôt Sud', 'Verger d\'Or', 'Travaux et Paysages', 'Compagnie du Lait', 'Nord Accastillage',
  'Papeterie Lemoine', 'Hôtellerie Belle Rive', 'Garage Mirabeau', 'Plaquier Lorrain', 'Cosmétiq',
  'Le Bocage Alimentaire', 'Teintures du Quai', 'Fonderie Aubert', 'Delta Nettoyage', 'Optique Verlaine',
  'Jardins d\'Argent', 'Transit Maloine', 'Boucherie du Stade', 'Fils et Tissus', 'Atelier Céramique Nord',
  'Promotion des Vallées', 'Hydro Confort', 'Comptoir Nautique', 'Immobilier de la Cour', 'Brasserie du Canal',
  'Top Élevage', 'Peintures Garnier', 'Data Moisson', 'Cordonnerie Plaza', 'Aube Électricité',
  'Mega Distribution Est', 'Le Petit Pressoir', 'Chaudronnerie Vasseur', 'Odyssée Marine', 'Microcrèche Trèfle',
  'Charpente Vallée', 'Quincaillerie Duc', 'La Boîte à Outils', 'Restaurant Le Cèdre', 'Agri Sud Ouest',
  'Verre et Table', 'Atelier Broderie Fine', 'Transports Vignon', 'Les Coussins de Louise', 'Fournil des Remparts',
  'Plomberie Roche', 'Cycle Aube', 'Emballages Dupré', 'Studio Photo Sud', 'Fromagerie Lavaux',
  'Net et Propre', 'Carrosserie Gaël', 'Paysages d\'Anjou', 'Ménagerie des Trois Sœurs', 'Disques et Vinyle',
  'Beauté Nature', 'Wellness Ouest', 'Maçonnerie Grand Sud', 'Textile du Nord', 'Arrosage Sud',
  'Crêperie du Port', 'Menuiserie Océane', 'Entreprise Générale BTP Sud', 'Le Chai des Grenadiers', 'Optique des Lacs',
  'Coiffure Élysée', 'Batteries et Cycles', 'Le Palais du Thé', 'Atelier du Vieux Port', 'Sérigraphie Millet',
  'Ambiance Jardin', 'Constructions Meunier', 'Fer de Cheval Distribution', 'Sylviculture Hêtre', 'Comptoir des Tanneurs',
];

// ── Dates ─────────────────────────────────────────────────────────────────────
const BASE = Date.parse('2026-09-15');
const d = (offset: number): string => new Date(BASE + offset * 86_400_000).toISOString().slice(0, 10);

// ── Registres ─────────────────────────────────────────────────────────────────
let invSeq = 0, paySeq = 0, caseSeq = 0, invNo = 100;
const customers: string[] = [];
const invoices: Invoice[] = [];
const cases: Case[] = [];

function nom(): string {
  const n = NAMES.shift();
  if (!n) throw new Error('stock de noms épuisé — allonger NAMES');
  if (!customers.includes(n)) customers.push(n);
  return n;
}

interface InvOpt {
  number?: string; day?: number; dueOffset?: number; open?: boolean;
  customerReference?: string | null; currency?: 'EUR' | 'USD';
}
function I(customer: string, amountCents: number, o: InvOpt = {}): Invoice {
  const day = o.day ?? 20;
  invNo += 1;
  const inv: Invoice = {
    id: `inv-${String(++invSeq).padStart(3, '0')}`,
    number: o.number ?? `FA2026-0${invNo}`,
    customer, customerReference: o.customerReference ?? null,
    amountCents, currency: o.currency ?? 'EUR',
    issueDate: d(day - 20), dueDate: d(day + (o.dueOffset ?? 15)),
    open: o.open ?? true,
  };
  invoices.push(inv);
  return inv;
}

interface PayOpt { currency?: 'EUR' | 'USD'; day?: number }
function P(label: string, amountCents: number, o: PayOpt = {}): Payment {
  return { id: `pay-${String(++paySeq).padStart(3, '0')}`, label, amountCents, currency: o.currency ?? 'EUR', date: d(o.day ?? 20) };
}

function addCase(cohort: Cohort, payment: Payment, invs: Invoice[], expected: Expected, extra?: Partial<Case>): void {
  cases.push({
    id: `case-${String(++caseSeq).padStart(3, '0')}`, cohort,
    phase2: extra?.phase2, locked: extra?.locked, sharedCustomerWith: extra?.sharedCustomerWith,
    payment, invoices: invs, expected,
  });
}

// ═══════════════════════════ C1 — terrain natif (40) ═══════════════════════════
// 24 standards (dont 2 via référence client, 2 dates hors fenêtre) + 6 sans client
// dans le libellé + 4 bruits réels (NBSP, minuscules, N°, espaces).
const c1std: Array<{ amount: number; day: number; kind?: 'custref' | 'outwin'; ref?: string }> = [
  { amount: 240000, day: 10 }, { amount: 85000, day: 12 }, { amount: 1200000, day: 15 },
  { amount: 480000, day: 18 }, { amount: 360000, day: 22 }, { amount: 920000, day: 25 },
  { amount: 640000, day: 28 }, { amount: 225000, day: 30 }, { amount: 2750000, day: 33 },
  { amount: 78000, day: 36 }, { amount: 156000, day: 40 }, { amount: 840000, day: 44 },
  { amount: 118000, day: 47 }, { amount: 445000, day: 50 }, { amount: 302000, day: 54 },
  { amount: 199000, day: 57 }, { amount: 540000, day: 60 }, { amount: 99000, day: 63 },
  { amount: 145000, day: 66 }, { amount: 410000, day: 68 }, { amount: 260000, day: 70 },
  { amount: 720000, day: 72 }, { amount: 333000, day: 74, kind: 'custref', ref: 'CDE-8842' },
  { amount: 505000, day: 74, kind: 'custref', ref: 'CDE-9017' },
  { amount: 355000, day: 16, kind: 'outwin' }, { amount: 612000, day: 58, kind: 'outwin' },
  { amount: 168000, day: 30 }, { amount: 295000, day: 45 }, { amount: 132000, day: 21 }, { amount: 205000, day: 37 },
];
for (const r of c1std) {
  const c = nom();
  const inv = I(c, r.amount, { day: r.day, dueOffset: r.kind === 'outwin' ? 90 : 15, customerReference: r.kind === 'custref' ? r.ref : null });
  const num = inv.number;
  const label = r.kind === 'custref'
    ? `VIR SEPA RECU DE ${c.toUpperCase()} REF ${r.ref}`
    : `VIR SEPA RECU DE ${c.toUpperCase()} FACT ${num}`;
  addCase('C1', P(label, r.amount, { day: r.day }), [inv], { decision: 'proposal', classification: 'matched_exact', invoiceId: inv.id, residualCents: 0 });
}
// 6 sans client dans le libellé (référence seule) — confiance 0,9
for (const [amount, day, suffix] of [[240000, 11, ''], [445000, 26, ' DG'], [156000, 38, ''], [720000, 52, ' ECH'], [118000, 64, ''], [302000, 71, ' REGLEMENT']] as const) {
  const c = nom();
  const inv = I(c, amount, { day });
  addCase('C1', P(`VIR RECU ${inv.number}${suffix}`, amount, { day }), [inv], { decision: 'proposal', classification: 'matched_exact', invoiceId: inv.id, residualCents: 0 });
}
// 4 bruits réels : NBSP, minuscules, N°, espaces dans le numéro
{
  const c1 = nom(); const i1 = I(c1, 268000, { day: 14 });
  addCase('C1', P(`VIR SEPA\u00a0RECU DE ${c1.toUpperCase()} FACT\u00a0${i1.number}`, 268000, { day: 14 }), [i1], { decision: 'proposal', classification: 'matched_exact', invoiceId: i1.id, residualCents: 0 });
  const c2 = nom(); const i2 = I(c2, 187000, { day: 27 });
  addCase('C1', P(`vir sepa recu de ${c2.toLowerCase()} fact ${i2.number.toLowerCase()}`, 187000, { day: 27 }), [i2], { decision: 'proposal', classification: 'matched_exact', invoiceId: i2.id, residualCents: 0 });
  const c3 = nom(); const i3 = I(c3, 523000, { day: 42 });
  addCase('C1', P(`VIR SEPA RECU DE ${c3.toUpperCase()} FACT N° ${i3.number.slice(2)}`, 523000, { day: 42 }), [i3], { decision: 'proposal', classification: 'matched_exact', invoiceId: i3.id, residualCents: 0 });
  const c4 = nom(); const i4 = I(c4, 96500, { day: 61 });
  addCase('C1', P(`VIR RECU DE ${c4.toUpperCase()} FACT FA 2026 0${i4.number.slice(8)}`, 96500, { day: 61 }), [i4], { decision: 'proposal', classification: 'matched_exact', invoiceId: i4.id, residualCents: 0 });
}

// ═════════════════════ C2 — terrain v0.1 spécifié (55) ═════════════════════════
// 10 paiements partiels (référence explicite, résiduel > 8,00 €)
const c2partial: Array<[number, number, number]> = [
  [240000, 114000, 13], [480000, 240000, 21], [640000, 38400, 29], [840000, 515000, 35],
  [156000, 100000, 43], [445000, 300445, 48], [118000, 60000, 55], [2750000, 1250000, 62],
  [360000, 216000, 67], [92000, 46460, 73],
];
for (const [invAmt, payAmt, day] of c2partial) {
  const c = nom(); const inv = I(c, invAmt, { day });
  addCase('C2', P(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${inv.number}`, payAmt, { day }), [inv], {
    decision: 'proposal', classification: 'matched_partial', invoiceId: inv.id, residualCents: invAmt - payAmt,
  });
}
// 8 écarts de montant : 4 type frais (≤ 8,00 €, sous la facture), 2 au-dessus, 2 frais sans client
const feeGaps = [240, 490, 800, 675];
for (const gap of feeGaps) {
  const c = nom(); const inv = I(c, 240000, { day: 17 });
  addCase('C2', P(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${inv.number}`, 240000 - gap, { day: 17 }), [inv], {
    decision: 'flag', classification: 'amount_mismatch', noteContains: 'frais bancaires ou déduction',
  });
}
for (const extra of [150000, 48000]) {
  const c = nom(); const inv = I(c, 240000, { day: 24 });
  addCase('C2', P(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${inv.number}`, 240000 + extra, { day: 24 }), [inv], {
    decision: 'flag', classification: 'amount_mismatch', noteContains: 'supérieur à la facture',
  });
}
for (const gap of [360, 175]) {
  const c = nom(); const inv = I(c, 118000, { day: 31 });
  addCase('C2', P(`VIR RECU ${inv.number}`, 118000 - gap, { day: 31 }), [inv], {
    decision: 'flag', classification: 'amount_mismatch', noteContains: 'frais bancaires ou déduction',
  });
}
// 4 écarts de devise (USD entrant, facture EUR)
for (const amount of [240000, 156000, 445000, 92000]) {
  const c = nom(); const inv = I(c, amount, { day: 19 });
  addCase('C2', P(`INCOMING WIRE USD REF ${inv.number}`, amount, { currency: 'USD', day: 19 }), [inv], {
    decision: 'flag', classification: 'currency_mismatch', noteContains: 'devise du paiement',
  });
}
// 8 rejets / annulations (négatifs) — jamais proposés
const rejLabels = ['PRLV SEPA RETOUR', 'REJET PRLV', 'VIR ANNULE', 'REJET PRLV RETOUR'];
for (const [lab, amt] of [[`${rejLabels[0]} SARL X`, -48000], [`${rejLabels[1]} MEUBLES Y`, -12500], [`${rejLabels[2]} ATELIER Z`, -96000], [`${rejLabels[3]} DISTRI W`, -7400]] as const) {
  addCase('C2', P(lab, amt, { day: 23 }), [], { decision: 'flag', classification: 'rejected_or_reversal', noteContains: 'jamais proposée' });
}
for (const lab of ['PRLV SEPA RETOUR', 'REJET PRLV', 'VIR ANNULE', 'RETOUR PRLV NON PAYER'] as const) {
  addCase('C2', P(lab, -18400, { day: 37 }), [], { decision: 'flag', classification: 'rejected_or_reversal', noteContains: 'jamais proposée' });
}
// 10 ambiguës : 4 même client / même montant sans référence + 3 pièges (référence
// trouvée chez un autre client) + 2 doublons de facture + 1 variante DG
for (const [amt, day, dg] of [[120000, 16, ''], [480000, 34, ''], [96000, 51, ''], [225000, 69, ' DG']] as const) {
  const c = nom(); const i1 = I(c, amt, { day, dueOffset: 10 }); const i2 = I(c, amt, { day, dueOffset: 25 });
  addCase('C2', P(`VIR RECU ${c.toUpperCase()}${dg}`, amt, { day }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'ne permet pas de trancher', candidatesInclude: [i1.id, i2.id],
  });
}
for (const amt of [240000, 156000, 640000]) {
  const payer = nom(); const other = nom();
  const invPayer = I(payer, amt, { day: 26 });          // la vraie facture du payeur (numéro NON cité)
  const invOther = I(other, amt, { day: 26 });          // sa référence a été tapée à la place
  addCase('C2', P(`VIR SEPA RECU DE ${payer.toUpperCase()} FACT ${invOther.number}`, amt, { day: 26 }), [invPayer, invOther], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'erreur de saisie probable', candidatesInclude: [invOther.id],
  });
}
for (const amt of [355000, 118000]) {
  const c = nom(); const i1 = I(c, amt, { day: 46 }); const i2 = I(c, amt, { day: 46 });
  i2.number = i1.number; // même numéro transmis deux fois
  addCase('C2', P(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${i1.number}`, amt, { day: 46 }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'doublon de facture possible', candidatesInclude: [i1.id, i2.id],
  });
}
{
  const c = nom(); const i1 = I(c, 308000, { day: 59 }); const i2 = I(c, 308000, { day: 59, dueOffset: 30 });
  addCase('C2', P(`VIR RECU ${c.toUpperCase()} DG`, 308000, { day: 59 }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'ne permet pas de trancher', candidatesInclude: [i1.id, i2.id],
  });
}
// 1 affectation client + montant exact unique (sans référence lue) — la seule
// proposition de C2 sans référence : confiance 0,80
{
  const c = nom(); const inv = I(c, 335000, { day: 53 });
  addCase('C2', P(`VIR RECU ${c.toUpperCase()}`, 335000, { day: 53 }), [inv], {
    decision: 'proposal', classification: 'matched_exact', invoiceId: inv.id, residualCents: 0,
  });
}
// 15 abstinences : 5 client sans montant correspondant + 4 opérations bancaires
// internes + 3 fausses références (transposition de chiffres) + 3 libellés nus
{
  const c1 = nom(); const i1 = I(c1, 480000, { day: 18 });
  addCase('C2', P(`VIR RECU ${c1.toUpperCase()}`, 114000, { day: 18 }), [i1], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel' });
  const c2 = nom(); const i2 = I(c2, 640000, { day: 32 });
  addCase('C2', P(`VIR RECU ${c2.toUpperCase()}`, 38400, { day: 32 }), [i2], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel' });
  const c3 = nom(); const i3a = I(c3, 120000, { day: 41 }); const i3b = I(c3, 480000, { day: 41 });
  addCase('C2', P(`VIR RECU ${c3.toUpperCase()}`, 240000, { day: 41 }), [i3a, i3b], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel' });
  const c4 = nom(); const i4a = I(c4, 96000, { day: 53 }); const i4b = I(c4, 260000, { day: 53 });
  addCase('C2', P(`VIR RECU ${c4.toUpperCase()}`, 187000, { day: 53 }), [i4a, i4b], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel' });
  const c5 = nom(); const i5 = I(c5, 120000, { day: 65 });
  addCase('C2', P(`VIR RECU ${c5.toUpperCase()}`, 480000, { day: 65 }), [i5], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel' });
}
for (const lab of ['FRAIS BANCAIRES', 'COTISATION TRIMESTRIELLE', 'INTERETS CREDITEURS', 'COMMISSION MOUVEMENT'] as const) {
  addCase('C2', P(lab, 1250, { day: 71 }), [], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'aucune référence ni client' });
}
{
  const c = nom(); const inv = I(c, 240000, { day: 20 }); // vraie facture FA2026-0142
  addCase('C2', P(`VIR RECU FA2026-9142 DG`, 240000, { day: 20 }), [inv], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'aucune référence ni client' });
  const c2 = nom(); const inv2 = I(c2, 156000, { day: 49 });
  addCase('C2', P(`VIR SEPA FACT 2026-9156`, 156000, { day: 49 }), [inv2], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'aucune référence ni client' });
  const c3 = nom(); const inv3 = I(c3, 78000, { day: 74 });
  addCase('C2', P(`VIR RECU ${inv3.number.slice(0, 8)}97${inv3.number.slice(10)}`, 78000, { day: 74 }), [inv3], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'aucune référence ni client' });
}
for (const lab of ['VIR SEPA', 'REMISE DE CHEQUES', 'VIR RECU'] as const) {
  addCase('C2', P(lab, 64000, { day: 74 }), [], { decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'aucune référence ni client' });
}

// ═══════════════════ C3 — terrain phase 2 verrouillé (17) ═════════════════════
// 8 virements groupés (2–3 références dans le libellé)
const grouped: Array<{ amts: number[]; mode: 'sum' | 'ded' | 'part'; day: number }> = [
  { amts: [120000, 90000], mode: 'sum', day: 15 },
  { amts: [240000, 156000], mode: 'sum', day: 20 },
  { amts: [84000, 118000, 44500], mode: 'sum', day: 27 },
  { amts: [360000, 216000], mode: 'sum', day: 39 },
  { amts: [96000, 78000, 64000], mode: 'sum', day: 58 },
  { amts: [240000, 156000], mode: 'ded', day: 33 },   // somme − escompte 2 %
  { amts: [445000, 118000], mode: 'ded', day: 47 },
  { amts: [480000, 240000], mode: 'part', day: 66 },  // 60 % de la somme
];
for (const g of grouped) {
  const c = nom();
  const invs = g.amts.map((a) => I(c, a, { day: g.day }));
  const sum = g.amts.reduce((x, y) => x + y, 0);
  const pay = g.mode === 'sum' ? sum : g.mode === 'ded' ? sum - Math.round(sum * 0.02) : Math.round(sum * 0.6);
  const label = `VIR SEPA RECU DE ${c.toUpperCase()} REGLEMENT FACT ${invs.map((i) => i.number).join(' + ')}`;
  addCase('C3', P(label, pay, { day: g.day }), invs, {
    decision: 'flag', classification: 'multi_reference_grouped', noteContains: 'ventilation en phase 2', candidatesInclude: invs.map((i) => i.id),
  }, { phase2: 'ventilation groupée', locked: true });
}
// 3 ventilations : 1 somme exacte de 2 factures sur 3 sans référence + 2 partiels sans référence
{
  const c = nom();
  const i1 = I(c, 120000, { day: 25 }); const i2 = I(c, 90000, { day: 25 }); const i3 = I(c, 70000, { day: 25 });
  addCase('C3', P(`VIR RECU ${c.toUpperCase()}`, 210000, { day: 25 }), [i1, i2, i3], {
    decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel',
  }, { phase2: 'ventilation libre (somme de 2 factures sur 3)', locked: true });
  const c2 = nom(); const inv2 = I(c2, 360000, { day: 44 });
  addCase('C3', P(`VIR RECU ${c2.toUpperCase()} ACOMPTE`, 144000, { day: 44 }), [inv2], {
    decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel',
  }, { phase2: 'paiement partiel sans référence', locked: true });
  const c3 = nom(); const inv3 = I(c3, 480000, { day: 63 });
  addCase('C3', P(`VIR RECU ${c3.toUpperCase()} ACOMPTE 40 PCT`, 192000, { day: 63 }), [inv3], {
    decision: 'abstain', classification: 'unmatched_no_candidate', noteContains: 'ventilation ou paiement partiel',
  }, { phase2: 'paiement partiel sans référence', locked: true });
}
// 3 déductions justifiées : 2 avec indice lisible (ESCOMPTE) → flag ; 1 sans
// indice (écart = 2 % exactement) → v0.1 n'a pas le droit de deviner : partiel.
{
  const c1 = nom(); const i1 = I(c1, 2400000, { day: 30 });
  addCase('C3', P(`VIR SEPA RECU DE ${c1.toUpperCase()} FACT ${i1.number} ESCOMPTE 2 PCT`, 2352000, { day: 30 }), [i1], {
    decision: 'flag', classification: 'amount_mismatch', noteContains: 'déduction/escompte',
  }, { phase2: 'déduction justifiée (escompte 2 %)', locked: true });
  const c2 = nom(); const i2 = I(c2, 1560000, { day: 56 });
  addCase('C3', P(`VIR RECU DE ${c2.toUpperCase()} FACT ${i2.number} REMISE 2 PCT`, 1528800, { day: 56 }), [i2], {
    decision: 'flag', classification: 'amount_mismatch', noteContains: 'déduction/escompte',
  }, { phase2: 'déduction justifiée (remise 2 %)', locked: true });
  const c3 = nom(); const i3 = I(c3, 480000, { day: 72 });
  addCase('C3', P(`VIR SEPA RECU DE ${c3.toUpperCase()} FACT ${i3.number}`, 470400, { day: 72 }), [i3], {
    decision: 'proposal', classification: 'matched_partial', invoiceId: i3.id, residualCents: 9600,
  }, { phase2: 'déduction sans indice lisible (écart = 2 % exactement)', locked: false });
}
// 3 doublons : 2 factures transmises deux fois + 1 paiement en double (2 cas partageant le client)
{
  const c1 = nom(); const i1 = I(c1, 355000, { day: 12 }); const i2 = I(c1, 355000, { day: 12 });
  i2.number = i1.number; // même numéro transmis deux fois
  addCase('C3', P(`VIR SEPA RECU DE ${c1.toUpperCase()} FACT ${i1.number}`, 355000, { day: 12 }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'doublon de facture possible', candidatesInclude: [i1.id, i2.id],
  }, { phase2: 'détection de doublons (factures)', locked: true });
  const c2 = nom(); const j1 = I(c2, 118000, { day: 55 }); const j2 = I(c2, 118000, { day: 55 });
  j2.number = j1.number; // même numéro transmis deux fois
  addCase('C3', P(`VIR RECU ${c2.toUpperCase()} FACT ${j1.number}`, 118000, { day: 55 }), [j1, j2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'doublon de facture possible', candidatesInclude: [j1.id, j2.id],
  }, { phase2: 'détection de doublons (factures)', locked: true });
}
{
  const c = nom(); const i1 = I(c, 120000, { day: 40 }); const i2 = I(c, 120000, { day: 40 });
  // deux paiements identiques du même client, même jour : doublon de paiement —
  // la phase 2 doit le détecter ; v0.1 signale l'ambiguïté, jamais une affectation
  addCase('C3', P(`VIR RECU ${c.toUpperCase()}`, 120000, { day: 40 }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'ne permet pas de trancher', candidatesInclude: [i1.id, i2.id],
  }, { phase2: 'détection de doublons (paiements)', locked: true });
  addCase('C3', P(`VIR RECU ${c.toUpperCase()}`, 120000, { day: 40 }), [i1, i2], {
    decision: 'flag', classification: 'ambiguous', noteContains: 'ne permet pas de trancher', candidatesInclude: [i1.id, i2.id],
  }, { phase2: 'détection de doublons (paiements)', locked: true });
  const first = cases[cases.length - 2], second = cases[cases.length - 1];
  first.sharedCustomerWith = [second.id];
  second.sharedCustomerWith = [first.id];
}

// ── Invariants de construction (échouent vite à la construction si le jeu est incohérent) ──
const seenPay = new Set<string>();
for (const c of cases) {
  if (seenPay.has(c.payment.id)) throw new Error(`paiement dupliqué : ${c.payment.id}`);
  seenPay.add(c.payment.id);
  const e = c.expected;
  if (e.decision === 'proposal') {
    const targetId = e.invoiceId; // hoisté : le rétrécissement ne traverse pas la frontière du callback
    const inv = invoices.find((i) => i.id === targetId);
    if (!inv) throw new Error(`facture inconnue : ${targetId}`);
    if (!inv.open) throw new Error(`proposition sur facture fermée : ${inv.id}`);
  }
}
const numberOwners = new Map<string, number>();
for (const i of invoices) numberOwners.set(i.number, (numberOwners.get(i.number) ?? 0) + 1);
for (const [num, n] of numberOwners) if (n > 2) throw new Error(`numéro ${num} sur ${n} factures (max 2 : doublon)`);

// ── Exports ───────────────────────────────────────────────────────────────────
export interface Dataset {
  cases: Case[];
  payments: Payment[];
  invoices: Invoice[];
  openInvoices: Invoice[];
  customers: string[];
  meta: { total: number; byCohort: Record<Cohort, number>; locked: number };
}

export function buildDataset(): Dataset {
  return {
    cases,
    payments: cases.map((c) => c.payment),
    invoices,
    openInvoices: invoices.filter((i) => i.open),
    customers,
    meta: {
      total: cases.length,
      byCohort: {
        C1: cases.filter((c) => c.cohort === 'C1').length,
        C2: cases.filter((c) => c.cohort === 'C2').length,
        C3: cases.filter((c) => c.cohort === 'C3').length,
      },
      locked: cases.filter((c) => c.locked).length,
    },
  };
}

let cached: Dataset | null = null;
export function getDataset(): Dataset {
  if (!cached) cached = buildDataset();
  return cached;
}
export { cases as _cases, invoices as _invoices, customers as _customers };
