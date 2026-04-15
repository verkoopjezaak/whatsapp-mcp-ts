import OpenAI from "openai";
import { toFile } from "openai";
import type P from "pino";

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  logger: P.Logger,
  language: string = "nl",
): Promise<string | null> {
  const client = getOpenAI();
  if (!client) {
    logger.warn("No OPENAI_API_KEY configured, skipping audio transcription");
    return null;
  }

  if (audioBuffer.length === 0) {
    logger.warn("Empty audio buffer, skipping transcription");
    return null;
  }

  // Whisper API limit is 25MB
  if (audioBuffer.length > 25 * 1024 * 1024) {
    logger.warn(
      `Audio too large for Whisper: ${audioBuffer.length} bytes, skipping`,
    );
    return null;
  }

  try {
    const file = await toFile(audioBuffer, "audio.ogg", {
      type: "audio/ogg; codecs=opus",
    });

    const response = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: file,
      language: language,
    });

    return response.text || null;
  } catch (error: any) {
    logger.error(`Whisper transcription failed: ${error.message}`);
    return null;
  }
}
