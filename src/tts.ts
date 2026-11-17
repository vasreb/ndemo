import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execa } from "execa";
import { synthesize, type TtsConfig } from "./tts-providers.js";
import type { Playbook, Segment } from "./schema.js";

interface TtsResult {
  audioPath: string;
  durationMs: number;
}

function ttsHash(narration: string, config: TtsConfig): string {
  // Piper resolves model paths from cwd; the cache must identify the same file.
  const cacheConfig = config.provider === "piper"
    ? { ...config, model: path.resolve(config.model) }
    : config;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([narration, cacheConfig]))
    .digest("hex")
    .slice(0, 8);
}

/**
 * Find existing audio file for a segment ID in the given directory.
 * Files are named `{id}-{hash}.mp3`.
 */
function findAudioFile(audioDir: string, segmentId: string): string | null {
  if (!fs.existsSync(audioDir)) return null;
  const pattern = new RegExp(`^${segmentId}-[a-f0-9]{8}\\.mp3$`);
  const files = fs.readdirSync(audioDir);
  const match = files.find(f => pattern.test(f));
  return match ? path.join(audioDir, match) : null;
}

/**
 * Delete any stale audio files for a segment ID that don't match the current hash.
 */
function cleanStaleAudio(audioDir: string, segmentId: string, currentHash: string): void {
  if (!fs.existsSync(audioDir)) return;
  const currentName = `${segmentId}-${currentHash}.mp3`;
  const pattern = new RegExp(`^${segmentId}-[a-f0-9]{8}\\.mp3$`);
  for (const file of fs.readdirSync(audioDir)) {
    if (pattern.test(file) && file !== currentName) {
      fs.unlinkSync(path.join(audioDir, file));
    }
  }
}

/**
 * Ensure TTS audio exists, regenerating if narration or provider settings changed.
 * Deletes stale audio files automatically.
 */
async function ensureAudio(
  segment: Segment,
  playbook: Playbook,
  outputDir: string
): Promise<TtsResult> {
  const audioDir = path.join(outputDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  const hash = ttsHash(segment.narration!, playbook.tts);
  const audioPath = path.join(audioDir, `${segment.id}-${hash}.mp3`);

  // If current file exists, just probe and return
  if (fs.existsSync(audioPath)) {
    const durationMs = await probeDuration(audioPath);
    return { audioPath, durationMs };
  }

  // Publish only complete, probeable audio; a failed generation keeps the old cache.
  const tempDir = fs.mkdtempSync(path.join(audioDir, ".tts-"));
  try {
    const tempPath = path.join(tempDir, "speech.mp3");
    await synthesize(segment.narration!, playbook.tts, tempPath);
    const durationMs = await probeDuration(tempPath);
    fs.renameSync(tempPath, audioPath);
    cleanStaleAudio(audioDir, segment.id, hash);
    return { audioPath, durationMs };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function probeDuration(audioPath: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    audioPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (isNaN(seconds)) {
    throw new Error(`Could not probe duration of ${audioPath}`);
  }
  return Math.round(seconds * 1000);
}

// Keep generateTts as an alias for ensureAudio for backwards compat within renderer
const generateTts = ensureAudio;

export { generateTts, ensureAudio, probeDuration, ttsHash, findAudioFile };
