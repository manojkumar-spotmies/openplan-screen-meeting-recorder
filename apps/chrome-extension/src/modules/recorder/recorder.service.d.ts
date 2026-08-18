import { LocalVideoSession } from '@openplan/contracts';
export interface StartRecordingOptions {
    sessionId?: string;
    title: string;
    sourceTabUrl?: string;
    displayStream: MediaStream;
    micStream?: MediaStream | null;
    timesliceMs?: number;
}
export type StopReason = 'USER_ACTION' | 'TAB_CLOSED' | 'NATIVE_STOP_BAR';
export interface RecordingControlState {
    sessionId: string;
    status: LocalVideoSession['status'];
    isPaused: boolean;
    microphoneEnabled: boolean;
    systemAudioEnabled: boolean;
    hasMicrophone: boolean;
    hasSystemAudio: boolean;
}
export declare class RecorderService {
    private mediaRecorder;
    private currentSession;
    private sequenceNumber;
    private startTime;
    private accumulatedBytes;
    private mixerResult;
    private activeCompositeStream;
    private displayStreamRef;
    private micStreamRef;
    private isStopping;
    private stopPromiseResolver;
    private microphoneEnabled;
    private systemAudioEnabled;
    startRecording(options: StartRecordingOptions): Promise<LocalVideoSession>;
    stopRecording(reason?: StopReason): Promise<LocalVideoSession>;
    getCurrentSession(): LocalVideoSession | null;
    getSequenceNumber(): number;
    pauseRecording(): Promise<RecordingControlState>;
    resumeRecording(): Promise<RecordingControlState>;
    setMicrophoneEnabled(enabled: boolean): Promise<RecordingControlState>;
    setSystemAudioEnabled(enabled: boolean): Promise<RecordingControlState>;
    getControlState(): RecordingControlState;
    private handleDataAvailable;
    private handleStop;
    private handleError;
    private stopAllTracks;
    private resetState;
    private selectMimeType;
}
