import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { PlaybookSchema, TtsSchema } from "../dist/schema.js";
import { synthesize, piperArgs } from "../dist/tts-providers.js";
import { ensureAudio, findAudioFile, ttsHash } from "../dist/tts.js";

const minimal = { app: { url: "http://localhost:3000" }, segments: [{ id: "intro", intent: "Show app" }] };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Real child processes with deterministic tool substitutes: no models, API keys,
// ffmpeg installation or platform-specific binaries are needed by these tests.
function fakeTools(t) {
  const dir = tempDir(t);
  const log = path.join(dir, "calls.jsonl");
  for (const tool of ["piper", "ffmpeg", "ffprobe"]) {
    const script = path.join(dir, `${tool}.cjs`);
    fs.writeFileSync(script, `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      const tool = ${JSON.stringify(tool)};
      const input = tool === "piper" ? fs.readFileSync(0, "utf8") : "";
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool, args, input }) + "\\n");
      if (tool === "piper") {
        if (input.includes("piper-error")) {
          console.error("Invalid speaker 99"); process.exit(1);
        }
        fs.writeFileSync(args[args.indexOf("--output_file") + 1], "WAV:" + input);
      } else if (tool === "ffmpeg") {
        const wav = fs.readFileSync(args[args.indexOf("-i") + 1], "utf8");
        if (wav.includes("ffmpeg-error")) {
          console.error("Unknown encoder libmp3lame"); process.exit(1);
        }
        fs.writeFileSync(args.at(-1), "MP3:" + wav);
      } else {
        if (fs.readFileSync(args.at(-1), "utf8") === "invalid-audio") {
          console.error("Invalid audio data"); process.exit(1);
        }
        console.log("1.25");
      }
    `);
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, `${tool}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(dir, tool), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
    }
  }
  // Windows environment variable names are case insensitive.
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const originalPath = process.env[pathKey];
  process.env[pathKey] = `${dir}${path.delimiter}${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = originalPath;
  });
  return { dir, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [] };
}

async function speechServer(t, audio) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "audio/mpeg");
    res.end(audio());
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test("existing playbooks retain OpenAI defaults", () => {
  for (const tts of [undefined, {}, { voice: "nova" }]) {
    const parsed = PlaybookSchema.parse({ ...minimal, tts });
    assert.deepEqual(parsed.tts, { provider: "openai", voice: tts?.voice ?? "alloy", speed: 1 });
  }
});

test("provider-specific defaults and validation", () => {
  for (const tts of [null, "piper", [], 42]) {
    assert.equal(PlaybookSchema.safeParse({ ...minimal, tts }).success, false);
  }
  assert.deepEqual(TtsSchema.parse({ provider: "kokoro" }), {
    provider: "kokoro", voice: "af_heart", speed: 1, baseUrl: "http://localhost:8880/v1",
  });
  assert.deepEqual(TtsSchema.parse({ provider: "piper", model: "voices/en.onnx" }), {
    provider: "piper", model: "voices/en.onnx", speaker: 0, speed: 1, executable: "piper",
  });
  for (const config of [
    { provider: "piper" },
    { provider: "piper", model: "" },
    { provider: "piper", model: "en.onnx", speaker: -1 },
    { provider: "piper", model: "en.onnx", speaker: 0.5 },
    { provider: "piper", model: "en.onnx", speed: 0 },
    { provider: "kokoro", baseUrl: "not-a-url" },
    { provider: "kokoro", baseUrl: "file:///tmp/kokoro" },
    { provider: "kokoro", baseUrl: "ftp://localhost/v1" },
    { provider: "kokoro", speed: 5 },
    { provider: "unknown" },
  ]) assert.equal(TtsSchema.safeParse(config).success, false, JSON.stringify(config));
});

