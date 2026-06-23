import cors from "cors";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFString } from "pdf-lib";
import serverless from "serverless-http";

const api = express();
api.use(express.json({ limit: "10mb" }));

api.use(
  cors({
    origin: [/^http:\/\/localhost(:\d+)?$/, /^https:\/\/(.*\.)?huffmanks\.com$/],
  }),
);

api.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipFailedRequests: true,
    keyGenerator: (req) => {
      const forwarded = req.headers["x-forwarded-for"];
      const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : Array.isArray(forwarded) ? forwarded[0].split(",")[0].trim() : undefined;

      return ip || req.ip || "localhost";
    },
  }),
);

api.use((req, res, next) => {
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (process.env.NETLIFY_DEV === "true" || (origin && origin.includes("localhost"))) {
    return next();
  }

  if (origin) {
    const isDomainValid = /^https:\/\/(.*\.)?huffmanks\.com$/.test(origin);
    if (!isDomainValid) {
      return res.status(403).send("Forbidden: Unauthorized Origin.");
    }
    return next();
  }

  if (referer) {
    const isRefererValid = /^https:\/\/(.*\.)?huffmanks\.com/.test(referer);
    if (!isRefererValid) {
      return res.status(403).send("Forbidden: Unauthorized Referer.");
    }
    return next();
  }

  return res.status(403).send("Forbidden: Direct API access is restricted.");
});

const router = Router();
router.get("/hello", (_req, res) => res.send("Hello World!"));

