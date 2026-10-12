// What `click "<label>"` resolves a label to: a whole name, never a part of one (the R109 incident:
// « Passer » clicked « Passer en cours » on prep), and what a miss offers instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickWords, distance, exactRef, markTextJs, nearNames, normName, refsOf, type Ref } from '../../src/web/match.ts';
import { CLICK_ROLES } from '../../src/web/page.ts';

const snap = (refs: Record<string, { role: string; name: string }>): string => JSON.stringify({ success: true, data: { refs } });

// The transition dialog of the run-through (2026-09-30), refs as agent-browser lists them.
const dialog = refsOf(
  snap({
    e1: { role: 'dialog', name: 'Traiter à la suite' },
    e10: { role: 'button', name: 'Passer' },
    e2: { role: 'radio', name: 'Passer en cours' },
    e3: { role: 'radio', name: 'Marquer résolu' },
    e9: { role: 'button', name: 'Valider et passer au suivant' },
    e11: { role: 'button', name: 'Précédent' },
  }),
);

test('the refs of a snapshot, in the order of the page', () => {
  assert.deepEqual(
    dialog.map((r) => r.ref),
    ['e1', 'e2', 'e3', 'e9', 'e10', 'e11'],
  );
  assert.deepEqual(refsOf('not json'), []);
  assert.deepEqual(refsOf(JSON.stringify({ success: false, data: null })), []);
});

test('a name is compared whole, whatever its case, its spacing and an icon glyph at either end', () => {
  assert.equal(normName('  Se   connecter '), 'se connecter');
  assert.equal(normName('SE DÉCONNECTER'), 'se déconnecter');
  assert.equal(normName('Publier ✓'), 'publier');
  assert.equal(normName('🎉 Fête'), 'fête');
  assert.equal(normName(' Suivant'), 'suivant');
  assert.equal(normName('Moi aussi 2'), 'moi aussi 2');
  assert.equal(normName('Retour à l’accueil'), normName("retour à l'ACCUEIL"));
  assert.equal(normName('12\u202f€'), '12 €');
});

test('« Passer » is the button named Passer, not the decision nor « Valider et passer au suivant »', () => {
  assert.equal(exactRef(dialog, 'Passer', CLICK_ROLES)?.ref, 'e10');
  assert.equal(exactRef(dialog, 'passer en cours', CLICK_ROLES)?.ref, 'e2');
  // Before the button is drawn, a click on « Passer » finds nothing rather than the radio.
  const early = dialog.filter((r) => r.ref !== 'e10');
  assert.equal(exactRef(early, 'Passer', CLICK_ROLES), undefined);
});

test('the same name on a button and a link: the button; a role outside the list still counts after', () => {
  const refs: Ref[] = [
    { ref: 'e1', role: 'link', name: 'Annonces' },
    { ref: 'e2', role: 'button', name: 'Annonces' },
    { ref: 'e3', role: 'generic', name: 'Carte du voisin' },
  ];
  assert.equal(exactRef(refs, 'Annonces', CLICK_ROLES)?.ref, 'e2');
  assert.equal(exactRef(refs, 'carte du voisin', CLICK_ROLES)?.ref, 'e3');
  assert.equal(exactRef(refs, '', CLICK_ROLES), undefined);
});

test('a miss offers up to three names: those holding the label first, then a slip away', () => {
  assert.deepEqual(nearNames(dialog.filter((r) => r.ref !== 'e10'), 'Passer', CLICK_ROLES), ['Passer en cours', 'Valider et passer au suivant']);
  assert.deepEqual(nearNames(dialog, 'Precedent', CLICK_ROLES), ['Précédent']);
  assert.deepEqual(nearNames(dialog, 'Supprimer le compte', CLICK_ROLES), []);
  const many: Ref[] = ['Voir 1', 'Voir 2', 'Voir 3', 'Voir 4'].map((name, i) => ({ ref: `e${i + 1}`, role: 'button', name }));
  assert.equal(nearNames(many, 'Voir', CLICK_ROLES).length, 3);
  // A dialog's title is not a control.
  assert.ok(!nearNames(dialog, 'Traiter', CLICK_ROLES).includes('Traiter à la suite'));
});

test('edit distance', () => {
  assert.equal(distance('passer', 'passer'), 0);
  assert.equal(distance('precedent', 'précédent'), 2);
  assert.equal(distance('', 'abc'), 3);
});

test('--partial is an option of the step, wherever it stands', () => {
  assert.deepEqual(clickWords(['Passer']), { label: 'Passer', partial: false });
  assert.deepEqual(clickWords(['Passer', '--partial']), { label: 'Passer', partial: true });
  assert.deepEqual(clickWords(['--partial', 'Passer']), { label: 'Passer', partial: true });
});

test('the text tier runs in the page with the same comparison', () => {
  const js = markTextJs('Porte « garage »');
  assert.ok(js.includes('"Porte « garage »"'));
  // The page's regex is the one normName uses, as a literal the page can parse.
  assert.ok(js.includes('/^[\\p{So}\\p{Co}\\s]+|[\\p{So}\\p{Co}\\s]+$/gu'));
  assert.doesNotThrow(() => new Function(`return ${js.replace(/document/g, 'globalThis.__doc')}`));
});