test("cache keys include provider, endpoint, model, speaker, voice and speed", () => {
  const configs = [
    { provider: "openai" },
    { provider: "kokoro" },
    { provider: "kokoro", baseUrl: "http://localhost:9999/v1" },
    { provider: "kokoro", voice: "af_bella" },
    { provider: "kokoro", speed: 1.5 },
    { provider: "piper", model: "a.onnx" },
    { provider: "piper", model: "b.onnx" },
    { provider: "piper", model: "a.onnx", speaker: 1 },
    { provider: "piper", model: "a.onnx", speed: 2 },
  ].map(config => TtsSchema.parse(config));
  const hashes = configs.map(config => ttsHash("Hello", config));
  assert.equal(new Set(hashes).size, configs.length);
  assert.notEqual(ttsHash("Hello", configs[0]), ttsHash("Goodbye", configs[0]));
  assert.equal(ttsHash("Hello", configs[0]), hashes[0]);
});

test("Piper cache identity follows the resolved model across working directories", t => {
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  const dir = tempDir(t);
  const config = TtsSchema.parse({ provider: "piper", model: "voices/en.onnx" });
  const first = ttsHash("Hello", config);
  assert.equal(first, ttsHash("Hello", { ...config, model: path.resolve(config.model) }));
  process.chdir(dir);
  assert.notEqual(ttsHash("Hello", config), first);
});

test("Kokoro uses the local speech API and never leaks OPENAI_API_KEY", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldKey = process.env.OPENAI_API_KEY;
  const oldKokoroKey = process.env.KOKORO_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  delete process.env.KOKORO_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldKokoroKey === undefined) delete process.env.KOKORO_API_KEY;
    else process.env.KOKORO_API_KEY = oldKokoroKey;
  });
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "audio/mpeg");
    res.end(Buffer.from("mock-mp3"));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = TtsSchema.parse({ provider: "kokoro", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, speed: 1.25 });
  const output = path.join(dir, "speech.mp3");
  await synthesize("Hello world", config, output);
  assert.equal(fs.readFileSync(output, "utf8"), "mock-mp3");
  assert.deepEqual(requests[0], {
    url: "/v1/audio/speech", auth: "Bearer not-needed",
    body: { model: "kokoro", voice: "af_heart", speed: 1.25, input: "Hello world", response_format: "mp3" },
  });
  process.env.KOKORO_API_KEY = "local-secret";
  await synthesize("Hello", config, output);
  assert.equal(requests[1].auth, "Bearer local-secret");
});

test("a failed generation preserves cached audio and removes temporary files", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir);
  fs.writeFileSync(path.join(audioDir, "intro-12345678.mp3"), "old audio");
  const playbook = PlaybookSchema.parse({ ...minimal, tts: { provider: "elevenlabs" } });
  await assert.rejects(ensureAudio({ ...playbook.segments[0], narration: "Hello" }, playbook, dir), /not yet implemented/);
  assert.deepEqual(fs.readdirSync(audioDir), ["intro-12345678.mp3"]);
});

test("ensureAudio publishes, reuses and invalidates the cache after settings change", async t => {
  const tools = fakeTools(t);
  const server = await speechServer(t, () => "mock-mp3");
  const playbook = PlaybookSchema.parse({ ...minimal, tts: { provider: "kokoro", baseUrl: server.baseUrl } });
  const segment = { ...playbook.segments[0], narration: "Hello" };
  const first = await ensureAudio(segment, playbook, tools.dir);
  assert.equal(first.durationMs, 1250);
  assert.equal(fs.readFileSync(first.audioPath, "utf8"), "mock-mp3");
  assert.deepEqual(await ensureAudio(segment, playbook, tools.dir), first);
  assert.equal(server.requests.length, 1);

  const updated = await ensureAudio(segment, { ...playbook, tts: { ...playbook.tts, voice: "af_bella" } }, tools.dir);
  assert.notEqual(updated.audioPath, first.audioPath);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1].voice, "af_bella");
  assert.equal(fs.existsSync(first.audioPath), false);
  assert.deepEqual(fs.readdirSync(path.join(tools.dir, "audio")), [path.basename(updated.audioPath)]);
});

test("a probe failure after synthesis preserves the old cache and cleans temporary audio", async t => {
  const tools = fakeTools(t);
  let audio = "mock-mp3";
  const server = await speechServer(t, () => audio);
  const playbook = PlaybookSchema.parse({ ...minimal, tts: { provider: "kokoro", baseUrl: server.baseUrl } });
  const segment = { ...playbook.segments[0], narration: "Hello" };
  const first = await ensureAudio(segment, playbook, tools.dir);
  audio = "invalid-audio";
  await assert.rejects(ensureAudio({ ...segment, narration: "Changed" }, playbook, tools.dir), /Invalid audio data/);
  assert.equal(server.requests.length, 2);
  assert.equal(fs.readFileSync(first.audioPath, "utf8"), "mock-mp3");
  assert.deepEqual(fs.readdirSync(path.join(tools.dir, "audio")), [path.basename(first.audioPath)]);
});

