import puppeteer, { Browser, Page } from 'puppeteer';
import { Slide, LLMResponse } from '@slideify/shared';
import { config } from '@slideify/config';

const TEMPLATE_HTML = (slide: Slide) => `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${slide.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1080px; height: 1350px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      display: flex; flex-direction: column;
      justify-content: center; align-items: center;
      padding: 60px;
    }
    .slide-number { position: absolute; top: 30px; right: 40px; font-size: 14px; opacity: 0.6; }
    .title { font-size: 36px; font-weight: 700; line-height: 1.3; margin-bottom: 24px; text-align: center; max-width: 900px; }
    .body { font-size: 18px; line-height: 1.6; opacity: 0.85; text-align: center; max-width: 800px; }
    .footer { position: absolute; bottom: 40px; font-size: 12px; opacity: 0.4; }
  </style>
</head>
<body>
  <div class="slide-number">${slide.order}</div>
  <div class="title">${escapeHtml(slide.title)}</div>
  <div class="body">${escapeHtml(slide.body)}</div>
  <div class="footer">Slideify</div>
</body>
</html>`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function renderSlides(slides: Slide[]): Promise<Buffer[]> {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  try {
    const buffers: Buffer[] = [];
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });

    for (const slide of slides) {
      await page.setContent(TEMPLATE_HTML(slide), { waitUntil: 'networkidle0' });
      const buffer = await page.screenshot({ type: 'png' });
      buffers.push(buffer);
    }

    return buffers;
  } finally {
    await browser.close();
  }
}

export async function renderPDF(slides: Slide[]): Promise<Buffer> {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350 });

    const htmlPages = slides.map((slide) => TEMPLATE_HTML(slide));
    await page.setContent(htmlPages[0], { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}