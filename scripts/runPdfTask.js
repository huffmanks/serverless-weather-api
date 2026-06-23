import fs from "fs";
import path from "path";

async function runPdfTask() {
  try {
    const jsonFilePath = path.join(import.meta.dirname, "data.json");

    if (!fs.existsSync(jsonFilePath)) {
      console.error(`HTML file not found at: ${jsonFilePath}`);
      return;
    }

    const rawData = fs.readFileSync(jsonFilePath, "utf8");

    const localJson = JSON.parse(rawData);

    const response = await fetch(`http://localhost:8888/api/generate-pdf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        htmlContent: localJson.htmlContent,
        volumeNumber: localJson.volumeNumber,
        issueNumber: localJson.issueNumber,
      }),
    });

    if (!response.ok) {
      throw new Error(`API responded with status ${response.status}`);
    }

    const data = await response.json();

    if (data.success && data.pdf) {
      const timestamp = Date.now();
      const outputDir = path.join(process.cwd(), "output");
      const outputPdfPath = path.join(outputDir, `doc_${timestamp}.pdf`);
      const outputSnippetPath = path.join(outputDir, `snip_${timestamp}.html`);

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      console.log("Converting Base64 string to binary buffer...");
      const buffer = Buffer.from(data.pdf, "base64");

      console.log(`Writing file to: ${outputPdfPath}`);
      fs.writeFileSync(outputPdfPath, new Uint8Array(buffer));
      fs.writeFileSync(outputSnippetPath, data.snippetHtml);

      console.log("PDF downloaded successfully to your current path!");
    } else {
      console.error("Failed to extract valid data content layout.");
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
  }
}

await runPdfTask();
