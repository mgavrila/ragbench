// Generates a minimal one-page PDF containing the text "RAGBench fixture PDF"
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });

const content = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 62 >> stream
BT /F1 24 Tf 72 700 Td (RAGBench fixture PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
writeFileSync(join(dir, "sample.pdf"), content);
writeFileSync(join(dir, "sample.md"), "# Fixture\n\nRAGBench markdown fixture body.\n");
console.log("fixtures written");
