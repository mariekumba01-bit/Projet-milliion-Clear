'use strict';
// E2E : le parcours complet utilisateur, exécuté comme un test avec assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJourney } from '../scripts/e2e-journey.mjs';

test('parcours utilisateur complet : inscription → analyse → validation humaine → audit → abonnement → suspension → réactivation', async () => {
  const out = await runJourney();
  assert.equal(out.seed.proposal, 9);
  assert.equal(out.seed.flag, 7);
  assert.equal(out.seed.abstain, 5);
  assert.equal(out.live.decision, 'proposal');
  assert.equal(out.live.classification, 'multi_reference_grouped');
  assert.ok(out.exceptions >= 20);
  assert.ok(Array.isArray(out.entry) && out.entry.length >= 2, 'écriture 411/512 générée');
  assert.equal(out.auditOk, true, 'chaîne intègre au terme du parcours (vérification finale)');
  assert.ok(out.auditFinal > out.auditChecked, 'le parcours a scellé de nouveaux événements');
  assert.equal(out.link.amountFcfa, 97500);
  assert.equal(out.link.mode, 'manual');
});
