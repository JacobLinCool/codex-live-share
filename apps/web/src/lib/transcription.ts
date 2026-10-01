import { useCallback, useEffect, useRef, useState } from 'react';
import { createTranscription, type Transcription, type TranscriptState } from '@codex-live-share/transcribe';
import { locale } from './i18n';
import type { LiveSession } from './session';

export type MicState =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'on'; level: number }
  | { kind: 'error'; message: string; denied: boolean };

/**
 * Transcribes only this person's microphone, so every line is attributed by
 * who sent it rather than by diarization. Finalized segments go to the daemon,
 * which appends them to the shared transcript; interim text rides awareness.
 */
export function useTranscription(live: LiveSession): { state: MicState; toggle: () => void } {
  const [state, setState] = useState<MicState>({ kind: 'off' });
  const running = useRef<{ transcription: Transcription; stream: MediaStream; stopMeter: () => void } | null>(null);
  const sent = useRef<{ sessionId: string | null; lastId: number }>({ sessionId: null, lastId: 0 });

  const onState = useCallback((snapshot: TranscriptState) => {
    if (snapshot.sessionId !== sent.current.sessionId) sent.current = { sessionId: snapshot.sessionId, lastId: 0 };
    for (const segment of snapshot.segments) {
      if (segment.id <= sent.current.lastId) continue;
      sent.current.lastId = segment.id;
      live.control({ type: 'transcript', text: segment.text });
    }
    live.awareness.setLocalStateField('interim', snapshot.interim || null);
    if (snapshot.status === 'error' && snapshot.error) {
      setState({ kind: 'error', message: snapshot.error.message, denied: false });
    }
  }, [live]);

  const stop = useCallback(async () => {
    const current = running.current;
    running.current = null;
    live.awareness.setLocalStateField('interim', null);
    if (!current) return;
    current.stopMeter();
    await current.transcription.stop().catch(() => undefined);
    await current.transcription.destroy().catch(() => undefined);
    for (const track of current.stream.getTracks()) track.stop();
  }, [live]);

  const start = useCallback(async () => {
    const provider = live.session?.asr.provider;
    if (!provider) return;
    setState({ kind: 'starting' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error), denied });
      return;
    }
    const transcription = createTranscription({
      credential: async () => {
        const response = await fetch('/api/transcription-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${live.token}` },
          body: '{}',
        });
        const body = (await response.json()) as { ok: boolean; token?: string; message?: string };
        if (!body.ok || !body.token) throw new Error(body.message ?? 'Could not get a transcription token.');
        return { type: 'ephemeral-token', value: body.token };
      },
      options: {
        provider,
        languageCodes: locale === 'zh-TW' ? ['cmn-Hant-TW', 'en-US'] : [],
        mode: 'VERBATIM',
      },
    });
    transcription.addAudioSource(stream, { id: 'microphone' });
    const unsubscribe = transcription.subscribe(onState);
    const stopMeter = meter(stream, (level) => setState((previous) => (previous.kind === 'on' ? { kind: 'on', level } : previous)));
    running.current = {
      transcription,
      stream,
      stopMeter: () => {
        stopMeter();
        unsubscribe();
      },
    };
    const started = await transcription.start();
    if (!started.ok) {
      await stop();
      setState({ kind: 'error', message: started.message, denied: false });
      return;
    }
    setState({ kind: 'on', level: 0 });
  }, [live, onState, stop]);

  const toggle = useCallback(() => {
    if (state.kind === 'on' || state.kind === 'starting') {
      void stop().then(() => setState({ kind: 'off' }));
    } else {
      void start();
    }
  }, [start, state.kind, stop]);

  useEffect(() => () => void stop(), [stop]);
  return { state, toggle };
}

/** RMS level for the mic button, sampled on animation frames. */
function meter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  let last = 0;
  const tick = (time: number) => {
    frame = requestAnimationFrame(tick);
    if (time - last < 60) return;
    last = time;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 6));
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    void context.close();
  };
}
