/**
 * Microphone and camera capture, shared by the desktop Media workspace and the phone
 * Quick surface so both agree on permission handling, MIME normalization, and teardown.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { canvasToBlob } from "./format";

export type CaptureStatus =
  | "idle"
  | "recording"
  | "ready"
  | "saving"
  | "uploaded"
  | "blocked"
  | "error";

export const CAPTURE_STATUS_LABEL: Record<CaptureStatus, string> = {
  idle: "Idle",
  recording: "Recording",
  ready: "Ready",
  saving: "Saving",
  uploaded: "Uploaded",
  blocked: "Blocked",
  error: "Error",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface AudioRecorderOptions {
  /** Invoked once the recorder flushes; the hook is already in the `saving` state. */
  onComplete: (blob: Blob, contentType: string) => Promise<void> | void;
  onError?: (message: string) => void;
}

export interface AudioRecorder {
  status: CaptureStatus;
  supported: boolean;
  recording: boolean;
  inputs: MediaDeviceInfo[];
  refreshInputs: () => Promise<void>;
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
}

export function useAudioRecorder({ onComplete, onError }: AudioRecorderOptions): AudioRecorder {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const completeRef = useRef(onComplete);
  const errorRef = useRef(onError);

  completeRef.current = onComplete;
  errorRef.current = onError;

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const supported = typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";

  const refreshInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    setInputs(devices.filter((device) => device.kind === "audioinput"));
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("blocked");
      errorRef.current?.("Audio recording is unavailable in this browser.");
      return;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      await refreshInputs().catch(() => undefined);
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        for (const track of stream.getTracks()) track.stop();
        const rawType = chunksRef.current[0]?.type || "audio/webm";
        const contentType = rawType.split(";")[0].trim().toLowerCase();
        const blob = new Blob(chunksRef.current, { type: contentType });
        recorderRef.current = null;
        chunksRef.current = [];
        setStatus("saving");
        void (async () => {
          try {
            await completeRef.current(blob, contentType);
            setStatus("uploaded");
          } catch (error) {
            setStatus("error");
            errorRef.current?.(errorMessage(error, "Recording upload failed."));
          }
        })();
      }, { once: true });
      recorder.start();
      setStatus("recording");
    } catch (error) {
      setStatus("blocked");
      errorRef.current?.(errorMessage(error, "Microphone access was blocked."));
    }
  }, [refreshInputs]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    setStatus("saving");
  }, []);

  return { status, supported, recording: status === "recording", inputs, refreshInputs, start, stop };
}

export interface CameraCaptureOptions {
  onError?: (message: string) => void;
}

export interface CameraCapture {
  status: CaptureStatus;
  active: boolean;
  supported: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  open: () => Promise<void>;
  close: () => void;
  toggle: () => Promise<void>;
  /** Grabs the current frame as a PNG blob, or null when the camera is not live. */
  capture: () => Promise<Blob | null>;
  setStatus: (status: CaptureStatus) => void;
}

export function useCameraCapture({ onError }: CameraCaptureOptions = {}): CameraCapture {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [active, setActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const errorRef = useRef(onError);

  errorRef.current = onError;

  const close = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setStatus("idle");
  }, []);

  useEffect(() => () => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const open = useCallback(async () => {
    if (streamRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("blocked");
      errorRef.current?.("Camera capture is unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setActive(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStatus("ready");
    } catch (error) {
      setStatus("blocked");
      errorRef.current?.(errorMessage(error, "Camera access was blocked."));
    }
  }, []);

  const toggle = useCallback(async () => {
    if (streamRef.current) close();
    else await open();
  }, [close, open]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!streamRef.current || !video?.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera canvas is unavailable.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvasToBlob(canvas, "image/png");
  }, []);

  return { status, active, supported, videoRef, open, close, toggle, capture, setStatus };
}
