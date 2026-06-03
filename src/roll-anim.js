/* Roll animation manifest. Each expression is a group of neighboring sheet cells
   (row_col) that animate together. mode: loop | pingpong (1..N..1) | once | hold. */
window.ROLL_ANIM = {
  // --- idle + neutral talk: the dedicated talk_blink frames (engine adds blinking on a timer) ---
  // talk_blink1 = resting idle; 1-3 = neutral talk (mouth); 4-6 = talk WITH a blink; 7-9 = idle
  // blink. The face engine (roll-face.js) drives idle/talk + overlays blinks from ROLL_BLINK below.
  idle:      { frames: ['talk_blink1'], mode: 'hold' },
  neutral:   { frames: ['talk_blink1'], mode: 'hold' },
  talk:      { frames: ['talk_blink1', 'talk_blink2', 'talk_blink3'], mode: 'loop', fps: 6 },
  // --- original, known-good emotional mappings (do not change) ---
  happy:     { frames: ['4_3', '4_4', '4_5'], mode: 'pingpong', fps: 5 },
  laugh:     { frames: ['5_0', '5_1', '5_2', '5_3'], mode: 'loop', fps: 8 },
  surprised: { frames: ['6_1', '6_2', '6_3'], mode: 'pingpong', fps: 6 },
  // frantic head-turn: dart one way past the exaggeration frame (1_6), hold the look (2_0), crawl back skipping
  // 1_6, dart the other way past 1_2, hold (1_3), crawl back skipping 1_2, repeat. Holds = repeated frames.
  worried:   { frames: ['1_4', '1_5', '1_6', '2_0', '2_0', '2_0', '1_5', '1_4', '1_0', '1_1', '1_2', '1_3', '1_3', '1_3', '1_1', '1_0'], mode: 'loop', fps: 9 },
  sad:       { frames: ['3_1', '3_0'], mode: 'loop', fps: 3 },     // teary
  cry:       { frames: ['5_4', '5_5', '5_6', '6_0'], mode: 'pingpong', fps: 5 }, // bawling, 4-frame
  angry:     { frames: ['2_1', '2_2', '0_7'], mode: 'loop', fps: 6 },  // grit -> shout -> full glare
  wink:      { frames: ['6_5', '6_6'], mode: 'once', fps: 4 },
  blush:     { frames: ['1_2'], mode: 'hold' },
  shocked:   { frames: ['2_6', '3_0', '3_1'], mode: 'loop', fps: 6 },  // wide-eyed frozen panic
  // --- new, ADDITIVE (brain-pickable), cells confirmed against the sheet ---
  whine:       { frames: ['3_3', '3_4', '3_5'], mode: 'pingpong', fps: 4 },  // grit → shout → cry, complaining
  rage:        { frames: ['3_2', '3_3', '3_4'], mode: 'loop', fps: 7 },      // building fury
  shame:       { frames: ['3_2'], mode: 'hold' },                            // head held low
};
window.ROLL_EXPRESSIONS = ['neutral', 'happy', 'laugh', 'talk', 'surprised',
  'worried', 'sad', 'cry', 'angry', 'wink', 'blush', 'shocked', 'whine',
  'rage', 'shame'];

// Eyes-only blink overlay (top 20px). It's a separate layer stacked over the mouth, so the SAME
// blink works whether she's idle or talking — no combined talk+blink frames needed (4-6 unused).
// The engine plays this on a randomized timer, occasionally twice fast. Tweak the order freely.
// closing → CLOSED (held two frames so the shut eyes actually register, not a 1-frame flash) → opening.
window.ROLL_BLINK = {
  eyes: ['talk_blink7', 'talk_blink8', 'talk_blink8', 'talk_blink9'],
};
// Neutral mouth visemes for lip-syncing to printed text: closed (rest/space), mid (consonant),
// open (vowel). The base layer; the engine sets one per character as the line types out.
window.ROLL_MOUTH = { closed: 'talk_blink1', mid: 'talk_blink2', open: 'talk_blink3' };