test("Piper passes stdin and paths through synthesis, conversion and cache publication", async t => {
  const tools = fakeTools(t);
  const playbook = PlaybookSchema.parse({ ...minimal, tts: {
    provider: "piper", model: path.join(tools.dir, "voices with spaces", "en.onnx"), speaker: 3, speed: 2,
  } });
  const segment = { ...playbook.segments[0], narration: "Hello from Piper" };
  const result = await ensureAudio(segment, playbook, tools.dir);
  assert.equal(result.durationMs, 1250);
  assert.equal(fs.readFileSync(result.audioPath, "utf8"), "MP3:WAV:Hello from Piper\n");
  const [piper, ffmpeg, probe] = tools.calls();
  assert.equal(piper.tool, "piper");
  assert.equal(piper.input, "Hello from Piper\n");
  const wav = piper.args.at(-1);
  assert.deepEqual(piper.args, piperArgs(playbook.tts, wav));
  assert.equal(ffmpeg.tool, "ffmpeg");
  assert.deepEqual(ffmpeg.args.slice(0, -1), ["-y", "-i", wav, "-ar", "24000", "-ac", "1", "-codec:a", "libmp3lame", "-q:a", "2"]);
  assert.equal(probe.tool, "ffprobe");
  assert.equal(probe.args.at(-1), ffmpeg.args.at(-1));
  assert.equal(fs.existsSync(path.dirname(wav)), false);
  assert.equal(fs.existsSync(path.dirname(ffmpeg.args.at(-1))), false);
  assert.deepEqual(await ensureAudio(segment, playbook, tools.dir), result);
  assert.equal(tools.calls().filter(call => call.tool === "piper").length, 1);
});

test("Piper and ffmpeg failures expose their stage and diagnostics and clean temporary WAVs", async t => {
  const tools = fakeTools(t);
  const config = TtsSchema.parse({ provider: "piper", model: "en.onnx" });
  for (const [narration, message] of [
    ["piper-error", /Piper synthesis failed: Invalid speaker 99/],
    ["ffmpeg-error", /Piper audio conversion \(ffmpeg\/libmp3lame\) failed: Unknown encoder libmp3lame/],
  ]) {
    await assert.rejects(synthesize(narration, config, path.join(tools.dir, "speech.mp3")), message);
  }
  for (const call of tools.calls().filter(call => call.tool === "piper")) {
    assert.equal(fs.existsSync(path.dirname(call.args.at(-1))), false);
  }
});

test("audio lookup does not confuse segment IDs sharing a prefix", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "intro-details-12345678.mp3"), "other segment");
  assert.equal(findAudioFile(dir, "intro"), null);
  fs.writeFileSync(path.join(dir, "intro-87654321.mp3"), "this segment");
  assert.equal(findAudioFile(dir, "intro"), path.join(dir, "intro-87654321.mp3"));
});

test("missing Piper executable gives actionable diagnostics", async () => {
  const config = TtsSchema.parse({ provider: "piper", model: "missing.onnx", executable: "ndemo-nonexistent-piper" });
  await assert.rejects(synthesize("Hello", config, "unused.mp3"), /Piper synthesis failed:.*ndemo-nonexistent-piper/);
});

test("Piper arguments map speed inversely and preserve paths as single arguments", () => {
  const config = TtsSchema.parse({ provider: "piper", model: "/voices with spaces/en.onnx", speed: 2, speaker: 3 });
  assert.deepEqual(piperArgs(config, "/output with spaces/speech.wav"), [
    "--model", "/voices with spaces/en.onnx",
    "--speaker", "3",
    "--length_scale", "0.5",
    "--output_file", "/output with spaces/speech.wav",
  ]);
  assert.equal(piperArgs({ ...config, speed: 0.5 }, "out.wav")[5], "2");
});
