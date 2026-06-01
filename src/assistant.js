/* Roll's pop-out window: renders state pushed from the main window. */
const roll = new window.RollFace(
  document.getElementById('pop-face'),
  document.getElementById('pop-msg')
);

// `instant` states are window-to-window handoffs — show them as-is instead of re-typing.
window.souljaterm.onAssistantState((state) => {
  if (!state) return;
  if (state.instant) roll.show(state); else roll.speak(state);
});
document.getElementById('pop-in').addEventListener('click', () => window.souljaterm.popin());
document.getElementById('pop-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('pop-chat-input');
  const v = input.value;
  input.value = '';
  if (v.trim()) window.souljaterm.popoutChat(v);
});
