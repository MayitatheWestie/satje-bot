import { chromium } from 'playwright';
import fs from 'fs';

// Lista de expedientes a vigilar diariamente
const CAUSAS = JSON.parse(fs.readFileSync('./causas.json', 'utf8'));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const resultados = [];

  for (const numeroCausa of CAUSAS) {
    try {
      await page.goto('https://procesosjudiciales.funcionjudicial.gob.ec/expel-busqueda-inteligente', { waitUntil: 'networkidle', timeout: 60000 });
      // Espera automática para que Google reCAPTCHA v3 genere el token válido en el navegador
      await page.waitForTimeout(3500);

      const inputCausa = page.locator('input[formcontrolname="numeroCausa"], input[placeholder*="proceso"], input[type="text"]').first();
      await inputCausa.fill(numeroCausa);

      // Interceptamos la respuesta JSON oficial del backend del SATJE tras validar el captcha
      const [apiResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('buscarCausas') && r.status() === 200, { timeout: 25000 }),
        page.locator('button:has-text("Buscar")').first().click()
      ]);

      const json = await apiResp.json();
      resultados.push({ numeroCausa, ok: true, fechaRevision: new Date().toISOString(), data: json });
    } catch (err) {
      resultados.push({ numeroCausa, ok: false, error: err.message, fechaRevision: new Date().toISOString() });
    }
  }

  fs.writeFileSync('./resultados_satje.json', JSON.stringify({ actualizado: new Date().toISOString(), resultados }, null, 2));
  await browser.close();
})();
