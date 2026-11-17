import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import OpenAI from "openai";
import type { Playbook } from "./schema.js";

type TtsConfig = Playbook["tts"];

function piperArgs(config: Extract<TtsConfig, { provider: "piper" }>, wavPath: string): string[] {
  return [
    "--model", config.model,
    "--speaker", String(config.speaker),
    "--length_scale", String(1 / config.speed),
    "--output_file", wavPath,
  ];
}

/** All adapters write MP3 so playback and the merge pipeline share one format. */
async function synthesize(narration: string, config: TtsConfig, outputPath: string): Promise<void> {
  switch (config.provider) {
    case "openai":
    case "kokoro": {
      // Never send the OpenAI key to a local/third-party Kokoro server.
      const client = config.provider === "kokoro"
        ? new OpenAI({ baseURL: config.baseUrl, apiKey: process.env.KOKORO_API_KEY || "not-needed" })
        : new OpenAI();
      const response = await client.audio.speech.create({
        model: config.provider === "kokoro" ? "kokoro" : "tts-1-hd",
        voice: config.voice as Parameters<typeof client.audio.speech.create>[0]["voice"],
        speed: config.speed,
        input: narration,
        response_format: "mp3",
      });
      fs.writeFileSync(outputPath, new Uint8Array(await response.arrayBuffer()));
      return;
    }
    case "piper": {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-piper-"));
      let stage = "Piper synthesis";
      try {
        const wavPath = path.join(tempDir, "speech.wav");
        await execa(config.executable, piperArgs(config, wavPath), { input: narration + "\n" });
        stage = "Piper audio conversion (ffmpeg/libmp3lame)";
        await execa("ffmpeg", [
          "-y", "-i", wavPath, "-ar", "24000", "-ac", "1",
          "-codec:a", "libmp3lame", "-q:a", "2", outputPath,
        ]);
      } catch (error) {
        // The CLI prints Error.message, not cause. Omit command/input dumps,
        // but retain the executable failure or tool's diagnostic on stderr.
        const failure = error as { shortMessage?: string; stderr?: string };
        const detail = failure.stderr?.trim() || failure.shortMessage || String(error);
        throw new Error(`${stage} failed: ${detail}`, { cause: error });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      return;
    }
    default:
      throw new Error(`TTS provider "${config.provider}" not yet implemented`);
  }
}

export { synthesize, piperArgs };
export type { TtsConfig };
