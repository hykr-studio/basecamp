import { AudioSession, registerGlobals } from '@livekit/react-native';

// WebRTC for livekit-client on iOS and Android: once, before any Room is made.
registerGlobals();

/** The phone's audio session: speaker and microphone for a call, while voice is on. */
export const startAudio = () => AudioSession.startAudioSession();
export const stopAudio = () => AudioSession.stopAudioSession();
