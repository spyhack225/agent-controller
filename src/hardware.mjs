// The boards this gateway knows how to provision.
//
// Pre-provisioning has to know which board it is stamping, because the four are not
// interchangeable: they differ in what they can display, how they take input, and whether they can
// capture audio at all. A claim label that says "flash the firmware" is useless when there are four
// firmwares; a device record without a model cannot be targeted by an OTA release; and a policy
// that grants media capture to a board with no microphone is a promise nothing can keep.
//
// `firmwareEnv` is the PlatformIO environment that produces this board's image. It is the single
// most useful thing to put in front of whoever is flashing the unit.

export const HARDWARE_BOARDS = Object.freeze([
  Object.freeze({
    id: "e213-esp32-s3r8",
    label: "CrowPanel 2.13\" e-paper",
    vendor: "Elecrow",
    firmwareEnv: "crowpanel-esp32-213-epaper-secure",
    firmwareDir: "firmware/CrowPanel-ESP32-2.13-E-paper",
    display: { kind: "epaper", width: 122, height: 250, colors: 2 },
    input: { touch: false, keys: 5 },
    audio: { microphone: false, speaker: false },
    camera: false,
    // The only board with a complete firmware and the only one validated end to end.
    maturity: "complete",
  }),
  Object.freeze({
    id: "ips28-esp32-s3r8",
    label: "Hosyond 2.8\" IPS touch",
    vendor: "Hosyond / LCDWIKI",
    firmwareEnv: "hosyond-es3c28p-controller",
    firmwareDir: "firmware/Hosyond-ESP32-S3-2.8-Touchscreen",
    display: { kind: "ips", width: 240, height: 320, colors: 65536 },
    input: { touch: true, keys: 1 },
    audio: { microphone: true, speaker: true },
    camera: false,
    maturity: "bring-up",
  }),
  Object.freeze({
    id: "amoled175-esp32-s3r8",
    label: "Waveshare 1.75\" round AMOLED",
    vendor: "Waveshare",
    firmwareEnv: "waveshare-amoled-175c",
    firmwareDir: "firmware/Waveshare-ESP32-S3-Touch-AMOLED-1.75C",
    display: { kind: "amoled", width: 466, height: 466, colors: 65536 },
    input: { touch: true, keys: 2 },
    audio: { microphone: true, speaker: true },
    camera: false,
    maturity: "scaffold",
  }),
  Object.freeze({
    id: "vision-master-t190",
    label: "Heltec Vision Master T190",
    vendor: "Heltec",
    firmwareEnv: "vision-master-t190",
    firmwareDir: "firmware/vision-master-t190",
    display: { kind: "tft", width: 170, height: 320, colors: 65536 },
    input: { touch: false, keys: 1 },
    audio: { microphone: false, speaker: false },
    camera: false,
    maturity: "scaffold",
  }),
]);

export const DEFAULT_HARDWARE_BOARD = "e213-esp32-s3r8";

export function findHardwareBoard(id) {
  if (typeof id !== "string" || id.length === 0) return null;
  return HARDWARE_BOARDS.find((board) => board.id === id) ?? null;
}

export function isKnownHardwareBoard(id) {
  return findHardwareBoard(id) !== null;
}

// Unknown models are accepted rather than rejected, and reported as unknown.
//
// A gateway that refuses a model it has not heard of cannot provision a board built after it was
// deployed — and the failure would land on a factory line, at the worst possible moment. The
// catalogue is here to inform the console and the label, not to gate manufacture.
export function describeHardwareBoard(id) {
  const board = findHardwareBoard(id);
  if (board) return board;
  return {
    id: id ?? DEFAULT_HARDWARE_BOARD,
    label: id ?? DEFAULT_HARDWARE_BOARD,
    vendor: null,
    firmwareEnv: null,
    firmwareDir: null,
    display: null,
    input: null,
    audio: null,
    camera: false,
    maturity: "unknown",
  };
}

// What a device of this model can physically do. The policy engine grants capabilities from the
// device's PROFILE; this is the separate question of whether the hardware could honour them, and
// the console uses it to avoid offering a microphone to a board that has none.
export function hardwareCapabilities(id) {
  const board = describeHardwareBoard(id);
  return {
    audioCapture: Boolean(board.audio?.microphone),
    audioPlayback: Boolean(board.audio?.speaker),
    cameraCapture: Boolean(board.camera),
    touchInput: Boolean(board.input?.touch),
    richDisplay: board.display ? board.display.colors > 2 : false,
  };
}
