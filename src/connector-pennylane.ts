// ─────────────────────────────────────────────────────────────────────────────
// Connecteur Pennylane v0.2 — couche de traduction PURE, sans réseau.
//
// Rôle : traduire les objets du format Pennylane (noms de champs réels de l'API
// publique, reconstitués en fixtures) vers les types de domaine du moteur
// (Invoice/Payment). Aucun appel HTTP ici : l'ingestion réseau (OAuth partenaire,
// webhooks, sandbox) est un chantier séparé — cette couche est testable et
// reviewable seule, et sera réutilisée telle quelle le jour où l'accès arrive.
//
// L'architecture d'indépendance de ClearMatch : chaque plateforme future
// (Sage, Acomba, Eliacin…) est une autre traduction vers les MÊMES types —
// le moteur, le harnais et le fuzz ne changent jamais.
// ─────────────────────────────────────────────────────────────────────────────
import type { Invoice, Payment } from './types.ts';

// ── Formes Pennylane (fixtures au format de l'API publique) ───────────────────

/** Facture Pennylane (champs du format public, devise en centimes chez Pennylane : « amount » est un entier de centimes). */
export interface PennylaneInvoice {
  id: string;                    // identifiant Pennylane
  invoice_number: string;        // ex. "FA2027-1021"
  customer_name: string;
  customer_reference?: string | null; // référence de commande côté client
  total: number;                 // centimes
  currency: string;              // "EUR" | "USD" | …
  issuance_date: string;         // ISO
  due_date: string;
  status: string;                // "open" | "paid" | … (seules "open" sont proposables)
}

/** Transaction bancaire Pennylane (flux bancaire connecté). */
export interface PennylaneBankTransaction {
  id: string;
  label: string;                 // libellé bancaire brut
  amount: number;                // signé : négatif = sortie/rejet
  currency: string;
  date: string;                  // ISO
}

export interface PennylaneWorld {
  invoices: PennylaneInvoice[];
  transactions: PennylaneBankTransaction[];
}

// ── Traduction → domaine ──────────────────────────────────────────────────────

/** Traduit une devise Pennylane vers la devise domaine ; null = non supportée (mismatch géré en amont). */
function toCurrency(s: string): 'EUR' | 'USD' | null {
  const up = s.toUpperCase();
  return up === 'EUR' || up === 'USD' ? up : null;
}

export interface TranslationReport {
  invoices: { kept: number; skippedClosed: number; skippedCurrency: number; skippedShape: number };
  payments: { kept: number; skippedCurrency: number; skippedShape: number };
  warnings: string[];
}

export interface Translated {
  domainInvoices: Invoice[];
  domainPayments: Payment[];
  customers: string[];
  report: TranslationReport;
}

/**
 * Traduit un monde Pennylane en objets domaine.
 * Les factures fermées (« paid ») ne sont PAS traduites : hors périmètre du moteur.
 * Une devise non supportée écarte l'objet avec un avertissement (jamais de conversion
 * implicite — un rapprochement de devise est une décision humaine).
 */
export function translatePennylane(world: PennylaneWorld): Translated {
  const warnings: string[] = [];
  const report: TranslationReport = {
    warnings,
    invoices: { kept: 0, skippedClosed: 0, skippedCurrency: 0, skippedShape: 0 },
    payments: { kept: 0, skippedCurrency: 0, skippedShape: 0 },
  };
  const customers = new Set<string>();

  const domainInvoices: Invoice[] = [];
  for (const inv of world.invoices) {
    if (inv.status !== 'open') { report.invoices.skippedClosed += 1; continue; }
    const currency = toCurrency(inv.currency);
    if (!currency) { report.invoices.skippedCurrency += 1; warnings.push(`facture ${inv.invoice_number} : devise ${inv.currency} non supportée — écartée`); continue; }
    if (!inv.invoice_number || typeof inv.total !== 'number' || Number.isNaN(inv.total)) { report.invoices.skippedShape += 1; warnings.push(`facture ${inv.id} : forme invalide — écartée`); continue; }
    if (inv.total <= 0) { report.invoices.skippedShape += 1; warnings.push(`facture ${inv.invoice_number} : montant non positif (${inv.total}) — écartée`); continue; }
    domainInvoices.push({
      id: inv.id,
      number: inv.invoice_number,
      customer: inv.customer_name,
      customerReference: inv.customer_reference ?? null,
      amountCents: inv.total,
      currency,
      issueDate: inv.issuance_date,
      dueDate: inv.due_date,
      open: true,
    });
    customers.add(inv.customer_name);
    report.invoices.kept += 1;
  }

  const domainPayments: Payment[] = [];
  for (const t of world.transactions) {
    const currency = toCurrency(t.currency);
    if (!currency) { report.payments.skippedCurrency += 1; warnings.push(`transaction ${t.id} : devise ${t.currency} non supportée — écartée`); continue; }
    if (typeof t.amount !== 'number' || Number.isNaN(t.amount) || t.amount === 0) { report.payments.skippedShape += 1; warnings.push(`transaction ${t.id} : montant invalide (${t.amount}) — écartée`); continue; }
    if (!t.label?.trim()) { report.payments.skippedShape += 1; warnings.push(`transaction ${t.id} : libellé vide — écartée`); continue; }
    domainPayments.push({ id: t.id, label: t.label, amountCents: t.amount, currency, date: t.date });
    report.payments.kept += 1;
  }

  return { domainInvoices, domainPayments, customers: [...customers], report };
}

/** Construit un contexte de lot pour le moteur : les paiements d'un même import bancaire. */
export function batchContext(payments: Payment[]): Payment[] {
  return payments;
}
