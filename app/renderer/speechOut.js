// Wraps text-to-speech synthesis + playback with a generation counter, so that a stop()
// (barge-in, mute, or typing over a reply) that happens while synth() is still running
// discards the result instead of playing a now-stale reply.
export function createSpeechOut({ synth, player }) {
  let generation = 0;
  return {
    async speak(text) {
      const my = generation;
      const result = await synth(text);
      if (!result || generation !== my) return;
      await player.play(result.pcm, result.sampleRate);
    },
    stop() {
      generation++;
      player.stop();
    },
  };
}
