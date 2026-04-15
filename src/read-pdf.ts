import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { PDFParse } from "pdf-parse";
import { DOCUMENT_DIR } from "./whatsapp.ts";

const MAX_CHARS = Number(process.env.PDF_MAX_CHARS ?? 20000);

export interface PdfReadResult {
  id: string;
  status: "read" | "no_file" | "error";
  filename?: string | null;
  pages?: number;
  text?: string;
  truncated?: boolean;
  error?: string;
}

/**
 * Read PDF text from a previously-downloaded document message. Truncates to
 * PDF_MAX_CHARS to avoid blowing up Claude context on large docs.
 */
export async function readChatPdf(
  messageId: string,
  logger: Logger,
): Promise<PdfReadResult> {
  const docPath = path.join(DOCUMENT_DIR, `${messageId}.pdf`);
  if (!fs.existsSync(docPath)) {
    return { id: messageId, status: "no_file" };
  }

  try {
    const buffer = fs.readFileSync(docPath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();
    const text = result.text || "";
    const truncated = text.length > MAX_CHARS;
    return {
      id: messageId,
      status: "read",
      pages: result.total,
      text: truncated ? text.slice(0, MAX_CHARS) + "\n\n…[TRUNCATED]…" : text,
      truncated,
    };
  } catch (error: any) {
    logger.warn(`Failed to parse PDF ${messageId}: ${error.message}`);
    return { id: messageId, status: "error", error: error.message };
  }
}
