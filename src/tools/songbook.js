// "Sing Out Joyfully" songs. Song videos (pub-sjjm_<n>_VIDEO, n = 500 + the
// song for the audio-described versions) show the words on screen and have no
// caption file in any language; the lyrics are songbook pages on WOL.

const SONG_KEY = /^pub-sjjm_(\d+)_VIDEO$/i;

/** True for a song video key (pub-sjjm_103_VIDEO, pub-sjjm_603_VIDEO). */
export function isSongKey(key) {
  return SONG_KEY.test(String(key ?? ''));
}

/** The song a song video key shows (pub-sjjm_603_VIDEO -> 103), or null. */
export function songOfKey(key) {
  const n = Number(SONG_KEY.exec(String(key ?? ''))?.[1]);
  if (!n) return null;
  return n > 500 ? n - 500 : n;
}

/** WOL docid of a "Sing Out Joyfully" song (the same in every language), or null. */
export function songbookDocid(song) {
  if (song >= 1 && song <= 151) return String(1102016800 + song);
  if (song >= 152 && song <= 199) return String(1102022800 + song);
  return null;
}
