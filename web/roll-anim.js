/* Roll animation manifest. Each expression is a group of neighboring sheet cells
   (row_col) that animate together. mode: loop | pingpong (1..N..1) | once | hold. */
window.ROLL_ANIM = {
  // --- original, known-good mappings (do not change) ---
  idle:      { frames: ['0_0', '0_1', '0_2', '0_3', '0_4'], mode: 'pingpong', fps: 3 },
  neutral:   { frames: ['0_1'], mode: 'hold' },
  happy:     { frames: ['4_3', '4_4', '4_5'], mode: 'pingpong', fps: 5 },
  laugh:     { frames: ['5_0', '5_1', '5_2', '5_3'], mode: 'loop', fps: 8 },
  talk:      { frames: ['0_1', '2_3'], mode: 'loop', fps: 6 },     // mouth flap
  surprised: { frames: ['6_1', '6_2', '6_3'], mode: 'pingpong', fps: 6 },
  worried:   { frames: ['2_0', '2_6'], mode: 'pingpong', fps: 3 },
  sad:       { frames: ['3_1', '3_0'], mode: 'loop', fps: 3 },     // teary
  cry:       { frames: ['2_6', '3_0', '3_5'], mode: 'loop', fps: 4 }, // bawling
  angry:     { frames: ['3_3', '3_4'], mode: 'loop', fps: 6 },     // grit -> shout
  wink:      { frames: ['6_5', '6_6'], mode: 'once', fps: 4 },
  blush:     { frames: ['1_2'], mode: 'hold' },
  shocked:   { frames: ['2_5'], mode: 'hold' },                    // blue frozen
  // --- new, ADDITIVE (brain-pickable), cells confirmed against the sheet ---
  whine:       { frames: ['3_3', '3_4', '3_5'], mode: 'pingpong', fps: 4 },  // grit → shout → cry, complaining
  mischievous: { frames: ['0_7'], mode: 'hold' },                            // sly side-glance
};
window.ROLL_EXPRESSIONS = ['neutral', 'happy', 'laugh', 'talk', 'surprised',
  'worried', 'sad', 'cry', 'angry', 'wink', 'blush', 'shocked', 'whine', 'mischievous'];
