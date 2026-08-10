const { env } = require("../config/env");

const MAX_FILE_BYTES = 24 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

const MIME_BY_EXTENSION = {
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
};

function extensionFromUrl(url) {
  try {
    const filename = new URL(url).pathname.split("/").pop() || "";
    const ext = filename.split(".").pop();
    if (ext && SUPPORTED_EXTENSIONS.has(String(ext).toLowerCase())) {
      return String(ext).toLowerCase();
    }
  } catch {
    // ignore
  }
  return null;
}

async function downloadMedia(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download media (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      `Media file is too large for transcription (${(buffer.length / 1024 / 1024).toFixed(1)}MB, max 24MB)`
    );
  }
  return buffer;
}

function formatTime(seconds) {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

async function transcribePodcast(mediaUrl) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!mediaUrl) {
    throw new Error("Podcast has no media file to transcribe");
  }

  const audioBuffer = await downloadMedia(mediaUrl);
  const ext = extensionFromUrl(mediaUrl) || "mp3";

  const formData = new FormData();
  formData.append("file",
    new Blob([audioBuffer], { type: MIME_BY_EXTENSION[ext] || "application/octet-stream" }),
    `podcast-media.${ext}`
  );
  // whisper-1 + verbose_json is the model combination that produced the
  // per-segment timestamps we ship; it is verified working in test-whisper-tmp.js.
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const segments = Array.isArray(data.segments) ? data.segments : [];

  if (segments.length === 0 && data.text) {
    return [{ time: "00:00", text: String(data.text).trim() }];
  }

  return segments
    .filter((s) => s.text && String(s.text).trim())
    .map((s) => ({
      time: formatTime(s.start || 0),
      text: String(s.text).trim(),
    }));
}

module.exports = { transcribePodcast };
