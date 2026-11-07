// Débogage ciblé : pourquoi un libellé piége « sans hit » au moment de la génération
// matche ≥ 2 factures au moment du jugement.
import { findRefHits, norm } from '../src/engine.ts';
import type { Invoice } from '../src/types.ts';

// Rejoue la génération (même PRNG, même ordre) en enregistrant les snapshots du monde.
// → on ne peut pas importer les internes ; on reproduit le scénario minimal :
//    1) un piège est validé contre le monde à l'instant T (findRefHits = 0)
//    2) des cas dup_invoice ajoutent ensuite des factures 2741..3100
//    3) au jugement, le libellé du piège matche une paire dup → ambiguous
// Le test : construis un monde avant/après et compare.

const before: Invoice[] = [];
const after: Invoice[] = [];
// monde « avant » : une facture 2852 n'existe pas encore ; le faux FA2027-2852 ne matche rien
before.push(mk('inv-x1', 'FA2027-1001', 240000));
// monde « après » : une paire dup_invoice portant le numéro FA2027-2852 apparaît (2 factures, même numéro)
after.push(mk('inv-x1', 'FA2027-1001', 240000));
after.push(mk('inv-d1', 'FA2027-2852', 150000));
after.push(mk('inv-d2', 'FA2027-2852', 150000));

const label = 'VIR RECU FA2027-2852 DG';
const hitsBefore = findRefHits(norm(label), before);
const hitsAfter = findRefHits(norm(label), after);
console.log('hits avant (garde-fou) :', hitsBefore.map((i) => i.id + '/' + i.number));
console.log('hits après (jugement) :', hitsAfter.map((i) => i.id + '/' + i.number));
console.log('→ si « après » ≥ 2 et « avant » = 0 : le mécanisme est confirmé (le monde grandit entre génération et jugement)');

function mk(id: string, number: string, amountCents: number): Invoice {
  return { id, number, customer: 'CLIENT X', customerReference: null, amountCents, currency: 'EUR', issueDate: '2027-01-01', dueDate: '2027-02-01', open: true };
}
