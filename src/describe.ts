import OpenAI from "openai";
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

export async function describeImage(
  imageBuffer: Buffer,
  caption: string | null,
  logger: P.Logger,
  mimeType: string = "image/jpeg",
): Promise<string | null> {
  const client = getOpenAI();
  if (!client) {
    logger.warn("No OPENAI_API_KEY configured, skipping image description");
    return null;
  }

  if (imageBuffer.length === 0) {
    logger.warn("Empty image buffer, skipping description");
    return null;
  }

  // OpenAI vision limit is 20MB per image
  if (imageBuffer.length > 20 * 1024 * 1024) {
    logger.warn(
      `Image too large for vision API: ${imageBuffer.length} bytes, skipping`,
    );
    return null;
  }

  try {
    const base64 = imageBuffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    const userText = caption
      ? `Beschrijf deze afbeelding beknopt in het Nederlands. Noem het type (screenshot, foto, document, grafiek, whiteboard), de kern van wat te zien is, en transcribeer alle leesbare tekst letterlijk (cijfers, namen, bedragen). Caption van de afzender: "${caption}".`
      : `Beschrijf deze afbeelding beknopt in het Nederlands. Noem het type (screenshot, foto, document, grafiek, whiteboard), de kern van wat te zien is, en transcribeer alle leesbare tekst letterlijk (cijfers, namen, bedragen).`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: dataUrl, detail: "auto" },
            },
          ],
        },
      ],
    });

    const description = response.choices[0]?.message?.content?.trim();
    return description || null;
  } catch (error: any) {
    logger.error(`Vision description failed: ${error.message}`);
    return null;
  }
}