router.get("/weather-data/:weatherSearch", async (req: express.Request, res: express.Response) => {
  try {
    const weatherSearch = req.params.weatherSearch;
    if (!weatherSearch) {
      throw Error("No search term provided.");
    }

    const GEONAMES_USER = process.env.GEONAMES_USER;
    const OPEN_WEATHER_MAP_API_KEY = process.env.OPEN_WEATHER_MAP_API_KEY;

    function extractZipCode(search: string) {
      const zipCodeRegex = /\b\d{5}\b/;
      const match = search.match(zipCodeRegex);
      return {
        route: match ? "zip?zip=" : "direct?q=",
        query: match ? match[0] : (search += ", US"),
      };
    }

    const { route, query } = extractZipCode(weatherSearch);

    const encodedQuery = route === "zip?zip=" ? query : encodeURIComponent(query);

    const geocodeUrl = `https://api.openweathermap.org/geo/1.0/${route}${encodedQuery}&appid=${OPEN_WEATHER_MAP_API_KEY}`;

    const geoCodeResponse = await fetch(geocodeUrl);
    if (!geoCodeResponse.ok) throw Error("No data found with that location.");

    const geoCodeData = await geoCodeResponse.json();

    const lat = geoCodeData?.[0]?.lat ? geoCodeData[0].lat : geoCodeData.lat;
    const lon = geoCodeData?.[0]?.lon ? geoCodeData[0].lon : geoCodeData.lon;

    if (!lat || !lon) throw Error;

    const timezoneUrl = `http://api.geonames.org/timezoneJSON?lat=${lat}&lng=${lon}&username=${GEONAMES_USER}`;

    const timezoneResponse = await fetch(timezoneUrl);
    const timezoneData = await timezoneResponse.json();

    const encodedTimezone = timezoneData?.timezoneId ? encodeURIComponent(timezoneData.timezoneId) : "auto";

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodedTimezone}&forecast_hours=24`;

    const weatherResponse = await fetch(weatherUrl);
    if (!weatherResponse.ok) throw Error;

    const weatherData = await weatherResponse.json();

    const locationUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const locationResponse = await fetch(locationUrl);
    let locationData:
      | undefined
      | {
          town: string;
          county: string;
          state: string;
          "ISO3166-2-lvl4": string;
          postcode: string;
          country: string;
          country_code: string;
        };

    if (locationResponse.ok) {
      const rawLocation = await locationResponse.json();
      const address = rawLocation.address || {};

      locationData = {
        town: address.city ? address.city : address.town,
        county: address.county,
        state: address.state,
        "ISO3166-2-lvl4": address["ISO3166-2-lvl4"],
        postcode: address.postcode,
        country: address.country,
        country_code: address.country_code,
      };
    } else {
      locationData = undefined;
    }

    res.status(200).send({ weatherData, locationData });
  } catch (error: any) {
    const message = error?.message ? error.message : error;
    res.status(500).send(message);
  }
});

router.post("/generate-pdf", async (req, res) => {
  try {
    const { htmlContent, issueNumber, volumeNumber } = req.body;

    if (!htmlContent) {
      return res.status(400).send("Missing htmlContent in request body");
    }

    const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
    if (!BROWSERLESS_TOKEN) {
      return res.status(500).send("PDF Service Token is missing.");
    }

    console.log("Sending HTML to Browserless for PDF conversion...");

    const response = await fetch(`https://production-sfo.browserless.io/pdf?token=${BROWSERLESS_TOKEN}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        html: htmlContent,
        options: {
          format: "letter",
          printBackground: true,
          margin: {
            top: "40px",
            right: "0px",
            bottom: "40px",
            left: "0px",
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Browserless error: ${errorText}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    console.log("PDF generated successfully via microservice");

    const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
    let match;
    const headingTitles: string[] = [];

    while ((match = h2Regex.exec(htmlContent)) !== null) {
      const cleanText = match[1].replace(/<[^>]*>/g, "").trim();
      if (cleanText) headingTitles.push(cleanText);
    }

    const pdfDoc = await PDFDocument.load(Buffer.from(pdfBuffer));
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();

    if (headingTitles.length > 0) {
      console.log(`Injecting ${headingTitles.length} low-level outline dictionary refs...`);

      const outlinesDictRef = context.nextRef();
      const outlineItemRefs = headingTitles.map(() => context.nextRef());

      for (let i = 0; i < headingTitles.length; i++) {
        const targetPageIndex = Math.min(i, pages.length - 1);
        const targetPageRef = pages[targetPageIndex].ref;

        const destArray = PDFArray.withContext(context);
        destArray.push(targetPageRef);
        destArray.push(PDFName.of("XYZ"));
        destArray.push(PDFNull);
        destArray.push(PDFNull);
        destArray.push(PDFNull);

        const itemMap = new Map();
        itemMap.set(PDFName.Title, PDFString.of(headingTitles[i]));
        itemMap.set(PDFName.Parent, outlinesDictRef);
        itemMap.set(PDFName.of("Dest"), destArray);

        if (i > 0) {
          itemMap.set(PDFName.of("Prev"), outlineItemRefs[i - 1]);
        }
        if (i < headingTitles.length - 1) {
          itemMap.set(PDFName.of("Next"), outlineItemRefs[i + 1]);
        }

        const outlineItemDict = PDFDict.fromMapWithContext(itemMap, context);
        context.assign(outlineItemRefs[i], outlineItemDict);
      }

      const outlinesDictMap = new Map();
      outlinesDictMap.set(PDFName.Type, PDFName.of("Outlines"));
      outlinesDictMap.set(PDFName.of("First"), outlineItemRefs[0]);
      outlinesDictMap.set(PDFName.of("Last"), outlineItemRefs[outlineItemRefs.length - 1]);
      outlinesDictMap.set(PDFName.of("Count"), PDFNumber.of(headingTitles.length));

      const outlinesDict = PDFDict.fromMapWithContext(outlinesDictMap, context);
      context.assign(outlinesDictRef, outlinesDict);

      pdfDoc.catalog.set(PDFName.of("Outlines"), outlinesDictRef);
    }

    const finalizedBytes = await pdfDoc.save();
    const base64Pdf = Buffer.from(finalizedBytes).toString("base64");

    const headingsMap: Array<{ title: string; page: number }> = [];

    for (let i = 0; i < headingTitles.length; i++) {
      const targetPageIndex = Math.min(i, pages.length - 1);

      headingsMap.push({
        title: headingTitles[i],
        page: targetPageIndex + 1,
      });
    }

    let snippetHtml = `<div class="mb-3"><a href="a/CHANGE_ME" title="CAP Vol. ${volumeNumber} - Issue ${issueNumber}" target="_blank" rel="noopener">Issue #${issueNumber}</a></div>\n<ul>\n`;

    headingsMap.forEach((item) => {
      const pageFragment = item.page > 1 ? `#page=${item.page}` : "";
      snippetHtml += `  <li><a href="a/CHANGE_ME${pageFragment}" target="_blank" rel="noopener">${item.title}</a></li>\n`;
    });

    snippetHtml += `</ul>`;

    return res.status(200).json({
      success: true,
      pdf: base64Pdf,
      snippetHtml,
    });
  } catch (error: any) {
    console.error("Error generating PDF:", error);
    return res.status(500).send(error?.message || "Internal Server Error");
  }
});

api.use("/api/", router);

export const handler = serverless(api);
