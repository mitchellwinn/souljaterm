/* Roll's pop-out window: renders state pushed from the main window. */
const roll = new window.RollFace(
  document.getElementById('pop-face'),
  document.getElementById('pop-msg')
);

window.souljaterm.onAssistantState((state) => roll.speak(state));
document.getElementById('pop-in').addEventListener('click', () => window.souljaterm.popin());
