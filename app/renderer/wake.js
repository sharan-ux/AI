// On-device "Hey Izza" wake word (Porcupine custom keyword). Needs a free Picovoice AccessKey
// and a wakeWordModel .ppn file trained at https://console.picovoice.ai/.
export async function createWake({ accessKey, wakeWordModel, onWake, onError }) {
  const { PorcupineWorker } = window.PorcupineWeb;
  const { WebVoiceProcessor } = window.WebVoiceProcessor;
  const porcupine = await PorcupineWorker.create(
    accessKey,
    [{ publicPath: '/' + wakeWordModel, label: 'Hey Izza', sensitivity: 0.6 }],
    () => onWake(),
    { publicPath: '/assets/porcupine_params.pv', forceWrite: true },
    { processErrorCallback: (e) => onError?.(e) },
  );
  await WebVoiceProcessor.subscribe(porcupine);
  let subscribed = true;
  return {
    async setMuted(m) {
      if (m) { if (subscribed) { await WebVoiceProcessor.unsubscribe(porcupine); subscribed = false; } }
      else { if (!subscribed) { await WebVoiceProcessor.subscribe(porcupine); subscribed = true; } }
    },
  };
}
