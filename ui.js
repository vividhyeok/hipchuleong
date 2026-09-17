const $ = (selector) => document.querySelector(selector);

const floatingDock = $('#floatingDock');
const dockOpen = $('#dockOpen');
const dockReset = $('#dockReset');
const dockSave = $('#dockSave');
const dockControls = $('#dockControls');
const fileInput = $('#fileInput');
const resetButton = $('#resetButton');
const snapshotButton = $('#snapshotButton');
const canvas = $('#canvas');

function setLoadedUI(isLoaded) {
  document.body.classList.toggle('has-image', isLoaded);
  floatingDock.hidden = !isLoaded;

  if (!isLoaded) {
    document.body.classList.remove('controls-open');
    dockControls.setAttribute('aria-expanded', 'false');
  }
}

function toggleControls(force) {
  const next = typeof force === 'boolean'
    ? force
    : !document.body.classList.contains('controls-open');

  document.body.classList.toggle('controls-open', next);
  dockControls.setAttribute('aria-expanded', String(next));
}

setLoadedUI(false);
window.addEventListener('hipchuleong:imagechange', (event) => {
  setLoadedUI(Boolean(event.detail?.loaded));
});

dockOpen?.addEventListener('click', () => {
  toggleControls(false);
  fileInput?.click();
});

dockReset?.addEventListener('click', () => resetButton?.click());
dockSave?.addEventListener('click', () => snapshotButton?.click());
dockControls?.addEventListener('click', () => toggleControls());

canvas?.addEventListener('pointerdown', () => {
  if (document.body.classList.contains('controls-open')) toggleControls(false);
}, { capture: true });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleControls(false);
});
