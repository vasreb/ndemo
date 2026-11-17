#!/usr/bin/env node

import { Command } from "commander";
import { open, close, reset } from "./browser.js";
import { connect } from "./browser.js";
import { readPageState } from "./page-reader.js";
import { play } from "./player.js";
import { render } from "./renderer.js";
import { generateSrt } from "./subtitles.js";
import { loadPlaybook } from "./playbook-io.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

const program = new Command();

program
  .name("ndemo")
  .description("Narrated demo video toolkit")
  .version("0.1.0");

// ─── open ────────────────────────────────────────────

program
  .command("open")
  .description("Launch browser daemon and navigate to app")
  .argument("<playbook>", "Path to playbook YAML file")
  .action(async (playbook: string) => {
    try {
      await open(playbook);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── close ───────────────────────────────────────────

program
  .command("close")
  .description("Shut down browser daemon")
  .action(async () => {
    try {
      await close();
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── reset ───────────────────────────────────────────

program
  .command("reset")
  .description("Navigate back to app URL (fresh state)")
  .action(async () => {
    try {
      await reset();
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── page-state ──────────────────────────────────────

program
  .command("page-state")
  .description("Print current page accessibility tree")
  .option("--screenshot", "Also save a screenshot")
  .action(async (options: { screenshot?: boolean }) => {
    try {
      const { page } = await connect();
      const output = await readPageState(page, {
        screenshot: options.screenshot,
      });
      console.log(output);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── play ────────────────────────────────────────────

program
  .command("play")
  .description("Play segments in the live browser")
  .argument("<playbook>", "Path to playbook YAML file")
  .option("--segment <id>", "Play just this segment")
  .option("--from <id>", "Play from this segment")
  .option("--to <id>", "Stop after this segment")
  .option("--audio", "Play TTS narration audio alongside actions")
  .action(async (playbook: string, options: {
    segment?: string;
    from?: string;
    to?: string;
    audio?: boolean;
  }) => {
    try {
      await play(playbook, options);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── render ──────────────────────────────────────────

program
  .command("render")
  .description("Full pipeline: TTS → replay → merge → mp4")
  .argument("<playbook>", "Path to playbook YAML file")
  .option("--output <path>", "Output file path")
  .action(async (playbook: string, options: { output?: string }) => {
    try {
      await render(playbook, options.output);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── subtitles ───────────────────────────────────

program
  .command("subtitles")
  .description("Generate SRT subtitle file from playbook")
  .argument("<playbook>", "Path to playbook YAML file")
  .option("--output <path>", "Output SRT file path")
  .action(async (playbookPath: string, options: { output?: string }) => {
    try {
      const playbook = loadPlaybook(playbookPath);
      const playbookName = path.basename(playbookPath, path.extname(playbookPath));
      const outputDir = path.resolve(path.dirname(playbookPath), playbook.recording.outputDir);

      const srtContent = generateSrt(
        playbook.segments.map(s => ({
          narration: s.narration,
          videoDurationMs: s.videoDuration ?? s.audioDuration ?? 0,
          audioDurationMs: s.audioDuration ?? 0,
        }))
      );

      const srtPath = options.output ?? path.join(outputDir, `${playbookName}.srt`);
      fs.writeFileSync(srtPath, srtContent);
      console.log(`✓ ${srtPath}`);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }
  });

// ─── doctor ──────────────────────────────────────────

program
  .command("doctor")
  .description("Check dependencies")
  .option("--playbook <path>", "Check TTS dependencies for a playbook (default: OpenAI)")
  .action(async (options: { playbook?: string }) => {
    let allOk = true;
    let tts;
    try {
      tts = options.playbook ? loadPlaybook(options.playbook).tts : { provider: "openai" as const };
    } catch (err) {
      console.error(`Error: ${err}`);
      process.exit(1);
    }

    const nodeVersion = process.version;
    const nodeMajor = parseInt(nodeVersion.slice(1));
    if (nodeMajor >= 20) {
      console.log(`  ✓ node ${nodeVersion} (≥ 20 required)`);
    } else {
      console.log(`  ✗ node ${nodeVersion} (≥ 20 required)`);
      allOk = false;
    }

    try {
      const ffmpegVersion = execSync("ffmpeg -version", { encoding: "utf-8" })
        .split("\n")[0]
        .match(/version\s+([\d.]+)/)?.[1] ?? "unknown";
      console.log(`  ✓ ffmpeg ${ffmpegVersion}`);
    } catch {
      console.log("  ✗ ffmpeg not found");
      allOk = false;
    }

    try {
      const ffprobeVersion = execSync("ffprobe -version", { encoding: "utf-8" })
        .split("\n")[0]
        .match(/version\s+([\d.]+)/)?.[1] ?? "unknown";
      console.log(`  ✓ ffprobe ${ffprobeVersion}`);
    } catch {
      console.log("  ✗ ffprobe not found");
      allOk = false;
    }

    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      console.log("  ✓ playwright browsers installed (chromium)");
    } catch {
      console.log("  ✗ playwright browsers not installed");
      console.log("    Run: npx playwright install chromium");
      allOk = false;
    }

    if (tts.provider === "kokoro") {
      try {
        const response = await fetch(`${tts.baseUrl.replace(/\/$/, "")}/audio/voices`, {
          signal: AbortSignal.timeout(5000),
          headers: process.env.KOKORO_API_KEY ? { Authorization: `Bearer ${process.env.KOKORO_API_KEY}` } : {},
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        console.log(`  ✓ Kokoro server reachable (${tts.baseUrl})`);
      } catch (err) {
        console.log(`  ✗ Kokoro voice-list check failed (/audio/voices): ${err}`);
        allOk = false;
      }
    } else if (tts.provider === "piper") {
      try {
        await execa(tts.executable, ["--help"], { timeout: 5000 });
        console.log(`  ✓ Piper executable (${tts.executable})`);
      } catch (err) {
        console.log(`  ✗ Piper executable check failed (${tts.executable}): ${err}`);
        allOk = false;
      }
      for (const file of [tts.model, `${tts.model}.json`]) {
        if (fs.existsSync(file)) {
          console.log(`  ✓ ${file}`);
        } else {
          console.log(`  ✗ Piper model/config not found: ${file}`);
          allOk = false;
        }
      }
      try {
        const { stdout } = await execa("ffmpeg", ["-encoders"]);
        if (!stdout.includes("libmp3lame")) throw new Error("missing encoder");
        console.log("  ✓ ffmpeg libmp3lame encoder");
      } catch {
        console.log("  ✗ Piper requires ffmpeg with libmp3lame");
        allOk = false;
      }
    } else if (tts.provider === "elevenlabs") {
      console.log("  ✗ elevenlabs TTS is not yet implemented");
      allOk = false;
    } else if (process.env.OPENAI_API_KEY) {
      console.log("  ✓ OPENAI_API_KEY is set");
    } else {
      console.log("  ✗ OPENAI_API_KEY not set (required for OpenAI TTS)");
      allOk = false;
    }

    process.exit(allOk ? 0 : 1);
  });

program.parse();
