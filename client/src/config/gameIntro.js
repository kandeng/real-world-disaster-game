// Per-game intro briefing shown over the Play! main panel while the 3D scene
// streams in. The clips introduce the game's background and (in future) the
// player's tasks, so they are CONTENT — supplied per game, not a fixed loading
// mask. Today this seeds from the existing /splash clips; a future game can
// replace this list (or fetch it from an API) without touching SplashOverlay.
//
// `music` is an optional soundtrack looped beneath the clips. When it is set,
// the clips themselves are muted (the music is the audio); when omitted, the
// clips play with their own audio (e.g. narrated briefings).
//
// `slogan` is localized; SplashOverlay picks the entry for the active locale.
export const GAME_INTRO = {
  clips: [
    '/splash/video_00.mp4',
    '/splash/kevtoe_worldview.mp4',
    '/splash/palantir_maven.mp4',
    '/splash/vantor_world3d.mp4',
  ],
  music: '/splash/background_music_00.mp3',
  slogan: {
    en: 'The world is wide, let us take off.',
    zh: '世界很大，我们飞过去看看',
  },
};

// Resolve the intro for a locale: a plain { clips, music, slogan } object with
// the slogan already localized. Unknown locales fall back to English.
export function getGameIntro(locale = 'en') {
  return {
    clips: GAME_INTRO.clips,
    music: GAME_INTRO.music,
    slogan: GAME_INTRO.slogan[locale] || GAME_INTRO.slogan.en,
  };
}
